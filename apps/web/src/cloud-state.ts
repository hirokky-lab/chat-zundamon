import { parseRemoteChatSnapshot, type LocalChatSnapshot, type RemoteChatSnapshot } from "@yui/domain";
import type { LocalStateStore } from "./local-state";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CloudStateConflictError extends Error {
  constructor() {
    super("別の画面で会話が更新されました");
  }
}

export type RemoteStateApi = {
  load(): Promise<RemoteChatSnapshot>;
  save(input: { expectedRevision: number; snapshot: RemoteChatSnapshot }): Promise<RemoteChatSnapshot>;
};

export type AuthoritativeRevisionCoordinator = {
  mutate(
    operation: (expectedRevision: number) => Promise<RemoteChatSnapshot>,
    draft: string,
  ): Promise<RemoteChatSnapshot>;
};

const authoritativeRevisionCoordinators = new WeakMap<LocalStateStore, AuthoritativeRevisionCoordinator>();

export function getAuthoritativeRevisionCoordinator(
  store: LocalStateStore,
): AuthoritativeRevisionCoordinator | null {
  return authoritativeRevisionCoordinators.get(store) ?? null;
}

export function isAuthoritativeRevisionCoordinator(
  store: LocalStateStore,
  candidate: AuthoritativeRevisionCoordinator | undefined,
): candidate is AuthoritativeRevisionCoordinator {
  return candidate !== undefined
    && Object.isFrozen(candidate)
    && authoritativeRevisionCoordinators.get(store) === candidate;
}

export function inheritAuthoritativeRevisionCoordinator<T extends LocalStateStore>(
  source: LocalStateStore,
  target: T,
): T {
  const coordinator = authoritativeRevisionCoordinators.get(source);
  if (coordinator) authoritativeRevisionCoordinators.set(target, coordinator);
  return target;
}

function toLocal(remote: RemoteChatSnapshot, draft: string): LocalChatSnapshot {
  return {
    timeline: remote.timeline,
    draft,
    pendingDisplayName: null,
    lastOpeningAt: remote.lastOpeningAt,
    lastConversationAt: remote.lastConversationAt,
  };
}

function toRemote(local: LocalChatSnapshot, revision: number, updatedAt: string): RemoteChatSnapshot {
  return {
    timeline: local.timeline,
    lastOpeningAt: local.lastOpeningAt,
    lastConversationAt: local.lastConversationAt,
    // Every outbound snapshot is current-schema. In particular, never downcast a photo-bearing v3 history.
    version: 3,
    revision,
    updatedAt,
  };
}

function hasSameRemoteContent(left: RemoteChatSnapshot, right: RemoteChatSnapshot): boolean {
  return JSON.stringify({
    timeline: left.timeline,
    lastOpeningAt: left.lastOpeningAt,
    lastConversationAt: left.lastConversationAt,
  }) === JSON.stringify({
    timeline: right.timeline,
    lastOpeningAt: right.lastOpeningAt,
    lastConversationAt: right.lastConversationAt,
  });
}

