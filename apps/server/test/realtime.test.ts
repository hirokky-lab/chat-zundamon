import { describe, expect, it, vi } from "vitest";
import type { RemoteChatSnapshot } from "@yui/domain";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import { makeTestRepository } from "../src/db";
import { createProfileRepository } from "../src/profile-db";
import type { MemoryExtractor } from "../src/memory-extractor";
import {
  createOpenAIRealtimeGateway,
  selectRecentVoiceTurns,
} from "../src/realtime";
import type { RealtimeSession } from "../src/realtime";
import { LOCAL_USER } from "../src/request-user";
import { CostLimitError } from "../src/cost-guard";
import { confirmTestMemory } from "./test-memory.js";

function fakeRealtimeGateway(answer: string) {
  return {
    createCall: async () => ({ sdp: answer }),
  };
}

const noMemoryExtractor: MemoryExtractor = {
  extract: async () => ({ candidates: [] }),
};

async function savedProfile() {
  const repository = createProfileRepository(":memory:");
  await repository.save(LOCAL_USER, "カナメ");
  return repository;
}

const realtimeSession: RealtimeSession = {
  type: "realtime",
  model: "gpt-realtime-2.1-mini",
  instructions: "ユイの指示",
  output_modalities: ["audio"],
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
    output: { voice: "marin" },
  },
  tools: [{
    type: "function",
    name: "remember_pending",
    description: "終話後の保存待ち",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }],
  tool_choice: "auto",
};

