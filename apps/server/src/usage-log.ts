import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RequestUser } from "./request-user.js";
import { CostLimitError, type CostGuard } from "./cost-guard.js";
import type { WriteGate } from "./write-gate.js";

export const USAGE_PRICING = {
  asOf: "2026-08-08",
  realtime: {
    model: "gpt-realtime-2.1-mini",
    referenceUrl:
      "https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini",
    inputTextUsdPerMillion: 0.6,
    cachedInputTextUsdPerMillion: 0.06,
    outputTextUsdPerMillion: 2.4,
    inputAudioUsdPerMillion: 10,
    cachedInputAudioUsdPerMillion: 0.3,
    outputAudioUsdPerMillion: 20,
  },
  memory: {
    model: "gpt-5.6-luna",
    referenceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 1.25,
    outputUsdPerMillion: 6,
  },
  chat: {
    model: "gpt-5.6-luna",
    referenceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 1.25,
    outputUsdPerMillion: 6,
  },
  asr: {
    model: "gpt-4o-mini-transcribe",
    referenceUrl:
      "https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe",
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 5,
  },
} as const;

export type UsageInput = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  inputTextTokens?: number;
  outputTextTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  cachedInputTextTokens?: number;
  cachedInputAudioTokens?: number;
  memoryInputTokens?: number;
  memoryOutputTokens?: number;
  memoryCachedInputTokens?: number;
  memoryCacheWriteTokens?: number;
  chatInputTokens?: number;
  chatCachedInputTokens?: number;
  chatCacheWriteTokens?: number;
  chatOutputTokens?: number;
  asrInputAudioTokens?: number;
  asrInputTextTokens?: number;
  asrOutputTokens?: number;
};

export type UsageRow = Required<UsageInput> & {
  userId: string;
  estimatedRealtimeUsd: number;
  estimatedMemoryUsd: number;
  estimatedChatUsd: number;
  estimatedAsrUsd: number;
  estimatedUsd: number;
};

export function toUsageRow(user: RequestUser, input: UsageInput): UsageRow {
  const inputTextTokens = input.inputTextTokens ?? 0;
  const outputTextTokens = input.outputTextTokens ?? 0;
  const inputAudioTokens = input.inputAudioTokens ?? 0;
  const outputAudioTokens = input.outputAudioTokens ?? 0;
  const cachedInputTextTokens = input.cachedInputTextTokens ?? 0;
  const cachedInputAudioTokens = input.cachedInputAudioTokens ?? 0;
  const memoryInputTokens = input.memoryInputTokens ?? 0;
  const memoryOutputTokens = input.memoryOutputTokens ?? 0;
  const memoryCachedInputTokens = input.memoryCachedInputTokens ?? 0;
  const memoryCacheWriteTokens = input.memoryCacheWriteTokens ?? 0;
  const chatInputTokens = input.chatInputTokens ?? 0;
  const chatCachedInputTokens = input.chatCachedInputTokens ?? 0;
  const chatCacheWriteTokens = input.chatCacheWriteTokens ?? 0;
  const chatOutputTokens = input.chatOutputTokens ?? 0;
  const asrInputAudioTokens = input.asrInputAudioTokens ?? 0;
  const asrInputTextTokens = input.asrInputTextTokens ?? 0;
  const asrOutputTokens = input.asrOutputTokens ?? 0;

  const estimatedRealtimeUsd = roundUsd(
    (inputTextTokens * USAGE_PRICING.realtime.inputTextUsdPerMillion +
      outputTextTokens * USAGE_PRICING.realtime.outputTextUsdPerMillion +
      inputAudioTokens * USAGE_PRICING.realtime.inputAudioUsdPerMillion +
      outputAudioTokens * USAGE_PRICING.realtime.outputAudioUsdPerMillion +
      cachedInputTextTokens *
        USAGE_PRICING.realtime.cachedInputTextUsdPerMillion +
      cachedInputAudioTokens *
        USAGE_PRICING.realtime.cachedInputAudioUsdPerMillion) /
      1_000_000,
  );
  const estimatedMemoryUsd = roundUsd(
    (memoryInputTokens * USAGE_PRICING.memory.inputUsdPerMillion +
      memoryOutputTokens * USAGE_PRICING.memory.outputUsdPerMillion +
      memoryCachedInputTokens * USAGE_PRICING.memory.cachedInputUsdPerMillion +
      memoryCacheWriteTokens * USAGE_PRICING.memory.cacheWriteUsdPerMillion) /
      1_000_000,
  );
  const estimatedAsrUsd = roundUsd(
    ((asrInputAudioTokens + asrInputTextTokens) *
      USAGE_PRICING.asr.inputUsdPerMillion +
      asrOutputTokens * USAGE_PRICING.asr.outputUsdPerMillion) /
      1_000_000,
  );
  const estimatedChatUsd = roundUsd(
    (chatInputTokens * USAGE_PRICING.chat.inputUsdPerMillion +
      chatCachedInputTokens * USAGE_PRICING.chat.cachedInputUsdPerMillion +
      chatCacheWriteTokens * USAGE_PRICING.chat.cacheWriteUsdPerMillion +
      chatOutputTokens * USAGE_PRICING.chat.outputUsdPerMillion) /
      1_000_000,
  );

  return {
    userId: user.userId,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    inputTextTokens,
    outputTextTokens,
    inputAudioTokens,
    outputAudioTokens,
    cachedInputTextTokens,
    cachedInputAudioTokens,
    memoryInputTokens,
    memoryOutputTokens,
    memoryCachedInputTokens,
    memoryCacheWriteTokens,
    chatInputTokens,
    chatCachedInputTokens,
    chatCacheWriteTokens,
    chatOutputTokens,
    asrInputAudioTokens,
    asrInputTextTokens,
    asrOutputTokens,
    estimatedRealtimeUsd,
    estimatedMemoryUsd,
    estimatedChatUsd,
    estimatedAsrUsd,
    estimatedUsd: roundUsd(
      estimatedRealtimeUsd + estimatedMemoryUsd + estimatedChatUsd + estimatedAsrUsd,
    ),
  };
}

