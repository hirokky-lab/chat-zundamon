import type { FastifyInstance } from "fastify";
import {
  buildCharacterInstructions,
  formatAddressedName,
  parseTimeZone,
  ZUNDAMON_CHARACTER,
} from "../../../packages/domain/src/index.js";
import type {
  ChatMessage,
  MemoryRecord,
  RemoteChatSnapshot,
  TranscriptTurn,
  YuiContext,
} from "../../../packages/domain/src/index.js";
import type { ChatStateRepository } from "./chat-state-routes.js";
import type { WriteGate } from "./write-gate.js";
import { releaseLeaseOnResponseEnd } from "./write-gate.js";
import type { ProfileRepository } from "./profile-db.js";
import {
  CostLimitError,
  type CostGuard,
  type CostReservation,
} from "./cost-guard.js";
import {
  extractRelatedNames,
  inferMemoryScope,
  type MemoryRetriever,
} from "./memory-retriever.js";

export type RealtimeSession = {
  type: "realtime";
  model: string;
  instructions: string;
  output_modalities: ["audio"] | ["text"];
  audio: {
    input: {
      transcription: {
        model: "gpt-4o-mini-transcribe";
        language: "ja";
      };
      turn_detection: {
        type: "server_vad";
        create_response: false;
        interrupt_response: true;
        silence_duration_ms: 700;
      };
    };
    output?: { voice: "marin" };
  };
  tools: [{
    type: "function";
    name: "remember_pending";
    description: string;
    parameters: { type: "object"; properties: Record<string, never>; additionalProperties: false };
  }];
  tool_choice: "auto";
};

export type RealtimeCallInput = {
  offerSdp: string;
  session: RealtimeSession;
};

export type RealtimeCallResult = {
  sdp: string;
  requestId?: string;
};

export type RealtimeGateway = {
  createCall(input: RealtimeCallInput): Promise<RealtimeCallResult>;
};

