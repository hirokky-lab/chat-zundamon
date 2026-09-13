import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { finished } from "node:stream/promises";
import OpenAI, { toFile } from "openai";
import { CHAT_DICTATION_MAX_BYTES, type ChatDictationMimeType } from "../../../packages/domain/src/index.js";
import type { UsageLog } from "./usage-log.js";
import { toUsageRow } from "./usage-log.js";
import {
  CostLimitError,
  type CostGuard,
  type CostReservation,
} from "./cost-guard.js";
import type { WriteGate } from "./write-gate.js";
import { releaseLeaseOnResponseEnd } from "./write-gate.js";

const transcriptionModel = "gpt-4o-mini-transcribe";
const acceptedMimeTypes = new Set<ChatDictationMimeType>(["audio/webm", "audio/mp4"]);

export type TranscriptionUsage = {
  asrInputAudioTokens: number;
  asrInputTextTokens: number;
  asrOutputTokens: number;
};

export type TranscriptionGateway = {
  transcribe(input: {
    audio: Uint8Array;
    mimeType: ChatDictationMimeType;
    signal: AbortSignal;
  }): Promise<{ text: string; usage?: TranscriptionUsage; requestId?: string }>;
};

export class TranscriptionGatewayError extends Error {
  constructor(
    readonly kind: "timeout" | "upstream",
    readonly requestId?: string,
  ) {
    super(`Transcription gateway ${kind}`);
    this.name = "TranscriptionGatewayError";
  }
}

type TranscriptionsClient = {
  audio: {
    transcriptions: {
      create: (
        request: { file: File; model: typeof transcriptionModel },
        options: { signal: AbortSignal },
      ) => Promise<{
        text: string;
        _request_id?: string | null;
        usage?:
          | {
              type: "tokens";
              input_tokens: number;
              output_tokens: number;
              input_token_details?: { audio_tokens?: number; text_tokens?: number };
            }
          | { type: "duration"; seconds: number };
      }>;
    };
  };
};

export class OpenAITranscriptionGateway implements TranscriptionGateway {
  constructor(private readonly client: TranscriptionsClient) {}

  async transcribe(input: {
    audio: Uint8Array;
    mimeType: ChatDictationMimeType;
    signal: AbortSignal;
  }): Promise<{ text: string; usage?: TranscriptionUsage; requestId?: string }> {
    let requestId: string | undefined;
    try {
      const response = await this.client.audio.transcriptions.create(
        {
          file: await toFile(
            input.audio,
            input.mimeType === "audio/mp4" ? "speech.mp4" : "speech.webm",
            { type: input.mimeType },
          ),
          model: transcriptionModel,
        },
        { signal: input.signal },
      );
      requestId = response._request_id ?? undefined;
      const tokenUsage = response.usage?.type === "tokens" ? response.usage : undefined;
      return {
        text: response.text,
        requestId,
        usage: tokenUsage ? toTranscriptionUsage(tokenUsage) : undefined,
      };
    } catch (error) {
      const kind =
        input.signal.aborted ||
        (error instanceof Error &&
          (error instanceof OpenAI.APIConnectionTimeoutError ||
            error.name === "TimeoutError" ||
            error.name === "AbortError"))
          ? "timeout"
          : "upstream";
      throw new TranscriptionGatewayError(kind, requestId);
    }
  }
}

function toTranscriptionUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  input_token_details?: { audio_tokens?: number; text_tokens?: number };
}): TranscriptionUsage | undefined {
  const audio = usage.input_token_details?.audio_tokens;
  const text = usage.input_token_details?.text_tokens;
  if (!isSafeTokenCount(usage.input_tokens) || !isSafeTokenCount(usage.output_tokens)) {
    return undefined;
  }
  if (audio === undefined && text === undefined) return undefined;
  if (audio !== undefined && text !== undefined) {
    if (!isSafeTokenCount(audio) || !isSafeTokenCount(text) || audio + text !== usage.input_tokens) {
      return undefined;
    }
    return {
      asrInputAudioTokens: audio,
      asrInputTextTokens: text,
      asrOutputTokens: usage.output_tokens,
    };
  }
  if (audio === undefined) {
    if (!isSafeTokenCount(text) || text > usage.input_tokens) return undefined;
    return {
      asrInputAudioTokens: usage.input_tokens - text,
      asrInputTextTokens: text,
      asrOutputTokens: usage.output_tokens,
    };
  }
  if (!isSafeTokenCount(audio) || audio > usage.input_tokens) return undefined;
  return {
    asrInputAudioTokens: audio,
    asrInputTextTokens: usage.input_tokens - audio,
    asrOutputTokens: usage.output_tokens,
  };
}

function isSafeTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createOpenAITranscriptionGateway(options: { apiKey: string }): TranscriptionGateway {
  return new OpenAITranscriptionGateway(
    new OpenAI({ apiKey: options.apiKey, logLevel: "off" }),
  );
}

class TranscriptionRequestError extends Error {
  constructor(readonly statusCode: 400 | 413 | 415, readonly message: string) {
    super(message);
  }
}

