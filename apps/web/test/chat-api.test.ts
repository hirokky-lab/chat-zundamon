import { describe, expect, it, vi } from "vitest";
import type { ChatRequest } from "../src/api";
import { createChatApi, createMemoryApi, createTranscriptionApi } from "../src/api";

function replyFor(clientMessageId: string, texts = ["おかえりなさい"]) {
  const replyGroupId = `${clientMessageId}:assistant`;
  return {
    replyGroupId,
    bubbles: texts.map((text, sequence) => ({
      id: `${replyGroupId}:${sequence}`,
      text,
      createdAt: "2026-08-08T03:00:00.000Z",
      sequence,
    })),
  };
}

const reply = replyFor("message-31");

describe("chat API", () => {
  it("preserves only the safe external-context reply marker", async () => {
    const safe = replyFor("calendar-1");
    safe.bubbles[0] = { ...safe.bubbles[0]!, flow: "external_context" } as typeof safe.bubbles[0];
    await expect(createChatApi(async () => Response.json({ reply: safe })).respond({
      kind: "reply", clientMessageId: "calendar-1", timeline: [],
    })).resolves.toEqual(safe);

    const unsafe = replyFor("calendar-2") as ReturnType<typeof replyFor> & { bubbles: Array<Record<string, unknown>> };
    unsafe.bubbles[0] = { ...unsafe.bubbles[0], flow: "google_calendar" };
    await expect(createChatApi(async () => Response.json({ reply: unsafe })).respond({
      kind: "reply", clientMessageId: "calendar-2", timeline: [],
    })).rejects.toThrow("Yui response was invalid");
  });
  it("sends hosted automatic memory source identity without conversation text", async () => {
    const fetch = vi.fn(async () => Response.json({ sourceMessageId: "message-1", state: "completed", appliedCount: 0 }));
    await createMemoryApi(fetch).process?.({
      sourceMessageId: "message-1", sourceOccurredAt: "2026-08-13T00:00:00.000Z",
      turns: [{ role: "user", text: "PRIVATE_BROWSER_TEXT", provenance: "authoritative_source" }],
    } as never);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      sourceMessageId: "message-1", sourceOccurredAt: "2026-08-13T00:00:00.000Z",
    });
  });
  it("uploads an audio recording as a named multipart transcription request", async () => {
    const fetch = vi.fn(async () => Response.json({ text: "今日は休み" }));
    const signal = new AbortController().signal;

    await expect(createTranscriptionApi(fetch).transcribe(new Blob(["voice"], { type: "audio/mp4" }), signal)).resolves.toBe("今日は休み");

    const [url, options] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/chat/transcriptions");
    expect(options).toMatchObject({ method: "POST", signal });
    expect(options.body).toBeInstanceOf(FormData);
    const file = (options.body as FormData).get("audio");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("speech.mp4");
  });

  it("sends only the final thirty conversation turns and excludes call cards and every profile-flow message", async () => {
    const fetch = vi.fn(async () => Response.json({ reply }));
    const request: ChatRequest = {
      kind: "reply",
      clientMessageId: "message-31",
      timeline: [
        { id: "call", type: "call", startedAt: "2026-08-08T02:00:00.000Z", endedAt: "2026-08-08T02:01:00.000Z" },
        ...Array.from({ length: 31 }, (_, index) => ({
          id: `message-${index}`,
          type: "message" as const,
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          text: `turn ${index}`,
          createdAt: "2026-08-08T02:00:00.000Z",
          delivery: "sent" as const,
        })),
        { id: "profile-user", type: "message", role: "user", text: "大輝", createdAt: "2026-08-08T02:30:00.000Z", delivery: "sent", flow: "profile" },
        { id: "profile-yui", type: "message", role: "assistant", text: "大輝さん、ですね", createdAt: "2026-08-08T02:30:01.000Z", delivery: "sent", flow: "profile" },
      ],
    };

    await expect(createChatApi(fetch, () => undefined).respond(request)).resolves.toEqual(reply);
    expect(fetch).toHaveBeenCalledWith("/api/chat/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "reply",
        clientMessageId: "message-31",
        turns: Array.from({ length: 30 }, (_, index) => ({
          role: (index + 1) % 2 === 0 ? "user" : "assistant",
          text: `turn ${index + 1}`,
        })),
      }),
    });
  });

  it("preserves the caller supplied message ID when retrying", async () => {
    const fetch = vi.fn(async () => Response.json({ reply: replyFor("stable-id") }));
    const api = createChatApi(fetch);
    const request: ChatRequest = {
      kind: "reply",
      clientMessageId: "stable-id",
      timeline: [{ id: "stable-id", type: "message", role: "user", text: "ただいま", createdAt: "2026-08-08T03:00:00.000Z", delivery: "failed" }],
    };

    await api.respond(request);
    await api.respond(request);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).clientMessageId).toBe("stable-id");
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string).clientMessageId).toBe("stable-id");
  });

  it("sends an opening with no turns even when local history exists", async () => {
    const fetch = vi.fn(async () => Response.json({ reply: replyFor("opening-1") }));
    await createChatApi(fetch).respond({
      kind: "opening", clientMessageId: "opening-1",
      timeline: [{ id: "old", type: "message", role: "user", text: "古い会話", createdAt: "2026-08-08T03:00:00.000Z", delivery: "sent" }],
    });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ kind: "opening", turns: [] });
  });

  it("includes the browser time zone in an opening request", async () => {
    const fetch = vi.fn(async () => Response.json({ reply: replyFor("opening-1") }));
    const api = createChatApi(fetch, () => "Asia/Tokyo");

    await api.respond({ kind: "opening", clientMessageId: "opening-1", timeline: [] });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      kind: "opening",
      clientMessageId: "opening-1",
      turns: [],
      timeZone: "Asia/Tokyo",
    });
  });

  it("sends a chat request when browser time-zone detection fails", async () => {
    const fetch = vi.fn(async () => Response.json({ reply: replyFor("opening-1") }));
    const api = createChatApi(fetch, () => { throw new Error("time zone unavailable"); });

    await api.respond({ kind: "opening", clientMessageId: "opening-1", timeline: [] });

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      kind: "opening",
      clientMessageId: "opening-1",
      turns: [],
    });
  });

  it("cancels an error body and classifies maintenance without exposing it", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = new Response("upstream secret", { status: 503 });
    Object.defineProperty(response, "body", { value: { cancel } });

    await expect(createChatApi(async () => response).respond({
      kind: "opening", clientMessageId: "opening-1", timeline: [],
    })).rejects.toMatchObject({ name: "YuiRequestError", kind: "maintenance", status: 503 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "authentication"],
    [409, "profile-required"],
    [429, "usage-limit"],
    [502, "upstream"],
    [503, "maintenance"],
    [504, "timeout"],
  ] as const)("classifies HTTP %s without trusting its response body", async (status, kind) => {
    await expect(createChatApi(async () => new Response("private upstream detail", { status })).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).rejects.toMatchObject({ name: "YuiRequestError", kind, status });
  });

  it("classifies a rejected fetch as a network failure but preserves explicit aborts", async () => {
    await expect(createChatApi(async () => { throw new TypeError("Load failed: private URL"); }).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).rejects.toMatchObject({ name: "YuiRequestError", kind: "network" });

    const abort = new DOMException("The operation was aborted", "AbortError");
    await expect(createChatApi(async () => { throw abort; }).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).rejects.toBe(abort);
  });

  it("returns a valid three-bubble grouped reply", async () => {
    const threeBubbles = replyFor("message-31", ["おかえり", "今日は大変だったね", "まずは座ろう"]);

    await expect(createChatApi(async () => Response.json({ reply: threeBubbles })).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).resolves.toEqual(threeBubbles);
  });

  it("returns a valid authoritative profile from a chat reply", async () => {
    const authoritativeProfile = {
      displayName: "大輝",
      addressingStyle: "none",
      updatedAt: "2026-08-08T03:05:00.000Z",
    };
    const replyWithProfile = { ...reply, profile: authoritativeProfile };

    await expect(createChatApi(async () => Response.json({ reply: replyWithProfile })).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).resolves.toMatchObject({
      profile: {
        displayName: "大輝",
        addressingStyle: "none",
      },
    });
  });

  it("accepts a chat reply with no profile", async () => {
    await expect(createChatApi(async () => Response.json({ reply })).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).resolves.toEqual(reply);
  });

  it("accepts only strict provider-backed web search metadata", async () => {
    const searched = {
      ...reply,
      search: {
        status: "completed" as const,
        searchedAt: "2026-08-13T03:00:00.000Z",
        sources: [{ title: "公式発表", url: "https://example.com/official" }],
        evidence: { facts: [{ text: "公式発表を確認しました", sourceUrl: "https://example.com/official" }], inference: null, suggestion: null },
      },
    };
    await expect(createChatApi(async () => Response.json({ reply: searched })).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).resolves.toEqual(searched);

    for (const malformed of [
      { ...searched, search: { ...searched.search, sources: [{ title: "偽URL", url: "http://example.com" }] } },
      { ...searched, search: { ...searched.search, sources: [{ title: "認証情報付きURL", url: "https://user:password@example.com" }] } },
      { ...searched, search: { ...searched.search, sources: [{ title: "script URL", url: "javascript:alert(1)" }] } },
      { ...searched, search: { ...searched.search, sources: [{ title: "非正規URL", url: "HTTPS://EXAMPLE.COM:443/official" }] } },
      { ...searched, search: { ...searched.search, sources: [
        { title: "一", url: "https://example.com/one" },
        { title: "二", url: "https://example.com/two" },
        { title: "三", url: "https://example.com/three" },
        { title: "四", url: "https://example.com/four" },
        { title: "五", url: "https://example.com/five" },
        { title: "六", url: "https://example.com/six" },
      ] } },
      { ...searched, search: { ...searched.search, sources: [
        { title: "一", url: "https://example.com/one" },
        { title: "重複", url: "https://example.com/one" },
      ] } },
      { ...searched, search: { ...searched.search, sources: [{ title: "不正\u0000タイトル", url: "https://example.com/official" }] } },
      { ...searched, search: { ...searched.search, sources: [{ title: "余分な属性", url: "https://example.com/official", providerOnly: true }] } },
      { ...searched, search: { ...searched.search, providerOnly: true } },
      { ...searched, search: { ...searched.search, sources: [] } },
      { ...searched, search: { status: "failed", searchedAt: "not-a-date", sources: [] } },
      { ...searched, search: { status: "failed", searchedAt: searched.search.searchedAt, sources: searched.search.sources } },
    ]) {
      await expect(createChatApi(async () => Response.json({ reply: malformed })).respond({
        kind: "reply", clientMessageId: "message-31", timeline: [],
      })).rejects.toThrow("Yui response was invalid");
    }
  });

  it.each([
    ["no bubbles", { ...reply, bubbles: [] }],
    ["four bubbles", replyFor("message-31", ["一", "二", "三", "四"])],
    ["wrong reply group", { ...reply, replyGroupId: "other:assistant" }],
    ["duplicate bubble IDs", { ...reply, bubbles: [reply.bubbles[0], { ...reply.bubbles[0], sequence: 1 }] }],
    ["sequence not beginning at zero", { ...reply, bubbles: [{ ...reply.bubbles[0], id: "message-31:assistant:1", sequence: 1 }] }],
    ["sequence gap", { ...replyFor("message-31", ["一", "二"]), bubbles: [replyFor("message-31", ["一", "二"]).bubbles[0], { ...replyFor("message-31", ["一", "二"]).bubbles[1], id: "message-31:assistant:2", sequence: 2 }] }],
    ["empty bubble text", { ...reply, bubbles: [{ ...reply.bubbles[0], text: "" }] }],
    ["bubble over 400 characters", replyFor("message-31", ["あ".repeat(401)])],
    ["total text over 800 characters", replyFor("message-31", ["あ".repeat(267), "い".repeat(267), "う".repeat(267)])],
    ["noncanonical timestamp", { ...reply, bubbles: [{ ...reply.bubbles[0], createdAt: "yesterday" }] }],
    ["invalid authoritative profile", { ...reply, profile: { displayName: "大輝", addressingStyle: "none", updatedAt: "yesterday" } }],
    ["malformed authoritative profile timestamp", { ...reply, profile: { displayName: "大輝", addressingStyle: "none", updatedAt: "2026-08-08T03:05:00.000+00:00" } }],
    ["an unknown reply key", { ...reply, unsupported: true }],
  ])("rejects a successful grouped reply with %s", async (_name, malformed) => {
    await expect(createChatApi(async () => Response.json({ reply: malformed })).respond({
      kind: "reply", clientMessageId: "message-31", timeline: [],
    })).rejects.toThrow("Yui response was invalid");
  });

  it("forwards the caller's abort signal to the chat request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => Response.json({ reply: replyFor("opening-1") }));

    await createChatApi(fetch).respond({
      kind: "opening",
      clientMessageId: "opening-1",
      timeline: [],
    }, controller.signal);

    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
