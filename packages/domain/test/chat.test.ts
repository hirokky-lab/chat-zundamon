import { describe, expect, it } from "vitest";
import {
  CHAT_DICTATION_MAX_BYTES,
  CHAT_DICTATION_MAX_MS,
  assertExternalContextOutput,
  createProfileGreeting,
  isReferentialExternalMemoryRequest,
  parseChatReplyOutput,
  parseChatResponseOutput,
  parseTimelineItem,
  parseWebSearchMetadata,
  prepareWebSearch,
  shouldCreateOpening,
  type CallCard,
  type ChatMessage,
  type LocalChatSnapshot,
} from "../src/chat";
import type { Profile } from "../src/profile";
import { buildOpeningLine } from "../src/persona";
import type { TtsStatus } from "../src/speech";

describe("external context output", () => {
  const replyGroupId = "calendar-message:assistant";
  const createdAt = "2026-08-21T00:00:00.000Z";

  it("accepts a reply only when profile and memory updates are both null", () => {
    const parsed = parseChatResponseOutput(
      JSON.stringify({ bubbles: ["10時は予定ありだよ"], profileUpdate: null, memoryAction: null }),
      replyGroupId,
      createdAt,
    );
    expect(assertExternalContextOutput(parsed)).toBe(parsed);
  });

  it.each([
    { bubbles: ["予定だよ"], profileUpdate: { displayName: "外部名", addressingStyle: null }, memoryAction: null },
    {
      bubbles: ["予定だよ"],
      profileUpdate: null,
      memoryAction: {
        type: "add",
        candidate: {
          kind: "schedule", scope: "daily", content: "外部予定", importance: 3,
          sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null,
        },
      },
    },
  ])("rejects an external-context mutation proposal", (output) => {
    const parsed = parseChatResponseOutput(JSON.stringify(output), replyGroupId, createdAt);
    expect(() => assertExternalContextOutput(parsed)).toThrow("External context output cannot mutate profile or memory");
  });
});

describe("external context lineage", () => {
  it("accepts only the safe generic external-context marker in strict snapshots", () => {
    const item = {
      id: "calendar-message:assistant:0", type: "message", role: "assistant", text: "10時は予定ありだよ",
      createdAt: "2026-08-21T00:00:00.000Z", delivery: "sent", flow: "external_context",
      replyGroupId: "calendar-message:assistant", sequence: 0,
    };
    expect(parseTimelineItem(item, { strict: true, snapshotVersion: 3 })).toMatchObject({ flow: "external_context" });
    expect(parseTimelineItem({ ...item, flow: "google_calendar" }, { strict: true, snapshotVersion: 3 })).toBeNull();
  });

  it.each(["それを覚えておいて", "この予定を記憶してください", "あのタスクを保存して"])(
    "recognizes an immediate referential memory request without carrying external data: %s",
    (text) => expect(isReferentialExternalMemoryRequest(text)).toBe(true),
  );
});

describe("web search admission", () => {
  it("keeps only the minimum topic for an explicit search request", () => {
    expect(prepareWebSearch("内閣の最新の支持率を検索して")).toEqual({
      query: "内閣の最新の支持率",
      reason: "explicit",
      highStakes: false,
    });
  });

  it.each([
    ["今の首相は誰？", "freshness"],
    ["新しい制度の出典を教えて", "source_request"],
    ["OpenAI公式情報からWeb search toolの概要を短く確認", "source_request"],
  ] as const)("admits a bounded current-information request: %s", (text, reason) => {
    expect(prepareWebSearch(text)).toMatchObject({ query: expect.any(String), reason });
  });

  it.each([
    "今日はここまでにしたい",
    "疲れたから少し静かにしていたい",
    "今日の天気は気持ちがいい",
    "新しい制度の出典は大切だね",
    "私の住所を検索して",
    "私の勤務先のニュースを検索して",
    "ぼくはA社で働いています。A社の最新ニュースを教えて",
    "私自身が勤めるABC株式会社の最新情報は？",
    "僕自身が勤めるABC株式会社の最新情報は？",
    "俺自身の会社の最新ニュースを教えて",
    "My employer's latest news — search the web",
    "I work at Acme. Look it up",
    "私が先週買った株の現在価格は？",
    "自分が契約している保険の最新情報は？",
    "俺の勤務先の現在の情報は？",
    "友人の電話番号を検索して",
    "妻の会社のニュースを教えて",
    "上司の最新情報を教えて",
    "自宅の郵便番号を検索して",
    "口座の最新情報を検索して",
    "小林さんの最新情報を検索して",
    "この添付写真を検索して",
    "覚えている内容を検索して",
    "それを検索して",
    "https://example.com の内容を検索して",
    "APIキーを検索して",
    "検索して",
    "あいうえお".repeat(50),
  ])("fails closed for an unsafe, personal, or underspecified request: %s", (text) => {
    expect(prepareWebSearch(text)).toBeNull();
  });
});

