import { beforeEach, describe, expect, it } from "vitest";
import type { LocalChatSnapshot } from "@yui/domain";
import {
  EMPTY_LOCAL_CHAT,
  createBrowserLocalStateStore,
  createIndexedDbLocalStateStore,
  createMemoryLocalStateStore,
  type LocalStateStore,
} from "../src/local-state";

const databaseName = "zundamon-ai-local";

const sendingSnapshot: LocalChatSnapshot = {
  ...EMPTY_LOCAL_CHAT,
  timeline: [{
    id: "message-1",
    type: "message",
    role: "user",
    text: "ただいま",
    createdAt: "2026-08-08T12:00:00.000Z",
    delivery: "sending",
  }],
};

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test database is blocked"));
  });
}

function writeRawSnapshot(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("state", "readwrite");
      transaction.objectStore("state").put(value, "current");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    };
  });
}

beforeEach(async () => {
  await deleteDatabase(databaseName);
});

function localStateStoreContract(
  name: string,
  createStore: () => LocalStateStore,
  reload: (store: LocalStateStore) => LocalStateStore,
) {
  describe(name, () => {
    it("loads a fresh canonical empty snapshot", async () => {
      const store = createStore();
      const first = await store.load();
      first.timeline.push(sendingSnapshot.timeline[0]);

      expect(await reload(store).load()).toEqual(EMPTY_LOCAL_CHAT);
    });

    it("saves and reloads a chat snapshot", async () => {
      const store = createStore();
      await store.save(sendingSnapshot);

      expect(await reload(store).load()).toEqual(sendingSnapshot);
    });

    it("replaces a duplicate timeline ID instead of persisting two messages", async () => {
      const store = createStore();
      await store.save({
        ...sendingSnapshot,
        timeline: [
          sendingSnapshot.timeline[0],
          { ...sendingSnapshot.timeline[0], delivery: "sent" },
        ],
      });

      expect((await reload(store).load()).timeline).toEqual([
        { ...sendingSnapshot.timeline[0], delivery: "sent" },
      ]);
    });

    it("preserves sending and failed delivery statuses through reload", async () => {
      const store = createStore();
      await store.save({
        ...sendingSnapshot,
        timeline: [
          sendingSnapshot.timeline[0],
          { ...sendingSnapshot.timeline[0], id: "message-2", delivery: "failed" },
        ],
      });

      expect((await reload(store).load()).timeline).toMatchObject([
        { id: "message-1", delivery: "sending" },
        { id: "message-2", delivery: "failed" },
      ]);
    });

    it("saves and reloads grouped assistant metadata", async () => {
      const store = createStore();
      const snapshot: LocalChatSnapshot = {
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          {
            id: "message-1:assistant:0",
            type: "message",
            role: "assistant",
            text: "おかえり",
            createdAt: "2026-08-08T12:00:00.000Z",
            delivery: "sent",
            replyGroupId: "message-1:assistant",
            sequence: 0,
          },
          {
            id: "message-1:assistant:1",
            type: "message",
            role: "assistant",
            text: "今日は大変だったね",
            createdAt: "2026-08-08T12:00:00.000Z",
            delivery: "sent",
            replyGroupId: "message-1:assistant",
            sequence: 1,
          },
        ],
      };

      await store.save(snapshot);

      expect(await reload(store).load()).toEqual(snapshot);
    });

    it("keeps a legacy ungrouped assistant message readable", async () => {
      const store = createStore();
      const snapshot: LocalChatSnapshot = {
        ...EMPTY_LOCAL_CHAT,
        timeline: [{
          id: "legacy-assistant",
          type: "message",
          role: "assistant",
          text: "前の形式の返事",
          createdAt: "2026-08-08T11:59:00.000Z",
          delivery: "sent",
        }],
      };

      await store.save(snapshot);

      expect(await reload(store).load()).toEqual(snapshot);
    });

    it("ignores the obsolete pending-name value while preserving the legacy timeline", async () => {
      const store = createStore();
      const snapshot: LocalChatSnapshot = {
        ...EMPTY_LOCAL_CHAT,
        pendingDisplayName: "旧名",
        timeline: [{
          id: "legacy-assistant",
          type: "message",
          role: "assistant",
          text: "前の形式の返事",
          createdAt: "2026-08-08T11:59:00.000Z",
          delivery: "sent",
        }],
      };

      await store.save(snapshot);

      expect(await reload(store).load()).toEqual({
        ...snapshot,
        pendingDisplayName: null,
      });
    });

    it("persists call cards without a transcript field", async () => {
      const store = createStore();
      await store.save({
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          {
            id: "call-1",
            type: "call",
            startedAt: "2026-08-08T12:00:00.000Z",
            endedAt: "2026-08-08T12:05:00.000Z",
            text: "保存してはいけない文字起こし",
          } as unknown as LocalChatSnapshot["timeline"][number],
        ],
      });

      const [card] = (await reload(store).load()).timeline;
      expect(card).toEqual({
        id: "call-1",
        type: "call",
        startedAt: "2026-08-08T12:00:00.000Z",
        endedAt: "2026-08-08T12:05:00.000Z",
      });
      expect("text" in card).toBe(false);
    });
  });
}

localStateStoreContract(
  "memory local state",
  () => createMemoryLocalStateStore(),
  (store) => store,
);

localStateStoreContract(
  "IndexedDB local state",
  () => createIndexedDbLocalStateStore({ indexedDB, databaseName }),
  () => createIndexedDbLocalStateStore({ indexedDB, databaseName }),
);

