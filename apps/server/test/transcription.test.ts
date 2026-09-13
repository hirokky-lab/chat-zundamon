import OpenAI from "openai";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { buildApp, type BuildAppOptions } from "../src/app";
import {
  createOpenAITranscriptionGateway,
  OpenAITranscriptionGateway,
  TranscriptionGatewayError,
  type TranscriptionGateway,
} from "../src/transcription";
import { CostLimitError } from "../src/cost-guard";

const audioBytes = Buffer.from("not-real-audio");

function multipart(
  fieldName: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): { contentType: string; body: Buffer } {
  const boundary = "----yui-transcription-boundary";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function emptyMultipart(): { contentType: string; body: Buffer } {
  const boundary = "----yui-empty-boundary";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(`--${boundary}--\r\n`),
  };
}

function multipartFiles(files: Array<{ fieldName: string; bytes: Uint8Array; filename: string; mimeType: string }>): {
  contentType: string;
  body: Buffer;
} {
  const boundary = "----yui-many-files-boundary";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      ...files.flatMap(({ fieldName, bytes, filename, mimeType }) => [
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
        bytes,
        Buffer.from("\r\n"),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}

function incompleteMultipartFile(
  fieldName: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): { contentType: string; body: Buffer } {
  const boundary = "----yui-incomplete-boundary";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      bytes,
    ]),
  };
}

async function completesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("operation did not complete")), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildTranscriptionApp(options: BuildAppOptions): ReturnType<typeof buildApp> {
  return buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, ...options });
}

function fakeGateway(
  result: Awaited<ReturnType<TranscriptionGateway["transcribe"]>>,
): TranscriptionGateway {
  return { transcribe: vi.fn(async () => result) };
}