export class RealtimeGatewayError extends Error {
  constructor(
    readonly kind: "timeout" | "upstream",
    readonly requestId?: string,
  ) {
    super(`Realtime gateway ${kind}`);
    this.name = "RealtimeGatewayError";
  }
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const VOICE_RECENT_TURN_LIMIT = 6;

export function selectRecentVoiceTurns(
  snapshot: RemoteChatSnapshot | null,
): TranscriptTurn[] {
  return (snapshot?.timeline ?? [])
    .filter((item): item is ChatMessage =>
      item.type === "message" &&
      item.delivery === "sent" &&
      item.flow !== "profile",
    )
    .slice(-VOICE_RECENT_TURN_LIMIT)
    .map(({ role, text }) => ({ role, text }));
}

export function createOpenAIRealtimeGateway(options: {
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): RealtimeGateway {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async createCall(input) {
      const body = new FormData();
      body.set("session", JSON.stringify(input.session));
      body.set("sdp", input.offerSdp);

      let requestId: string | undefined;
      try {
        const response = await fetchImpl(
          "https://api.openai.com/v1/realtime/calls",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${options.apiKey}` },
            body,
            signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          },
        );
        requestId = response.headers.get("x-request-id") ?? undefined;
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {
            // The upstream error remains authoritative; never inspect its body.
          }
          throw new RealtimeGatewayError("upstream", requestId);
        }

        return {
          requestId,
          sdp: await response.text(),
        };
      } catch (error) {
        if (error instanceof RealtimeGatewayError) {
          throw error;
        }
        const kind =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
            ? "timeout"
            : "upstream";
        throw new RealtimeGatewayError(kind, requestId);
      }
    },
  };
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  options: {
    memoryRetriever: MemoryRetriever;
    now: () => Date;
    realtimeGateway: RealtimeGateway;
    realtimeModel: string;
    zundamonEnabled?: boolean;
    profileRepository: ProfileRepository;
    costGuard: CostGuard;
    maximumUsd: number;
    chatStateRepository?: ChatStateRepository;
    writeGate?: WriteGate;
  },
): void {
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url === "/api/realtime/calls") {
      console.info(JSON.stringify({event:"realtime_connection",status:reply.statusCode}));
    }
  });
  app.addContentTypeParser(
    "application/sdp",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );

  app.post("/api/realtime/calls", async (request, reply) => {
    const offerSdp = request.body as string;
    if (!offerSdp.trim()) {
      return reply.code(400).send({ error: "SDP offer is required" });
    }
    const lease = options.writeGate?.enter("user_mutation") ?? (options.writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });
    releaseLeaseOnResponseEnd(reply.raw, lease);
    const sessionIdHeader = request.headers["x-yui-session-id"];
    const sessionId = typeof sessionIdHeader === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(sessionIdHeader)
      ? sessionIdHeader
      : request.id;

    const profile = await options.profileRepository.get(request.yuiUser);
    if (!profile) return reply.code(409).send({ error: "Profile setup is required" });
    let recentTurns: TranscriptTurn[] = [];
    try {
      recentTurns = selectRecentVoiceTurns(
        (await options.chatStateRepository?.get(request.yuiUser)) ?? null,
      );
    } catch {
      request.log.warn("Recent chat context unavailable for Realtime call");
    }
    const startedAt = options.now();
    const recallText = recentTurns.map((turn) => turn.text).join("\n");
    const latestUserText = [...recentTurns].reverse().find((turn) => turn.role === "user")?.text ?? "";
    let recalledMemories: MemoryRecord[] = [];
    try {
      recalledMemories = await options.memoryRetriever.retrieve(request.yuiUser, {
        text: recallText,
        now: startedAt.toISOString(),
        scope: inferMemoryScope(latestUserText),
        relatedNames: extractRelatedNames(recallText),
      });
    } catch {
      request.log.warn("Realtime memory retrieval unavailable");
    }
    const context: YuiContext = {
      now: startedAt.toISOString(),
      timeZone: parseTimeZone(request.headers["x-yui-time-zone"]),
      mode: "voice",
      capabilities: ["voice-call", "confirmed-memory", "realtime-audio"],
      userName: formatAddressedName(profile),
      memories: recalledMemories.map((memory) => memory.content),
      recentTurns,
    };
    const session: RealtimeSession = {
      type: "realtime",
      model: options.realtimeModel,
      instructions: [
        buildCharacterInstructions({ ...context, recentTurns }, ZUNDAMON_CHARACTER),
        "通話開始は、直近会話があればその話題を一つだけ自然に引き継ぎ、なければ現在の時間帯に合う短い挨拶と答えやすい質問一つにします。自己紹介、話題メニュー、サービス案内はしません。",
        "音声の返答は、まず短い一文で応じてから必要な説明を続けます。最初の一文は目安40文字以内にし、自然な句点で区切ります。",
        "音声通話は最長30分です。終了時刻が近づいたら、必要なら自然に区切ってください。",
        "通話中にユーザーから覚えてほしいと頼まれたら、返答を作る前に必ず remember_pending を呼びます。保存処理は通話が終わったあとに行われます。ツール結果は pending だけで保存成功ではありません。この通話中は成功を確認できないため、「覚えた」「保存した」とは言いません。依頼内容を短く確認するだけにします。",
      ].join("\n"),
      output_modalities: options.zundamonEnabled ? ["text"] : ["audio"],
      audio: {
        input: {
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: "ja",
          },
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: true,
            silence_duration_ms: 700,
          },
        },
        ...(options.zundamonEnabled ? {} : {output: { voice: "marin" as const }}),
      },
      tools: [{
        type: "function",
        name: "remember_pending",
        description: "ユーザーが覚えてほしいと明示した内容を、終話後の保存待ちとして記録します。保存完了は示しません。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      tool_choice: "auto",
    };
    let result: RealtimeCallResult;
    let reservation: CostReservation | undefined;
    try {
      reservation = await options.costGuard.reserve({
        user: request.yuiUser,
        requestId: `realtime:${sessionId}`,
        feature: "realtime",
        maximumUsd: options.maximumUsd,
      });
      result = await options.realtimeGateway.createCall({ offerSdp, session });
    } catch (error) {
      if (reservation) await reservation.hold().catch(() => undefined);
      if (error instanceof CostLimitError) {
        return reply.code(429).send({ error: "usage_limit_reached" });
      }
      if (error instanceof RealtimeGatewayError) {
        request.log.error(
          { requestId: error.requestId ?? "unavailable" },
          "OpenAI realtime call failed",
        );
        const statusCode = error.kind === "timeout" ? 504 : 502;
        const message =
          error.kind === "timeout"
            ? "Realtime service timed out"
            : "Realtime service is unavailable";
        return reply.code(statusCode).send({ error: message });
      }
      throw error;
    }

    return reply.header("X-Yui-Voice-Provider", options.zundamonEnabled ? "zundamon" : "marin").code(201).type("application/sdp").send(result.sdp);
  });
}