export function registerTranscriptionRoutes(
  app: FastifyInstance,
  options: {
    transcriptionGateway: TranscriptionGateway;
    usageLog: UsageLog;
    now: () => Date;
    costGuard: CostGuard;
    maximumUsd: number;
    writeGate?: WriteGate;
  },
): void {
  app.register(async (scope) => {
    await scope.register(multipart, {
      limits: { files: 1, fileSize: CHAT_DICTATION_MAX_BYTES, fields: 0 },
    });

    scope.post("/api/chat/transcriptions", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
      if (!lease) return reply.code(503).send({ error: "maintenance" });
      releaseLeaseOnResponseEnd(reply.raw, lease);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const abortOnResponseClose = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", abortOnResponseClose);
      const startedAt = options.now();
      let reservation: CostReservation | undefined;

      try {
        const { audio, mimeType } = await readAudioPart(request);
        reservation = await options.costGuard.reserve({
          user: request.yuiUser,
          requestId: `transcription:${request.id}`,
          feature: "transcription",
          maximumUsd: options.maximumUsd,
        });
        const result = await options.transcriptionGateway.transcribe({
          audio,
          mimeType,
          signal: controller.signal,
        });
        const text = result.text.trim();

        if (result.usage) {
          const usageInput = {
            sessionId: `asr:${request.id}`,
            startedAt: startedAt.toISOString(),
            endedAt: options.now().toISOString(),
            ...result.usage,
          };
          try {
            await options.usageLog.append(request.yuiUser, usageInput);
          } catch {
            request.log.error(
              { requestId: request.id },
              "Transcription usage log append failed",
            );
          }
          await reservation.settle(
            toUsageRow(request.yuiUser, usageInput).estimatedAsrUsd,
          );
        } else {
          await reservation.hold();
        }
        if (!text) throw new TranscriptionGatewayError("upstream", result.requestId);
        return { text };
      } catch (error) {
        if (error instanceof TranscriptionRequestError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        if (isMultipartTooLargeError(error)) {
          return reply.code(413).send({ error: "Audio file is too large" });
        }
        if (isRejectedMultipartError(error)) {
          return reply.code(400).send({ error: "Exactly one audio file is required" });
        }
        if (reservation) await reservation.hold().catch(() => undefined);
        if (error instanceof CostLimitError) {
          return reply.code(429).send({ error: "usage_limit_reached" });
        }
        const gatewayError = error instanceof TranscriptionGatewayError
          ? error
          : new TranscriptionGatewayError("upstream");
        request.log.error(
          { requestId: gatewayError.requestId ?? "unavailable" },
          "OpenAI transcription failed",
        );
        const timeout = gatewayError.kind === "timeout";
        return reply.code(timeout ? 504 : 502).send({
          error: timeout
            ? "Transcription service timed out"
            : "Transcription service is unavailable",
        });
      } finally {
        lease.release();
        request.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", abortOnResponseClose);
      }
    });
  });
}

function isMultipartTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE";
}

function isRejectedMultipartError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error &&
    (error.code === "FST_FILES_LIMIT" ||
      error.code === "FST_FIELDS_LIMIT" ||
      error.code === "FST_PARTS_LIMIT" ||
      error.code === "FST_MP_PREMATURE_CLOSE" ||
      error.code === "FST_INVALID_MULTIPART_CONTENT_TYPE");
}

async function readAudioPart(request: FastifyRequest): Promise<{
  audio: Buffer;
  mimeType: ChatDictationMimeType;
}> {
  let audio: Buffer | undefined;
  let mimeType: ChatDictationMimeType | undefined;
  for await (const part of request.parts()) {
    if (part.type !== "file") {
      throw new TranscriptionRequestError(400, "Audio file is required");
    }
    if (part.fieldname !== "audio" || audio) {
      await discard(part.file);
      throw new TranscriptionRequestError(400, "Exactly one audio file is required");
    }
    if (!acceptedMimeTypes.has(part.mimetype as ChatDictationMimeType)) {
      await discard(part.file);
      throw new TranscriptionRequestError(415, "Unsupported audio type");
    }
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.byteLength > CHAT_DICTATION_MAX_BYTES) {
      throw new TranscriptionRequestError(413, "Audio file is too large");
    }
    if (bytes.byteLength === 0) {
      throw new TranscriptionRequestError(400, "Audio file is required");
    }
    audio = bytes;
    mimeType = part.mimetype as ChatDictationMimeType;
  }
  if (!audio || !mimeType) throw new TranscriptionRequestError(400, "Audio file is required");
  return { audio, mimeType };
}

async function discard(stream: NodeJS.ReadableStream): Promise<void> {
  stream.resume();
  try {
    await finished(stream, { cleanup: true });
  } catch (error) {
    if (!isPrematureStreamClose(error)) {
      throw error;
    }
  }
}

function isPrematureStreamClose(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ERR_STREAM_PREMATURE_CLOSE";
}
