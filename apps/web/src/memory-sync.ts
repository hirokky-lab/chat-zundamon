import { isReferentialExternalMemoryRequest, type LocalChatSnapshot, type TimelineItem, type TranscriptTurn } from "@yui/domain";

export type MemoryProcessingReceipt = {
  sourceMessageId: string;
  state: "pending" | "completed" | "failed";
  appliedCount: number;
};

export type MemorySyncInput = {
  sourceMessageId: string;
  sourceOccurredAt: string;
};

export type AutomaticMemoryTurn = TranscriptTurn & {
  provenance: "context" | "authoritative_source";
};

export type PendingMemorySync = {
  sourceMessageId: string;
  sourceOccurredAt: string;
  attempts: number;
};

export type MemorySyncQueue = {
  enqueue(input: MemorySyncInput): Promise<void>;
  hydrate(): Promise<void>;
  whenIdle(): Promise<void>;
  cancel(): void;
};

export type MemorySyncPendingStore = {
  load(): Promise<PendingMemorySync[]>;
  save(pending: PendingMemorySync[]): Promise<void>;
};

type MemorySyncQueueOptions = {
  process(input: MemorySyncInput, signal?: AbortSignal): Promise<MemoryProcessingReceipt>;
  loadPending(): Promise<PendingMemorySync[]>;
  savePending(pending: PendingMemorySync[]): Promise<void>;
  ready?: () => Promise<void>;
  automaticMemoryEnabled?: () => boolean;
  now?: () => string;
};

function isPending(value: unknown): value is PendingMemorySync {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sourceMessageId === "string"
    && entry.sourceMessageId.length > 0
    && entry.sourceMessageId.length <= 128
    && typeof entry.sourceOccurredAt === "string"
    && Number.isFinite(Date.parse(entry.sourceOccurredAt))
    && Number.isInteger(entry.attempts)
    && (entry.attempts as number) >= 0;
}

export function createMemorySyncQueue(options: MemorySyncQueueOptions): MemorySyncQueue {
  const pending = new Map<string, PendingMemorySync>();
  const inFlight = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  let generation = 0;
  let closed = false;

  const enabled = () => options.automaticMemoryEnabled?.() ?? true;
  const snapshot = () => [...pending.values()].sort((left, right) => left.sourceMessageId.localeCompare(right.sourceMessageId));

  const start = (entry: PendingMemorySync): void => {
    if (closed || !enabled() || inFlight.has(entry.sourceMessageId)) return;
    const startedGeneration = generation;
    const controller = new AbortController();
    controllers.set(entry.sourceMessageId, controller);
    const work = (async () => {
      try {
        await options.ready?.();
        if (generation !== startedGeneration || controller.signal.aborted || !enabled()) return;
        const receipt = await options.process({
          sourceMessageId: entry.sourceMessageId,
          sourceOccurredAt: entry.sourceOccurredAt,
        }, controller.signal);
        if (generation !== startedGeneration || controller.signal.aborted) return;
        if (receipt.state === "completed") {
          pending.delete(entry.sourceMessageId);
        } else {
          pending.set(entry.sourceMessageId, { ...entry, attempts: entry.attempts + 1 });
        }
        await options.savePending(snapshot());
      } catch {
        if (generation !== startedGeneration || controller.signal.aborted) return;
        pending.set(entry.sourceMessageId, { ...entry, attempts: entry.attempts + 1 });
        await options.savePending(snapshot()).catch(() => undefined);
      } finally {
        if (controllers.get(entry.sourceMessageId) === controller) controllers.delete(entry.sourceMessageId);
      }
    })();
    inFlight.set(entry.sourceMessageId, work);
    void work.finally(() => {
      if (inFlight.get(entry.sourceMessageId) === work) inFlight.delete(entry.sourceMessageId);
    });
  };

  return {
    async enqueue(input) {
      if (closed || !enabled() || pending.has(input.sourceMessageId) || inFlight.has(input.sourceMessageId)) return;
      const enqueueGeneration = generation;
      const entry: PendingMemorySync = {
        sourceMessageId: input.sourceMessageId,
        sourceOccurredAt: input.sourceOccurredAt,
        attempts: 0,
      };
      pending.set(entry.sourceMessageId, entry);
      await options.savePending(snapshot());
      if (closed || generation !== enqueueGeneration || !enabled()) return;
      start(entry);
    },
    async hydrate() {
      if (closed || !enabled()) return;
      const hydrateGeneration = generation;
      const loaded = await options.loadPending();
      if (closed || generation !== hydrateGeneration || !enabled()) return;
      for (const entry of loaded) {
        if (isPending(entry) && !pending.has(entry.sourceMessageId)) pending.set(entry.sourceMessageId, entry);
      }
      for (const entry of pending.values()) start(entry);
    },
    async whenIdle() {
      await Promise.allSettled([...inFlight.values()]);
    },
    cancel() {
      closed = true;
      generation += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    },
  };
}

function isConversationMessage(item: TimelineItem): item is Extract<TimelineItem, { type: "message" }> {
  return item.type === "message" && item.flow !== "profile";
}

function previousUserMessageIndex(timeline: readonly TimelineItem[], before: number): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.type === "message" && item.role === "user") return index;
  }
  return -1;
}