describe("realtime routes", () => {
  it("selects only the latest six sent conversation messages for voice", () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      id: `m-${index}`,
      type: "message" as const,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `会話${index}`,
      createdAt: `2026-08-10T0${index}:00:00.000Z`,
      delivery: "sent" as const,
    }));
    const snapshot: RemoteChatSnapshot = {
      timeline: [
        { ...messages[0], id: "profile", flow: "profile" as const },
        { ...messages[0], id: "failed", delivery: "failed" as const },
        { id: "call", type: "call" as const, startedAt: messages[0].createdAt, endedAt: messages[1].createdAt },
        ...messages,
      ],
      lastOpeningAt: null,
      lastConversationAt: messages.at(-1)?.createdAt ?? null,
      version: 2,
      revision: 1,
      updatedAt: "2026-08-10T07:00:00.000Z",
    };

    expect(selectRecentVoiceTurns(snapshot)).toEqual(
      messages.slice(-6).map(({ role, text }) => ({ role, text })),
    );
  });

  it("adds recent chat as untrusted voice context and survives repository failure", async () => {
    const createdAt = "2026-08-10T10:00:00.000Z";
    const recent: RemoteChatSnapshot = {
      timeline: [
        { id: "user-1", type: "message", role: "user", text: "晩ごはん食べた", createdAt, delivery: "sent" },
        { id: "assistant-1", type: "message", role: "assistant", text: "何食べたの？", createdAt, delivery: "sent" },
      ],
      lastOpeningAt: createdAt,
      lastConversationAt: createdAt,
      version: 2,
      revision: 1,
      updatedAt: createdAt,
    };
    let firstInstructions = "";
    const first = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      chatStateRepository: { get: async () => recent, save: async () => recent },
      realtimeGateway: {
        createCall: async ({ session }) => {
          firstInstructions = session.instructions;
          return { sdp: "v=0\r\nanswer" };
        },
      },
    });
    const response = await first.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp", "x-yui-time-zone": "Asia/Tokyo" },
      payload: "v=0\r\no=browser-offer",
    });
    expect(response.statusCode).toBe(201);
    expect(firstInstructions).toContain("ユーザー: 晩ごはん食べた");
    expect(firstInstructions).toContain("ずんだもん: 何食べたの？");

    let fallbackInstructions = "";
    const fallback = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      chatStateRepository: { get: async () => { throw new Error("offline"); }, save: async () => "stale" },
      realtimeGateway: {
        createCall: async ({ session }) => {
          fallbackInstructions = session.instructions;
          return { sdp: "v=0\r\nanswer" };
        },
      },
    });
    const fallbackResponse = await fallback.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp", "x-yui-time-zone": "Asia/Tokyo" },
      payload: "v=0\r\no=browser-offer",
    });
    expect(fallbackResponse.statusCode).toBe(201);
    expect(fallbackInstructions).toContain("<recent_conversation>\nなし\n</recent_conversation>");
  });

  it("returns a neutral limit response before creating a realtime call", async () => {
    let calls = 0;
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      realtimeGateway: { createCall: async () => { calls += 1; return { sdp: "answer" }; } },
      costGuard: { reserve: async () => { throw new CostLimitError(); } },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp", "x-yui-session-id": "call-limit" },
      payload: "v=0",
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "usage_limit_reached" });
    expect(calls).toBe(0);
  });

  it("requires a saved profile before it calls the upstream gateway", async () => {
    let calls = 0;
    const app = buildApp({ extractor: noMemoryExtractor, realtimeGateway: { createCall: async () => { calls += 1; return { sdp: "answer" }; } } });
    const response = await app.inject({ method: "POST", url: "/api/realtime/calls", headers: { "content-type": "application/sdp" }, payload: "v=0" });
    expect(response.statusCode).toBe(409);
    expect(calls).toBe(0);
  });
  it("proxies an SDP offer and never returns the API key", async () => {
    const profileRepository = createProfileRepository(":memory:");
    await profileRepository.save(LOCAL_USER, "カナメ");
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository,
      realtimeGateway: fakeRealtimeGateway("v=0\r\nanswer"),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\no=browser-offer",
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toContain("answer");
    expect(response.body).not.toContain("ZUNDAMON_OPENAI_API_KEY");
  });

  it("builds the realtime session from at most eight relevant memories without exposing opening context", async () => {
    const memoryRepository = makeTestRepository();
    for (let index = 1; index <= 8; index += 1) {
      await confirmTestMemory(memoryRepository, LOCAL_USER, {
        kind: "shared",
        content: `コーヒーの好みその${index}`,
        importance: 2,
      });
    }
    await confirmTestMemory(memoryRepository, LOCAL_USER, {
      kind: "preference",
      content: "コーヒーの九件目の除外対象",
      importance: 1,
    });

    const createdAt = "2026-08-08T02:00:00.000Z";
    const recent: RemoteChatSnapshot = {
      timeline: [{ id: "query", type: "message", role: "user", text: "コーヒーの話をしよう", createdAt, delivery: "sent" }],
      lastOpeningAt: createdAt,
      lastConversationAt: createdAt,
      version: 2,
      revision: 1,
      updatedAt: createdAt,
    };

    let forwarded: unknown;
    const profileRepository = createProfileRepository(":memory:");
    await profileRepository.save(LOCAL_USER, "カナメ");
    const app = buildApp({
      extractor: noMemoryExtractor,
      chatStateRepository: { get: async () => recent, save: async () => recent },
      memoryRepository,
      now: () => new Date("2026-08-08T02:30:00.000Z"),
      profileRepository,
      realtimeGateway: {
        createCall: async (input: unknown) => {
          forwarded = input;
          return { sdp: "v=0\r\nanswer" };
        },
      },
      realtimeModel: "gpt-realtime-2.1-mini",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp", "x-yui-time-zone": "Asia/Tokyo" },
      payload: "v=0\r\no=browser-offer",
    });

    expect(forwarded).toEqual({
      offerSdp: "v=0\r\no=browser-offer",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1-mini",
        instructions: expect.stringContaining("ユーザー名: カナメさん"),
        output_modalities: ["audio"],
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
          output: { voice: "marin" },
        },
        tools: [{
          type: "function",
          name: "remember_pending",
          description: expect.stringContaining("終話後"),
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
        tool_choice: "auto",
      },
    });
    const instructions = (forwarded as { session: { instructions: string } })
      .session.instructions;
    for (let index = 1; index <= 8; index += 1) expect(instructions).toContain(`コーヒーの好みその${index}`);
    expect(instructions).not.toContain("コーヒーの九件目の除外対象");
    expect(instructions).toContain("会話モード: 音声通話");
    expect(instructions).toContain("利用可能な機能: 音声通話 / 確認済み記憶 / リアルタイム音声");
    expect(instructions).not.toContain("ローカル音声合成");
    expect(instructions).toContain("2026年8月8日土曜日 11:30");
    expect(instructions).toContain("通常は短い1文で、話題は一つにします。");
    expect(instructions).toContain("必要な場合だけ短い2文まで許可します。");
    expect(instructions).toContain("説明の詰め込み");
    expect(instructions).toContain("複数質問");
    expect(instructions).toContain("音声通話は最長30分です");
    expect(instructions).toContain("保存処理は通話が終わったあと");
    expect(instructions).toContain("「覚えた」「保存した」とは言いません");
    expect(instructions).toContain("remember_pending");
    expect(instructions).toContain("ツール結果は pending");
    expect(instructions).toContain("雑談、個人的な話、相談では、返答したあとに会話を自然に一歩進めることを基本にします");
    expect(instructions).toContain("仕事、休日、趣味、誕生日など、その人自身への関心");
    expect(instructions).toContain("おおむね二、三往復に一度");
    expect(instructions).toContain("実際の行動、努力、選択、工夫を具体的に認めます");
    expect(instructions).toContain("質問は一回の返答につき最大一つ");
    expect(response.headers["x-yui-opening-context"]).toBeUndefined();
    expect(response.body).not.toContain("カナメ");
    expect(response.body).not.toContain("コーヒーの好みその1");
  });

  it("gives chat and realtime the same relevant memories for the same records and query", async () => {
    const queryText = "コーヒー何にしよう";
    const createdAt = "2026-08-11T11:59:00.000Z";
    const recent: RemoteChatSnapshot = {
      timeline: [{ id: "same-query", type: "message", role: "user", text: queryText, createdAt, delivery: "sent" }],
      lastOpeningAt: createdAt,
      lastConversationAt: createdAt,
      version: 2,
      revision: 1,
      updatedAt: createdAt,
    };
    const memoryRepository = makeTestRepository();
    await confirmTestMemory(memoryRepository, LOCAL_USER, { kind: "preference", content: "ブラックコーヒーが好き", importance: 2 });
    await confirmTestMemory(memoryRepository, LOCAL_USER, { kind: "shared", content: "重要な契約更新は金曜日", importance: 5 });
    await memoryRepository.create(LOCAL_USER, {
      kind: "schedule", scope: "shared", content: "家族の通院は十一時", origin: "explicit", sensitivity: "sensitive", importance: 5,
      sourceMessageId: null, sourceOccurredAt: createdAt, validFrom: null, validUntil: "2026-08-11T13:00:00.000Z", expiresAt: null, pinned: true, supersedesId: null,
    });
    let chatInstructions = "";
    let realtimeInstructions = "";
    const app = buildApp({
      extractor: noMemoryExtractor,
      chatGateway: {
        respond: vi.fn(async ({ instructions }) => {
          chatInstructions = instructions;
          return { outputText: JSON.stringify({ bubbles: ["コーヒーにしよう"], profileUpdate: null, memoryAction: null }) };
        }),
      },
      chatStateRepository: { get: async () => recent, save: async () => recent },
      memoryRepository,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      profileRepository: await savedProfile(),
      realtimeGateway: {
        createCall: async ({ session }) => {
          realtimeInstructions = session.instructions;
          return { sdp: "v=0\r\nanswer" };
        },
      },
    });

    const chat = await app.inject({
      method: "POST",
      url: "/api/chat/responses",
      payload: { kind: "reply", clientMessageId: "same-recall-chat", turns: [{ role: "user", text: queryText }] },
    });
    const realtime = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0",
    });

    expect(chat.statusCode).toBe(200);
    expect(realtime.statusCode).toBe(201);
    const memorySection = (instructions: string) => instructions.slice(instructions.indexOf("<memories>"), instructions.indexOf("</memories>"));
    expect(memorySection(chatInstructions)).toBe(memorySection(realtimeInstructions));
    expect(memorySection(chatInstructions)).toContain("ブラックコーヒーが好き");
    expect(memorySection(chatInstructions)).not.toContain("重要な契約更新は金曜日");
    expect(memorySection(chatInstructions)).not.toContain("家族の通院は十一時");
  });

  it("stops recall in both routes without changing stored records", async () => {
    const queryText = "コーヒー何にしよう";
    const createdAt = "2026-08-11T11:59:00.000Z";
    const recent: RemoteChatSnapshot = {
      timeline: [{ id: "disabled-query", type: "message", role: "user", text: queryText, createdAt, delivery: "sent" }],
      lastOpeningAt: createdAt,
      lastConversationAt: createdAt,
      version: 2,
      revision: 1,
      updatedAt: createdAt,
    };
    const memoryRepository = makeTestRepository();
    const stored = await confirmTestMemory(memoryRepository, LOCAL_USER, { kind: "preference", content: "ブラックコーヒーが好き", importance: 4 });
    const list = vi.spyOn(memoryRepository, "list");
    let chatInstructions = "";
    let realtimeInstructions = "";
    const app = buildApp({
      extractor: noMemoryExtractor,
      chatGateway: {
        respond: async ({ instructions }) => {
          chatInstructions = instructions;
          return { outputText: JSON.stringify({ bubbles: ["了解"], profileUpdate: null, memoryAction: null }) };
        },
      },
      chatStateRepository: { get: async () => recent, save: async () => recent },
      memoryRepository,
      profileRepository: await savedProfile(),
      recallMemoryEnabled: () => false,
      realtimeGateway: {
        createCall: async ({ session }) => {
          realtimeInstructions = session.instructions;
          return { sdp: "answer" };
        },
      },
    });

    await app.inject({
      method: "POST",
      url: "/api/chat/responses",
      payload: { kind: "reply", clientMessageId: "disabled-recall-chat", turns: [{ role: "user", text: queryText }] },
    });
    await app.inject({ method: "POST", url: "/api/realtime/calls", headers: { "content-type": "application/sdp" }, payload: "v=0" });

    for (const instructions of [chatInstructions, realtimeInstructions]) {
      const recalled = instructions.slice(instructions.indexOf("<memories>"), instructions.indexOf("</memories>"));
      expect(recalled).not.toContain(stored.content);
    }
    expect(list).not.toHaveBeenCalled();
    expect(await memoryRepository.list(LOCAL_USER)).toEqual([expect.objectContaining({ id: stored.id, content: stored.content })]);
  });

  it("keeps memory repository failures content-free and starts realtime without recall", async () => {
    const logLines: string[] = [];
    let instructions = "";
    const repository = makeTestRepository();
    const app = buildApp({
      extractor: noMemoryExtractor,
      logger: { level: "warn", stream: { write: (line: string) => logLines.push(line) } },
      memoryRepository: { ...repository, list: async () => { throw new Error("秘密の記憶本文"); } },
      profileRepository: await savedProfile(),
      realtimeGateway: {
        createCall: async ({ session }) => {
          instructions = session.instructions;
          return { sdp: "answer" };
        },
      },
    });

    const response = await app.inject({ method: "POST", url: "/api/realtime/calls", headers: { "content-type": "application/sdp" }, payload: "v=0" });

    expect(response.statusCode).toBe(201);
    expect(instructions).toContain("<memories>\nなし\n</memories>");
    expect(logLines.join("\n")).not.toContain("秘密の記憶本文");
  });

  it("infers realtime scope from the latest successful user turn while retaining bounded text context", async () => {
    const createdAt = "2026-08-11T11:59:00.000Z";
    const recent: RemoteChatSnapshot = {
      timeline: [
        { id: "work", type: "message", role: "user", text: "仕事の契約を確認した", createdAt, delivery: "sent" },
        { id: "assistant", type: "message", role: "assistant", text: "契約は片付いたんだね", createdAt, delivery: "sent" },
        { id: "daily", type: "message", role: "user", text: "コーヒーの話をしよう", createdAt, delivery: "sent" },
      ],
      lastOpeningAt: createdAt,
      lastConversationAt: createdAt,
      version: 2,
      revision: 1,
      updatedAt: createdAt,
    };
    const repository = makeTestRepository();
    await repository.create(LOCAL_USER, {
      kind: "preference", scope: "daily", content: "コーヒーは浅煎りが好き", origin: "explicit", sensitivity: "normal", importance: 2,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    });
    await repository.create(LOCAL_USER, {
      kind: "work", scope: "work", content: "仕事ではコーヒーを飲む", origin: "explicit", sensitivity: "normal", importance: 5,
      sourceMessageId: null, sourceOccurredAt: null, validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null,
    });
    let instructions = "";
    const app = buildApp({
      extractor: noMemoryExtractor,
      chatStateRepository: { get: async () => recent, save: async () => recent },
      memoryRepository: repository,
      profileRepository: await savedProfile(),
      realtimeGateway: { createCall: async ({ session }) => { instructions = session.instructions; return { sdp: "answer" }; } },
    });

    const response = await app.inject({ method: "POST", url: "/api/realtime/calls", headers: { "content-type": "application/sdp" }, payload: "v=0" });

    expect(response.statusCode).toBe(201);
    const recalled = instructions.slice(instructions.indexOf("<memories>"), instructions.indexOf("</memories>"));
    expect(recalled).toContain("コーヒーは浅煎りが好き");
    expect(recalled).not.toContain("仕事ではコーヒーを飲む");
    expect(instructions).toContain("ユーザー: 仕事の契約を確認した");
  });

  it.each([
    ["大輝", "san", "大輝さん"],
    ["大輝さん", "san", "大輝さん"],
    ["大輝", "none", "大輝"],
  ] as const)(
    "passes the formatted addressed name %s/%s into voice instructions",
    async (displayName, addressingStyle, expectedName) => {
      let forwarded: unknown;
      const profileRepository = createProfileRepository(":memory:");
      await profileRepository.save(LOCAL_USER, { displayName, addressingStyle });
      const app = buildApp({
        extractor: noMemoryExtractor,
        now: () => new Date("2026-08-10T22:00:00.000Z"),
        profileRepository,
        realtimeGateway: {
          createCall: async (input: unknown) => {
            forwarded = input;
            return { sdp: "v=0\r\nanswer" };
          },
        },
      });

      await app.inject({
        method: "POST",
        url: "/api/realtime/calls",
        headers: { "content-type": "application/sdp", "x-yui-time-zone": "Asia/Tokyo" },
        payload: "v=0\r\no=browser-offer",
      });

      const instructions = (forwarded as { session: { instructions: string } })
        .session.instructions;
      expect(instructions).toContain(`ユーザー名: ${expectedName}`);
      expect(instructions).not.toContain("大輝さんさん");
      expect(instructions).toContain("短答が二回続いた時点で、その話題は終了したと判断します");
      expect(instructions).toContain("ユーザー本人に関係する別の具体的話題へ一度だけ切り替えます");
      expect(instructions).toContain("現在の時間帯: 朝");
    },
  );

  it("excludes an invalid time-zone header from realtime instructions", async () => {
    let forwarded: unknown;
    const app = buildApp({
      extractor: noMemoryExtractor,
      now: () => new Date("2026-08-08T02:30:00.000Z"),
      profileRepository: await savedProfile(),
      realtimeGateway: {
        createCall: async (input: unknown) => {
          forwarded = input;
          return { sdp: "v=0\r\nanswer" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp", "x-yui-time-zone": "Invalid/Zone" },
      payload: "v=0\r\no=browser-offer",
    });

    expect(response.statusCode).toBe(201);
    expect((forwarded as { session: { instructions: string } }).session.instructions).not.toContain("Invalid/Zone");
  });

  it("rejects an empty SDP offer", async () => {
    let calls = 0;
    const profileRepository = createProfileRepository(":memory:");
    await profileRepository.save(LOCAL_USER, "カナメ");
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository,
      realtimeGateway: {
        createCall: async () => {
          calls += 1;
          return { sdp: "v=0\r\nanswer" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "   ",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "SDP offer is required" });
    expect(calls).toBe(0);
  });
});

describe("OpenAI realtime gateway", () => {
  it("sends the session and SDP offer as multipart form data", async () => {
    let requestedUrl: string | URL | Request | undefined;
    let requestedInit: RequestInit | undefined;
    const gateway = createOpenAIRealtimeGateway({
      apiKey: "server-only-secret",
      fetch: async (url, init) => {
        requestedUrl = url;
        requestedInit = init;
        return new Response("v=0\r\nopenai-answer", {
          status: 201,
          headers: { "x-request-id": "req_success" },
        });
      },
    });

    const result = await gateway.createCall({
      offerSdp: "v=0\r\nbrowser-offer",
      session: realtimeSession,
    });

    expect(requestedUrl).toBe("https://api.openai.com/v1/realtime/calls");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toEqual({
      Authorization: "Bearer server-only-secret",
    });
    const body = requestedInit?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("sdp")).toBe("v=0\r\nbrowser-offer");
    expect(JSON.parse(body.get("session") as string)).toEqual(realtimeSession);
    expect(result).toEqual({
      requestId: "req_success",
      sdp: "v=0\r\nopenai-answer",
    });
  });

  it("maps an OpenAI error to 502 without returning its body or the API key", async () => {
    const logLines: string[] = [];
    const gateway = createOpenAIRealtimeGateway({
      apiKey: "server-only-secret",
      fetch: async () =>
        new Response("ZUNDAMON_OPENAI_API_KEY=server-only-secret; quota exceeded", {
          status: 429,
          headers: { "x-request-id": "req_failure" },
        }),
    });
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      logger: {
        level: "error",
        stream: { write: (line: string) => logLines.push(line) },
      },
      realtimeGateway: gateway,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nbrowser-offer",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Realtime service is unavailable" });
    expect(response.body).not.toContain("quota exceeded");
    expect(response.body).not.toContain("server-only-secret");
    expect(response.body).not.toContain("req_failure");
    expect(logLines.join("\n")).toContain("req_failure");
    expect(logLines.join("\n")).not.toContain("quota exceeded");
    expect(logLines.join("\n")).not.toContain("server-only-secret");
  });

  it("cancels an OpenAI error body and keeps 502 when cancellation rejects", async () => {
    const logLines: string[] = [];
    let cancelCalls = 0;
    let textCalls = 0;
    const upstreamResponse = {
      body: {
        cancel: async () => {
          cancelCalls += 1;
          throw new Error("server-only-secret cancel failed");
        },
      },
      headers: new Headers({ "x-request-id": "req_cancel_failure" }),
      ok: false,
      text: async () => {
        textCalls += 1;
        return "ZUNDAMON_OPENAI_API_KEY=server-only-secret; upstream body";
      },
    } as unknown as Response;
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      logger: {
        level: "error",
        stream: { write: (line: string) => logLines.push(line) },
      },
      realtimeGateway: createOpenAIRealtimeGateway({
        apiKey: "server-only-secret",
        fetch: async () => upstreamResponse,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nbrowser-offer",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Realtime service is unavailable" });
    expect(cancelCalls).toBe(1);
    expect(textCalls).toBe(0);
    expect(response.body).not.toContain("server-only-secret");
    expect(response.body).not.toContain("upstream body");
    expect(logLines.join("\n")).toContain("req_cancel_failure");
    expect(logLines.join("\n")).not.toContain("server-only-secret");
    expect(logLines.join("\n")).not.toContain("upstream body");
  });

  it("maps an OpenAI timeout to 504 without returning the thrown error", async () => {
    const timeout = new Error("server-only-secret timed out upstream");
    timeout.name = "TimeoutError";
    const gateway = createOpenAIRealtimeGateway({
      apiKey: "server-only-secret",
      fetch: async () => {
        throw timeout;
      },
    });
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      realtimeGateway: gateway,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nbrowser-offer",
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: "Realtime service timed out" });
    expect(response.body).not.toContain("server-only-secret");
    expect(response.body).not.toContain("timed out upstream");
  });

  it("maps an SDP answer read abort to 504 and preserves the request ID", async () => {
    const logLines: string[] = [];
    const upstreamResponse = new Response(
      "ZUNDAMON_OPENAI_API_KEY=server-only-secret; upstream body",
      {
        status: 201,
        headers: { "x-request-id": "req_body_timeout" },
      },
    );
    const timeout = new Error("server-only-secret body read aborted");
    timeout.name = "AbortError";
    Object.defineProperty(upstreamResponse, "text", {
      value: async () => {
        throw timeout;
      },
    });
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      logger: {
        level: "error",
        stream: { write: (line: string) => logLines.push(line) },
      },
      realtimeGateway: createOpenAIRealtimeGateway({
        apiKey: "server-only-secret",
        fetch: async () => upstreamResponse,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nbrowser-offer",
    });

    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: "Realtime service timed out" });
    expect(response.body).not.toContain("server-only-secret");
    expect(response.body).not.toContain("upstream body");
    expect(logLines.join("\n")).toContain("req_body_timeout");
    expect(logLines.join("\n")).not.toContain("server-only-secret");
    expect(logLines.join("\n")).not.toContain("upstream body");
  });

  it("maps an SDP answer read failure to 502 and preserves the request ID", async () => {
    const logLines: string[] = [];
    const upstreamResponse = new Response(
      "ZUNDAMON_OPENAI_API_KEY=server-only-secret; upstream body",
      {
        status: 201,
        headers: { "x-request-id": "req_body_failure" },
      },
    );
    Object.defineProperty(upstreamResponse, "text", {
      value: async () => {
        throw new Error("server-only-secret body read failed");
      },
    });
    const app = buildApp({
      extractor: noMemoryExtractor,
      profileRepository: await savedProfile(),
      logger: {
        level: "error",
        stream: { write: (line: string) => logLines.push(line) },
      },
      realtimeGateway: createOpenAIRealtimeGateway({
        apiKey: "server-only-secret",
        fetch: async () => upstreamResponse,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/realtime/calls",
      headers: { "content-type": "application/sdp" },
      payload: "v=0\r\nbrowser-offer",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Realtime service is unavailable" });
    expect(response.body).not.toContain("server-only-secret");
    expect(response.body).not.toContain("upstream body");
    expect(logLines.join("\n")).toContain("req_body_failure");
    expect(logLines.join("\n")).not.toContain("server-only-secret");
    expect(logLines.join("\n")).not.toContain("upstream body");
  });
});

describe("realtime config", () => {
  it("loads the realtime model from validated env", () => {
    const config = loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "server-only-secret",
      OPENAI_MEMORY_MODEL: "gpt-5.6-luna",
      OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
      ZUNDAMON_PORT: "4310",
      ZUNDAMON_DB_PATH: "./data/test.sqlite",
    });

    expect(config.realtimeModel).toBe("gpt-realtime-2.1-mini");
  });
});

