import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { createNdjsonUsageLog, toUsageRow } from "../src/usage-log";
import { LOCAL_USER } from "../src/request-user";

describe("usage log", () => {
  it("records usage without transcript or API key", () => {
    const row = toUsageRow(LOCAL_USER, {
      sessionId: "session-1",
      startedAt: "2026-08-08T20:00:00+09:00",
      endedAt: "2026-08-08T20:15:00+09:00",
      inputTextTokens: 200,
      outputTextTokens: 100,
      inputAudioTokens: 1200,
      outputAudioTokens: 900,
      memoryInputTokens: 800,
      memoryOutputTokens: 120,
      chatInputTokens: 1_000,
      chatCachedInputTokens: 2_000,
      chatCacheWriteTokens: 3_000,
      chatOutputTokens: 4_000,
    });

    expect(JSON.stringify(row)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(row)).not.toContain("transcript");
    expect(row.estimatedChatUsd).toBe(0.02895);
    expect(row.estimatedUsd).toBeCloseTo(0.06083, 5);
  });

  it("prices cached, memory, and transcription usage without double counting", () => {
    const row = toUsageRow(LOCAL_USER, {
      sessionId: "session-cache",
      startedAt: "2026-08-08T20:00:00+09:00",
      endedAt: "2026-08-08T20:15:00+09:00",
      inputTextTokens: 100,
      outputTextTokens: 100,
      inputAudioTokens: 100,
      outputAudioTokens: 100,
      cachedInputTextTokens: 900,
      cachedInputAudioTokens: 100,
      memoryInputTokens: 100,
      memoryOutputTokens: 100,
      memoryCachedInputTokens: 200,
      memoryCacheWriteTokens: 100,
      asrInputAudioTokens: 100,
      asrInputTextTokens: 10,
      asrOutputTokens: 20,
    });

    expect(row.estimatedRealtimeUsd).toBe(0.003384);
    expect(row.estimatedMemoryUsd).toBe(0.000845);
    expect(row.estimatedAsrUsd).toBe(0.0002375);
    expect(row.estimatedUsd).toBe(0.0044665);
  });

  it("allows only the existing numeric ASR usage fields", () => {
    const row = toUsageRow(LOCAL_USER, {
      sessionId: "asr:request-1",
      startedAt: "2026-08-08T20:00:00+09:00",
      endedAt: "2026-08-08T20:00:01+09:00",
      asrInputAudioTokens: 12,
      asrInputTextTokens: 3,
      asrOutputTokens: 4,
    } as Parameters<typeof toUsageRow>[1] & {
      transcript: string;
      mimeType: string;
      bytes: number;
    });

    expect(Object.keys(row)).not.toContain("transcript");
    expect(Object.keys(row)).not.toContain("mimeType");
    expect(Object.keys(row)).not.toContain("bytes");
  });

  it("appends only sanitized usage rows as NDJSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-usage-"));
    const path = join(directory, "nested", "usage.ndjson");
    const log = createNdjsonUsageLog(path);

    await log.append(LOCAL_USER, {
      sessionId: "session-ndjson",
      startedAt: "2026-08-08T20:00:00+09:00",
      endedAt: "2026-08-08T20:15:00+09:00",
      inputTextTokens: 1,
      transcript: "ログへ保存してはいけない会話",
      apiKey: "OPENAI_API_KEY=secret",
    } as Parameters<typeof log.append>[1] & {
      transcript: string;
      apiKey: string;
    });

    const content = await readFile(path, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content)).toMatchObject({
      userId: LOCAL_USER.userId,
      sessionId: "session-ndjson",
      inputTextTokens: 1,
    });
    expect(content).not.toContain("ログへ保存してはいけない会話");
    expect(content).not.toContain("OPENAI_API_KEY");
    expect(Object.keys(JSON.parse(content))).toEqual([
      "userId", "sessionId", "startedAt", "endedAt",
      "inputTextTokens", "outputTextTokens", "inputAudioTokens", "outputAudioTokens",
      "cachedInputTextTokens", "cachedInputAudioTokens",
      "memoryInputTokens", "memoryOutputTokens", "memoryCachedInputTokens", "memoryCacheWriteTokens",
      "chatInputTokens", "chatCachedInputTokens", "chatCacheWriteTokens", "chatOutputTokens",
      "asrInputAudioTokens", "asrInputTextTokens", "asrOutputTokens",
      "estimatedRealtimeUsd", "estimatedMemoryUsd", "estimatedChatUsd", "estimatedAsrUsd", "estimatedUsd",
    ]);
  });

  it("accepts a sanitized usage event through the server route", async () => {
    const append = vi.fn(async () => undefined);
    const settle = vi.fn(async () => undefined);
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      usageLog: { append },
      costGuard: {
        reserve: async ({ requestId }) => ({
          requestId,
          settle,
          hold: async () => undefined,
        }),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: {
        sessionId: "session-route",
        startedAt: "2026-08-08T20:00:00+09:00",
        endedAt: "2026-08-08T20:15:00+09:00",
        inputTextTokens: 7,
        transcript: "保存してはいけない本文",
        apiKey: "OPENAI_API_KEY=secret",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(append).toHaveBeenCalledWith(LOCAL_USER, {
      sessionId: "session-route",
      startedAt: "2026-08-08T20:00:00+09:00",
      endedAt: "2026-08-08T20:15:00+09:00",
      inputTextTokens: 7,
    });
    expect(JSON.stringify(append.mock.calls)).not.toContain("保存してはいけない本文");
    expect(JSON.stringify(append.mock.calls)).not.toContain("OPENAI_API_KEY");
    expect(settle).toHaveBeenCalledWith(0.0000042);
  });

  it("contains an append failure within the usage endpoint", async () => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [] }) },
      usageLog: {
        append: async () => {
          throw new Error("path contains secret that must not be returned");
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: {
        sessionId: "session-failure",
        startedAt: "2026-08-08T20:00:00+09:00",
        endedAt: "2026-08-08T20:15:00+09:00",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Usage log is unavailable" });
    expect(response.body).not.toContain("secret");
  });
});
