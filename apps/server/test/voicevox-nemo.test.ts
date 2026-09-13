import { describe, expect, it } from "vitest";
import { TtsProviderError } from "../src/tts";
import { createVoicevoxNemoProvider } from "../src/voicevox-nemo";
import { loadConfig } from "../src/config";

const speakers = [{
  name: "女声2",
  speaker_uuid: "nemo-female-2",
  styles: [{ id: 42, name: "ノーマル", type: "talk" }],
}];

function minimalWav(): Uint8Array {
  return new Uint8Array([
    82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69,
    102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0,
    192, 93, 0, 0, 128, 187, 0, 0, 2, 0, 16, 0,
    100, 97, 116, 97, 0, 0, 0, 0,
  ]);
}

function response(body: BodyInit, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(fixture: typeof speakers | (() => typeof speakers) = speakers) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({ url, init });
    if (url.pathname === "/version") return response("0.24.0");
    if (url.pathname === "/speakers") return response(JSON.stringify(typeof fixture === "function" ? fixture() : fixture));
    if (url.pathname === "/audio_query") return response('{"accent_phrases":[]}');
    if (url.pathname === "/synthesis") return new Response(
      minimalWav(),
      { headers: { "content-type": "audio/wav" } },
    );
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  return { calls, fetch };
}

function provider(
  fetch: typeof globalThis.fetch,
  now = () => 0,
  baseUrls = ["http://127.0.0.1:50121", "http://127.0.0.1:50021"],
) {
  return createVoicevoxNemoProvider({
    baseUrls,
    fetch,
    now,
    statusTimeoutMs: 2_000,
    queryTimeoutMs: 5_000,
    synthesisTimeoutMs: 15_000,
  });
}

