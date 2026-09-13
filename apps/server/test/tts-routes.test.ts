import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { buildApp } from "../src/app";
import { TtsProviderError } from "../src/tts";
import type { TtsProvider } from "../src/tts";

function buildTtsApp(provider: TtsProvider, logger = false) {
  return buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, logger, provider });
}

describe("TTS routes", () => {
  it("returns provider status and hides status failures", async () => {
    const available = buildTtsApp({
      status: async () => ({ available: true, provider: "voicevox-nemo", voiceLabel: "女性2" }),
      synthesize: async () => ({ audio: new Uint8Array(), contentType: "audio/wav" }),
    });
    const unavailable = buildTtsApp({
      status: async () => { throw new Error("VOICEVOX-UPSTREAM-SENTINEL"); },
      synthesize: async () => ({ audio: new Uint8Array(), contentType: "audio/wav" }),
    });

    await expect((await available.inject({ method: "GET", url: "/api/tts/status" })).json()).toEqual({
      available: true, provider: "voicevox-nemo", voiceLabel: "女性2",
    });
    const response = await unavailable.inject({ method: "GET", url: "/api/tts/status" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ available: false });
    expect(response.body).not.toContain("VOICEVOX-UPSTREAM-SENTINEL");
  });

  it("accepts 1 to 160 Unicode code points and returns an in-memory WAV without caching", async () => {
    const received: Array<{ text: string; requestId: string; signal?: AbortSignal }> = [];
    const app = buildTtsApp({
      status: async () => ({ available: false }),
      synthesize: async (input, signal) => {
        received.push({ ...input, signal });
        return { audio: new Uint8Array([87, 65, 86]), contentType: "audio/wav" };
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tts/speech",
      payload: { requestId: "turn:1_a-2", text: "😀".repeat(160) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/wav");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.rawPayload).toEqual(Buffer.from([87, 65, 86]));
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toHaveLength(320);
    expect(received[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(received[0]?.signal?.aborted).toBe(false);
  });

  it.each([
    { requestId: "turn", text: "" },
    { requestId: "turn", text: " ", },
    { requestId: "turn", text: "あ".repeat(161) },
    { requestId: "", text: "本文" },
    { requestId: "x".repeat(129), text: "本文" },
    { requestId: "turn bad", text: "本文" },
    { requestId: "turn/unsafe", text: "本文" },
  ])("rejects invalid speech before calling the provider: %#", async (payload) => {
    let calls = 0;
    const app = buildTtsApp({
      status: async () => ({ available: false }),
      synthesize: async () => { calls += 1; return { audio: new Uint8Array(), contentType: "audio/wav" }; },
    });
    const response = await app.inject({ method: "POST", url: "/api/tts/speech", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid speech request" });
    expect(calls).toBe(0);
  });

  it.each([
    ["unavailable", 503],
    ["voice-not-found", 503],
    ["timeout", 504],
    ["upstream", 502],
  ] as const)("maps %s synthesis errors to %i without exposing private content", async (kind, statusCode) => {
    const textSecret = "TTS-TEXT-DO-NOT-LEAK";
    const upstreamSecret = "TTS-UPSTREAM-DO-NOT-LEAK";
    const app = buildTtsApp({
      status: async () => ({ available: false }),
      synthesize: async () => {
        const error = new TtsProviderError(kind);
        error.message = upstreamSecret;
        throw error;
      },
    });
    const response = await app.inject({
      method: "POST", url: "/api/tts/speech", payload: { requestId: "turn:private", text: textSecret },
    });
    expect(response.statusCode).toBe(statusCode);
    expect(response.body).not.toContain(textSecret);
    expect(response.body).not.toContain(upstreamSecret);
  });

  it("ends a caller-cancelled synthesis without inventing audio or logging text and WAV sentinels", async () => {
    const textSecret = "TEXT-DO-NOT-LOG";
    const wavSecret = "WAV-DO-NOT-LOG";
    const logs: string[] = [];
    const app = buildTtsApp({
      status: async () => ({ available: false }),
      synthesize: async () => { throw new TtsProviderError("cancelled"); },
    }, { level: "info", stream: { write: (line: string) => logs.push(line) } });
    const response = await app.inject({
      method: "POST", url: "/api/tts/speech", payload: { requestId: "turn:cancel", text: textSecret },
    });
    expect(response.statusCode).toBe(499);
    expect(response.body).not.toContain(wavSecret);
    expect(logs.join("\n")).not.toContain(textSecret);
    expect(logs.join("\n")).not.toContain(wavSecret);
  });

  it("aborts the provider after the request body is received when the response socket closes", async () => {
    let providerStarted: (() => void) | undefined;
    let providerCancelled = false;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const app = buildTtsApp({
      status: async () => ({ available: false }),
      synthesize: async (_input, signal) => new Promise((_, reject) => {
        providerStarted?.();
        signal?.addEventListener("abort", () => {
          providerCancelled = true;
          reject(new TtsProviderError("cancelled"));
        }, { once: true });
      }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(address);
    try {
      const request = httpRequest({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        path: "/api/tts/speech",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      request.on("error", () => undefined);
      request.end(JSON.stringify({ requestId: "socket-close", text: "本文は受信済み" }));

      await started;
      request.destroy();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(providerCancelled).toBe(true);
    } finally {
      await app.close();
    }
  });
});
