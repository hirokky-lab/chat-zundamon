import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@yui/domain";
import {
  createMemoryRetriever,
  extractRelatedNames,
  rankMemories,
  type MemoryQuery,
} from "../src/memory-retriever";
import { LOCAL_USER } from "../src/request-user";

const now = "2026-08-11T12:00:00.000Z";

function memory(
  id: string,
  content: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    kind: "shared",
    scope: "shared",
    content,
    normalizedContent: content.normalize("NFKC").replace(/[、。\s]/gu, ""),
    status: "active",
    origin: "explicit",
    sensitivity: "normal",
    importance: 3,
    sourceMessageId: null,
    sourceOccurredAt: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    pinned: true,
    supersedesId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function query(overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    text: "コーヒー何にしよう",
    now,
    scope: "daily",
    relatedNames: [],
    ...overrides,
  };
}

describe("memory relevance ranking", () => {
  it("matches normalized Japanese substrings and excludes unrelated high-importance records", () => {
    const records = [
      memory("coffee", "ブラックコーヒーが好き", { kind: "preference", importance: 2 }),
      memory("half-width", "朝はｺｰﾋｰを飲む", { kind: "routine", importance: 1 }),
      memory("unrelated", "重要な契約更新は金曜日", { kind: "work", importance: 5 }),
    ];

    expect(rankMemories(query(), records).map(({ id }) => id)).toEqual([
      "coffee",
      "half-width",
    ]);
  });

  it("uses kind, named-person, recency, importance, and schedule proximity only to order relevant records", () => {
    const records = [
      memory("event-coffee", "コーヒーが好きと話した", { kind: "event", importance: 5 }),
      memory("preference-coffee", "コーヒーが好き", { kind: "preference", importance: 1 }),
      memory("misaki-event", "美咲の誕生日を祝った", { kind: "event", updatedAt: "2026-08-10T00:00:00.000Z" }),
      memory("misaki-person", "美咲の誕生日は九月", { kind: "person", updatedAt: "2026-07-01T00:00:00.000Z" }),
      memory("dentist-near", "歯医者の予定は今週", { kind: "schedule", validUntil: "2026-08-12T12:00:00.000Z" }),
      memory("dentist-far", "歯医者の予定は来月", { kind: "schedule", validUntil: "2026-09-10T12:00:00.000Z" }),
      memory("book-new", "読書の時間を作る", { updatedAt: "2026-08-11T11:00:00.000Z", importance: 2 }),
      memory("book-old", "読書の時間を増やす", { updatedAt: "2026-06-01T00:00:00.000Z", importance: 2 }),
      memory("movie-important", "映画はSFが好き", { importance: 5 }),
      memory("movie-less-important", "映画は宇宙ものが好き", { importance: 2 }),
    ];

    expect(rankMemories(query({ text: "好きなコーヒー" }), records).map(({ id }) => id).slice(0, 2))
      .toEqual(["preference-coffee", "event-coffee"]);
    expect(rankMemories(query({ text: "美咲の誕生日", relatedNames: ["美咲"] }), records).map(({ id }) => id).slice(0, 2))
      .toEqual(["misaki-person", "misaki-event"]);
    expect(rankMemories(query({ text: "歯医者の予定" }), records).map(({ id }) => id).slice(0, 2))
      .toEqual(["dentist-near", "dentist-far"]);
    expect(rankMemories(query({ text: "読書の時間" }), records).map(({ id }) => id).slice(0, 2))
      .toEqual(["book-new", "book-old"]);
    expect(rankMemories(query({ text: "映画を見たい" }), records).map(({ id }) => id).slice(0, 2))
      .toEqual(["movie-important", "movie-less-important"]);
  });

  it("keeps only active, currently available, scope-compatible records", () => {
    const records = [
      memory("daily", "コーヒーは浅煎りが好き", { scope: "daily" }),
      memory("shared", "コーヒーは豆から挽く", { scope: "shared" }),
      memory("work", "職場ではコーヒーを飲む", { scope: "work" }),
      memory("past", "昔はコーヒーが苦手", { status: "past" }),
      memory("uncertain", "コーヒーをやめたかもしれない", { status: "uncertain" }),
      memory("expired-status", "期限切れのコーヒー予定", { status: "expired" }),
      memory("expired-time", "昨日までのコーヒー予定", { expiresAt: "2026-08-11T11:59:59.999Z" }),
      memory("future", "来月からコーヒーを控える", { validFrom: "2026-09-01T00:00:00.000Z" }),
      memory("ended", "昨日までコーヒーを控える", { validUntil: "2026-08-11T11:59:59.999Z" }),
    ];

    expect(rankMemories(query(), records).map(({ id }) => id).sort()).toEqual(["daily", "shared"]);
    expect(rankMemories(query({ scope: "work" }), records).map(({ id }) => id).sort()).toEqual(["shared", "work"]);
  });

  it("requires a clear current-topic match for sensitive records even when time is adjacent or has passed", () => {
    const records = [
      memory("health", "偏頭痛の薬は寝る前", {
        kind: "schedule",
        sensitivity: "sensitive",
        importance: 5,
        sourceOccurredAt: "2026-08-11T11:59:00.000Z",
        validUntil: "2026-08-12T12:00:00.000Z",
      }),
      memory("family", "家族の通院は十一時", {
        kind: "schedule",
        sensitivity: "sensitive",
        sourceOccurredAt: "2026-08-11T11:00:00.000Z",
        validUntil: "2026-08-11T13:00:00.000Z",
      }),
    ];

    expect(rankMemories(query({ text: "今日は何しよう" }), records)).toEqual([]);
    expect(rankMemories(query({ text: "さっきの予定はどうなった" }), records)).toEqual([]);
    expect(rankMemories(query({ text: "偏頭痛の薬はいつ飲む？" }), records).map(({ id }) => id)).toEqual(["health"]);
    expect(rankMemories(query({ text: "家族の通院は何時？" }), records).map(({ id }) => id)).toEqual(["family"]);
  });

  it("requires non-name, non-generic exact topical evidence for sensitive records", () => {
    const records = [
      memory("named", "美咲の家族は治療中", { sensitivity: "sensitive", kind: "person" }),
      memory("drive", "ドライブ中に体調を崩した", { sensitivity: "sensitive" }),
      memory("underwear", "パンツの購入費を相談した", { sensitivity: "sensitive" }),
      memory("recent", "最近は借金の返済に悩んでいる", { sensitivity: "sensitive" }),
      memory("migraine", "偏頭痛の薬は寝る前", { sensitivity: "sensitive" }),
    ];

    expect(rankMemories(query({ text: "美咲", relatedNames: ["美咲"] }), records)).toEqual([]);
    expect(rankMemories(query({ text: "美咲", relatedNames: [] }), records)).toEqual([]);
    expect(rankMemories(query({ text: "ライブはどうだった？" }), records)).toEqual([]);
    expect(rankMemories(query({ text: "パンを買おう" }), records)).toEqual([]);
    expect(rankMemories(query({ text: "最近どう？" }), records)).toEqual([]);
    expect(rankMemories(query({ text: "偏頭痛の薬について" }), records).map(({ id }) => id)).toEqual(["migraine"]);
  });

  it("rejects a bare name in sensitive records regardless of position or kind but permits explicit sensitive topics", () => {
    const records = [
      memory("person-middle", "友人の美咲は治療中", { sensitivity: "sensitive", kind: "person" }),
      memory("event-middle", "友人の美咲は病気で休んだ", { sensitivity: "sensitive", kind: "event" }),
      memory("shared-middle", "友人の美咲は通院中", { sensitivity: "sensitive", kind: "shared" }),
    ];

    expect(rankMemories(query({ text: "美咲", relatedNames: [] }), records)).toEqual([]);
    for (const record of records) {
      expect(rankMemories(query({ text: "友人の美咲", relatedNames: [] }), [record])).toEqual([]);
    }
    expect(rankMemories(query({ text: "治療どう", relatedNames: [] }), records).map(({ id }) => id)).toEqual(["person-middle"]);
    expect(rankMemories(query({ text: "美咲の病気", relatedNames: [] }), records).map(({ id }) => id)).toEqual(["event-middle"]);
    expect(rankMemories(query({ text: "通院どう", relatedNames: [] }), records).map(({ id }) => id)).toEqual(["shared-middle"]);
  });

  it("keeps exact topical evidence ahead of newer high-scoring substring evidence", () => {
    const records = [
      memory("exact-old", "TypeScriptを学ぶ", {
        importance: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      memory("substring-new-schedule", "TypeScriptBookの発売予定", {
        kind: "schedule",
        importance: 5,
        sourceOccurredAt: "2026-08-11T11:59:00.000Z",
        validUntil: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-11T11:59:00.000Z",
      }),
    ];

    expect(rankMemories(query({ text: "TypeScriptについて" }), records).map(({ id }) => id)).toEqual([
      "exact-old",
      "substring-new-schedule",
    ]);
  });

  it("returns nothing for empty, short, or ambiguous conversation", () => {
    const records = [memory("important", "大切な旅行の予定", { importance: 5 })];

    for (const text of ["", "うん", "そう", "はい", "了解", "今日は", "どうしよう", "最近どう", "元気"]) {
      expect(rankMemories(query({ text }), records)).toEqual([]);
    }
  });

  it("treats standalone conversational replies as ambiguous without blocking longer topical queries", () => {
    const records = [
      memory("request", "旅行のお願いをした"),
      memory("understood", "なるほどと思った映画"),
      memory("agreed", "たしかに面白い本"),
      memory("okay", "大丈夫だった薬"),
    ];

    for (const text of [
      "お願い", "なるほど", "たしかに", "大丈夫", "お願い。", " なるほど ",
      "お願いです", "なるほどね", "たしかにね", "大丈夫です",
      "大丈夫ですよね", "大丈夫でしたね",
    ]) {
      expect(rankMemories(query({ text }), records)).toEqual([]);
    }
    expect(rankMemories(query({ text: "旅行のお願いについて" }), records).map(({ id }) => id)).toEqual(["request"]);
    expect(rankMemories(query({ text: "大丈夫だった薬について" }), records).map(({ id }) => id)).toEqual(["okay"]);
    expect(rankMemories(query({ text: "薬は大丈夫です" }), records).map(({ id }) => id)).toEqual(["okay"]);
    expect(rankMemories(query({ text: "薬は大丈夫ですよね" }), records).map(({ id }) => id)).toEqual(["okay"]);
  });

  it("extracts only the immediately honorific-marked name without prefixes or particles", () => {
    expect(extractRelatedNames("昨日美咲さんに会って、その美咲さんの話をした。友人の佐藤さんもいた"))
      .toEqual(["美咲", "佐藤"]);
    expect(extractRelatedNames("お母さんと最近どう？")).toEqual([]);
  });

  it("uses memory ID as the final tie-breaker and never returns more than eight", () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      memory(`memory-${String(9 - index).padStart(2, "0")}`, `コーヒー豆その${index}`));

    expect(rankMemories(query({ text: "コーヒー豆" }), records).map(({ id }) => id)).toEqual([
      "memory-00",
      "memory-01",
      "memory-02",
      "memory-03",
      "memory-04",
      "memory-05",
      "memory-06",
      "memory-07",
    ]);
  });

  it("fails with a neutral error and never exposes repository or query content", async () => {
    const retriever = createMemoryRetriever({
      repository: {
        list: async () => { throw new Error("秘密の記憶本文と検索語"); },
      } as never,
    });

    await expect(retriever.retrieve(LOCAL_USER, query({ text: "秘密の検索語" })))
      .rejects.toThrow("Memory retrieval unavailable");
  });
});