describe("VoicevoxNemoProvider", () => {
  it("probes Nemo 女声2 on 50121 with 接続確認 and caches a successful status for 60 seconds", async () => {
    let time = 1_000;
    const fake = fakeFetch();
    const subject = provider(fake.fetch as typeof globalThis.fetch, () => time);

    await expect(subject.status()).resolves.toEqual({
      available: true,
      provider: "voicevox-nemo",
      voiceLabel: "女性2",
    });
    expect(fake.calls.map(({ url }) => url.pathname)).toEqual([
      "/version", "/speakers", "/audio_query", "/synthesis",
    ]);
    expect(fake.calls[0]?.url.toString()).toContain("127.0.0.1:50121/version");
    expect(fake.calls[2]?.url.searchParams.get("text")).toBe("接続確認");
    expect(fake.calls[2]?.url.searchParams.get("speaker")).toBe("42");
    expect(fake.calls[3]?.url.searchParams.get("speaker")).toBe("42");

    time += 59_999;
    await subject.status();
    expect(fake.calls).toHaveLength(4);
  });

  it("synthesizes only in memory using the discovered style ID instead of a fixed numeric ID", async () => {
    const fake = fakeFetch([{ ...speakers[0], styles: [{ id: 731, name: "ノーマル", type: "talk" }] }]);
    const subject = provider(fake.fetch as typeof globalThis.fetch);

    await expect(subject.synthesize({ text: "本文は保存しない", requestId: "turn:1" })).resolves.toEqual({
      audio: minimalWav(),
      contentType: "audio/wav",
    });
    expect(fake.calls.map(({ url }) => url.pathname)).toEqual(["/version", "/speakers", "/audio_query", "/synthesis"]);
    expect(fake.calls[2]?.url.searchParams.get("speaker")).toBe("731");
    expect(fake.calls[3]?.url.searchParams.get("speaker")).toBe("731");
  });

  it("selects an exact 女声2 ノーマル style even when VOICEVOX reports a non-talk type", async () => {
    const fake = fakeFetch([{
      ...speakers[0],
      styles: [{ id: 919, name: "ノーマル", type: "sing" }],
    }]);

    await expect(provider(fake.fetch as typeof globalThis.fetch).synthesize({ text: "本文", requestId: "id" }))
      .resolves.toMatchObject({ contentType: "audio/wav" });
    expect(fake.calls[2]?.url.searchParams.get("speaker")).toBe("919");
    expect(fake.calls[3]?.url.searchParams.get("speaker")).toBe("919");
  });

  it.each([
    ["missing", []],
    ["missing a normal style", [{ ...speakers[0], styles: [{ id: 43, name: "ハミング", type: "sing" }] }]],
  ])("returns voice-not-found when 女声2 is %s", async (_case, fixture) => {
    const fake = fakeFetch(fixture);
    await expect(provider(fake.fetch as typeof globalThis.fetch).status()).rejects.toMatchObject({
      kind: "voice-not-found",
    } satisfies Partial<TtsProviderError>);
  });

  it("uses an explicit endpoint first and removes duplicate candidate URLs", async () => {
    const fake = fakeFetch();
    await provider(
      fake.fetch as typeof globalThis.fetch,
      () => 0,
      ["http://127.0.0.1:50021", "http://127.0.0.1:50121", "http://127.0.0.1:50021"],
    ).status();

    expect(fake.calls.map(({ url }) => url.origin)).toEqual([
      "http://127.0.0.1:50021", "http://127.0.0.1:50021",
      "http://127.0.0.1:50021", "http://127.0.0.1:50021",
    ]);
  });

  it("continues from the standard engine on 50121 to the Nemo endpoint on 50021", async () => {
    const calls: URL[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      calls.push(url);
      if (url.pathname === "/version") return response("0.24.0");
      if (url.pathname === "/speakers") return response(JSON.stringify(
        url.port === "50121" ? [{ name: "ずんだもん", styles: [{ id: 3, name: "ノーマル" }] }] : speakers,
      ));
      if (url.pathname === "/audio_query") return response("{}");
      return new Response(minimalWav(), { headers: { "content-type": "audio/wav" } });
    };

    await expect(provider(fetch as typeof globalThis.fetch).status()).resolves.toMatchObject({ available: true });
    expect(calls.map((url) => `${url.port}${url.pathname}`)).toEqual([
      "50121/version", "50121/speakers", "50021/version", "50021/speakers",
      "50021/audio_query", "50021/synthesis",
    ]);
  });

  it("does not select a similarly named voice or a non-normal style", async () => {
    const fixture = [
      { name: "女性2", styles: [{ id: 42, name: "ノーマル" }] },
      { name: "女声2", styles: [{ id: 43, name: "あまあま" }] },
    ];
    const fake = fakeFetch(fixture as typeof speakers);

    await expect(provider(fake.fetch as typeof globalThis.fetch).status()).rejects.toMatchObject({
      kind: "voice-not-found",
    } satisfies Partial<TtsProviderError>);
  });

  it("invalidates a cached endpoint after synthesis fails and rediscovers only once", async () => {
    let synthesisCalls = 0;
    const calls: URL[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      calls.push(url);
      if (url.pathname === "/version") return response("0.24.0");
      if (url.pathname === "/speakers") return response(JSON.stringify(speakers));
      if (url.pathname === "/audio_query") return response("{}");
      synthesisCalls += 1;
      if (synthesisCalls === 2) return new Response("failed", { status: 500 });
      return new Response(minimalWav(), { headers: { "content-type": "audio/wav" } });
    };
    const subject = provider(fetch as typeof globalThis.fetch);

    await subject.status();
    await expect(subject.synthesize({ text: "本文", requestId: "id" })).resolves.toMatchObject({ contentType: "audio/wav" });
    expect(calls.filter((url) => url.pathname === "/speakers")).toHaveLength(2);
    expect(calls.filter((url) => url.pathname === "/synthesis")).toHaveLength(3);
  });

  it.each([
    [new TypeError("fetch failed"), undefined, "unavailable"],
    [new Error("connect ECONNREFUSED 127.0.0.1"), undefined, "unavailable"],
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), undefined, "timeout"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), undefined, "timeout"],
    [Object.assign(new Error("caller cancelled"), { name: "AbortError" }), AbortSignal.abort(), "cancelled"],
  ] as const)("normalizes provider failures without exposing upstream messages", async (failure, signal, kind) => {
    const fetch = async () => { throw failure; };
    await expect(provider(fetch as typeof globalThis.fetch).status(signal)).rejects.toMatchObject({ kind });
  });

  it("cancels an unsuccessful upstream response without reading or logging its body", async () => {
    const upstreamSecret = "UPSTREAM-ERROR-DO-NOT-LEAK";
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => { cancelled = true; },
    });
    const fetch = async () => new Response(body, { status: 500 });
    const logLines: string[] = [];
    const originalError = console.error;
    console.error = (...values: unknown[]) => logLines.push(values.join(" "));
    try {
      await expect(provider(fetch as typeof globalThis.fetch, () => 0, ["http://127.0.0.1:50121"]).status())
        .rejects.toMatchObject({ kind: "upstream" });
    } finally {
      console.error = originalError;
    }
    expect(cancelled).toBe(true);
    expect(logLines.join("\n")).not.toContain(upstreamSecret);
  });

  it("expires the resolved voice with the status cache and discovers a replacement style", async () => {
    let time = 0;
    let activeStyle = 42;
    const fake = fakeFetch(() => [{ ...speakers[0], styles: [{ id: activeStyle, name: "ノーマル", type: "talk" }] }]);
    const subject = provider(fake.fetch as typeof globalThis.fetch, () => time);

    await subject.status();
    activeStyle = 731;
    time = 60_001;
    await subject.status();

    expect(fake.calls.filter(({ url }) => url.pathname === "/speakers")).toHaveLength(2);
    expect(fake.calls.at(-1)?.url.searchParams.get("speaker")).toBe("731");
  });

  it("rejects malformed, oversized, and non-WAV upstream payloads without retaining them", async () => {
    const responses = [
      response("0.24.0"),
      response(JSON.stringify(speakers)),
      new Response('{"private":true}', { headers: { "content-type": "text/plain" } }),
    ];
    const fetch = async () => responses.shift()!;
    await expect(provider(fetch as typeof globalThis.fetch).synthesize({ text: "本文", requestId: "id" }))
      .rejects.toMatchObject({ kind: "upstream" });

    const oversized = new Response(new Uint8Array([82, 73, 70, 70]), {
      headers: { "content-type": "audio/wav", "content-length": "999999999" },
    });
    const retry = [response("0.24.0"), response(JSON.stringify(speakers)), response("{}"), oversized];
    await expect(provider((async () => retry.shift()!) as typeof globalThis.fetch).synthesize({ text: "本文", requestId: "id" }))
      .rejects.toMatchObject({ kind: "upstream" });
  });

  it.each([
    ["application/jsonx", "audio/wav"],
    ["application/json; charset=utf-8", "audio/wavx"],
  ])("accepts Content-Type parameters but rejects lookalike media types: %s / %s", async (queryType, wavType) => {
    const responses = [
      response("0.24.0"), response(JSON.stringify(speakers)),
      new Response("{}", { headers: { "content-type": queryType } }),
      new Response(minimalWav(), { headers: { "content-type": wavType } }),
    ];
    await expect(provider((async () => responses.shift()!) as typeof globalThis.fetch)
      .synthesize({ text: "本文", requestId: "id" })).rejects.toMatchObject({ kind: "upstream" });
  });

  it("accepts exact media types with Content-Type parameters", async () => {
    const responses = [
      response("0.24.0"), response(JSON.stringify(speakers)),
      new Response("{}", { headers: { "content-type": "application/json; charset=utf-8" } }),
      new Response(minimalWav(), { headers: { "content-type": "audio/wav; codec=pcm" } }),
    ];
    await expect(provider((async () => responses.shift()!) as typeof globalThis.fetch)
      .synthesize({ text: "本文", requestId: "id" })).resolves.toEqual({
        audio: minimalWav(), contentType: "audio/wav",
      });
  });

  it.each([
    ["truncated RIFF header", new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])],
    ["declared file size mismatch", (() => { const wav = minimalWav(); wav[4] = 35; return wav; })()],
    ["data chunk extending past the file", (() => { const wav = minimalWav(); wav[40] = 1; return wav; })()],
  ])("rejects malformed WAV data: %s", async (_name, wav) => {
    const responses = [
      response("0.24.0"), response(JSON.stringify(speakers)), response("{}"),
      new Response(wav, { headers: { "content-type": "audio/wav" } }),
    ];
    await expect(provider((async () => responses.shift()!) as typeof globalThis.fetch)
      .synthesize({ text: "本文", requestId: "id" })).rejects.toMatchObject({ kind: "upstream" });
  });

  it("cancels a streamed WAV that exceeds the hard byte cap despite a small content length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16_000_001));
      },
      cancel() { cancelled = true; },
    });
    const responses = [
      response("0.24.0"), response(JSON.stringify(speakers)), response("{}"),
      new Response(body, { headers: { "content-type": "audio/wav", "content-length": "12" } }),
    ];
    await expect(provider((async () => responses.shift()!) as typeof globalThis.fetch)
      .synthesize({ text: "本文", requestId: "id" })).rejects.toMatchObject({ kind: "upstream" });
    expect(cancelled).toBe(true);
  });

  it("bounds the status probe synthesis by the status deadline", async () => {
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/version") return response("0.24.0");
      if (path === "/speakers") return response(JSON.stringify(speakers));
      if (path === "/audio_query") return response("{}");
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const subject = createVoicevoxNemoProvider({
      baseUrls: ["http://127.0.0.1:50121"], fetch: fetch as typeof globalThis.fetch,
      statusTimeoutMs: 5, queryTimeoutMs: 5_000, synthesisTimeoutMs: 15_000,
    });
    await expect(subject.status()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("uses one shrinking two-second budget across version, speakers, query, and synthesis", async () => {
    let time = 0;
    const timeoutBudgets: number[] = [];
    const fetch = async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      time += 500;
      if (path === "/version") return response("0.24.0");
      if (path === "/speakers") return response(JSON.stringify(speakers));
      if (path === "/audio_query") return response("{}");
      return new Response(minimalWav(), { headers: { "content-type": "audio/wav" } });
    };
    const subject = createVoicevoxNemoProvider({
      baseUrls: ["http://127.0.0.1:50121"],
      fetch: fetch as typeof globalThis.fetch,
      now: () => time,
      statusTimeoutMs: 2_000,
      queryTimeoutMs: 5_000,
      synthesisTimeoutMs: 15_000,
      createTimeoutSignal: (milliseconds) => {
        timeoutBudgets.push(milliseconds);
        return new AbortController().signal;
      },
    });

    await expect(subject.status()).resolves.toMatchObject({ available: true });
    expect(timeoutBudgets).toEqual([2_000, 1_500, 1_000, 500]);
  });
});

describe("VOICEVOX production configuration", () => {
  it("allows only credential-free local HTTP endpoints", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test", ZUNDAMON_VOICEVOX_BASE_URL: "http://localhost:50021" }).voicevoxBaseUrls)
      .toEqual(["http://localhost:50021", "http://127.0.0.1:50121", "http://127.0.0.1:50021"]);
    for (const voicevoxBaseUrl of [
      "https://localhost:50021", "http://voicevox.example", "http://192.168.1.2:50021",
      "http://user:password@127.0.0.1:50021",
    ]) {
      expect(() => loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test", ZUNDAMON_VOICEVOX_BASE_URL: voicevoxBaseUrl })).toThrow();
    }
  });
});