describe("web search evidence metadata", () => {
  it("accepts only source-linked facts and separate derived text", () => {
    expect(parseWebSearchMetadata({
      status: "completed",
      searchedAt: "2026-08-20T10:00:00.000Z",
      sources: [{ title: "公式発表", url: "https://example.com/official" }],
      evidence: {
        facts: [{ text: "公式発表は今日です", sourceUrl: "https://example.com/official" }],
        inference: "予定は変更される可能性があります",
        suggestion: "ユイからは公式をもう一度見るのがおすすめ",
      },
    })).toMatchObject({ status: "completed", evidence: { facts: [{ sourceUrl: "https://example.com/official" }] } });
  });

  it("rejects evidence without a displayed source or with raw-result fields", () => {
    const metadata = {
      status: "completed",
      searchedAt: "2026-08-20T10:00:00.000Z",
      sources: [{ title: "公式発表", url: "https://example.com/official" }],
      evidence: {
        facts: [{ text: "公式発表は今日です", sourceUrl: "https://other.example/unsupported" }],
        inference: null,
        suggestion: null,
      },
    };
    expect(parseWebSearchMetadata(metadata)).toBeNull();
    expect(parseWebSearchMetadata({ ...metadata, evidence: { ...metadata.evidence, rawHtml: "<p>not stored</p>" } })).toBeNull();
  });
});