describe("OpenAITranscriptionGateway", () => {
  it("uses the fixed transcription model with a typed audio file", async () => {
    const create = vi.fn(async () => ({
      text: "今日は休み",
      _request_id: "req_transcription",
      usage: {
        type: "tokens",
        input_tokens: 13,
        output_tokens: 4,
        input_token_details: { audio_tokens: 10, text_tokens: 3 },
      },
    }));
    const gateway = new OpenAITranscriptionGateway({ audio: { transcriptions: { create } } });

    const result = await gateway.transcribe({
      audio: audioBytes,
      mimeType: "audio/webm",
      signal: new AbortController().signal,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini-transcribe" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      text: "今日は休み",
      requestId: "req_transcription",
      usage: { asrInputAudioTokens: 10, asrInputTextTokens: 3, asrOutputTokens: 4 },
    });
  });

  it("redacts upstream errors and maps SDK timeouts", async () => {
    const upstream = new OpenAITranscriptionGateway({
      audio: { transcriptions: { create: async () => { throw new Error("OPENAI_API_KEY=secret"); } } },
    });
    const timeout = new OpenAITranscriptionGateway({
      audio: { transcriptions: { create: async () => { throw new OpenAI.APIConnectionTimeoutError(); } } },
    });
    const input = { audio: audioBytes, mimeType: "audio/webm" as const, signal: new AbortController().signal };

    await expect(upstream.transcribe(input)).rejects.toEqual(new TranscriptionGatewayError("upstream"));
    await expect(timeout.transcribe(input)).rejects.toEqual(new TranscriptionGatewayError("timeout"));
  });

  it("does not invent ASR token counts from duration-only SDK usage", async () => {
    const gateway = new OpenAITranscriptionGateway({
      audio: {
        transcriptions: {
          create: async () => ({
            text: "今日は休み",
            usage: { type: "duration", seconds: 1.2 },
          }),
        },
      },
    });

    await expect(gateway.transcribe({
      audio: audioBytes,
      mimeType: "audio/webm",
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: "今日は休み", requestId: undefined, usage: undefined });
  });

  it("derives missing text tokens from total tokens when audio detail is present", async () => {
    const gateway = new OpenAITranscriptionGateway({
      audio: {
        transcriptions: {
          create: async () => ({
            text: "今日は休み",
            usage: {
              type: "tokens",
              input_tokens: 13,
              output_tokens: 4,
              input_token_details: { audio_tokens: 10 },
            },
          }),
        },
      },
    });

    await expect(gateway.transcribe({
      audio: audioBytes,
      mimeType: "audio/webm",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      usage: { asrInputAudioTokens: 10, asrInputTextTokens: 3, asrOutputTokens: 4 },
    });
  });

  it("derives missing audio tokens from total tokens when text detail is present", async () => {
    const gateway = new OpenAITranscriptionGateway({
      audio: {
        transcriptions: {
          create: async () => ({
            text: "今日は休み",
            usage: {
              type: "tokens",
              input_tokens: 13,
              output_tokens: 4,
              input_token_details: { text_tokens: 3 },
            },
          }),
        },
      },
    });

    await expect(gateway.transcribe({
      audio: audioBytes,
      mimeType: "audio/webm",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      usage: { asrInputAudioTokens: 10, asrInputTextTokens: 3, asrOutputTokens: 4 },
    });
  });

  it("omits token usage when the total is lower than known detail", async () => {
    const gateway = new OpenAITranscriptionGateway({
      audio: {
        transcriptions: {
          create: async () => ({
            text: "今日は休み",
            usage: {
              type: "tokens",
              input_tokens: 9,
              output_tokens: 4,
              input_token_details: { audio_tokens: 10 },
            },
          }),
        },
      },
    });

    await expect(gateway.transcribe({
      audio: audioBytes,
      mimeType: "audio/webm",
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: "今日は休み", requestId: undefined, usage: undefined });
  });
});

describe("transcription production configuration", () => {
  it("turns off SDK logging even when OPENAI_LOG is set", () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const gateway = createOpenAITranscriptionGateway({ apiKey: "test-key" }) as unknown as {
      client: { logLevel: string };
    };

    expect(gateway.client.logLevel).toBe("off");
    vi.unstubAllEnvs();
  });
});

describe("transcription route", () => {
  it("returns a neutral limit response before transcribing valid audio", async () => {
    const gateway = fakeGateway({ text: "unused" });
    const app = buildTranscriptionApp({
      transcriptionGateway: gateway,
      costGuard: { reserve: async () => { throw new CostLimitError(); } },
    });
    const payload = multipart("audio", audioBytes, "voice.webm", "audio/webm");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "usage_limit_reached" });
    expect(gateway.transcribe).not.toHaveBeenCalled();
  });

  it("returns a transcript without logging it and marks the response private", async () => {
    const logLines: string[] = [];
    const app = buildTranscriptionApp({
      logger: { level: "info", stream: { write: (line: string) => logLines.push(line) } },
      transcriptionGateway: fakeGateway({ text: "今日は休み" }),
    });
    const payload = multipart("audio", audioBytes, "voice.webm", "audio/webm");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "今日は休み" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(logLines.join("\n")).not.toContain("今日は休み");
  });

  it.each([
    ["no file", emptyMultipart(), 400],
    ["wrong field", multipart("clip", audioBytes, "voice.webm", "audio/webm"), 400],
    ["unsupported MIME", multipart("audio", audioBytes, "voice.ogg", "audio/ogg"), 415],
    ["empty audio", multipart("audio", Buffer.alloc(0), "voice.webm", "audio/webm"), 400],
  ])("rejects $0 without calling the gateway", async (_name, payload, status) => {
    const gateway = fakeGateway({ text: "must not be sent" });
    const app = buildTranscriptionApp({ transcriptionGateway: gateway });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(gateway.transcribe).not.toHaveBeenCalled();
  });

  it("rejects audio over the ten-megabyte limit", async () => {
    const app = buildTranscriptionApp({ transcriptionGateway: fakeGateway({ text: "unused" }) });
    const payload = multipart("audio", Buffer.alloc(10 * 1024 * 1024 + 1), "voice.webm", "audio/webm");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects a second multipart file instead of transcribing either upload", async () => {
    const gateway = fakeGateway({ text: "unused" });
    const app = buildTranscriptionApp({ transcriptionGateway: gateway });
    const payload = multipartFiles([
      { fieldName: "audio", bytes: audioBytes, filename: "voice.webm", mimeType: "audio/webm" },
      { fieldName: "audio", bytes: audioBytes, filename: "voice-2.webm", mimeType: "audio/webm" },
    ]);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(400);
    expect(gateway.transcribe).not.toHaveBeenCalled();
  });

  it("rejects a non-multipart request without treating it as an upstream failure", async () => {
    const gateway = fakeGateway({ text: "unused" });
    const app = buildTranscriptionApp({ transcriptionGateway: gateway });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(gateway.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    [new TranscriptionGatewayError("upstream", "req_upstream"), 502, "Transcription service is unavailable"],
    [new TranscriptionGatewayError("timeout", "req_timeout"), 504, "Transcription service timed out"],
    [new Error("OPENAI_API_KEY=secret; upstream body"), 502, "Transcription service is unavailable"],
  ] as const)("returns a safe %s failure", async (failure, status, message) => {
    const app = buildTranscriptionApp({
      transcriptionGateway: { transcribe: async () => { throw failure; } },
    });
    const payload = multipart("audio", audioBytes, "voice.webm", "audio/webm");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: message });
    expect(response.body).not.toContain("req_");
    expect(response.body).not.toContain("OPENAI_API_KEY");
  });

  it("rejects an empty transcript", async () => {
    const app = buildTranscriptionApp({ transcriptionGateway: fakeGateway({ text: "  " }) });
    const payload = multipart("audio", audioBytes, "voice.webm", "audio/webm");

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Transcription service is unavailable" });
  });

  it("logs only a safe upstream request ID", async () => {
    const logLines: string[] = [];
    const app = buildTranscriptionApp({
      logger: { level: "error", stream: { write: (line: string) => logLines.push(line) } },
      transcriptionGateway: {
        transcribe: async () => {
          throw new TranscriptionGatewayError("upstream", "req_only_this_is_safe");
        },
      },
    });
    const payload = multipart("audio", Buffer.from("SECRET_AUDIO"), "voice.webm", "audio/webm");

    await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    expect(logLines.join("\n")).toContain("req_only_this_is_safe");
    expect(logLines.join("\n")).not.toContain("SECRET_AUDIO");
  });

  it("records only existing ASR usage fields", async () => {
    const append = vi.fn(async () => undefined);
    const app = buildTranscriptionApp({
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      usageLog: { append },
      transcriptionGateway: fakeGateway({
        text: "今日は休み",
        usage: { asrInputAudioTokens: 10, asrInputTextTokens: 3, asrOutputTokens: 4 },
      }),
    });
    const payload = multipart("audio", audioBytes, "voice.webm", "audio/webm");

    await app.inject({
      method: "POST",
      url: "/api/chat/transcriptions",
      headers: { "content-type": payload.contentType },
      payload: payload.body,
    });

    const logged = append.mock.calls[0]?.[1];
    expect(logged).toMatchObject({
      sessionId: expect.stringMatching(/^asr:/),
      asrInputAudioTokens: 10,
      asrInputTextTokens: 3,
      asrOutputTokens: 4,
    });
    expect(JSON.stringify(logged)).not.toContain("今日は休み");
    expect(JSON.stringify(logged)).not.toContain("voice.webm");
    expect(JSON.stringify(logged)).not.toContain(String(audioBytes.byteLength));
  });

  it("aborts transcription after the client closes its response socket", async () => {
    let gatewayStarted: (() => void) | undefined;
    let gatewayCancelled = false;
    const started = new Promise<void>((resolve) => { gatewayStarted = resolve; });
    const app = buildTranscriptionApp({
      transcriptionGateway: {
        transcribe: async ({ signal }) => new Promise((_, reject) => {
          gatewayStarted?.();
          signal.addEventListener("abort", () => {
            gatewayCancelled = true;
            reject(new TranscriptionGatewayError("timeout"));
          }, { once: true });
        }),
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(address);
    const payload = multipart("audio", audioBytes, "voice.webm", "audio/webm");
    try {
      const request = httpRequest({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        path: "/api/chat/transcriptions",
        method: "POST",
        headers: {
          "content-type": payload.contentType,
          "content-length": String(payload.body.byteLength),
        },
      });
      request.on("error", () => undefined);
      request.end(payload.body);

      await started;
      request.destroy();
      await vi.waitFor(() => expect(gatewayCancelled).toBe(true));
    } finally {
      await app.close();
    }
  });

  it("finishes cleanup when a rejected upload socket closes before its file stream ends", async () => {
    const app = buildTranscriptionApp({ transcriptionGateway: fakeGateway({ text: "unused" }) });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(address);
    const payload = incompleteMultipartFile(
      "clip",
      Buffer.alloc(1024, 1),
      "voice.webm",
      "audio/webm",
    );
    let closed = false;
    try {
      const request = httpRequest({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        path: "/api/chat/transcriptions",
        method: "POST",
        headers: {
          "content-type": payload.contentType,
          "content-length": String(payload.body.byteLength + 1024),
        },
      });
      request.on("error", () => undefined);
      request.write(payload.body);
      await new Promise((resolve) => setTimeout(resolve, 25));
      request.destroy();

      await completesWithin(app.close(), 1_000);
      closed = true;
    } finally {
      if (!closed) await app.close();
    }
  });
});
