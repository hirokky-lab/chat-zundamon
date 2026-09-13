import { describe, expect, it } from "vitest";
import type { LocalChatSnapshot, RemoteChatSnapshot } from "@yui/domain";
import {
  CloudStateConflictError,
  createCloudLocalStateStore,
  getAuthoritativeRevisionCoordinator,
  type RemoteStateApi,
} from "../src/cloud-state";
import type { LocalStateStore } from "../src/local-state";

const now = "2026-08-10T06:30:00.000Z";
const localMessage = { id: "local", type: "message" as const, role: "user" as const, text: "古い端末履歴", createdAt: now, delivery: "sent" as const };
const remoteMessage = { id: "remote", type: "message" as const, role: "assistant" as const, text: "クラウド履歴", createdAt: now, delivery: "sent" as const };

function local(overrides: Partial<LocalChatSnapshot> = {}): LocalChatSnapshot {
  return { timeline: [], draft: "", pendingDisplayName: null, lastOpeningAt: null, lastConversationAt: null, ...overrides };
}

function remote(overrides: Partial<RemoteChatSnapshot> = {}): RemoteChatSnapshot {
  return { timeline: [], lastOpeningAt: null, lastConversationAt: null, version: 2, revision: 0, updatedAt: now, ...overrides };
}

function cache(initial: LocalChatSnapshot, events: string[] = []): LocalStateStore & { current(): LocalChatSnapshot } {
  let value = initial;
  return {
    load: async () => value,
    save: async (next) => { events.push("cache-save"); value = next; },
    current: () => value,
  };
}