function sameTimelineItem(left: RemoteChatSnapshot["timeline"][number], right: RemoteChatSnapshot["timeline"][number]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function startsWithTimeline(
  candidate: RemoteChatSnapshot["timeline"],
  prefix: RemoteChatSnapshot["timeline"],
): boolean {
  return candidate.length >= prefix.length
    && prefix.every((item, index) => sameTimelineItem(candidate[index]!, item));
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function rebaseAppendOnlyTextTurn(
  base: RemoteChatSnapshot | null,
  local: LocalChatSnapshot,
  latest: RemoteChatSnapshot,
  updatedAt: string,
): RemoteChatSnapshot | null {
  if (!base || !startsWithTimeline(local.timeline, base.timeline) || !startsWithTimeline(latest.timeline, base.timeline)) return null;
  const appended = local.timeline.slice(base.timeline.length);
  if (appended.length !== 1) return null;
  const pending = appended[0]!;
  if (pending.type !== "message" || pending.role !== "user" || pending.delivery !== "sending") return null;
  const ids = new Set(latest.timeline.map((item) => item.id));
  if (ids.has(pending.id)) return null;
  return {
    timeline: [...latest.timeline, pending],
    lastOpeningAt: laterTimestamp(latest.lastOpeningAt, local.lastOpeningAt),
    lastConversationAt: laterTimestamp(latest.lastConversationAt, local.lastConversationAt),
    version: 3,
    revision: latest.revision,
    updatedAt,
  };
}

export function createCloudLocalStateStore(options: {
  remote: RemoteStateApi;
  cache: LocalStateStore;
  now: () => string;
}): LocalStateStore {
  let revision = 0;
  let authoritative: RemoteChatSnapshot | null = null;
  let saveQueue: Promise<void> = Promise.resolve();
  let cacheWarning: string | null = null;
  let remoteWarning: string | null = null;
  let unresolvedConflict = false;
  const cacheMessage = "端末内に保存できません。会話はクラウドで管理していますが、下書きはこの画面を閉じると失われます。";
  const remoteMessage = (error: unknown) => error instanceof CloudStateConflictError
    ? error.message : "会話をクラウドに保存できていません。再読み込みせず「保存を再試行」を押してください。";

  async function saveCache(snapshot: LocalChatSnapshot): Promise<void> {
    try {await options.cache.save(snapshot);cacheWarning=options.cache.getPersistenceWarning?.() ? cacheMessage : null;}
    catch {cacheWarning=cacheMessage;}
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = saveQueue.then(work);
    saveQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function adopt(saved: RemoteChatSnapshot, draft: string): Promise<void> {
    if (saved.revision !== revision + 1) throw new CloudStateConflictError();
    revision = saved.revision;
    authoritative = saved;
    // A failed disposable cache must not turn an authoritative write into a failed mutation.
    await saveCache(toLocal(saved, draft));
  }

  const save = async (snapshot: LocalChatSnapshot): Promise<void> => {
    const outbound = toRemote(snapshot, revision, options.now());
    if (authoritative && hasSameRemoteContent(authoritative, outbound)) {
      await saveCache(toLocal(authoritative, snapshot.draft));
      return;
    }
    // A previously rejected stale snapshot is not made safe by learning the newest revision.
    // Require a fresh load before further mutations instead of overwriting the other device.
    if (unresolvedConflict) throw new CloudStateConflictError();
    try {
      const saved = await options.remote.save({ expectedRevision: revision, snapshot: outbound });
      await adopt(saved, snapshot.draft);
    } catch (error) {
      if (!(error instanceof CloudStateConflictError)) throw error;
      unresolvedConflict = true;
      const base = authoritative;
      const latest = await options.remote.load();
      revision = latest.revision;
      authoritative = latest;
      const rebased = rebaseAppendOnlyTextTurn(base, snapshot, latest, options.now());
      if (!rebased) {
        await saveCache(toLocal(latest, snapshot.draft));
        throw error;
      }
      try {
        const saved = await options.remote.save({ expectedRevision: latest.revision, snapshot: rebased });
        await adopt(saved, snapshot.draft);
        unresolvedConflict = false;
      } catch (retryError) {
        if (retryError instanceof CloudStateConflictError) {
          const newest = await options.remote.load();
          revision = newest.revision;
          authoritative = newest;
          await saveCache(toLocal(newest, snapshot.draft));
        }
        throw retryError;
      }
    }
  };

  const coordinator: AuthoritativeRevisionCoordinator = Object.freeze({
    mutate(operation, draft) {
      return enqueue(async () => {
        if (unresolvedConflict) throw new CloudStateConflictError();
        const saved = await operation(revision);
        await adopt(saved, draft);
        return saved;
      });
    },
  });

  const store: LocalStateStore = {
    async load() {
      try {
        const [remote, draft] = await Promise.all([options.remote.load(), options.cache.load().then(cached=>{
          cacheWarning=options.cache.getPersistenceWarning?.() ? cacheMessage : null;return cached.draft;
        },()=>{cacheWarning=cacheMessage;return '';})]);
        revision = remote.revision;
        authoritative = remote;
        unresolvedConflict=false;
        remoteWarning=null;
        return toLocal(remote, draft);
      }catch(error){remoteWarning=remoteMessage(error);throw error;}
    },
    save(snapshot) {
      return enqueue(async () => {
        try {await save(snapshot);remoteWarning=null;}
        catch(error){remoteWarning=remoteMessage(error);throw error;}
      });
    },
    getPersistenceWarning: () => remoteWarning ?? cacheWarning,
  };
  authoritativeRevisionCoordinators.set(store, coordinator);
  return store;
}

export function createRemoteStateApi(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): RemoteStateApi {
  const read = async (response: Response): Promise<RemoteChatSnapshot> => {
    if (response.status === 409) throw new CloudStateConflictError();
    if (!response.ok) throw new Error("Cloud chat state is unavailable");
    const payload = await response.json() as { snapshot?: unknown };
    const snapshot = parseRemoteChatSnapshot(payload.snapshot);
    if (!snapshot) throw new Error("Cloud chat state is invalid");
    return snapshot;
  };
  return {
    load: async () => read(await fetchImpl("/api/chat-state", { cache: "no-store" })),
    save: async (input) => read(await fetchImpl("/api/chat-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })),
  };
}