export type UsageLog = {
  append(user: RequestUser, input: UsageInput): Promise<void>;
};

const tokenCountSchema = z.number().int().nonnegative();
const usageInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  inputTextTokens: tokenCountSchema.optional(),
  outputTextTokens: tokenCountSchema.optional(),
  inputAudioTokens: tokenCountSchema.optional(),
  outputAudioTokens: tokenCountSchema.optional(),
  cachedInputTextTokens: tokenCountSchema.optional(),
  cachedInputAudioTokens: tokenCountSchema.optional(),
  memoryInputTokens: tokenCountSchema.optional(),
  memoryOutputTokens: tokenCountSchema.optional(),
  memoryCachedInputTokens: tokenCountSchema.optional(),
  memoryCacheWriteTokens: tokenCountSchema.optional(),
  chatInputTokens: tokenCountSchema.optional(),
  chatCachedInputTokens: tokenCountSchema.optional(),
  chatCacheWriteTokens: tokenCountSchema.optional(),
  chatOutputTokens: tokenCountSchema.optional(),
  asrInputAudioTokens: tokenCountSchema.optional(),
  asrInputTextTokens: tokenCountSchema.optional(),
  asrOutputTokens: tokenCountSchema.optional(),
});

export function registerUsageRoute(
  app: FastifyInstance,
  usageLog: UsageLog,
  costGuard: CostGuard,
  realtimeMaximumUsd: number,
  writeGate?: WriteGate,
): void {
  app.post("/api/usage", async (request, reply) => {
    const parsed = usageInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid usage event" });
    }
    const lease = writeGate?.enter("background_job") ?? (writeGate ? null : { release() {} });
    if (!lease) return reply.code(503).send({ error: "maintenance" });

    try {
      await usageLog.append(request.yuiUser, parsed.data);
      const row = toUsageRow(request.yuiUser, parsed.data);
      const reservation = await costGuard.reserve({
        user: request.yuiUser,
        requestId: `realtime:${parsed.data.sessionId}`,
        feature: "realtime",
        maximumUsd: realtimeMaximumUsd,
      });
      await reservation.settle(row.estimatedRealtimeUsd + row.estimatedAsrUsd);
      return reply.code(202).send();
    } catch (error) {
      if (error instanceof CostLimitError) {
        return reply.code(429).send({ error: "usage_limit_reached" });
      }
      request.log.error(
        { sessionId: parsed.data.sessionId },
        "Usage log append failed",
      );
      return reply.code(503).send({ error: "Usage log is unavailable" });
    } finally {
      lease.release();
    }
  });
}

export function createNdjsonUsageLog(path: string): UsageLog {
  let pending: Promise<void> = Promise.resolve();

  return {
    append(user, input) {
      const write = pending.then(async () => {
        const row = toUsageRow(user, input);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(row)}\n`, {
          encoding: "utf8",
          flag: "a",
        });
      });
      pending = write.catch(() => undefined);
      return write;
    },
  };
}

export function createDiscardingUsageLog(): UsageLog {
  return { append: async () => undefined };
}

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}
