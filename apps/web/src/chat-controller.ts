import {
  createProfileGreeting,
  parseProfile,
  parseLifeCard,
  type LifeCard,
  shouldCreateOpening,
  type AddressingStyle,
  type ChatMessage,
  type ChatReply,
  type LocalChatSnapshot,
  type PhotoMessage,
  type Profile,
  type TimelineItem,
} from "@yui/domain";
import { EMPTY_LOCAL_CHAT } from "./local-state";
import { YuiRequestError, type ChatApi, type PhotoApi, type ProfileApi, type YuiRequestErrorKind } from "./api";
import type { LocalStateStore } from "./local-state";
import type { PhotoSendLease } from "./photo-preparation";
import { isAuthoritativeRevisionCoordinator, type AuthoritativeRevisionCoordinator } from "./cloud-state";
import type { TalkCausalCueObservation } from "./talk-causal-cue";

export type ChatState = {
  profile: Profile | null;
  snapshot: LocalChatSnapshot;
  openingRequestId: string | null;
  delayedGreetingReplyGroupId: string | null;
  failureByMessageId: Record<string, YuiRequestErrorKind>;
};

export type ChatCommand =
  | { type: "request-chat"; kind: "opening" | "reply"; clientMessageId: string }
  | { type: "persist" };

export type ChatTransition = { state: ChatState; commands: ChatCommand[] };

export type ChatAction =
  | { type: "hydrate"; snapshot: LocalChatSnapshot; profile: Profile | null; now: string; openingMessageId: string }
  | { type: "profile-saved"; profile: Profile; greetingId: string; now: string }
  | { type: "profile-greeting-revealed"; replyGroupId: string }
  | { type: "profile-updated"; profile: Profile }
  | { type: "send"; clientMessageId: string; text: string; now: string }
  | { type: "retry-chat"; clientMessageId: string }
  | { type: "chat-succeeded"; kind: "opening" | "reply"; clientMessageId: string; reply: ChatReply; now: string }
  | { type: "chat-failed"; kind: "opening" | "reply"; clientMessageId: string; failureKind: YuiRequestErrorKind }
  | { type: "proactive-received"; candidateId: string; text: string; now: string };

export const initialChatState: ChatState = {
  profile: null,
  snapshot: EMPTY_LOCAL_CHAT,
  openingRequestId: null,
  delayedGreetingReplyGroupId: null,
  failureByMessageId: {},
};

function withoutFailure(state: ChatState, clientMessageId: string): ChatState {
  if (!(clientMessageId in state.failureByMessageId)) return state;
  const { [clientMessageId]: _removed, ...failureByMessageId } = state.failureByMessageId;
  return { ...state, failureByMessageId };
}

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
  createdAt: string,
  delivery: ChatMessage["delivery"] = "sent",
  flow?: ChatMessage["flow"],
): ChatMessage {
  const base = { id, type: "message" as const, text, createdAt, delivery, ...(flow ? { flow } : {}) };
  return role === "user" ? { ...base, role: "user" } : { ...base, role: "assistant" };
}

function replaceOrAppend(timeline: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = timeline.findIndex((current) => current.id === item.id);
  if (index === -1) return [...timeline, item];
  return timeline.map((current) => current.id === item.id ? item : current);
}

function upsertReply(timeline: TimelineItem[], reply: ChatReply): TimelineItem[] {
  return reply.bubbles.reduce<TimelineItem[]>((current, bubble) =>
    replaceOrAppend(current, {
      id: bubble.id,
      type: "message",
      role: "assistant",
      text: bubble.text,
      createdAt: bubble.createdAt,
      delivery: "sent",
      replyGroupId: reply.replyGroupId,
      sequence: bubble.sequence,
      ...(bubble.flow ? { flow: bubble.flow } : {}),
      ...(reply.lifeCard && bubble.sequence === reply.bubbles.length - 1 ? { lifeCard: reply.lifeCard, flow: "external_context" as const } : {}),
      ...(reply.search && bubble.sequence === reply.bubbles.length - 1 ? { search: reply.search } : {}),
    }), timeline);
}

