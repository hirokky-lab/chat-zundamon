import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { createMemoryRepository } from "../src/db";
import { createMemorySettingsRepository } from "../src/memory-settings";
import { LOCAL_USER, type RequestUser } from "../src/request-user";
import { confirmTestMemory } from "./test-memory.js";

const userA: RequestUser = { userId: "00000000-0000-0000-0000-00000000000a", email: "a@yui.invalid", accessToken: "a" };
const userB: RequestUser = { userId: "00000000-0000-0000-0000-00000000000b", email: "b@yui.invalid", accessToken: "b" };

describe("memory settings", () => {
  it("normalizes legacy controls into one fail-closed owner setting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-settings-legacy-"));
    const path = join(directory, "settings.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE memory_settings (
      user_id TEXT PRIMARY KEY,
      automatic_memory_enabled INTEGER NOT NULL,
      recall_memory_enabled INTEGER NOT NULL,
      voice_memory_enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database.prepare(`INSERT INTO memory_settings VALUES (?, ?, ?, ?, ?)`)
      .run(userA.userId, 1, 1, 1, "2026-08-11T00:00:00.000Z");
    database.prepare(`INSERT INTO memory_settings VALUES (?, ?, ?, ?, ?)`)
      .run(userB.userId, 1, 0, 1, "2026-08-11T00:00:00.000Z");
    database.close();

    const repository = createMemorySettingsRepository(path);
    await expect(repository.get(userA)).resolves.toMatchObject({ memoryEnabled: true });
    await expect(repository.get(userB)).resolves.toMatchObject({ memoryEnabled: false });
  });

  it("persists one owner memory setting with enabled defaults", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-settings-"));
    const path = join(directory, "settings.sqlite");
    const repository = createMemorySettingsRepository(path, () => new Date("2026-08-11T00:00:00.000Z"));

    expect(await repository.get(userA)).toEqual({ memoryEnabled: true, updatedAt: null });
    await repository.patch(userA, { memoryEnabled: false });

    expect(await createMemorySettingsRepository(path).get(userA)).toMatchObject({ memoryEnabled: false });
    expect(await repository.get(userB)).toEqual({ memoryEnabled: true, updatedAt: null });
  });

  it("keeps the single setting owner-scoped under concurrent writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-memory-settings-fields-"));
    const path = join(directory, "settings.sqlite");
    const firstTab = createMemorySettingsRepository(path);
    const secondTab = createMemorySettingsRepository(path);

    await Promise.all([
      firstTab.patch(userA, { memoryEnabled: false }),
      secondTab.patch(userA, { memoryEnabled: false }),
      firstTab.patch(userB, { memoryEnabled: true }),
    ]);

    await expect(firstTab.get(userA)).resolves.toMatchObject({ memoryEnabled: false });
    await expect(firstTab.get(userB)).resolves.toMatchObject({ memoryEnabled: true });
  });

  it("serves strict no-store settings while local automatic chat memory stays disabled", async () => {
    const extract = vi.fn(async () => ({ candidates: [], actions: [] }));
    const settings = createMemorySettingsRepository(":memory:");
    const app = buildApp({ extractor: { extract }, memorySettingsRepository: settings });

    const initial = await app.inject({ method: "GET", url: "/api/memory-settings" });
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/memory-settings",
      payload: { memoryEnabled: false },
    });
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/memory-settings",
      payload: { memoryEnabled: true, unexpected: false },
    });
    const processed = await app.inject({
      method: "POST",
      url: "/api/memory/process",
      payload: {
        sourceMessageId: "settings-message-1",
        sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      },
    });

    expect(initial.json().settings).toEqual({ memoryEnabled: true, updatedAt: null });
    expect(saved.json().settings).toMatchObject({ memoryEnabled: false });
    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(invalid.statusCode).toBe(400);
    expect(processed.statusCode).toBe(404);
    expect(processed.json()).toEqual({ error: "automatic_chat_memory_disabled" });
    expect(extract).not.toHaveBeenCalled();
  });

  it("backs recalled chat memories without changing stored records", async () => {
    const settings = createMemorySettingsRepository(":memory:");
    const respond = vi.fn(async () => ({
      outputText: JSON.stringify({ bubbles: ["わかった"], profileUpdate: null, memoryAction: null }),
    }));
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, memorySettingsRepository: settings, chatGateway: { respond } });
    await app.profileRepository.save(LOCAL_USER, "大禅");
    await confirmTestMemory(app.memoryRepository, LOCAL_USER, { kind: "preference", content: "コーヒーが好き", importance: 4 });
    await settings.patch(LOCAL_USER, { memoryEnabled: false });

    await app.inject({
      method: "POST",
      url: "/api/chat/responses",
      payload: { kind: "reply", clientMessageId: "00000000-0000-4000-8000-000000000099", turns: [{ role: "user", text: "コーヒーの話をしよう" }] },
    });

    expect(respond).toHaveBeenCalledOnce();
    expect(vi.mocked(respond).mock.calls[0]?.[0].instructions).not.toContain("コーヒーが好き");
    expect(await app.memoryRepository.list(LOCAL_USER)).toHaveLength(1);
  });

  it("fails closed for an explicit chat memory action while YUI memory is OFF", async () => {
    const settings = createMemorySettingsRepository(":memory:");
    const respond = vi.fn(async () => ({
      outputText: JSON.stringify({
        bubbles: ["わかった"],
        profileUpdate: null,
        memoryAction: {
          type: "add",
          candidate: {
            kind: "preference",
            scope: "daily",
            content: "コーヒーが好き",
            importance: 3,
            sourceOccurredAt: null,
            validFrom: null,
            validUntil: null,
            retention: null,
          },
        },
      }),
    }));
    const app = buildApp({ extractor: { extract: async () => ({ candidates: [] }) }, memorySettingsRepository: settings, chatGateway: { respond } });
    await app.profileRepository.save(LOCAL_USER, "大禅");
    await confirmTestMemory(app.memoryRepository, LOCAL_USER, { kind: "preference", content: "既存の記憶", importance: 4 });
    await settings.patch(LOCAL_USER, { memoryEnabled: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/responses",
      payload: { kind: "reply", clientMessageId: "00000000-0000-4000-8000-000000000098", turns: [{ role: "user", text: "コーヒーが好きだから覚えて" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(respond).mock.calls[0]?.[0].instructions).toContain("memoryActionは必ずnull");
    await expect(app.memoryRepository.list(LOCAL_USER)).resolves.toMatchObject([{ content: "既存の記憶" }]);
    expect(await app.memoryRepository.list(LOCAL_USER)).toHaveLength(1);
  });

  it.each(["after-claim", "after-cost", "provider", "outbox"] as const)("linearizes memory OFF against the %s boundary", async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), `yui-voice-off-${boundary}-`));
    const path = join(directory, "memory.sqlite");
    const repository = createMemoryRepository(path);
    const settings = createMemorySettingsRepository(path);
    let announce!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { announce = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const pause = async () => { announce(); await blocked; };
    const originalList = repository.listForRecall.bind(repository);
    if (boundary === "after-claim") {
      vi.spyOn(repository, "listForRecall").mockImplementationOnce(async (...args) => { await pause(); return originalList(...args); });
    }
    const originalSave = repository.saveAutomaticOutbox.bind(repository);
    if (boundary === "outbox") {
      vi.spyOn(repository, "saveAutomaticOutbox").mockImplementationOnce(async (...args) => {
        const saved = await originalSave(...args);
        await pause();
        return saved;
      });
    }
    const extract = vi.fn(async () => {
      if (boundary === "provider") await pause();
      return { candidates: [], actions: [{
        type: "add" as const,
        candidate: { kind: "routine" as const, scope: "daily" as const, content: "水曜は仕事帰りに図書館へ寄る", importance: 3 as const, sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null },
      }] };
    });
    const reserve = vi.fn(async () => {
      if (boundary === "after-cost") await pause();
      return { requestId: "voice-cost", settle: async () => undefined, hold: async () => undefined };
    });
    const app = buildApp({
      extractor: { extract },
      memoryRepository: repository,
      memorySettingsRepository: settings,
      costGuard: { reserve },
    });
    const sourceCharacter = boundary === "after-claim" ? "1" : boundary === "after-cost" ? "2" : boundary === "provider" ? "3" : "4";
    const sourceId = `voice:${sourceCharacter.repeat(64)}`;
    const payload = {
      sourceMessageId: sourceId,
      sourceOccurredAt: "2026-08-11T00:00:00.000Z",
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [],
      turns: [{ role: "user", text: "水曜日は仕事帰りに駅前の図書館へ寄って新刊を確認している", provenance: "authoritative_source" }],
    };

    const processing = app.inject({ method: "POST", url: "/api/memory/process", payload });
    await reached;
    let offSettled = false;
    const stopping = app.inject({ method: "PATCH", url: "/api/memory-settings", payload: { memoryEnabled: false } })
      .finally(() => { offSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(offSettled).toBe(false);
    release();

    await expect(processing).resolves.toMatchObject({ statusCode: 202 });
    const stopped = await stopping;
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().settings.memoryEnabled).toBe(false);
    expect(await repository.getAutomaticOutbox(LOCAL_USER, sourceId)).toBeNull();
    expect(await repository.list(LOCAL_USER)).toEqual([]);

    const claimCount = (await repository.getAutomaticProcessing(LOCAL_USER, sourceId)) ? 1 : 0;
    const costCount = reserve.mock.calls.length;
    const providerCount = extract.mock.calls.length;
    const laterSource = `voice:${"9".repeat(64)}`;
    const later = await app.inject({ method: "POST", url: "/api/memory/process", payload: { ...payload, sourceMessageId: laterSource } });
    expect(later.json()).toMatchObject({ state: "failed", appliedCount: 0 });
    expect(await repository.getAutomaticProcessing(LOCAL_USER, laterSource)).toBeNull();
    expect((await repository.getAutomaticProcessing(LOCAL_USER, sourceId)) ? 1 : 0).toBe(claimCount);
    expect(reserve).toHaveBeenCalledTimes(costCount);
    expect(extract).toHaveBeenCalledTimes(providerCount);
    if (boundary === "after-claim") {
      expect(reserve).not.toHaveBeenCalled();
      expect(extract).not.toHaveBeenCalled();
    }
    if (boundary === "after-cost") expect(extract).not.toHaveBeenCalled();
  });

  it("cleans a crash-stale local voice outbox on startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yui-voice-startup-cleanup-"));
    const path = join(directory, "memory.sqlite");
    const repository = createMemoryRepository(path);
    const source = `voice:${"6".repeat(64)}`;
    await repository.claimAutomaticProcessing(LOCAL_USER, source, "voice");
    const attempt = await repository.prepareAutomaticExtractionAttempt(LOCAL_USER, source);
    await repository.setAutomaticExtractionAttemptState(LOCAL_USER, source, attempt.attemptIndex, "dispatched");
    await repository.saveAutomaticOutbox(LOCAL_USER, source, { actions: [{ type: "add" }], usage: null, attemptIndex: attempt.attemptIndex });
    const observer = new DatabaseSync(path);
    observer.prepare("UPDATE automatic_memory_processing SET attempted_at = ? WHERE user_id = ? AND source_message_id = ?")
      .run("2026-08-11T00:00:00.000Z", LOCAL_USER.userId, source);
    observer.close();

    const app = buildApp({
      extractor: { extract: async () => ({ candidates: [], actions: [] }) },
      memoryRepository: repository,
      memorySettingsRepository: createMemorySettingsRepository(path),
      now: () => new Date("2026-08-11T00:05:00.001Z"),
    });
    await app.ready();

    expect(await repository.getAutomaticOutbox(LOCAL_USER, source)).toBeNull();
    expect(await repository.getAutomaticProcessing(LOCAL_USER, source)).toEqual({ state: "failed", appliedCount: 0, outboxRef: null });
  });
});