it('negotiates text-only Realtime when Sakura is configured',async()=>{
 let negotiated:RealtimeSession|undefined;
 const app=buildApp({extractor:noMemoryExtractor,profileRepository:await savedProfile(),realtimeGateway:{createCall:async({session})=>{negotiated=session;return {sdp:'answer'};}},sakuraSpeechGateway:{speak:async()=>Buffer.alloc(44)}});
 const response=await app.inject({method:'POST',url:'/api/realtime/calls',headers:{'content-type':'application/sdp'},payload:'offer'});
 expect(response.statusCode).toBe(201);expect(response.headers['x-yui-voice-provider']).toBe('zundamon');
 expect(negotiated?.output_modalities).toEqual(['text']);expect(negotiated?.audio.output).toBeUndefined();
 await app.close();
});
it('validates speech input and returns non-cacheable audio',async()=>{
 const speak=vi.fn(async()=>Buffer.alloc(44));const app=buildApp({extractor:noMemoryExtractor,sakuraSpeechGateway:{speak}});
 expect((await app.inject({method:'POST',url:'/api/realtime/speech',payload:{text:'あ'.repeat(241)}})).statusCode).toBe(400);
 expect(speak).not.toHaveBeenCalled();
 const response=await app.inject({method:'POST',url:'/api/realtime/speech',payload:{text:'こんにちは。'}});
 expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['content-type']).toBe('audio/wav');await app.close();
});
