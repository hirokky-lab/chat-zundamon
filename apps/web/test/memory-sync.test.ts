import { describe, expect, it, vi } from "vitest";
import type { LocalChatSnapshot } from "@yui/domain";
import {
  createMemorySyncQueue,
  selectMemorySyncTurns,
  type AutomaticMemoryTurn,
  type PendingMemorySync,
} from "../src/memory-sync";

const now = "2026-08-11T00:00:00.000Z";
const turns: AutomaticMemoryTurn[] = [
  { role: "user", text: "朝は紅茶が好き", provenance: "authoritative_source" },
  { role: "assistant", text: "覚えておくと役立ちそうだね", provenance: "context" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options: {
  ready?: () => Promise<void>;
  enabled?: () => boolean;
  process?: ReturnType<typeof vi.fn>;
  initial?: PendingMemorySync[];
  loadPending?: () => Promise<PendingMemorySync[]>;
  savePending?: (pending: PendingMemorySync[]) => Promise<void>;
} = {}) {
  let persisted = options.initial ?? [];
  const saves: PendingMemorySync[][] = [];
  const process = options.process ?? vi.fn(async (input) => ({
    sourceMessageId: input.sourceMessageId,
    state: "completed",
    appliedCount: 1,
  }));
  const queue = createMemorySyncQueue({
    process,
    loadPending: options.loadPending ?? (async () => persisted),
    savePending: options.savePending ?? (async (pending) => {
      persisted = pending;
      saves.push(structuredClone(pending));
    }),
    ready: options.ready,
    automaticMemoryEnabled: options.enabled,
    now: () => now,
  });
  return { queue, process, saves, get persisted() { return persisted; } };
}

describe("MemorySyncQueue", () => {
  it("waits for reply rendering and snapshot persistence before processing", async () => {
    const replyRendered = deferred<void>();
    const snapshotSaved = deferred<void>();
    const ready = vi.fn(async () => {
      await Promise.all([replyRendered.promise, snapshotSaved.promise]);
    });
    const state = harness({ ready });

    await state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });
    expect(state.process).not.toHaveBeenCalled();
    replyRendered.resolve();
    await Promise.resolve();
    expect(state.process).not.toHaveBeenCalled();
    snapshotSaved.resolve();
    await state.queue.whenIdle();

    expect(state.process).toHaveBeenCalledOnce();
  });

  it("persists only source identity and retry metadata, never turns", async () => {
    const processing = deferred<{ sourceMessageId: string; state: "completed"; appliedCount: number }>();
    const state = harness({ process: vi.fn(() => processing.promise) });

    await state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });

    expect(state.saves[0]).toEqual([{ sourceMessageId: "message-1", sourceOccurredAt: now, attempts: 0 }]);
    expect(JSON.stringify(state.saves[0])).not.toContain(turns[0]?.text);
    processing.resolve({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 });
    await state.queue.whenIdle();
  });

  it("keeps failed work and retries it from the existing snapshot on hydration", async () => {
    const process = vi.fn()
      .mockResolvedValueOnce({ sourceMessageId: "message-1", state: "failed", appliedCount: 0 })
      .mockResolvedValueOnce({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 });
    const first = harness({ process });
    await first.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });
    await first.queue.whenIdle();
    expect(first.persisted).toEqual([{ sourceMessageId: "message-1", sourceOccurredAt: now, attempts: 1 }]);

    const retry = harness({ process, initial: first.persisted });
    await retry.queue.hydrate();
    await retry.queue.whenIdle();

    expect(retry.persisted).toEqual([]);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it("keeps stale cross-tab work pending when the server reports automatic memory paused", async () => {
    const process = vi.fn(async () => ({ sourceMessageId: "stale-tab", state: "failed" as const, appliedCount: 0 }));
    const state = harness({ process });

    await state.queue.enqueue({ sourceMessageId: "stale-tab", sourceOccurredAt: now });
    await state.queue.whenIdle();

    expect(state.persisted).toEqual([{ sourceMessageId: "stale-tab", sourceOccurredAt: now, attempts: 1 }]);
  });

  it("deduplicates a source id while it is pending", async () => {
    const processing = deferred<{ sourceMessageId: string; state: "completed"; appliedCount: number }>();
    const state = harness({ process: vi.fn(() => processing.promise) });

    await state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });
    await state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });
    expect(state.process).toHaveBeenCalledOnce();
    expect(state.persisted).toHaveLength(1);
    processing.resolve({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 });
    await state.queue.whenIdle();
  });

  it("keeps pending work when cancellation wins over a late response", async () => {
    const processing = deferred<{ sourceMessageId: string; state: "completed"; appliedCount: number }>();
    const state = harness({ process: vi.fn(() => processing.promise) });

    await state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });
    state.queue.cancel();
    processing.resolve({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(state.persisted).toEqual([{ sourceMessageId: "message-1", sourceOccurredAt: now, attempts: 0 }]);
  });

  it("does not start work when cancellation happens while enqueue persistence is pending", async () => {
    const saving = deferred<void>();
    const state = harness({ savePending: vi.fn(() => saving.promise) });

    const enqueue = state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });
    await Promise.resolve();
    state.queue.cancel();
    saving.resolve();
    await enqueue;

    expect(state.process).not.toHaveBeenCalled();
  });

  it("does not hydrate or start work when cancellation happens during pending load", async () => {
    const loading = deferred<PendingMemorySync[]>();
    const state = harness({ loadPending: vi.fn(() => loading.promise) });

    const hydrate = state.queue.hydrate();
    state.queue.cancel();
    loading.resolve([{ sourceMessageId: "message-1", sourceOccurredAt: now, attempts: 0 }]);
    await hydrate;

    expect(state.process).not.toHaveBeenCalled();
  });

  it("does not enqueue, process, or delete pending data while automatic memory is off", async () => {
    const initial = [{ sourceMessageId: "old-message", sourceOccurredAt: now, attempts: 2 }];
    const state = harness({ initial, enabled: () => false });

    await state.queue.hydrate();
    await state.queue.enqueue({ sourceMessageId: "message-1", sourceOccurredAt: now });

    expect(state.process).not.toHaveBeenCalled();
    expect(state.saves).toEqual([]);
    expect(state.persisted).toEqual(initial);
  });

});