describe("cloud local state", () => {
  it("does not overwrite another device's update when retrying an unresolved conflict",async()=>{
    let loads=0,writes=0;
    const store=createCloudLocalStateStore({remote:{load:async()=>remote({revision:loads++ ? 5 : 4,timeline:loads>1 ? [remoteMessage] : []}),save:async()=>{writes++;throw new CloudStateConflictError();}},cache:cache(local()),now:()=>now});
    await store.load();const stale=local({timeline:[localMessage]});
    await expect(store.save(stale)).rejects.toBeInstanceOf(CloudStateConflictError);
    await expect(store.save(stale)).rejects.toBeInstanceOf(CloudStateConflictError);
    expect(writes).toBe(1);
  });
  it("loads authoritative history when the device cache cannot be read",async()=>{
    const store=createCloudLocalStateStore({remote:{load:async()=>remote({timeline:[remoteMessage],revision:4}),save:async()=>{throw Error('unused');}},cache:{load:async()=>{throw Error('blocked');},save:async()=>{}},now:()=>now});
    await expect(store.load()).resolves.toMatchObject({timeline:[remoteMessage],draft:''});
    expect(store.getPersistenceWarning?.()).toContain('端末');
  });
  it("keeps a successful remote save authoritative after a cache failure, then recovers without a duplicate write",async()=>{
    let writes=0,blocked=true;
    const store=createCloudLocalStateStore({remote:{load:async()=>remote({revision:4}),save:async input=>{writes++;return {...input.snapshot,revision:input.expectedRevision+1};}},cache:{load:async()=>local(),save:async()=>{if(blocked)throw Error('quota');}},now:()=>now});
    await store.load();const snapshot=local({timeline:[remoteMessage]});
    await expect(store.save(snapshot)).resolves.toBeUndefined();expect(writes).toBe(1);
    expect(store.getPersistenceWarning?.()).toContain('端末');
    blocked=false;await store.save(snapshot);expect(writes).toBe(1);expect(store.getPersistenceWarning?.()).toBeNull();
  });
  it("serializes overlapping saves so each write uses the revision returned by the previous write", async () => {
    let finishFirst: ((snapshot: RemoteChatSnapshot) => void) | undefined;
    const saveInputs: Array<{ expectedRevision: number; snapshot: RemoteChatSnapshot }> = [];
    const store = createCloudLocalStateStore({
      remote: {
        load: async () => remote({ revision: 4 }),
        save: async (input) => {
          saveInputs.push(input);
          if (saveInputs.length === 1) {
            return new Promise<RemoteChatSnapshot>((resolve) => { finishFirst = resolve; });
          }
          return { ...input.snapshot, revision: 6, updatedAt: now };
        },
      },
      cache: cache(local()),
      now: () => now,
    });
    await store.load();

    const first = store.save(local({ timeline: [localMessage] }));
    const second = store.save(local({ timeline: [localMessage, remoteMessage] }));
    await Promise.resolve();

    expect(saveInputs).toHaveLength(1);
    expect(saveInputs[0]?.expectedRevision).toBe(4);
    finishFirst?.({ ...saveInputs[0]!.snapshot, revision: 5, updatedAt: now });
    await first;
    await second;

    expect(saveInputs).toHaveLength(2);
    expect(saveInputs[1]?.expectedRevision).toBe(5);
  });

  it("serializes a dedicated photo mutation and the following ordinary save on one hydrated revision", async () => {
    const ordinarySaves: number[] = [];
    const store = createCloudLocalStateStore({
      remote: {
        load: async () => remote({ revision: 4 }),
        save: async (input) => {
          ordinarySaves.push(input.expectedRevision);
          return { ...input.snapshot, revision: input.expectedRevision + 1, updatedAt: now };
        },
      },
      cache: cache(local()),
      now: () => now,
    });
    await store.load();
    const coordinator = getAuthoritativeRevisionCoordinator(store);
    expect(coordinator).not.toBeNull();

    await coordinator!.mutate(async (expectedRevision) => {
      expect(expectedRevision).toBe(4);
      return remote({ timeline: [remoteMessage], revision: 5 });
    }, "draft");
    await store.save(local({ timeline: [remoteMessage, localMessage], draft: "draft" }));

    expect(ordinarySaves).toEqual([5]);
  });

  it("does not advance the shared revision when a dedicated mutation conflicts", async () => {
    const ordinarySaves: number[] = [];
    const store = createCloudLocalStateStore({
      remote: {
        load: async () => remote({ revision: 9 }),
        save: async (input) => {
          ordinarySaves.push(input.expectedRevision);
          return { ...input.snapshot, revision: input.expectedRevision + 1, updatedAt: now };
        },
      },
      cache: cache(local()),
      now: () => now,
    });
    await store.load();
    const coordinator = getAuthoritativeRevisionCoordinator(store)!;

    await expect(coordinator.mutate(async () => { throw new Error("photo_conflict"); }, ""))
      .rejects.toThrow("photo_conflict");
    await store.save(local({ timeline: [localMessage] }));

    expect(ordinarySaves).toEqual([9]);
  });

  it("loads the remote timeline as authoritative while preserving only the local draft", async () => {
    const localCache = cache(local({ timeline: [localMessage], draft: "書きかけ", pendingDisplayName: "消す" }));
    const api: RemoteStateApi = {
      load: async () => remote({ timeline: [remoteMessage], revision: 4 }),
      save: async () => { throw new Error("unused"); },
    };

    const loaded = await createCloudLocalStateStore({ remote: api, cache: localCache, now: () => now }).load();

    expect(loaded).toEqual(local({ timeline: [remoteMessage], draft: "書きかけ" }));
  });

  it("does not update the cache when a remote save fails", async () => {
    const events: string[] = [];
    const original = local({ timeline: [remoteMessage], draft: "残す" });
    const localCache = cache(original, events);
    const store = createCloudLocalStateStore({
      remote: { load: async () => remote(), save: async () => { events.push("remote-save"); throw new Error("offline"); } },
      cache: localCache,
      now: () => now,
    });
    await store.load();

    await expect(store.save(local({ timeline: [localMessage], draft: "残す" }))).rejects.toThrow("offline");
    expect(events).toEqual(["remote-save"]);
    expect(localCache.current()).toEqual(original);
  });

  it("updates the local cache only after the remote snapshot succeeds", async () => {
    const events: string[] = [];
    const localCache = cache(local({ draft: "下書き" }), events);
    const api: RemoteStateApi = {
      load: async () => remote({ revision: 2 }),
      save: async (input) => {
        events.push("remote-save");
        expect(input.expectedRevision).toBe(2);
        expect(input.snapshot.version).toBe(3);
        return { ...input.snapshot, revision: 3, updatedAt: now };
      },
    };
    const store = createCloudLocalStateStore({ remote: api, cache: localCache, now: () => now });
    await store.load();

    await store.save(local({ timeline: [localMessage], draft: "下書き" }));

    expect(events).toEqual(["remote-save", "cache-save"]);
    expect(localCache.current()).toEqual(local({ timeline: [localMessage], draft: "下書き" }));
  });

  it("keeps draft-only changes local without advancing the remote revision", async () => {
    let remoteSaves = 0;
    const localCache = cache(local({ draft: "" }));
    const store = createCloudLocalStateStore({
      remote: {
        load: async () => remote({ timeline: [remoteMessage], revision: 3 }),
        save: async () => { remoteSaves += 1; return remote({ revision: 4 }); },
      },
      cache: localCache,
      now: () => now,
    });
    await store.load();

    await store.save(local({ timeline: [remoteMessage], draft: "書きかけ" }));

    expect(remoteSaves).toBe(0);
    expect(localCache.current()).toEqual(local({ timeline: [remoteMessage], draft: "書きかけ" }));
  });

  it("adopts a newer remote revision and fails closed when the conflicting histories are not append-only", async () => {
    const localCache = cache(local({ draft: "送信前の文章" }));
    const latest = remote({ timeline: [remoteMessage], revision: 8 });
    let loads = 0;
    const api: RemoteStateApi = {
      load: async () => { loads += 1; return loads === 1 ? remote({ timeline: [localMessage], revision: 7 }) : latest; },
      save: async () => { throw new CloudStateConflictError(); },
    };
    const store = createCloudLocalStateStore({ remote: api, cache: localCache, now: () => now });
    await store.load();

    await expect(store.save(local({ timeline: [{ ...localMessage, text: "既存履歴を変更" }], draft: "送信前の文章" })))
      .rejects.toThrow("別の画面で会話が更新されました");
    expect(localCache.current()).toEqual(local({ timeline: [remoteMessage], draft: "送信前の文章" }));
  });

  it("rebases one append-only text turn after a revision conflict before chat dispatch", async () => {
    const localCache = cache(local({ draft: "送信前の文章" }));
    const latest = remote({ timeline: [remoteMessage], revision: 8 });
    const pendingMessage = { ...localMessage, delivery: "sending" as const };
    const saveInputs: Array<{ expectedRevision: number; snapshot: RemoteChatSnapshot }> = [];
    let loads = 0;
    const api: RemoteStateApi = {
      load: async () => { loads += 1; return loads === 1 ? remote({ revision: 7 }) : latest; },
      save: async (input) => {
        saveInputs.push(input);
        if (saveInputs.length === 1) throw new CloudStateConflictError();
        return { ...input.snapshot, revision: 9, updatedAt: now };
      },
    };
    const store = createCloudLocalStateStore({ remote: api, cache: localCache, now: () => now });
    await store.load();

    await expect(store.save(local({ timeline: [pendingMessage], draft: "送信前の文章" }))).resolves.toBeUndefined();

    expect(saveInputs).toHaveLength(2);
    expect(saveInputs[0]?.expectedRevision).toBe(7);
    expect(saveInputs[1]).toEqual({
      expectedRevision: 8,
      snapshot: remote({ timeline: [remoteMessage, pendingMessage], version: 3, revision: 8 }),
    });
    expect(localCache.current()).toEqual(local({ timeline: [remoteMessage, pendingMessage], draft: "送信前の文章" }));
  });

  it("fails closed instead of rebasing multiple or non-pending appended messages", async () => {
    for (const timeline of [
      [localMessage],
      [{ ...localMessage, delivery: "sending" as const }, { ...localMessage, id: "second", delivery: "sending" as const }],
    ]) {
      const localCache = cache(local());
      let loads = 0;
      const api: RemoteStateApi = {
        load: async () => { loads += 1; return loads === 1 ? remote({ revision: 7 }) : remote({ timeline: [remoteMessage], revision: 8 }); },
        save: async () => { throw new CloudStateConflictError(); },
      };
      const store = createCloudLocalStateStore({ remote: api, cache: localCache, now: () => now });
      await store.load();

      await expect(store.save(local({ timeline }))).rejects.toThrow("別の画面で会話が更新されました");
      expect(localCache.current().timeline).toEqual([remoteMessage]);
    }
  });

  it("fails closed after one rebase retry when the remote revision changes again", async () => {
    const localCache = cache(local({ draft: "送信前の文章" }));
    const firstLatest = remote({ timeline: [remoteMessage], revision: 8 });
    const newest = remote({ timeline: [remoteMessage, { ...localMessage, id: "other-device" }], revision: 9 });
    const expectedRevisions: number[] = [];
    let loads = 0;
    const api: RemoteStateApi = {
      load: async () => {
        loads += 1;
        if (loads === 1) return remote({ revision: 7 });
        if (loads === 2) return firstLatest;
        return newest;
      },
      save: async (input) => {
        expectedRevisions.push(input.expectedRevision);
        throw new CloudStateConflictError();
      },
    };
    const store = createCloudLocalStateStore({ remote: api, cache: localCache, now: () => now });
    await store.load();

    await expect(store.save(local({ timeline: [{ ...localMessage, delivery: "sending" }], draft: "送信前の文章" })))
      .rejects.toThrow("別の画面で会話が更新されました");

    expect(expectedRevisions).toEqual([7, 8]);
    expect(loads).toBe(3);
    expect(localCache.current()).toEqual(local({ timeline: newest.timeline, draft: "送信前の文章" }));
  });
});