describe("chat opening contracts", () => {
  it("uses the fixed introduction when no display name is available", () => {
    expect(
      buildOpeningLine({
        now: "2026-08-08T12:00:00.000Z",
        userName: "",
        memories: [],
      }),
    ).toBe("、おかえり");
  });

  it("creates an opening at both elapsed-time boundaries", () => {
    expect(
      shouldCreateOpening({
        now: "2026-08-08T12:00:00.000Z",
        lastOpeningAt: "2026-08-08T05:59:59.999Z",
        lastConversationAt: "2026-08-08T11:29:59.999Z",
      }),
    ).toBe(true);
  });

  it("does not create an opening before either elapsed-time boundary", () => {
    expect(
      shouldCreateOpening({
        now: "2026-08-08T12:00:00.000Z",
        lastOpeningAt: "2026-08-08T06:00:00.001Z",
        lastConversationAt: "2026-08-08T11:29:59.999Z",
      }),
    ).toBe(false);
    expect(
      shouldCreateOpening({
        now: "2026-08-08T12:00:00.000Z",
        lastOpeningAt: "2026-08-08T05:59:59.999Z",
        lastConversationAt: "2026-08-08T11:30:00.001Z",
      }),
    ).toBe(false);
  });

  it("creates an opening without prior opening or conversation", () => {
    expect(
      shouldCreateOpening({
        now: "2026-08-08T12:00:00.000Z",
        lastOpeningAt: null,
        lastConversationAt: null,
      }),
    ).toBe(true);
  });

  it("fails closed for invalid dates", () => {
    expect(
      shouldCreateOpening({
        now: "not-a-date",
        lastOpeningAt: null,
        lastConversationAt: null,
      }),
    ).toBe(false);
    expect(
      shouldCreateOpening({
        now: "2026-08-08T12:00:00.000Z",
        lastOpeningAt: "not-a-date",
        lastConversationAt: null,
      }),
    ).toBe(false);
  });

  it("fails closed for calendar dates that JavaScript would normalize", () => {
    expect(
      shouldCreateOpening({
        now: "2026-02-30T12:00:00.000Z",
        lastOpeningAt: null,
        lastConversationAt: null,
      }),
    ).toBe(false);
    expect(
      shouldCreateOpening({
        now: "2026-03-02T12:00:00.000Z",
        lastOpeningAt: "2026-02-30T00:00:00.000Z",
        lastConversationAt: "2026-02-28T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("chat timeline contracts", () => {
  const now = "2026-08-10T00:00:00.000Z";
  const photo = {
    id: "11111111-1111-4111-8111-111111111111",
    type: "photo",
    role: "user",
    photoId: "22222222-2222-4222-8222-222222222222",
    caption: "これ見て",
    origin: "photo",
    createdAt: now,
    delivery: "sent",
  } as const;

  it("accepts a strict UUIDv4 photo exchange only in snapshot v3", () => {
    expect(parseTimelineItem(photo, { strict: true, snapshotVersion: 3 })).toEqual(photo);
    expect(parseTimelineItem(photo, { strict: true, snapshotVersion: 2 })).toBeNull();
    expect(parseTimelineItem({ ...photo, url: "https://storage.invalid/a.jpg" }, { strict: true, snapshotVersion: 3 })).toBeNull();
  });

  it("rejects non-v4 identifiers for every new photo identity", () => {
    const uuidV7 = "0198a900-0000-7000-8000-000000000001";

    expect(parseTimelineItem({ ...photo, id: uuidV7 }, { strict: true, snapshotVersion: 3 })).toBeNull();
    expect(parseTimelineItem({ ...photo, photoId: uuidV7 }, { strict: true, snapshotVersion: 3 })).toBeNull();
  });

  it("rejects unsafe captions and photo metadata fields", () => {
    expect(parseTimelineItem({ ...photo, caption: `安全ではない\u0000` }, { strict: true, snapshotVersion: 3 })).toBeNull();
    expect(parseTimelineItem({ ...photo, caption: "あ".repeat(401) }, { strict: true, snapshotVersion: 3 })).toBeNull();
    expect(parseTimelineItem({ ...photo, storagePath: "private/a.jpg" }, { strict: true, snapshotVersion: 3 })).toBeNull();
    expect(parseTimelineItem({ ...photo, metadata: { width: 100 } }, { strict: true, snapshotVersion: 3 })).toBeNull();
  });

  it("requires the complete assistant photo-analysis lineage pair only in v3", () => {
    const assistant = {
      id: "photo-reply:0",
      type: "message",
      role: "assistant",
      text: "夕焼けがきれいだね",
      createdAt: now,
      delivery: "sent",
      replyGroupId: "photo-reply",
      sequence: 0,
      origin: "photo_analysis",
      sourcePhotoMessageId: photo.id,
    } as const;

    expect(parseTimelineItem(assistant, { strict: true, snapshotVersion: 3 })).toEqual(assistant);
    expect(parseTimelineItem(assistant, { strict: true, snapshotVersion: 2 })).toBeNull();
    expect(parseTimelineItem({ ...assistant, sourcePhotoMessageId: undefined }, { strict: true, snapshotVersion: 3 })).toBeNull();
    expect(parseTimelineItem({ ...assistant, origin: undefined }, { strict: true, snapshotVersion: 3 })).toBeNull();
    expect(parseTimelineItem({ ...assistant, sourcePhotoMessageId: "not-a-uuid" }, { strict: true, snapshotVersion: 3 })).toBeNull();
  });

  it("allows an existing message ID to change delivery status", () => {
    const sending: ChatMessage = {
      id: "message-1",
      type: "message",
      role: "user",
      text: "ただいま",
      createdAt: "2026-08-08T12:00:00.000Z",
      delivery: "sending",
    };
    const sent: ChatMessage = { ...sending, delivery: "sent" };

    expect(sent).toMatchObject({ id: "message-1", delivery: "sent" });
  });

  it("represents calls with timestamps but no transcript text", () => {
    const card: CallCard = {
      id: "call-1",
      type: "call",
      startedAt: "2026-08-08T12:00:00.000Z",
      endedAt: "2026-08-08T12:05:00.000Z",
    };
    const snapshot: LocalChatSnapshot = {
      timeline: [card],
      draft: "",
      pendingDisplayName: null,
      lastOpeningAt: null,
      lastConversationAt: null,
    };
    const tts: TtsStatus = {
      available: true,
      provider: "voicevox-nemo",
      voiceLabel: "女性2",
    };

    // @ts-expect-error Call cards must never retain transcript text.
    const invalidCard: CallCard = { ...card, text: "通話の文字起こし" };

    expect(snapshot.timeline).toEqual([card]);
    expect(tts.available).toBe(true);
    expect("text" in card).toBe(false);
  });
});

describe("chat reply contracts", () => {
  const createdAt = "2026-08-09T00:00:01.000Z";
  const replyGroupId = "message-1:assistant";
  const targetMemoryId = "00000000-0000-4000-8000-000000000001";
  const currentLatte = {
    kind: "preference" as const,
    scope: "shared" as const,
    content: "カフェラテが好き",
    importance: 4 as const,
    sourceOccurredAt: null,
    validFrom: null,
    validUntil: null,
    retention: null,
  };

  it("parses a permanent profile proposal independently from reply bubbles", () => {
    const parsed = parseChatResponseOutput(
      JSON.stringify({
        bubbles: ["じゃあ、大輝って呼ぶね"],
        profileUpdate: { displayName: "大輝", addressingStyle: null },
        memoryAction: null,
      }),
      "group-1",
      createdAt,
    );

    expect(parsed.profileUpdate).toEqual({ displayName: "大輝", addressingStyle: null });
    expect(parsed.reply.bubbles).toEqual([{
      id: "group-1:0",
      text: "じゃあ、大輝って呼ぶね",
      createdAt,
      sequence: 0,
    }]);
  });

  it("keeps a temporary form of address out of the profile proposal", () => {
    expect(parseChatResponseOutput(
      JSON.stringify({ bubbles: ["今日は社長ね"], profileUpdate: null, memoryAction: null }),
      "group-2",
      createdAt,
    ).profileUpdate).toBeNull();
  });

  it.each([
    ["add", { type: "add", candidate: currentLatte }],
    ["replace", { type: "replace", targetMemoryId, candidate: currentLatte }],
    ["mark past", { type: "mark_past", targetMemoryId }],
    ["mark uncertain", { type: "mark_uncertain", targetMemoryIds: [targetMemoryId] }],
    ["forget", { type: "forget", targetMemoryId, blockRelearning: true }],
  ] as const)("parses one explicit %s memory action", (_name, memoryAction) => {
    const parsed = parseChatResponseOutput(JSON.stringify({
      bubbles: ["うん、覚えた"],
      profileUpdate: null,
      memoryAction,
    }), "reply", createdAt, [targetMemoryId]);

    expect(parsed.memoryAction).toEqual(memoryAction);
  });

  it.each([
    ["unknown action key", { type: "add", candidate: currentLatte, extra: true }],
    ["unknown candidate key", { type: "add", candidate: { ...currentLatte, extra: true } }],
    ["model-owned origin", { type: "add", candidate: { ...currentLatte, origin: "explicit" } }],
    ["invalid kind", { type: "add", candidate: { ...currentLatte, kind: "temporary" } }],
    ["overlong content", { type: "add", candidate: { ...currentLatte, content: "あ".repeat(201) } }],
    ["invalid importance", { type: "add", candidate: { ...currentLatte, importance: 6 } }],
    ["forget without target", { type: "forget", blockRelearning: true }],
    ["more than one action", [{ type: "add", candidate: currentLatte }, { type: "add", candidate: currentLatte }]],
  ])("rejects a memory action with %s", (_name, memoryAction) => {
    expect(() => parseChatResponseOutput(JSON.stringify({
      bubbles: ["うん"],
      profileUpdate: null,
      memoryAction,
    }), replyGroupId, createdAt)).toThrow();
  });

  it("rejects duplicate uncertain-memory targets", () => {
    expect(() => parseChatResponseOutput(JSON.stringify({
      bubbles: ["確認するね"],
      profileUpdate: null,
      memoryAction: { type: "mark_uncertain", targetMemoryIds: [targetMemoryId, targetMemoryId] },
    }), replyGroupId, createdAt, [targetMemoryId])).toThrow();
  });

  it("rejects a target that was not shown to the model", () => {
    expect(() => parseChatResponseOutput(JSON.stringify({
      bubbles: ["わかった"],
      profileUpdate: null,
      memoryAction: { type: "forget", targetMemoryId, blockRelearning: true },
    }), replyGroupId, createdAt, ["00000000-0000-4000-8000-000000000002"])).toThrow();
  });

  it("splits one long conversational bubble at the nearest sentence boundary", () => {
    const first = "いいね、宇宙や量子力学の話って、考えるほど深いのに声のトーンが落ち着いてて、寝る前にちょうどよさそう。";
    const second = "どんな動画が多い？宇宙のスケール系か、量子の不思議系か";
    const parsed = parseChatResponseOutput(
      JSON.stringify({ bubbles: [`${first}${second}`], profileUpdate: null, memoryAction: null }),
      "reply",
      createdAt,
    );

    expect(parsed.reply.bubbles.map((bubble) => bubble.text)).toEqual([
      first.slice(0, -1), second,
    ]);
  });

  it("splits three balanced conversational meaning units into three bubbles", () => {
    const first = "今日は少し早く起きられたから、朝の空気がいつもより気持ちよく感じた。";
    const second = "散歩の途中で寄った店のコーヒーも、思ったより香りがよかった。";
    const third = "このあとの予定はある？無理のない感じで過ごせそうかな";
    const parsed = parseChatResponseOutput(JSON.stringify({
      bubbles: [`${first}${second}${third}`],
      profileUpdate: null,
      memoryAction: { type: "add", candidate: { ...currentLatte, content: "朝の散歩が好き" } },
    }), "reply", createdAt);

    expect(parsed.reply.bubbles).toEqual([
      { id: "reply:0", text: first.slice(0, -1), createdAt, sequence: 0 },
      { id: "reply:1", text: second.slice(0, -1), createdAt, sequence: 1 },
      { id: "reply:2", text: third, createdAt, sequence: 2 },
    ]);
    expect(parsed.memoryAction).toEqual({
      type: "add",
      candidate: { ...currentLatte, content: "朝の散歩が好き" },
    });
  });

  it.each([
    ["a short reply", "今日はゆっくり過ごそう"],
    ["a long URL", "https://example.com/" + "a".repeat(90)],
    ["inline code", "`" + "a".repeat(40) + "?" + "b".repeat(50) + "`"],
    ["a sentence boundary too close to the start", "あ".repeat(22) + "。" + "い".repeat(70)],
    ["a sentence without a boundary", "あ".repeat(85)],
  ])("does not split %s", (_name, text) => {
    expect(parseChatReplyOutput(text, "reply", createdAt).bubbles).toHaveLength(1);
  });

  it.each([
    ["unknown top-level key", { bubbles: ["了解"], profileUpdate: null, memoryAction: null, extra: true }],
    ["missing profileUpdate", { bubbles: ["了解"], memoryAction: null }],
    ["missing memoryAction", { bubbles: ["了解"], profileUpdate: null }],
    ["unknown proposal key", { bubbles: ["了解"], profileUpdate: { displayName: "大輝", addressingStyle: null, extra: true }, memoryAction: null }],
    ["invalid addressing style", { bubbles: ["了解"], profileUpdate: { displayName: null, addressingStyle: "kun" }, memoryAction: null }],
    ["non-string display name", { bubbles: ["了解"], profileUpdate: { displayName: 123, addressingStyle: null }, memoryAction: null }],
    ["an object bubble", { bubbles: [{ text: "了解" }], profileUpdate: null, memoryAction: null }],
    ["more than three bubbles", { bubbles: ["一", "二", "三", "四"], profileUpdate: null, memoryAction: null }],
    ["empty bubbles", { bubbles: [], profileUpdate: null, memoryAction: null }],
  ])("rejects structured output with %s", (_name, value) => {
    expect(() => parseChatResponseOutput(
      JSON.stringify(value),
      replyGroupId,
      createdAt,
    )).toThrow();
  });

  it("uses plaintext as one bubble with no profile proposal", () => {
    expect(parseChatResponseOutput("今日はゆっくりでいいよ。", replyGroupId, createdAt)).toEqual({
      reply: {
        replyGroupId,
        bubbles: [{
          id: "message-1:assistant:0",
          text: "今日はゆっくりでいいよ",
          createdAt,
          sequence: 0,
        }],
      },
      profileUpdate: null,
      memoryAction: null,
    });
  });

  it("parses structured reply bubbles with stable IDs and sequence", () => {
    const reply = parseChatReplyOutput(
      JSON.stringify({
        bubbles: ["今日はゆっくりでいいよ。", "なんか食べた？"],
        profileUpdate: null,
        memoryAction: null,
      }),
      replyGroupId,
      createdAt,
    );

    expect(reply).toEqual({
      replyGroupId,
      bubbles: [
        { id: "message-1:assistant:0", text: "今日はゆっくりでいいよ", createdAt, sequence: 0 },
        { id: "message-1:assistant:1", text: "なんか食べた？", createdAt, sequence: 1 },
      ],
    });
  });

  it("falls back to one validated plaintext bubble when JSON parsing fails", () => {
    expect(parseChatReplyOutput("今日はゆっくりでいいよ。", replyGroupId, createdAt).bubbles)
      .toEqual([{ id: "message-1:assistant:0", text: "今日はゆっくりでいいよ", createdAt, sequence: 0 }]);
  });

  it.each([
    ["普通の文.", "普通の文"],
    ["https://example.com/path.", "https://example.com/path."],
    ["`value.`", "`value.`"],
    ["...", "..."],
  ])("removes only safe ordinary-sentence final punctuation: %s", (raw, expected) => {
    expect(parseChatReplyOutput(raw, replyGroupId, createdAt).bubbles[0]?.text).toBe(expected);
  });

  it.each([
    JSON.stringify({ bubbles: [], profileUpdate: null, memoryAction: null }),
    JSON.stringify({ bubbles: ["a", "b", "c", "d"], profileUpdate: null, memoryAction: null }),
    JSON.stringify({ bubbles: [""], profileUpdate: null, memoryAction: null }),
    JSON.stringify({ bubbles: ["a".repeat(401)], profileUpdate: null, memoryAction: null }),
    JSON.stringify({ bubbles: ["a".repeat(400), "b".repeat(400), "c"], profileUpdate: null, memoryAction: null }),
    JSON.stringify({ bubbles: ["first\nsecond"], profileUpdate: null, memoryAction: null }),
    " ",
    "a".repeat(801),
  ])("rejects malformed, empty, or over-limit reply output", (raw) => {
    expect(() => parseChatReplyOutput(raw, replyGroupId, createdAt)).toThrow();
  });

  it("creates exactly two local-only profile greeting messages", () => {
    const profile: Profile = {
      displayName: "大輝",
      addressingStyle: "san",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };

    expect(createProfileGreeting(profile, createdAt, "profile-1")).toEqual([
      {
        id: "profile-1:0",
        type: "message",
        role: "assistant",
        text: "大輝さん、はじめまして",
        createdAt,
        delivery: "sent",
        flow: "profile",
        replyGroupId: "profile-1",
        sequence: 0,
      },
      {
        id: "profile-1:1",
        type: "message",
        role: "assistant",
        text: "これからよろしくね",
        createdAt,
        delivery: "sent",
        flow: "profile",
        replyGroupId: "profile-1",
        sequence: 1,
      },
    ]);
  });

  it("defines browser dictation limits", () => {
    expect(CHAT_DICTATION_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(CHAT_DICTATION_MAX_MS).toBe(60_000);
  });
});