describe("selectMemorySyncTurns", () => {
  it("never sends external context or its immediate referential followup to automatic memory", () => {
    const snapshot: LocalChatSnapshot = {
      timeline: [
        { id: "calendar-1", type: "message", role: "user", text: "今日の予定を教えて", createdAt: now, delivery: "sent" },
        { id: "calendar-1:assistant:0", type: "message", role: "assistant", text: "RAW_EXTERNAL_SENTINEL", createdAt: now, delivery: "sent", flow: "external_context", replyGroupId: "calendar-1:assistant", sequence: 0 },
        { id: "remember-1", type: "message", role: "user", text: "それを覚えておいて", createdAt: now, delivery: "sent" },
        { id: "remember-1:assistant:0", type: "message", role: "assistant", text: "わかったよ", createdAt: now, delivery: "sent", replyGroupId: "remember-1:assistant", sequence: 0 },
        { id: "normal-1", type: "message", role: "user", text: "紅茶が好き", createdAt: now, delivery: "sent" },
        { id: "normal-1:assistant:0", type: "message", role: "assistant", text: "覚えておくね", createdAt: now, delivery: "sent", replyGroupId: "normal-1:assistant", sequence: 0 },
      ],
      draft: "", pendingDisplayName: null, lastOpeningAt: null, lastConversationAt: now,
    };
    expect(selectMemorySyncTurns(snapshot, "calendar-1")).toEqual([]);
    expect(selectMemorySyncTurns(snapshot, "remember-1")).toEqual([]);
    const normal = selectMemorySyncTurns(snapshot, "normal-1");
    expect(normal).toEqual([
      { role: "user", text: "紅茶が好き", provenance: "authoritative_source" },
      { role: "assistant", text: "覚えておくね", provenance: "context" },
    ]);
    expect(JSON.stringify(normal)).not.toContain("RAW_EXTERNAL_SENTINEL");
  });
  it("never sends a web-search query or result to automatic memory, including as later context", () => {
    const snapshot: LocalChatSnapshot = {
      timeline: [
        { id: "search-1", type: "message", role: "user", text: "最新情報を検索して", createdAt: now, delivery: "sent" },
        { id: "search-1:assistant:0", type: "message", role: "assistant", text: "検索結果の本文", createdAt: now, delivery: "sent", replyGroupId: "search-1:assistant", sequence: 0, search: { status: "completed", searchedAt: now, sources: [{ title: "公式", url: "https://example.com/" }], evidence: { facts: [{ text: "検索結果の本文", sourceUrl: "https://example.com/" }], inference: null, suggestion: null } } },
        { id: "normal-1", type: "message", role: "user", text: "今日は紅茶が好き", createdAt: now, delivery: "sent" },
        { id: "normal-1:assistant:0", type: "message", role: "assistant", text: "覚えておくね", createdAt: now, delivery: "sent", replyGroupId: "normal-1:assistant", sequence: 0 },
      ],
      draft: "",
      pendingDisplayName: null,
      lastOpeningAt: null,
      lastConversationAt: now,
    };

    expect(selectMemorySyncTurns(snapshot, "search-1")).toEqual([]);
    const normalTurns = selectMemorySyncTurns(snapshot, "normal-1");
    expect(normalTurns).toEqual([
      { role: "user", text: "今日は紅茶が好き", provenance: "authoritative_source" },
      { role: "assistant", text: "覚えておくね", provenance: "context" },
    ]);
    expect(JSON.stringify(normalTurns)).not.toContain("検索");
  });

  it("reconstructs a bounded turn window through the saved assistant reply", () => {
    const timeline = Array.from({ length: 14 }, (_, index) => ({
      id: index === 10 ? "message-1" : index > 10 ? `message-1:assistant:${index - 11}` : `old-${index}`,
      type: "message" as const,
      role: index === 10 || (index < 10 && index % 2 === 0) ? "user" as const : "assistant" as const,
      text: `本文${index}`,
      createdAt: `2026-08-10T23:59:${String(index).padStart(2, "0")}.000Z`,
      delivery: "sent" as const,
      ...(index > 10
        ? { replyGroupId: "message-1:assistant", sequence: index - 11 }
        : index < 10 && index % 2 === 1
          ? { replyGroupId: `old-${index - 1}:assistant`, sequence: 0 }
          : {}),
    }));
    const snapshot: LocalChatSnapshot = {
      timeline,
      draft: "",
      pendingDisplayName: null,
      lastOpeningAt: null,
      lastConversationAt: now,
    };

    const selected = selectMemorySyncTurns(snapshot, "message-1");

    expect(selected).toHaveLength(12);
    expect(selected.at(-1)).toEqual({ role: "assistant", text: "本文13", provenance: "context" });
    expect(selected.some((turn) => turn.text === "本文10")).toBe(true);
    expect(selected.filter((turn) => turn.provenance === "authoritative_source")).toEqual([
      { role: "user", text: "本文10", provenance: "authoritative_source" },
    ]);
  });

  it("excludes failed user messages and marks only the successful source as authoritative", () => {
    const snapshot: LocalChatSnapshot = {
      timeline: [
        { id: "failed-a", type: "message", role: "user", text: "失敗したA", createdAt: now, delivery: "failed" },
        { id: "message-b", type: "message", role: "user", text: "成功したB", createdAt: now, delivery: "sent" },
        { id: "message-b:assistant:0", type: "message", role: "assistant", text: "Bへの返答", createdAt: now, delivery: "sent", replyGroupId: "message-b:assistant", sequence: 0 },
      ],
      draft: "",
      pendingDisplayName: null,
      lastOpeningAt: null,
      lastConversationAt: now,
    };

    expect(selectMemorySyncTurns(snapshot, "message-b")).toEqual([
      { role: "user", text: "成功したB", provenance: "authoritative_source" },
      { role: "assistant", text: "Bへの返答", provenance: "context" },
    ]);
  });
});