function profileFromReply(current: Profile | null, incoming: Profile | undefined): Profile | null {
  if (!incoming || !parseProfile(incoming)) return current;
  if (current && Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt)) return current;
  return incoming;
}

function withSnapshot(state: ChatState, snapshot: LocalChatSnapshot): ChatTransition {
  return { state: { ...state, snapshot }, commands: [{ type: "persist" }] };
}

function addMessage(
  state: ChatState,
  item: ChatMessage,
  changes: Partial<LocalChatSnapshot> = {},
): ChatTransition {
  return withSnapshot(state, {
    ...state.snapshot,
    ...changes,
    timeline: replaceOrAppend(state.snapshot.timeline, item),
  });
}

export function chatReducer(state: ChatState, action: ChatAction): ChatTransition {
  switch (action.type) {
    case "hydrate": {
      // Requests belong to the running controller, not to persisted history.
      // A restored "sending" marker cannot resume its old network request.
      const deliveredGroups = new Set(action.snapshot.timeline.flatMap(item =>
        item.type === "message" && item.role === "assistant" && item.replyGroupId ? [item.replyGroupId] : []));
      const failureByMessageId: ChatState["failureByMessageId"] = {};
      const timeline = action.snapshot.timeline.map(item => {
        if (item.type !== "message" || item.role !== "user" || item.delivery !== "sending") return item;
        if (deliveredGroups.has(`${item.id}:assistant`)) return { ...item, delivery: "sent" as const };
        failureByMessageId[item.id] = "interrupted";
        return { ...item, delivery: "failed" as const };
      });
      const next: ChatState = { ...state, profile: action.profile, snapshot: { ...action.snapshot, timeline }, delayedGreetingReplyGroupId: null, failureByMessageId };
      if (!action.profile) {
        return { state: next, commands: [] };
      }
      if (next.openingRequestId || !shouldCreateOpening({ now: action.now, lastOpeningAt: action.snapshot.lastOpeningAt, lastConversationAt: action.snapshot.lastConversationAt })) {
        return { state: next, commands: [] };
      }
      return {
        state: { ...next, openingRequestId: action.openingMessageId },
        commands: [{ type: "request-chat", kind: "opening", clientMessageId: action.openingMessageId }],
      };
    }
    case "profile-saved": {
      const next = { ...state, profile: action.profile, delayedGreetingReplyGroupId: action.greetingId };
      const timeline = createProfileGreeting(action.profile, action.now, action.greetingId)
        .reduce<TimelineItem[]>((items, greeting) => replaceOrAppend(items, greeting), state.snapshot.timeline);
      return withSnapshot(next, {
        ...state.snapshot,
        timeline,
        pendingDisplayName: null,
      });
    }
    case "profile-greeting-revealed":
      return action.replyGroupId === state.delayedGreetingReplyGroupId
        ? { state: { ...state, delayedGreetingReplyGroupId: null }, commands: [] }
        : { state, commands: [] };
    case "profile-updated":
      return { state: { ...state, profile: action.profile }, commands: [] };
    case "send": {
      if (!state.profile || !action.text.trim() || state.snapshot.timeline.some((item) => item.id === action.clientMessageId)) return { state, commands: [] };
      const next = addMessage(state, message(action.clientMessageId, "user", action.text, action.now, "sending"));
      return {
        state: next.state,
        commands: [...next.commands, { type: "request-chat", kind: "reply", clientMessageId: action.clientMessageId }],
      };
    }
    case "retry-chat": {
      const item = state.snapshot.timeline.find((current): current is ChatMessage => current.type === "message" && current.id === action.clientMessageId);
      if (!item || item.role !== "user" || item.delivery !== "failed" || state.failureByMessageId[action.clientMessageId] === "profile-required" || state.failureByMessageId[action.clientMessageId] === "authentication") return { state, commands: [] };
      const cleared = withoutFailure(state, action.clientMessageId);
      const next = withSnapshot(cleared, { ...state.snapshot, timeline: replaceOrAppend(state.snapshot.timeline, { ...item, delivery: "sending" }) });
      return { state: next.state, commands: [...next.commands, { type: "request-chat", kind: "reply", clientMessageId: action.clientMessageId }] };
    }
    case "proactive-received": {
      if (!state.profile || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(action.candidateId) || !action.text.trim()) return { state, commands: [] };
      const replyGroupId = `proactive:${action.candidateId}`;
      const id = `${replyGroupId}:0`;
      if (state.snapshot.timeline.some((item) => item.id === id)) return { state, commands: [] };
      return withSnapshot(state, {
        ...state.snapshot,
        timeline: [...state.snapshot.timeline, {
          id,
          type: "message",
          role: "assistant",
          text: action.text,
          createdAt: action.now,
          delivery: "sent",
          flow: "external_context",
          replyGroupId,
          sequence: 0,
        }],
      });
    }
    case "chat-succeeded": {
      if (action.kind === "reply") {
        const user = state.snapshot.timeline.find((item): item is ChatMessage => item.type === "message" && item.id === action.clientMessageId);
        if (!user || user.role !== "user" || user.delivery !== "sending") return { state, commands: [] };
        const timeline = upsertReply(
          replaceOrAppend(state.snapshot.timeline, { ...user, delivery: "sent" }),
          action.reply,
        );
        return withSnapshot(
          { ...withoutFailure(state, action.clientMessageId), profile: profileFromReply(state.profile, action.reply.profile) },
          { ...state.snapshot, timeline, lastConversationAt: action.now },
        );
      }
      if (state.openingRequestId !== action.clientMessageId) return { state, commands: [] };
      return withSnapshot(
        { ...state, openingRequestId: null, profile: profileFromReply(state.profile, action.reply.profile) },
        {
          ...state.snapshot,
          timeline: upsertReply(state.snapshot.timeline, action.reply),
          lastOpeningAt: action.now,
        },
      );
    }
    case "chat-failed": {
      if (action.kind === "opening") {
        return state.openingRequestId === action.clientMessageId
          ? { state: { ...state, openingRequestId: null }, commands: [] }
          : { state, commands: [] };
      }
      const user = state.snapshot.timeline.find((item): item is ChatMessage => item.type === "message" && item.id === action.clientMessageId);
      if (!user || user.role !== "user" || user.delivery !== "sending") return { state, commands: [] };
      return withSnapshot(
        { ...state, failureByMessageId: { ...state.failureByMessageId, [action.clientMessageId]: action.failureKind } },
        { ...state.snapshot, timeline: replaceOrAppend(state.snapshot.timeline, { ...user, delivery: "failed" }) },
      );
    }
  }
}