export function shouldExcludeAutomaticMemorySource(snapshot: LocalChatSnapshot, sourceMessageId: string): boolean {
  const sourceIndex = snapshot.timeline.findIndex((item) => item.type === "message" && item.role === "user" && item.id === sourceMessageId);
  if (sourceIndex < 0) return true;
  const source = snapshot.timeline[sourceIndex] as Extract<TimelineItem, { type: "message"; role: "user" }>;
  const replies = snapshot.timeline.filter((item): item is Extract<TimelineItem, { type: "message"; role: "assistant" }> => (
    item.type === "message" && item.role === "assistant" && item.replyGroupId === `${sourceMessageId}:assistant`
  ));
  if (replies.some((reply) => Boolean(reply.search) || reply.flow === "external_context")) return true;
  const previousUserIndex = previousUserMessageIndex(snapshot.timeline, sourceIndex);
  if (previousUserIndex < 0 || !isReferentialExternalMemoryRequest(source.text)) return false;
  const previousUser = snapshot.timeline[previousUserIndex]!;
  return snapshot.timeline.some((item, index) => index > previousUserIndex && index < sourceIndex
    && item.type === "message" && item.role === "assistant" && item.delivery === "sent"
    && item.replyGroupId === `${previousUser.id}:assistant` && item.flow === "external_context");
}

function externalMemoryExcludedSourceIds(snapshot: LocalChatSnapshot): Set<string> {
  const excluded = new Set(snapshot.timeline.flatMap((item) => item.type === "message" && item.role === "assistant"
    && item.flow === "external_context" && item.replyGroupId ? [item.replyGroupId.replace(/:assistant$/u, "")] : []));
  for (const [index, item] of snapshot.timeline.entries()) {
    if (item.type !== "message" || item.role !== "user" || !isReferentialExternalMemoryRequest(item.text)) continue;
    const previousUserIndex = previousUserMessageIndex(snapshot.timeline, index);
    if (previousUserIndex < 0) continue;
    const previousUser = snapshot.timeline[previousUserIndex]!;
    if (excluded.has(previousUser.id)) excluded.add(item.id);
  }
  return excluded;
}

export function selectMemorySyncTurns(snapshot: LocalChatSnapshot, sourceMessageId: string): AutomaticMemoryTurn[] {
  if (shouldExcludeAutomaticMemorySource(snapshot, sourceMessageId)) return [];
  const conversationMessages = snapshot.timeline.filter(isConversationMessage);
  const webSearchSourceIds = new Set(conversationMessages
    .filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant" && Boolean(message.search) && typeof message.replyGroupId === "string")
    .map((message) => message.replyGroupId!.replace(/:assistant$/, "")));
  const externalSourceIds = externalMemoryExcludedSourceIds(snapshot);
  const allMessages = conversationMessages.filter((message) => message.role === "user"
    ? !webSearchSourceIds.has(message.id) && !externalSourceIds.has(message.id)
    : typeof message.replyGroupId !== "string" || (!webSearchSourceIds.has(message.replyGroupId.replace(/:assistant$/, "")) && !externalSourceIds.has(message.replyGroupId.replace(/:assistant$/, ""))));
  const completedUserIds = new Set(allMessages
    .filter((message) => message.role === "user" && message.delivery === "sent")
    .filter((message) => allMessages.some((reply) => (
      reply.role === "assistant"
      && reply.delivery === "sent"
      && reply.replyGroupId === `${message.id}:assistant`
    )))
    .map((message) => message.id));
  const messages = allMessages.filter((message) => (
    message.delivery === "sent"
    && (message.role === "user"
      ? completedUserIds.has(message.id)
      : typeof message.replyGroupId === "string"
        && completedUserIds.has(message.replyGroupId.replace(/:assistant$/, "")))
  ));
  const sourceIndex = messages.findIndex((message) => message.id === sourceMessageId && message.role === "user");
  if (sourceIndex < 0) return [];
  let endIndex = sourceIndex;
  for (let index = sourceIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.replyGroupId === `${sourceMessageId}:assistant`) endIndex = index;
    else if (message?.role === "user") break;
  }
  const sourceExchange = messages.slice(sourceIndex, endIndex + 1);
  const boundedSourceExchange = sourceExchange.length <= 12
    ? sourceExchange
    : [sourceExchange[0]!, ...sourceExchange.slice(-11)];
  const olderContext = messages.slice(0, sourceIndex).slice(-(12 - boundedSourceExchange.length));
  return [...olderContext, ...boundedSourceExchange]
    .map(({ id, role, text }) => ({
      role,
      text,
      provenance: id === sourceMessageId ? "authoritative_source" as const : "context" as const,
    }));
}

export function createBrowserMemorySyncPendingStore(options: {
  key: string;
  storage?: Pick<Storage, "getItem" | "setItem">;
}): MemorySyncPendingStore {
  let storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  try {
    const candidate = options.storage ?? globalThis.localStorage;
    if (typeof candidate?.getItem === "function" && typeof candidate?.setItem === "function") storage = candidate;
  } catch {
    // Private browsing or policy can make localStorage inaccessible.
  }
  if (!storage) return createMemorySyncPendingStore();
  return {
    async load() {
      try {
        const raw = storage.getItem(options.key);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.filter(isPending) : [];
      } catch {
        return [];
      }
    },
    async save(pending) {
      storage.setItem(options.key, JSON.stringify(pending.filter(isPending)));
    },
  };
}

export function createMemorySyncPendingStore(initial: PendingMemorySync[] = []): MemorySyncPendingStore {
  let pending = initial.filter(isPending);
  return {
    async load() { return structuredClone(pending); },
    async save(next) { pending = structuredClone(next.filter(isPending)); },
  };
}