describe("IndexedDB local state corruption", () => {
  it("preserves the durable profile-flow marker through reload", async () => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    const snapshot: LocalChatSnapshot = {
      ...EMPTY_LOCAL_CHAT,
      timeline: [{
        id: "name-question",
        type: "message",
        role: "assistant",
        text: "名前を教えてください",
        createdAt: "2026-08-08T12:00:00.000Z",
        delivery: "sent",
        flow: "profile",
      }],
    };
    await store.save(snapshot);

    expect(await createIndexedDbLocalStateStore({ indexedDB, databaseName }).load()).toEqual(snapshot);
  });

  it("fails closed to an empty snapshot when stored state is malformed", async () => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    await store.load();
    await writeRawSnapshot({ ...EMPTY_LOCAL_CHAT, timeline: [{ id: "broken", type: "message" }] });

    expect(await store.load()).toEqual(EMPTY_LOCAL_CHAT);
  });

  it("keeps a legacy message while discarding an unknown flow marker", async () => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    await store.load();
    await writeRawSnapshot({
      ...sendingSnapshot,
      timeline: [{ ...sendingSnapshot.timeline[0], flow: "legacy-setup" }],
    });

    expect(await store.load()).toEqual(sendingSnapshot);
  });

  it("keeps a legacy user message while discarding assistant-only reply metadata", async () => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    await store.load();
    await writeRawSnapshot({
      ...sendingSnapshot,
      timeline: [{
        ...sendingSnapshot.timeline[0],
        replyGroupId: "legacy-group",
        sequence: 0,
      }],
    });

    expect(await store.load()).toEqual(sendingSnapshot);
  });

  it("keeps a legacy message with an empty ID", async () => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    await store.load();
    const snapshot = {
      ...sendingSnapshot,
      timeline: [{ ...sendingSnapshot.timeline[0], id: "" }],
    };
    await writeRawSnapshot(snapshot);

    expect(await store.load()).toEqual(snapshot);
  });

  it.each([
    ["message createdAt", { ...sendingSnapshot, timeline: [{ ...sendingSnapshot.timeline[0], createdAt: "2026-02-30T12:00:00.000Z" }] }],
    ["call startedAt", { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "call-1", type: "call", startedAt: "not-a-date", endedAt: "2026-08-08T12:05:00.000Z" }] }],
    ["call endedAt", { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "call-1", type: "call", startedAt: "2026-08-08T12:00:00.000Z", endedAt: "not-a-date" }] }],
    ["lastOpeningAt", { ...EMPTY_LOCAL_CHAT, lastOpeningAt: "not-a-date" }],
    ["lastConversationAt", { ...EMPTY_LOCAL_CHAT, lastConversationAt: "2026-02-30T12:00:00.000Z" }],
    ["partial grouped reply metadata", { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "message-1:assistant:0", type: "message", role: "assistant", text: "おかえり", createdAt: "2026-08-08T12:00:00.000Z", delivery: "sent", replyGroupId: "message-1:assistant" }] }],
    ["empty grouped reply ID", { ...EMPTY_LOCAL_CHAT, timeline: [{ id: ":0", type: "message", role: "assistant", text: "おかえり", createdAt: "2026-08-08T12:00:00.000Z", delivery: "sent", replyGroupId: "", sequence: 0 }] }],
    ["mismatched grouped reply ID", { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "other:0", type: "message", role: "assistant", text: "おかえり", createdAt: "2026-08-08T12:00:00.000Z", delivery: "sent", replyGroupId: "message-1:assistant", sequence: 0 }] }],
    ["out-of-range grouped reply sequence", { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "message-1:assistant:3", type: "message", role: "assistant", text: "おかえり", createdAt: "2026-08-08T12:00:00.000Z", delivery: "sent", replyGroupId: "message-1:assistant", sequence: 3 }] }],
  ])("fails closed when persisted %s is not canonical", async (_field, corruptedSnapshot) => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    await store.load();
    await writeRawSnapshot(corruptedSnapshot);

    expect(await store.load()).toEqual(EMPTY_LOCAL_CHAT);
  });

  it("loads a legacy local snapshot but discards reviewed dates", async () => {
    const store = createIndexedDbLocalStateStore({ indexedDB, databaseName });
    await store.load();
    await writeRawSnapshot({ ...sendingSnapshot, reviewedLocalDates: ["2026-08-07"] });

    expect(await store.load()).toEqual(sendingSnapshot);
  });
});

describe("browser local state", () => {
  it("uses session memory when IndexedDB cannot open", async () => {
    const unavailableIndexedDb = {
      open() {
        throw new Error("IndexedDB disabled");
      },
    } as unknown as IDBFactory;

    const result = await createBrowserLocalStateStore({ indexedDB: unavailableIndexedDb });
    await result.store.save(sendingSnapshot);

    expect(result.persistent).toBe(false);
    expect(await result.store.load()).toEqual(sendingSnapshot);
  });

  it("uses session memory when the first IndexedDB transaction fails", async () => {
    const transactionFailingIndexedDb = {
      open() {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => {
          Object.assign(request, {
            result: {
              close() {},
              transaction() {
                throw new Error("IndexedDB transaction disabled");
              },
            },
          });
          request.onsuccess?.(new Event("success"));
        });
        return request;
      },
    } as unknown as IDBFactory;

    const result = await createBrowserLocalStateStore({
      indexedDB: transactionFailingIndexedDb,
    });

    expect(result.persistent).toBe(false);
    expect(await result.store.load()).toEqual(EMPTY_LOCAL_CHAT);
  });
});