export type ChatControllerOptions = {
  store: LocalStateStore;
  profileApi: ProfileApi;
  chatApi: ChatApi;
  now: () => string;
  nextId: () => string;
  requirePersistBeforeChat?: boolean;
  photoApi?: PhotoApi;
  authoritativeRevisionCoordinator?: AuthoritativeRevisionCoordinator;
  onCausalCueObservation?: (observation: TalkCausalCueObservation) => void;
  onStateChange?: () => void;
};

export type ChatController = {
  readonly state: ChatState;
  hydrate(): Promise<void>;
  saveProfile(input: { displayName: string; addressingStyle: AddressingStyle; occupation?: string; region?: string }): Promise<Profile>;
  updateProfile(input: { displayName: string; addressingStyle: AddressingStyle; occupation?: string; region?: string }): Promise<Profile>;
  send(text: string): Promise<string>;
  retryChat(clientMessageId: string): Promise<void>;
  stopGeneration(): void;
  updateLifeCard(messageId: string, card: LifeCard): Promise<void>;
  updateDraft(draft: string): Promise<void>;
  flush(): Promise<void>;
  appendVoiceTurn(input: { id: string; role: "user" | "assistant"; text: string; createdAt: string }): Promise<void>;
  appendProactiveCandidate(input: Readonly<{ candidateId: string; text: string; createdAt: string }>): Promise<string>;
  sendPhoto(lease: PhotoSendLease, caption: string, onProgress?: (stage: PhotoProgressStage) => void): Promise<string>;
  photoDelivery(clientMessageId: string): "sent" | "retryable" | "terminal" | null;
  retryPhoto(clientMessageId: string, onProgress?: (stage: PhotoProgressStage) => void): Promise<void>;
  cancelPhoto(clientMessageId: string): Promise<void>;
  deletePhoto(photoId: string): Promise<void>;
  markProfileGreetingRevealed(replyGroupId: string): void;
  dispose(): void;
};

