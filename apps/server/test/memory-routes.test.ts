import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import type { MemoryExtractor } from "../src/memory-extractor";
import { LOCAL_USER } from "../src/request-user";
import type { MemoryCandidateV2 } from "../../../packages/domain/src/index.js";
import type { RequestUser } from "../src/request-user";
import { confirmTestMemory } from "./test-memory.js";

const OTHER_USER: RequestUser = {
  userId: "00000000-0000-0000-0000-000000000002",
  email: "other@yui.invalid",
  accessToken: "other",
};

const editableCandidate: MemoryCandidateV2 = {
  kind: "preference",
  scope: "shared",
  content: "ブラックコーヒーが好き",
  origin: "manual",
  sensitivity: "normal",
  importance: 4,
  sourceMessageId: "message-source-1",
  sourceOccurredAt: "2026-08-10T23:59:00.000Z",
  validFrom: null,
  validUntil: null,
  expiresAt: "2026-09-10T00:00:00.000Z",
  pinned: false,
  supersedesId: null,
};

function fakeExtractor(candidates: unknown): MemoryExtractor {
  return {
    extract: async () => ({ candidates }) as Awaited<
      ReturnType<MemoryExtractor["extract"]>
    >,
  };
}

describe("memory routes", () => {
  it("edits and pins only an owned memory after strict policy validation", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const owned = await app.memoryRepository.create(LOCAL_USER, editableCandidate);
    const foreign = await app.memoryRepository.create(OTHER_USER, { ...editableCandidate, content: "他人の紅茶" });

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/memories/${owned.id}`,
      payload: { content: "最近はカフェラテが好き", pinned: true },
    });
    const foreignEdit = await app.inject({
      method: "PATCH",
      url: `/api/memories/${foreign.id}`,
      payload: { pinned: true },
    });

    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toEqual({ memory: expect.objectContaining({
      id: owned.id,
      content: "最近はカフェラテが好き",
      normalizedContent: "最近はカフェラテが好き",
      pinned: true,
      expiresAt: null,
    }) });
    expect(foreignEdit.statusCode).toBe(404);
    expect(foreignEdit.json()).toEqual({ error: "memory_not_found" });
    expect((await app.memoryRepository.list(OTHER_USER))[0]).toMatchObject({ id: foreign.id, pinned: false });
  });

  it("rejects duplicate, secret, empty, and extra-key edits without leaking their content", async () => {
    const logLines: string[] = [];
    const app = buildApp({ extractor: fakeExtractor([]), logger: { level: "info", stream: { write: (line: string) => logLines.push(line) } } });
    const target = await app.memoryRepository.create(LOCAL_USER, editableCandidate);
    await app.memoryRepository.create(LOCAL_USER, { ...editableCandidate, content: "紅茶が好き" });
    const secret = "パスワードは hunter2";

    const duplicate = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: " 紅茶が、好き。 " } });
    const rejectedSecret = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: secret } });
    const empty = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: {} });
    const extra = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { pinned: true, contentCopy: secret } });

    for (const response of [duplicate, rejectedSecret, empty, extra]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_memory_update" });
      expect(response.body).not.toContain("紅茶");
      expect(response.body).not.toContain("hunter2");
    }
    expect(logLines.join("\n")).not.toContain("hunter2");
    expect((await app.memoryRepository.list(LOCAL_USER)).find(({ id }) => id === target.id)).toMatchObject({ content: editableCandidate.content, pinned: false });
  });

  it("reclassifies edited sensitive content and returns a neutral persistence failure", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const target = await app.memoryRepository.create(LOCAL_USER, editableCandidate);
    const sensitive = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: "偏頭痛で通院している" } });

    expect(sensitive.statusCode).toBe(200);
    expect(sensitive.json().memory).toMatchObject({ sensitivity: "sensitive" });

    const update = vi.spyOn(app.memoryRepository, "update").mockRejectedValueOnce(new Error("private persistence details"));
    const failed = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { pinned: true } });
    expect(update).toHaveBeenCalledOnce();
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "memory_update_unavailable" });
    expect(failed.body).not.toContain("private persistence details");
  });

  it("lists time-expired memories as expired and does not revive them on edit", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const target = await app.memoryRepository.create(LOCAL_USER, { ...editableCandidate, expiresAt: "2000-01-01T00:00:00.000Z" });
    const listed = await app.inject({ method: "GET", url: "/api/memories" });
    expect(listed.json().memories).toContainEqual(expect.objectContaining({ id: target.id, status: "expired" }));

    const edited = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: "期限切れの内容を修正", pinned: true } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().memory).toMatchObject({ status: "expired", pinned: true });
  });

  it("never downgrades an existing sensitive memory when edited text is classifier-uncertain", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const target = await app.memoryRepository.create(LOCAL_USER, { ...editableCandidate, content: "糖尿病で通院中", sensitivity: "sensitive" });

    const response = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: "体のことは今度話す" } });

    expect(response.statusCode).toBe(200);
    expect(response.json().memory).toMatchObject({ content: "体のことは今度話す", sensitivity: "sensitive" });
  });

  it("does not let a manual edit recreate an active tombstone paraphrase", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const forgotten = await app.memoryRepository.create(LOCAL_USER, { ...editableCandidate, content: "友達と昼食を食べた" });
    await app.memoryRepository.forget(LOCAL_USER, forgotten.id, true);
    const target = await app.memoryRepository.create(LOCAL_USER, { ...editableCandidate, content: "紅茶が好き" });

    const blocked = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: "昼食を友達と食べた" } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toEqual({ error: "invalid_memory_update" });

    const [tombstone] = await app.memoryRepository.listActiveTombstones(LOCAL_USER);
    await app.memoryRepository.releaseTombstone(LOCAL_USER, tombstone!.id);
    const allowed = await app.inject({ method: "PATCH", url: `/api/memories/${target.id}`, payload: { content: "昼食を友達と食べた" } });
    expect(allowed.statusCode).toBe(200);
  });

  it("forgets an owned memory with an optional relearning block and releases only its tombstone", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const blocked = await app.memoryRepository.create(LOCAL_USER, editableCandidate);
    const unblocked = await app.memoryRepository.create(LOCAL_USER, { ...editableCandidate, content: "紅茶が好き" });
    const foreign = await app.memoryRepository.create(OTHER_USER, { ...editableCandidate, content: "他人の記憶" });

    const forgotBlocked = await app.inject({ method: "POST", url: `/api/memories/${blocked.id}/forget`, payload: { blockRelearning: true } });
    const forgotUnblocked = await app.inject({ method: "POST", url: `/api/memories/${unblocked.id}/forget`, payload: { blockRelearning: false } });
    const forgotForeign = await app.inject({ method: "POST", url: `/api/memories/${foreign.id}/forget`, payload: { blockRelearning: true } });
    const tombstones = await app.inject({ method: "GET", url: "/api/memory-tombstones" });
    const [tombstone] = tombstones.json().tombstones;

    expect(forgotBlocked.statusCode).toBe(204);
    expect(forgotUnblocked.statusCode).toBe(204);
    expect(forgotForeign.statusCode).toBe(404);
    expect(tombstones.statusCode).toBe(200);
    expect(tombstone).toEqual(expect.objectContaining({ memoryId: blocked.id }));
    expect(JSON.stringify(tombstone)).not.toContain(editableCandidate.content);

    const released = await app.inject({ method: "POST", url: `/api/memory-tombstones/${tombstone.id}/release`, payload: {} });
    const releasedAgain = await app.inject({ method: "POST", url: `/api/memory-tombstones/${tombstone.id}/release`, payload: {} });
    expect(released.statusCode).toBe(204);
    expect(releasedAgain.statusCode).toBe(404);
    expect(await app.memoryRepository.listActiveTombstones(LOCAL_USER)).toEqual([]);
    expect(await app.memoryRepository.list(OTHER_USER)).toEqual([expect.objectContaining({ id: foreign.id })]);
  });

  it("uses strict forget and tombstone-release schemas", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const target = await app.memoryRepository.create(LOCAL_USER, editableCandidate);

    const missingChoice = await app.inject({ method: "POST", url: `/api/memories/${target.id}/forget`, payload: {} });
    const extra = await app.inject({ method: "POST", url: `/api/memories/${target.id}/forget`, payload: { blockRelearning: false, content: "秘密" } });
    const invalidId = await app.inject({ method: "POST", url: "/api/memory-tombstones/not-an-id/release", payload: {} });
    const releaseExtra = await app.inject({ method: "POST", url: "/api/memory-tombstones/00000000-0000-4000-8000-000000000001/release", payload: { force: true } });

    expect(missingChoice.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(invalidId.statusCode).toBe(400);
    expect(releaseExtra.statusCode).toBe(400);
    expect(await app.memoryRepository.list(LOCAL_USER)).toHaveLength(1);
  });
  it("processes automatic memory actions and returns only a durable receipt", async () => {
    const app = buildApp({
      automaticChatMemoryMode: "hosted_authoritative_snapshot",
      memoryTurnSource: { load: async () => [{ role: "user", text: "朝は紅茶が好き", provenance: "authoritative_source" }] },
      extractor: {
        extract: async (_turns, options) => ({
          candidates: [],
          actions: options?.mode === "automatic" ? [{
            type: "add",
            candidate: {
              kind: "preference",
              scope: "daily",
              content: "朝は紅茶が好き",
              importance: 3,
              sourceOccurredAt: null,
              validFrom: null,
              validUntil: null,
              retention: null,
            },
          }] : [],
        }),
      },
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/memory/process",
      payload: {
        sourceMessageId: "message-route-1",
        sourceOccurredAt: "2026-08-10T23:59:00.000Z",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ sourceMessageId: "message-route-1", state: "completed", appliedCount: 1 });
    expect(JSON.stringify(response.json())).not.toContain("朝は紅茶が好き");
    expect(await app.memoryRepository.list(LOCAL_USER)).toHaveLength(1);
  });

  it("rejects local chat automatic memory before snapshot, cost, or extraction", async () => {
    const extract = vi.fn(async () => ({ candidates: [], actions: [] }));
    const source = { load: vi.fn() };
    const reserve = vi.fn();
    const app = buildApp({ extractor: { extract }, memoryTurnSource: source, costGuard: { reserve } as never });
    const response = await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: "message-local-1", sourceOccurredAt: "2026-08-10T23:59:00.000Z",
    } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "automatic_chat_memory_disabled" });
    expect(source.load).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  it("forces bounded voice memory to a dated concise gist and deduplicates duplicate end delivery", async () => {
    const transcript = "水曜日は仕事帰りに駅前の図書館へ寄って新刊を確認している。これを覚えておいて";
    const extract = vi.fn(async (_turns, options) => ({
      candidates: [],
      actions: options?.mode === "automatic" ? [{
        type: "add" as const,
        candidate: {
          kind: "routine" as const,
          scope: "daily" as const,
          content: "水曜は仕事帰りに図書館へ寄る",
          importance: 3 as const,
          sourceOccurredAt: null,
          validFrom: null,
          validUntil: null,
          retention: null,
        },
      }] : [],
    }));
    const app = buildApp({
      extractor: { extract },
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });
    const payload = {
      sourceMessageId: `voice:${"a".repeat(64)}`,
      sourceOccurredAt: "2026-08-10T23:58:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [0],
      turns: [
        { role: "user", text: transcript, provenance: "authoritative_source" },
        { role: "assistant", text: "保存できるまでは覚えたとは言わないよ", provenance: "context" },
        { role: "user", text: "うん", provenance: "authoritative_source" },
      ],
    };

    const first = await app.inject({ method: "POST", url: "/api/memory/process", payload });
    const duplicate = await app.inject({ method: "POST", url: "/api/memory/process", payload });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ sourceMessageId: payload.sourceMessageId, state: "completed", appliedCount: 1 });
    expect(duplicate.json()).toEqual(first.json());
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      mode: "automatic",
      sourceOrigin: "voice",
      explicitMemoryIntent: true,
    }));
    expect(vi.mocked(extract).mock.calls[0]?.[0]).toEqual([
      { role: "user", text: transcript, provenance: "authoritative_source" },
      { role: "user", text: "うん", provenance: "authoritative_source" },
    ]);
    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([
      expect.objectContaining({
        content: "水曜は仕事帰りに図書館へ寄る",
        origin: "voice",
        pinned: true,
        sourceMessageId: payload.sourceMessageId,
        sourceOccurredAt: payload.sourceOccurredAt,
      }),
    ]);
    expect(JSON.stringify(await app.memoryRepository.list(LOCAL_USER))).not.toContain(transcript);
  });

  it("drops quoted, verbatim, and full-transcript voice candidates", async () => {
    const transcript = "来月から毎週月曜の朝に公園を三周走る予定にしている";
    const app = buildApp({
      extractor: {
        extract: async () => ({
          candidates: [],
          actions: [
            { type: "add", candidate: { kind: "routine", scope: "daily", content: `「${transcript}」`, importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null } },
            { type: "add", candidate: { kind: "routine", scope: "daily", content: transcript, importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null } },
          ],
        }),
      },
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/memory/process",
      payload: {
        sourceMessageId: `voice:${"b".repeat(64)}`,
        sourceOccurredAt: "2026-08-10T23:58:00.000Z",
        sourceOrigin: "voice",
        explicitMemoryTargetTurnIndexes: [],
        turns: [{ role: "user", text: transcript, provenance: "authoritative_source" }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ state: "completed", appliedCount: 0 });
    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([]);
  });

  it.each([
    ["ASCII wrapper", "prefix 来月から毎週月曜の朝に公園を三周走る予定にしている suffix"],
    ["punctuation insertion", "来月、から。毎週！月曜の朝に公園を三周走る予定にしている"],
    ["Unicode guillemets", "«来月から毎週月曜の朝に公園を三周走る予定にしている»"],
    ["Unicode single guillemets", "‹来月から毎週月曜の朝に公園を三周走る予定にしている›"],
    ["Unicode CJK quotes", "〝来月から毎週月曜の朝に公園を三周走る予定にしている〟"],
    ["full-width wrapper", "ＰＲＥＦＩＸ：来月から毎週月曜の朝に公園を三周走る予定にしている：ＳＵＦＦＩＸ"],
    ["format characters", "来月から毎週\u200b月曜の朝に公園を三周走る予定にしている"],
  ])("drops voice text copied through %s", async (_name, candidateContent) => {
    const transcript = "来月から毎週月曜の朝に公園を三周走る予定にしている";
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [{ type: "add", candidate: { kind: "routine", scope: "daily", content: candidateContent, importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null } }] }) },
    });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"7".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: transcript, provenance: "authoritative_source" }],
    } });

    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([]);
  });

  it.each([
    ["one-character substitution", "赤い傘を売った"],
    ["one-character insertion", "赤い傘を新買った"],
    ["one-character deletion", "赤い傘買った"],
  ])("drops a short voice copy with %s", async (_name, candidateContent) => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [{
        type: "add",
        candidate: { kind: "preference", scope: "daily", content: candidateContent, importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
      }] }) },
    });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"6".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: "赤い傘を買った", provenance: "authoritative_source" }],
    } });

    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([]);
  });

  it.each([
    ["one-character substitution", "赤い傘を売った"],
    ["one-character insertion", "赤い傘を新買った"],
    ["one-character deletion", "赤い傘買った"],
  ])("drops a short voice copy with %s inside a longer utterance", async (_name, candidateContent) => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [{
        type: "add",
        candidate: { kind: "preference", scope: "daily", content: candidateContent, importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
      }] }) },
    });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"4".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: "今日は帰り道で赤い傘を買ったことを話した", provenance: "authoritative_source" }],
    } });

    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([]);
  });

  it("keeps a short grounded summary that is not a near-copy", async () => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [{
        type: "add",
        candidate: { kind: "preference", scope: "daily", content: "赤い傘を購入", importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
      }] }) },
    });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"5".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: "今日は帰り道で赤い傘を買ったことを話した", provenance: "authoritative_source" }],
    } });

    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([
      expect.objectContaining({ content: "赤い傘を購入", origin: "voice" }),
    ]);
  });

  it.each([
    ["an exact substantial span", "要旨では毎週土曜日に公園を散歩している習慣として記録"],
    ["a one-edit substantial span", "要旨では毎週土曜日に公園を散策している習慣として記録"],
  ])("drops a long wrapped voice candidate containing %s", async (_name, candidateContent) => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [{
        type: "add",
        candidate: { kind: "routine", scope: "daily", content: candidateContent, importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
      }] }) },
    });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"3".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: "本人の説明では毎週土曜日に公園を散歩している週末習慣で気分が整うとのこと", provenance: "authoritative_source" }],
    } });

    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([]);
  });

  it("keeps a long grounded gist without a substantial copied span", async () => {
    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [{
        type: "add",
        candidate: { kind: "routine", scope: "daily", content: "土曜日の公園散歩を週末習慣にする", importance: 3, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
      }] }) },
    });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"2".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: "本人の説明では毎週土曜日に公園を散歩している週末習慣で気分が整うとのこと", provenance: "authoritative_source" }],
    } });

    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([
      expect.objectContaining({ content: "土曜日の公園散歩を週末習慣にする", origin: "voice" }),
    ]);
  });

  it("drops assistant-only voice facts even when the extractor rephrases them", async () => {
    const extract = vi.fn(async () => ({ candidates: [], actions: [{
      type: "add" as const,
      candidate: { kind: "routine" as const, scope: "daily" as const, content: "週半ばに図書館へ通う習慣", importance: 3 as const, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
    }] }));
    const app = buildApp({ extractor: { extract } });

    await app.inject({ method: "POST", url: "/api/memory/process", payload: {
      sourceMessageId: `voice:${"8".repeat(64)}`,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [
        { role: "user", text: "今日は少し疲れた", provenance: "authoritative_source" },
        { role: "assistant", text: "毎週水曜は図書館へ行く習慣なんだね", provenance: "context" },
      ],
    } });

    expect(extract).toHaveBeenCalledWith(
      [{ role: "user", text: "今日は少し疲れた", provenance: "authoritative_source" }],
      expect.objectContaining({ sourceOrigin: "voice" }),
    );
    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([]);
  });

  it("does no claim, extraction, outbox, cost, or mutation when YUI memory is disabled", async () => {
    const extract = vi.fn(async () => ({ candidates: [], actions: [] }));
    const reserve = vi.fn();
    const app = buildApp({
      extractor: { extract },
      costGuard: { reserve },
      memoryEnabled: async () => false,
    });
    const existing = await app.memoryRepository.create(LOCAL_USER, editableCandidate);
    const claim = vi.spyOn(app.memoryRepository, "claimAutomaticProcessing");
    const saveOutbox = vi.spyOn(app.memoryRepository, "saveAutomaticOutbox");

    const response = await app.inject({
      method: "POST",
      url: "/api/memory/process",
      payload: {
        sourceMessageId: `voice:${"c".repeat(64)}`,
        sourceOccurredAt: "2026-08-10T23:58:00.000Z",
        sourceOrigin: "voice",
        explicitMemoryTargetTurnIndexes: [],
        turns: [{ role: "user", text: "朝は散歩する", provenance: "authoritative_source" }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ state: "failed", appliedCount: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(saveOutbox).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([expect.objectContaining({ id: existing.id })]);
  });

  it.each([
    { sourceMessageId: "", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: "message-1", sourceOccurredAt: "not-a-date", turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [] },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: Array.from({ length: 13 }, (_, index) => ({ role: "user", text: "本文", provenance: index === 0 ? "authoritative_source" : "context" })) },
    { sourceMessageId: "message with spaces", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: "sk-proj-abcdefghijklmnopqrstuvwxyz012345", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "x".repeat(4_001), provenance: "authoritative_source" }] },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: Array.from({ length: 4 }, (_, index) => ({ role: index === 0 ? "user" : "assistant", text: "x".repeat(3_500), provenance: index === 0 ? "authoritative_source" : "context" })) },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "本文", provenance: "context" }] },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "assistant", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }, { role: "user", text: "本文2", provenance: "authoritative_source" }] },
    { sourceMessageId: `voice:${"0".repeat(64)}`, sourceOccurredAt: "2026-08-11T00:00:00.000Z", turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: `voice:${"d".repeat(64)}`, sourceOccurredAt: "2026-08-11T00:00:00.000Z", sourceOrigin: "voice", explicitMemoryTargetTurnIndexes: [], turns: [{ role: "assistant", text: "本文", provenance: "authoritative_source" }] },
    { sourceMessageId: `voice:${"e".repeat(64)}`, sourceOccurredAt: "2026-08-11T00:00:00.000Z", sourceOrigin: "voice", explicitMemoryTargetTurnIndexes: [], turns: [{ role: "user", text: "本文", provenance: "context" }] },
    { sourceMessageId: `voice:${"f".repeat(64)}`, sourceOccurredAt: "2026-08-11T00:00:00.000Z", sourceOrigin: "voice", explicitMemoryTargetTurnIndexes: [], turns: [{ role: "user", text: "本文", provenance: "authoritative_source" }], extra: "transcript" },
  ])("rejects malformed automatic processing input without extraction", async (payload) => {
    const extract = vi.fn(async () => ({ candidates: [], actions: [] }));
    const app = buildApp({ extractor: { extract } });

    const response = await app.inject({ method: "POST", url: "/api/memory/process", payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid memory processing request" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("lists, deletes, and exports confirmed memories without candidates", async () => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const saved = await confirmTestMemory(app.memoryRepository, LOCAL_USER, {
      kind: "shared",
      content: "朝は静かに過ごす",
      importance: 4,
    });

    const list = await app.inject({ method: "GET", url: "/api/memories" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      memories: [expect.objectContaining({ id: saved.id, content: "朝は静かに過ごす" })],
    });

    const exported = await app.inject({ method: "GET", url: "/api/memories/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toBe(
      'attachment; filename="yui-memories.json"',
    );
    expect(exported.headers["content-type"]).toContain("application/json");
    expect(exported.json()).toEqual({
      memories: [expect.objectContaining({ id: saved.id, content: "朝は静かに過ごす" })],
    });

    const legacyDelete = await app.inject({ method: "DELETE", url: `/api/memories/${saved.id}` });
    expect(legacyDelete.statusCode).toBe(404);
    expect(await app.memoryRepository.list(LOCAL_USER)).toEqual([expect.objectContaining({ id: saved.id })]);
  });

  it.each(["/api/memory/candidates", "/api/memories/confirm"])("does not expose the removed confirmation endpoint %s", async (url) => {
    const app = buildApp({ extractor: fakeExtractor([]) });
    const response = await app.inject({ method: "POST", url, payload: {} });
    expect(response.statusCode).toBe(404);
  });

});