export type PhotoProgressStage = "sending" | "committing" | "completed" | "retryable" | "commit_retryable" | "terminal";

// Release the queue even if a transport ignores cancellation.
async function abortableReply<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([start(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createChatController(options: ChatControllerOptions): ChatController {
  let current = initialChatState;
  let commandQueue: Promise<void> = Promise.resolve();
  let disposed = false;
  let activeGeneration: { controller: AbortController; clientMessageId: string } | undefined;
  const retryablePhotos = new Map<string, { lease: PhotoSendLease; caption: string; commitInput?: Parameters<PhotoApi["commit"]>[0] }>();

  const observeCausalCue = (observation: TalkCausalCueObservation) => {
    try { options.onCausalCueObservation?.(observation); } catch { /* Display-only observers cannot affect chat. */ }
  };

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = commandQueue.then(work, work);
    commandQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  function markStopped(clientMessageId: string): void {
    current = { ...withoutFailure(current, clientMessageId),
      openingRequestId: current.openingRequestId === clientMessageId ? null : current.openingRequestId,
      snapshot: { ...current.snapshot, timeline: current.snapshot.timeline.map(item =>
        item.type === "message" && item.role === "user" && item.id === clientMessageId && item.delivery === "sending"
          ? { ...item, delivery: "sent" } : item) },
    };
    options.onStateChange?.();
  }

  function scheduleGeneration(action: Extract<ChatAction, { type: "send" | "retry-chat" }>): Promise<void> {
    const generation = { controller: new AbortController(), clientMessageId: action.clientMessageId };
    activeGeneration = generation;
    return enqueue(async () => {
      if (disposed) return;
      // A user can stop before an earlier draft save has finished.
      if (generation.controller.signal.aborted) {
        current = chatReducer(current, action).state;
        markStopped(action.clientMessageId);
        await options.store.save(current.snapshot);
        return;
      }
      try { await dispatch(action, generation); }
      finally { if (activeGeneration === generation) activeGeneration = undefined; }
    });
  }

  async function dispatch(action: ChatAction, scheduledGeneration?: NonNullable<typeof activeGeneration>): Promise<void> {
    if (disposed) return;
    const previous = current;
    const transition = chatReducer(current, action);
    const requestCommand = transition.commands.find(command => command.type === "request-chat");
    const generation = requestCommand?.type === "request-chat"
      ? scheduledGeneration ?? { controller: new AbortController(), clientMessageId: requestCommand.clientMessageId }
      : undefined;
    if (generation) activeGeneration = generation;
    current = transition.state;
    if (current !== previous) options.onStateChange?.();
    if (current !== previous && action.type === "send") {
      const accepted = current.snapshot.timeline.some((item) => item.type === "message" && item.role === "user" && item.id === action.clientMessageId && item.delivery === "sending");
      if (accepted) observeCausalCue({ type: "received", requestId: action.clientMessageId });
    } else if (current !== previous && action.type === "retry-chat") {
      const accepted = current.snapshot.timeline.some((item) => item.type === "message" && item.role === "user" && item.id === action.clientMessageId && item.delivery === "sending");
      if (accepted) observeCausalCue({ type: "retry", requestId: action.clientMessageId });
    } else if (current !== previous && action.type === "chat-succeeded" && action.kind === "reply") {
      const delivered = current.snapshot.timeline.some((item) => item.type === "message" && item.role === "assistant" && item.replyGroupId === action.reply.replyGroupId);
      if (delivered) observeCausalCue({ type: "delivered", requestId: action.clientMessageId, replyGroupId: action.reply.replyGroupId });
    } else if (current !== previous && action.type === "chat-failed" && action.kind === "reply") {
      observeCausalCue({ type: "failed", requestId: action.clientMessageId });
    }
    for (const command of transition.commands) {
      if (disposed || generation?.controller.signal.aborted) return;
      if (command.type === "persist") {
        try {
          await options.store.save(current.snapshot);
        } catch (error) {
          if (disposed || generation?.controller.signal.aborted) return;
          if (options.requirePersistBeforeChat) {
            const pendingRequest = transition.commands.find(
              (candidate): candidate is Extract<ChatCommand, { type: "request-chat" }> =>
                candidate.type === "request-chat" && candidate.kind === "reply",
            );
            if (pendingRequest) {
              current = chatReducer(current, {
                type: "chat-failed",
                kind: "reply",
                clientMessageId: pendingRequest.clientMessageId,
                failureKind: "unknown",
              }).state;
              observeCausalCue({ type: "failed", requestId: pendingRequest.clientMessageId });
              return;
            }
            throw error;
          }
          // Conversation remains usable when local history persistence is unavailable.
        }
        continue;
      }
      if (command.kind === "reply") {
        const pending = current.snapshot.timeline.some((item) => item.type === "message" && item.role === "user" && item.id === command.clientMessageId && item.delivery === "sending");
        if (pending) observeCausalCue({ type: "waiting", requestId: command.clientMessageId });
      }
      try {
        const signal = generation!.controller.signal;
        const reply = await abortableReply(signal, () => options.chatApi.respond({
          kind: command.kind,
          clientMessageId: command.clientMessageId,
          timeline: current.snapshot.timeline,
        }, signal));
        if (disposed || signal.aborted) return;
        await dispatch({ type: "chat-succeeded", kind: command.kind, clientMessageId: command.clientMessageId, reply, now: options.now() });
      } catch (error) {
        if (disposed || generation?.controller.signal.aborted) return;
        await dispatch({
          type: "chat-failed",
          kind: command.kind,
          clientMessageId: command.clientMessageId,
          failureKind: error instanceof YuiRequestError ? error.kind : "unknown",
        });
      } finally {
        if (activeGeneration === generation) activeGeneration = undefined;
      }
    }
  }

  async function runPhoto(clientMessageId: string, lease: PhotoSendLease, caption: string, onProgress?: (stage: PhotoProgressStage) => void, commitInput?: Parameters<PhotoApi["commit"]>[0]): Promise<void> {
    if (!options.photoApi || !isAuthoritativeRevisionCoordinator(options.store, options.authoritativeRevisionCoordinator) || disposed) { lease.terminal(); onProgress?.("terminal"); return; }
    const optimistic: PhotoMessage = {
      id: clientMessageId, type: "photo", role: "user", photoId: clientMessageId, caption,
      origin: "photo", createdAt: options.now(), delivery: "sending",
    };
    current = { ...current, snapshot: { ...current.snapshot, timeline: replaceOrAppend(current.snapshot.timeline, optimistic) } };
    try {
      let analyzedPhoto: Awaited<ReturnType<PhotoApi["analyze"]>>["photo"] | undefined;
      let timeline = commitInput?.snapshot.timeline;
      if (!commitInput) {
        onProgress?.("sending");
        const analyzed = await options.photoApi.analyze({ clientMessageId, caption, blob: lease.blob() });
        if (disposed) { lease.terminal(); return; }
        analyzedPhoto = analyzed.photo;
        const photo: PhotoMessage = { ...optimistic, photoId: analyzed.photo.id, createdAt: analyzed.photo.createdAt, delivery: "sent" };
        timeline = analyzed.reply.bubbles.reduce<TimelineItem[]>((items, bubble) => replaceOrAppend(items, {
          id: bubble.id, type: "message", role: "assistant", text: bubble.text, createdAt: bubble.createdAt,
          delivery: "sent", replyGroupId: analyzed.reply.replyGroupId, sequence: bubble.sequence,
          origin: "photo_analysis", sourcePhotoMessageId: clientMessageId,
        }), replaceOrAppend(current.snapshot.timeline, photo));
      }
      if (!isAuthoritativeRevisionCoordinator(options.store, options.authoritativeRevisionCoordinator)) {
        throw new Error("photo_coordinator_invalid");
      }
      onProgress?.("committing");
      const committed = await options.authoritativeRevisionCoordinator.mutate((expectedRevision) => {
        // Reuse the exact mutation after an unknown storage result, never upload/analyze again.
        if (commitInput && commitInput.expectedRevision !== expectedRevision) throw new Error("photo_ambiguous");
        commitInput ??= {
          photoId: analyzedPhoto!.id, expectedRevision,
          snapshot: { timeline: timeline!, lastOpeningAt: current.snapshot.lastOpeningAt, lastConversationAt: analyzedPhoto!.createdAt, version: 3, revision: expectedRevision + 1, updatedAt: options.now() },
        };
        return options.photoApi!.commit(commitInput);
      }, current.snapshot.draft);
      if (disposed) { lease.terminal(); return; }
      current = { ...current, snapshot: { ...current.snapshot, timeline: committed.timeline, lastOpeningAt: committed.lastOpeningAt, lastConversationAt: committed.lastConversationAt } };
      retryablePhotos.delete(clientMessageId);
      lease.finish();
      onProgress?.("completed");
    } catch (error) {
      if (disposed) { retryablePhotos.delete(clientMessageId); lease.terminal(); return; }
      if (error instanceof Error && (error.message === "photo_ambiguous" || error.message === "photo_coordinator_invalid")) {
        retryablePhotos.delete(clientMessageId);
        lease.terminal();
        onProgress?.("terminal");
      } else {
        retryablePhotos.set(clientMessageId, { lease, caption, commitInput });
        lease.markRetryable();
        onProgress?.(commitInput ? "commit_retryable" : "retryable");
      }
      const item = current.snapshot.timeline.find((value) => value.id === clientMessageId);
      if (item?.type === "photo") current = { ...current, snapshot: { ...current.snapshot, timeline: replaceOrAppend(current.snapshot.timeline, { ...item, delivery: "failed" }) } };
    }
  }

  return {
    get state() { return current; },
    hydrate() {
      return enqueue(async () => {
      const [snapshot, profile] = await Promise.all([options.store.load(), options.profileApi.get()]);
      await dispatch({ type: "hydrate", snapshot, profile, now: options.now(), openingMessageId: options.nextId() });
      });
    },
    saveProfile(input) {
      return enqueue(async () => {
        const firstSave = current.profile === null;
        const profile = await options.profileApi.save(input);
        if (!disposed) {
          if (firstSave) {
            const transition = chatReducer(current, {
              type: "profile-saved",
              profile,
              greetingId: options.nextId(),
              now: options.now(),
            });
            await options.store.save(transition.state.snapshot);
            if (!disposed) current = transition.state;
          } else {
            await dispatch({ type: "profile-updated", profile });
          }
        }
        return profile;
      });
    },
    updateProfile(input) {
      return enqueue(async () => {
        const profile = await options.profileApi.save(input);
        if (!disposed) {
          await dispatch({ type: "profile-updated", profile });
        }
        return profile;
      });
    },
    send(text) {
      const clientMessageId = options.nextId();
      return scheduleGeneration({ type: "send", clientMessageId, text, now: options.now() }).then(() => clientMessageId);
    },
    updateDraft(draft) {
      return enqueue(async () => {
        if (disposed) throw new Error("Chat controller is closed");
        if (current.snapshot.draft === draft) return;
        const snapshot = { ...current.snapshot, draft };
        await options.store.save(snapshot);
        if (!disposed) current = { ...current, snapshot };
      });
    },
    updateLifeCard(messageId, card) {
      return enqueue(async () => {
        if (disposed) throw new Error("Life card controller is closed");
        const parsed = parseLifeCard(card);
        const item = current.snapshot.timeline.find(item => item.id === messageId);
        if (!parsed || item?.type !== "message" || item.role !== "assistant" || item.flow !== "external_context" || item.origin || !item.lifeCard) throw new Error("Life card target is invalid");
        if (JSON.stringify(item.lifeCard) === JSON.stringify(parsed)) return;
        const snapshot = { ...current.snapshot, timeline: replaceOrAppend(current.snapshot.timeline, { ...item, lifeCard: parsed }) };
        // The cloud-backed store owns revision serialization and rejects stale replacement.
        await options.store.save(snapshot);
        if (!disposed) current = { ...current, snapshot };
      });
    },
    retryChat(clientMessageId) {
      return scheduleGeneration({ type: "retry-chat", clientMessageId });
    },
    stopGeneration() {
      const generation = activeGeneration;
      if (!generation || disposed) return;
      activeGeneration = undefined;
      generation.controller.abort();
      markStopped(generation.clientMessageId);
      // Keep writes ordered, including any save already in progress.
      void enqueue(async () => { if (!disposed) await options.store.save(current.snapshot); }).catch(() => undefined);
    },
    flush() {
      return enqueue(async () => { if (!disposed) await options.store.save(current.snapshot); });
    },
    appendVoiceTurn(input) {
      return enqueue(async () => {
        if (disposed || !input.text.trim()) return;
        const existing = current.snapshot.timeline.find(item => item.id === input.id);
        if (existing) { await options.store.save(current.snapshot); return; }
        const snapshot = { ...current.snapshot,
          timeline: [...current.snapshot.timeline, message(input.id, input.role, input.text, input.createdAt)],
          lastConversationAt: input.createdAt };
        // Keep the local transcript visible even if its cloud write needs attention.
        current = { ...current, snapshot };
        options.onStateChange?.();
        await options.store.save(snapshot);
      });
    },
    appendProactiveCandidate(input) {
      const messageId = `proactive:${input.candidateId}:0`;
      return enqueue(async () => {
        await dispatch({ type: "proactive-received", candidateId: input.candidateId, text: input.text, now: input.createdAt });
        return messageId;
      });
    },
    sendPhoto(lease, caption, onProgress) {
      const clientMessageId = options.nextId();
      return enqueue(async () => { await runPhoto(clientMessageId, lease, caption, onProgress); return clientMessageId; });
    },
    photoDelivery(clientMessageId) {
      const item = current.snapshot.timeline.find((candidate) => candidate.id === clientMessageId);
      if (item?.type !== "photo") return null;
      if (item.delivery === "sent") return "sent";
      if (item.delivery !== "failed") return null;
      return retryablePhotos.has(clientMessageId) ? "retryable" : "terminal";
    },
    retryPhoto(clientMessageId, onProgress) {
      return enqueue(async () => {
        const retained = retryablePhotos.get(clientMessageId);
        if (!retained) return;
        await runPhoto(clientMessageId, retained.lease, retained.caption, onProgress, retained.commitInput);
      });
    },
    cancelPhoto(clientMessageId) {
      return enqueue(async () => {
        const retained = retryablePhotos.get(clientMessageId);
        if (!retained) return;
        retained.lease.cancel();
        retryablePhotos.delete(clientMessageId);
        current = {
          ...current,
          snapshot: {
            ...current.snapshot,
            timeline: current.snapshot.timeline.filter((item) => item.id !== clientMessageId),
          },
        };
      });
    },
    deletePhoto(photoId) {
      return enqueue(async () => {
        if (!options.photoApi || !isAuthoritativeRevisionCoordinator(options.store, options.authoritativeRevisionCoordinator)) return;
        const deleted = await options.authoritativeRevisionCoordinator.mutate(
          (expectedRevision) => options.photoApi!.delete({ photoId, expectedRevision }),
          current.snapshot.draft,
        );
        current = { ...current, snapshot: { ...current.snapshot, timeline: deleted.timeline, lastOpeningAt: deleted.lastOpeningAt, lastConversationAt: deleted.lastConversationAt } };
        for (const [messageId, retained] of retryablePhotos) {
          const item = current.snapshot.timeline.find((value) => value.id === messageId && value.type === "photo" && value.photoId === photoId);
          if (!item) { retained.lease.terminal(); retryablePhotos.delete(messageId); }
        }
      });
    },
    markProfileGreetingRevealed(replyGroupId) {
      void dispatch({ type: "profile-greeting-revealed", replyGroupId });
    },
    dispose() { activeGeneration?.controller.abort("chat-disposed"); disposed = true; for (const retained of retryablePhotos.values()) retained.lease.terminal(); retryablePhotos.clear(); },
  };
}
