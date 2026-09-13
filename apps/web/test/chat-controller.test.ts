import { describe, expect, it, vi } from "vitest";
import type { ChatReply, LocalChatSnapshot, Profile, RemoteChatSnapshot } from "@yui/domain";
import { EMPTY_LOCAL_CHAT } from "../src/local-state";
import { chatReducer, createChatController, initialChatState } from "../src/chat-controller";
import type { PhotoSendLease } from "../src/photo-preparation";
import { YuiRequestError } from "../src/api";
import { createCloudLocalStateStore, getAuthoritativeRevisionCoordinator } from "../src/cloud-state";

const now = "2026-08-08T03:00:00.000Z";
const profile: Profile = { displayName: "大輝", addressingStyle: "san", updatedAt: now };

it("notifies the UI of a queued message before its save and reply complete", async () => {
  let release!: () => void;
  const pendingSave = new Promise<void>(resolve => { release = resolve; });
  const observed: string[] = [];
  const controller = createChatController({
    store: { load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => pendingSave },
    profileApi: { get: async () => profile, save: async () => profile },
    chatApi: { respond: async () => groupedReply("pending") },
    now: () => now, nextId: () => "pending",
    onStateChange: () => {
      for (const item of controller.state.snapshot.timeline) {
        if (item.type === "message" && item.role === "user") observed.push(item.text);
      }
    },
  });
  await controller.hydrate();
  const sent = controller.send("すぐ表示して");
  await vi.waitFor(() => expect(observed).toContain("すぐ表示して"));
  expect(controller.state.snapshot.timeline).toMatchObject([{ delivery: "sending" }]);
  release();
  await sent;
});

function groupedReply(clientMessageId: string, texts = ["おかえりなさい"], authoritativeProfile?: Profile): ChatReply {
  const replyGroupId = `${clientMessageId}:assistant`;
  return {
    replyGroupId,
    bubbles: texts.map((text, sequence) => ({
      id: `${replyGroupId}:${sequence}`,
      text,
      createdAt: now,
      sequence: sequence as 0 | 1 | 2,
    })),
    ...(authoritativeProfile ? { profile: authoritativeProfile } : {}),
  };
}

function reduce(action: Parameters<typeof chatReducer>[1]) {
  return chatReducer(initialChatState, action);
}

function hydrate(snapshot: LocalChatSnapshot = EMPTY_LOCAL_CHAT, savedProfile: Profile | null = null) {
  return reduce({ type: "hydrate", snapshot, profile: savedProfile, now, openingMessageId: "opening-1" });
}

function photoCloudStore(initialRevision = 0, initial: LocalChatSnapshot = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }) {
  return createCloudLocalStateStore({
    remote: {
      load: async () => ({
        timeline: initial.timeline,
        lastOpeningAt: initial.lastOpeningAt,
        lastConversationAt: initial.lastConversationAt,
        version: 3,
        revision: initialRevision,
        updatedAt: now,
      }),
      save: async () => { throw new Error("unexpected ordinary save"); },
    },
    cache: { load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined },
    now: () => now,
  });
}

describe("chat controller reducer", () => {
  it("keeps profile setup out of the chat timeline", () => {
    const result = hydrate();

    expect(result.state.snapshot.timeline).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  it("requests an opening only for a named hydration that the domain rule permits", () => {
    const allowed = hydrate(EMPTY_LOCAL_CHAT, profile);
    const recent: LocalChatSnapshot = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now, lastConversationAt: now };
    const blocked = hydrate(recent, profile);

    expect(allowed.commands).toEqual(expect.arrayContaining([{ type: "request-chat", kind: "opening", clientMessageId: "opening-1" }]));
    expect(blocked.commands.some((command) => command.type === "request-chat")).toBe(false);
  });

  it("keeps an opening single-flight across repeated hydration and ignores a stale settlement", () => {
    const first = hydrate(EMPTY_LOCAL_CHAT, profile);
    const repeated = chatReducer(first.state, { type: "hydrate", snapshot: first.state.snapshot, profile, now, openingMessageId: "opening-2" });
    const stale = chatReducer(first.state, { type: "chat-succeeded", kind: "opening", clientMessageId: "opening-old", now, reply: groupedReply("opening-old", ["古い返答"]) });

    expect(repeated.commands).toEqual([]);
    expect(stale.state).toEqual(first.state);
  });

  it("sends one user item with a stable ID, marks failure, and retries it without duplicating", () => {
    const state = hydrate(EMPTY_LOCAL_CHAT, profile).state;
    const sent = chatReducer(state, { type: "send", clientMessageId: "message-1", text: "ただいま", now });
    const failed = chatReducer(sent.state, { type: "chat-failed", kind: "reply", clientMessageId: "message-1", failureKind: "upstream" });
    const retried = chatReducer(failed.state, { type: "retry-chat", clientMessageId: "message-1" });

    expect(sent.state.snapshot.timeline).toMatchObject([{ id: "message-1", delivery: "sending", text: "ただいま" }]);
    expect(failed.state.snapshot.timeline).toMatchObject([{ id: "message-1", delivery: "failed" }]);
    expect(failed.state.failureByMessageId).toEqual({ "message-1": "upstream" });
    expect(retried.state.failureByMessageId).toEqual({});
    expect(retried.state.snapshot.timeline.filter((item) => item.id === "message-1")).toHaveLength(1);
    expect(retried.commands).toEqual(expect.arrayContaining([{ type: "request-chat", kind: "reply", clientMessageId: "message-1" }]));
  });

  it("does not dispatch a retry when the profile must be completed first", () => {
    const state = hydrate(EMPTY_LOCAL_CHAT, profile).state;
    const sent = chatReducer(state, { type: "send", clientMessageId: "message-1", text: "ただいま", now });
    const failed = chatReducer(sent.state, { type: "chat-failed", kind: "reply", clientMessageId: "message-1", failureKind: "profile-required" });
    const retried = chatReducer(failed.state, { type: "retry-chat", clientMessageId: "message-1" });

    expect(retried).toEqual({ state: failed.state, commands: [] });
  });

  it("does not dispatch a retry when authentication has expired", () => {
    const state = hydrate(EMPTY_LOCAL_CHAT, profile).state;
    const sent = chatReducer(state, { type: "send", clientMessageId: "message-1", text: "ただいま", now });
    const failed = chatReducer(sent.state, { type: "chat-failed", kind: "reply", clientMessageId: "message-1", failureKind: "authentication" });
    const retried = chatReducer(failed.state, { type: "retry-chat", clientMessageId: "message-1" });

    expect(retried).toEqual({ state: failed.state, commands: [] });
  });

  it("marks a completed reply sent and upserts every grouped bubble in sequence with one persist transition", () => {
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "send", clientMessageId: "message-1", text: "ただいま", now });
    const action = {
      type: "chat-succeeded" as const,
      kind: "reply" as const,
      clientMessageId: "message-1",
      now,
      reply: groupedReply("message-1", ["おかえり", "今日は大変だったね", "まずは座ろう"]),
    };
    const completed = chatReducer(sending.state, action);
    const repeated = chatReducer(completed.state, action);
    const staleFailure = chatReducer(completed.state, { type: "chat-failed", kind: "reply", clientMessageId: "message-1", failureKind: "unknown" });

    expect(completed.state.snapshot.timeline).toMatchObject([
      { id: "message-1", delivery: "sent" },
      { id: "message-1:assistant:0", role: "assistant", text: "おかえり", delivery: "sent", replyGroupId: "message-1:assistant", sequence: 0 },
      { id: "message-1:assistant:1", role: "assistant", text: "今日は大変だったね", delivery: "sent", replyGroupId: "message-1:assistant", sequence: 1 },
      { id: "message-1:assistant:2", role: "assistant", text: "まずは座ろう", delivery: "sent", replyGroupId: "message-1:assistant", sequence: 2 },
    ]);
    expect(completed.commands).toEqual([{ type: "persist" }]);
    expect(repeated.state).toEqual(completed.state);
    expect(repeated.commands).toEqual([]);
    expect(staleFailure.state).toEqual(completed.state);
  });

  it("persists the safe external-context marker without service details", () => {
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "send", clientMessageId: "calendar-1", text: "今日の予定", now });
    const reply = groupedReply("calendar-1", ["10時は予定ありだよ"]);
    reply.bubbles[0] = { ...reply.bubbles[0]!, flow: "external_context" };
    const completed = chatReducer(sending.state, { type: "chat-succeeded", kind: "reply", clientMessageId: "calendar-1", now, reply });
    expect(completed.state.snapshot.timeline.at(-1)).toMatchObject({ flow: "external_context" });
    expect(JSON.stringify(completed.state.snapshot.timeline)).not.toContain("google_calendar");
  });

  it("appends one idempotent proactive bubble to the same Talk without requesting chat", () => {
    const state = hydrate({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }, profile).state;
    const action = {
      type: "proactive-received" as const,
      candidateId: "opening-20260829",
      text: "おかえりなさい。今日もここにいますよ",
      now,
    };
    const first = chatReducer(state, action);
    const repeated = chatReducer(first.state, action);

    expect(first.state.snapshot.timeline).toEqual([{
      id: "proactive:opening-20260829:0",
      type: "message",
      role: "assistant",
      text: action.text,
      createdAt: now,
      delivery: "sent",
      flow: "external_context",
      replyGroupId: "proactive:opening-20260829",
      sequence: 0,
    }]);
    expect(first.commands).toEqual([{ type: "persist" }]);
    expect(repeated.state).toBe(first.state);
    expect(repeated.commands).toEqual([]);
  });

  it("attaches search status and sources only to the final assistant bubble", () => {
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "send", clientMessageId: "message-1", text: "検索して", now });
    const searched = groupedReply("message-1", ["確認したよ", "出典はこちら"]);
    searched.search = {
      status: "completed",
      searchedAt: "2026-08-13T03:00:00.000Z",
      sources: [{ title: "公式発表", url: "https://example.com/official" }],
      evidence: { facts: [{ text: "公式発表を確認しました", sourceUrl: "https://example.com/official" }], inference: null, suggestion: null },
    };
    const completed = chatReducer(sending.state, {
      type: "chat-succeeded", kind: "reply", clientMessageId: "message-1", now, reply: searched,
    });
    const assistants = completed.state.snapshot.timeline.filter((item) => item.type === "message" && item.role === "assistant");

    expect(assistants[0]).not.toHaveProperty("search");
    expect(assistants[1]).toMatchObject({ search: searched.search });
  });

  it("applies an accepted authoritative profile atomically with its reply bubbles", () => {
    const updatedProfile: Profile = { displayName: "大輝", addressingStyle: "none", updatedAt: "2026-08-08T03:05:00.000Z" };
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "send", clientMessageId: "message-1", text: "呼び方を変えて", now });

    const completed = chatReducer(sending.state, {
      type: "chat-succeeded",
      kind: "reply",
      clientMessageId: "message-1",
      now,
      reply: groupedReply("message-1", ["わかったよ"], updatedProfile),
    });

    expect(completed.state.profile).toEqual(updatedProfile);
    expect(completed.state.snapshot.timeline).toContainEqual(expect.objectContaining({
      id: "message-1:assistant:0",
      text: "わかったよ",
    }));
    expect(completed.commands).toEqual([{ type: "persist" }]);
  });

  it("keeps the current profile when an accepted chat reply has no profile", () => {
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "send", clientMessageId: "message-1", text: "ただいま", now });

    const completed = chatReducer(sending.state, {
      type: "chat-succeeded",
      kind: "reply",
      clientMessageId: "message-1",
      now,
      reply: groupedReply("message-1"),
    });

    expect(completed.state.profile).toEqual(profile);
  });

  it("keeps a newer Settings profile while accepting bubbles from an older cached reply", () => {
    const newerSettingsProfile: Profile = {
      displayName: "大輝",
      addressingStyle: "none",
      updatedAt: "2026-08-08T03:10:00.000Z",
    };
    const staleReplyProfile: Profile = {
      displayName: "大輝",
      addressingStyle: "san",
      updatedAt: "2026-08-08T03:05:00.000Z",
    };
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, {
      type: "send",
      clientMessageId: "message-cached",
      text: "呼び方を変えて",
      now,
    });
    const settingsSaved = chatReducer(sending.state, {
      type: "profile-updated",
      profile: newerSettingsProfile,
    });

    const completed = chatReducer(settingsSaved.state, {
      type: "chat-succeeded",
      kind: "reply",
      clientMessageId: "message-cached",
      now,
      reply: groupedReply("message-cached", ["返事は届いたよ"], staleReplyProfile),
    });

    expect(completed.state.profile).toEqual(newerSettingsProfile);
    expect(completed.state.snapshot.timeline).toContainEqual(expect.objectContaining({
      id: "message-cached:assistant:0",
      text: "返事は届いたよ",
    }));
    expect(completed.commands).toEqual([{ type: "persist" }]);
  });

  it("accepts an authoritative reply profile with the same update timestamp", () => {
    const currentProfile: Profile = {
      displayName: "大輝",
      addressingStyle: "san",
      updatedAt: "2026-08-08T03:10:00.000Z",
    };
    const equalTimestampProfile: Profile = {
      ...currentProfile,
      addressingStyle: "none",
    };
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, currentProfile).state, {
      type: "send",
      clientMessageId: "message-equal",
      text: "呼び捨てで",
      now,
    });

    const completed = chatReducer(sending.state, {
      type: "chat-succeeded",
      kind: "reply",
      clientMessageId: "message-equal",
      now,
      reply: groupedReply("message-equal", ["わかったよ"], equalTimestampProfile),
    });

    expect(completed.state.profile).toEqual(equalTimestampProfile);
  });

  it("does not let a stale chat reply change the profile", () => {
    const updatedProfile: Profile = { displayName: "大輝", addressingStyle: "none", updatedAt: "2026-08-08T03:05:00.000Z" };
    const sending = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "send", clientMessageId: "message-1", text: "ただいま", now });
    const completed = chatReducer(sending.state, {
      type: "chat-succeeded",
      kind: "reply",
      clientMessageId: "message-1",
      now,
      reply: groupedReply("message-1"),
    });

    const stale = chatReducer(completed.state, {
      type: "chat-succeeded",
      kind: "reply",
      clientMessageId: "message-1",
      now,
      reply: groupedReply("message-1", ["古い返答"], updatedProfile),
    });

    expect(stale.state).toEqual(completed.state);
    expect(stale.commands).toEqual([]);
  });

  it("persists completion timestamps for openings and replies", () => {
    const opening = chatReducer(hydrate(EMPTY_LOCAL_CHAT, profile).state, { type: "chat-succeeded", kind: "opening", clientMessageId: "opening-1", now, reply: groupedReply("opening-1", ["おかえり", "今日もおつかれさま"]) });
    const replyState = chatReducer(opening.state, { type: "send", clientMessageId: "message-1", text: "ただいま", now }).state;
    const reply = chatReducer(replyState, { type: "chat-succeeded", kind: "reply", clientMessageId: "message-1", now: "2026-08-08T03:10:00.000Z", reply: groupedReply("message-1") });

    expect(opening.state.snapshot.lastOpeningAt).toBe(now);
    expect(opening.state.snapshot.timeline).toMatchObject([
      { id: "opening-1:assistant:0", replyGroupId: "opening-1:assistant", sequence: 0 },
      { id: "opening-1:assistant:1", replyGroupId: "opening-1:assistant", sequence: 1 },
    ]);
    expect(opening.commands).toEqual(expect.arrayContaining([{ type: "persist" }]));
    expect(reply.state.snapshot.lastConversationAt).toBe("2026-08-08T03:10:00.000Z");
    expect(reply.commands).toEqual(expect.arrayContaining([{ type: "persist" }]));
  });

  it("saves the first profile and atomically persists exactly two local profile greetings", async () => {
    const saveProfile = vi.fn(async () => profile);
    const saveSnapshot = vi.fn(async () => undefined);
    const ids = ["opening-unused", "profile-1"];
    const controller = createChatController({
      store: { load: async () => EMPTY_LOCAL_CHAT, save: saveSnapshot },
      profileApi: { get: async () => null, save: saveProfile },
      chatApi: { respond: async () => { throw new Error("not used"); } },
      now: () => now,
      nextId: () => ids.shift() ?? "extra",
    });
    await controller.hydrate();

    const saved = await controller.saveProfile({ displayName: "大輝", addressingStyle: "san" });

    expect(saved).toEqual(profile);
    expect(saveProfile).toHaveBeenCalledWith({ displayName: "大輝", addressingStyle: "san" });
    expect(controller.state.profile).toEqual(profile);
    expect(controller.state.snapshot.timeline).toMatchObject([
      { id: "profile-1:0", text: "大輝さん、はじめまして", flow: "profile", replyGroupId: "profile-1", sequence: 0 },
      { id: "profile-1:1", text: "これからよろしくね", flow: "profile", replyGroupId: "profile-1", sequence: 1 },
    ]);
    expect(controller.state.delayedGreetingReplyGroupId).toBe("profile-1");
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      timeline: expect.arrayContaining([
        expect.objectContaining({ id: "profile-1:0" }),
        expect.objectContaining({ id: "profile-1:1" }),
      ]),
    }));
    expect(saveSnapshot.mock.calls[0]?.[0]).not.toHaveProperty("delayedGreetingReplyGroupId");

    controller.markProfileGreetingRevealed("stale-profile");
    expect(controller.state.delayedGreetingReplyGroupId).toBe("profile-1");

    controller.markProfileGreetingRevealed("profile-1");
    expect(controller.state.delayedGreetingReplyGroupId).toBeNull();
    expect(controller.state.snapshot.timeline).toMatchObject([
      { id: "profile-1:0", text: "大輝さん、はじめまして" },
      { id: "profile-1:1", text: "これからよろしくね" },
    ]);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);

    const reloaded = createChatController({
      store: { load: async () => saveSnapshot.mock.calls[0]![0], save: async () => undefined },
      profileApi: { get: async () => profile, save: saveProfile },
      chatApi: { respond: async () => { throw new Error("not used"); } },
      now: () => now,
      nextId: () => "opening-after-reload",
    });
    await reloaded.hydrate();

    expect(reloaded.state.delayedGreetingReplyGroupId).toBeNull();
    expect(reloaded.state.snapshot.timeline).toMatchObject([
      { id: "profile-1:0", text: "大輝さん、はじめまして" },
      { id: "profile-1:1", text: "これからよろしくね" },
    ]);
  });

  it("leaves profile and local greetings untouched when the first save fails", async () => {
    const saveSnapshot = vi.fn(async () => undefined);
    const controller = createChatController({
      store: { load: async () => EMPTY_LOCAL_CHAT, save: saveSnapshot },
      profileApi: { get: async () => null, save: async () => { throw new Error("offline"); } },
      chatApi: { respond: async () => { throw new Error("not used"); } },
      now: () => now,
      nextId: () => "unused",
    });
    await controller.hydrate();

    await expect(controller.saveProfile({ displayName: "大輝", addressingStyle: "san" }))
      .rejects.toThrow("offline");

    expect(controller.state.profile).toBeNull();
    expect(controller.state.snapshot.timeline).toEqual([]);
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it("updates a saved profile without creating another greeting", async () => {
    const updated: Profile = { displayName: "大輝", addressingStyle: "none", updatedAt: now };
    const saveProfile = vi.fn(async () => updated);
    const saveSnapshot = vi.fn(async () => undefined);
    const nextId = vi.fn(() => "opening-1");
    const existingGreeting = {
      id: "profile-1:0",
      type: "message" as const,
      role: "assistant" as const,
      text: "大輝さん、はじめまして",
      createdAt: now,
      delivery: "sent" as const,
      flow: "profile" as const,
      replyGroupId: "profile-1",
      sequence: 0 as const,
    };
    const controller = createChatController({
      store: { load: async () => ({ ...EMPTY_LOCAL_CHAT, timeline: [existingGreeting] }), save: saveSnapshot },
      profileApi: { get: async () => profile, save: saveProfile },
      chatApi: { respond: async () => { throw new Error("not used"); } },
      now: () => now,
      nextId,
    });
    await controller.hydrate();
    saveSnapshot.mockClear();
    nextId.mockClear();

    await expect(controller.updateProfile({ displayName: "大輝", addressingStyle: "none" }))
      .resolves.toEqual(updated);

    expect(controller.state.profile).toEqual(updated);
    expect(controller.state.snapshot.timeline).toEqual([existingGreeting]);
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
  });

  it("persists a complete reply group in one completion save", async () => {
    const saveSnapshot = vi.fn(async () => undefined);
    const recent = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now, lastConversationAt: now };
    const controller = createChatController({
      store: { load: async () => recent, save: saveSnapshot },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond: async ({ clientMessageId }) => groupedReply(clientMessageId, ["おかえり", "今日は大変だったね"]) },
      now: () => now,
      nextId: () => "user-1",
    });
    await controller.hydrate();

    await controller.send("起きた");

    const completedWrites = saveSnapshot.mock.calls.filter(([snapshot]) =>
      snapshot.timeline.some((item) => item.id === "user-1:assistant:0"),
    );
    expect(completedWrites).toHaveLength(1);
    expect(completedWrites[0]?.[0]).toEqual(expect.objectContaining({
      timeline: expect.arrayContaining([
        expect.objectContaining({ replyGroupId: "user-1:assistant", sequence: 0 }),
        expect.objectContaining({ replyGroupId: "user-1:assistant", sequence: 1 }),
      ]),
    }));
  });

  it("commits a v3 photo exchange before releasing the transferred Blob", async () => {
    const finish = vi.fn();
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish, cancel: vi.fn(), terminal: vi.fn() } satisfies PhotoSendLease;
    const photoId = "22222222-2222-4222-8222-222222222222";
    const photoApi = {
      analyze: vi.fn(async () => ({
        photo: { id: photoId, messageId: "11111111-1111-4111-8111-111111111111", createdAt: now },
        reply: { replyGroupId: "11111111-1111-4111-8111-111111111111:assistant", bubbles: [{ id: "11111111-1111-4111-8111-111111111111:assistant:0", text: "見えたよ", createdAt: now, sequence: 0 as const, delivery: "sent" as const, origin: "photo_analysis" as const, sourcePhotoMessageId: "11111111-1111-4111-8111-111111111111" }] },
      })),
      commit: vi.fn(async ({ expectedRevision, snapshot }) => ({ ...snapshot, revision: expectedRevision + 1 })), delete: vi.fn(), fetchContent: vi.fn(),
    };
    const store = photoCloudStore(7);
    const controller = createChatController({
      store,
      profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() }, photoApi,
      authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!,
      now: () => now, nextId: () => "11111111-1111-4111-8111-111111111111",
    });
    await controller.hydrate();
    await controller.sendPhoto(lease, "見て");
    expect(photoApi.commit).toHaveBeenCalledWith(expect.objectContaining({ photoId, expectedRevision: 7, snapshot: expect.objectContaining({ version: 3, revision: 8 }) }));
    expect(controller.state.snapshot.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "photo", photoId, caption: "見て", delivery: "sent" }),
      expect.objectContaining({ origin: "photo_analysis", text: "見えたよ" }),
    ]));
    expect(finish).toHaveBeenCalledOnce();
    expect(controller.photoDelivery("11111111-1111-4111-8111-111111111111")).toBe("sent");
  });

  it("reports analysis and durable commit stages without changing the photo request", async () => {
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    const photoId = "22222222-2222-4222-8222-222222222222";
    const stages: string[] = [];
    const photoApi = {
      analyze: vi.fn(async () => ({
        photo: { id: photoId, messageId: clientMessageId, createdAt: now },
        reply: { replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "見えたよ", createdAt: now, sequence: 0 as const }] },
      })),
      commit: vi.fn(async ({ snapshot }) => ({ ...snapshot, revision: 1 })), delete: vi.fn(), fetchContent: vi.fn(),
    };
    const store = photoCloudStore();
    const controller = createChatController({ store, profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() }, photoApi, authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!, now: () => now, nextId: () => clientMessageId });
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel: vi.fn(), terminal: vi.fn() } satisfies PhotoSendLease;
    await controller.hydrate();

    await controller.sendPhoto(lease, "見て", (stage) => stages.push(stage));

    expect(stages).toEqual(["sending", "committing", "completed"]);
    expect(photoApi.analyze).toHaveBeenCalledWith(expect.objectContaining({ clientMessageId }));
    expect(photoApi.commit).toHaveBeenCalledOnce();
  });

  it("retries only durable storage after analysis succeeded and commit timed out", async () => {
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    const photoId = "22222222-2222-4222-8222-222222222222";
    const stages: string[] = [];
    const photoApi = {
      analyze: vi.fn(async () => ({ photo: { id: photoId, messageId: clientMessageId, createdAt: now }, reply: { replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "見えたよ", createdAt: now, sequence: 0 as const }] } })),
      commit: vi.fn().mockRejectedValueOnce(new Error("photo_unavailable")).mockImplementationOnce(async ({ snapshot }) => snapshot),
      delete: vi.fn(), fetchContent: vi.fn(),
    };
    const store = photoCloudStore();
    const controller = createChatController({ store, profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() }, photoApi, authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!, now: () => now, nextId: () => clientMessageId });
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel: vi.fn(), terminal: vi.fn() } satisfies PhotoSendLease;
    await controller.hydrate();
    await controller.sendPhoto(lease, "見て", (stage) => stages.push(stage));
    expect(stages).toEqual(["sending", "committing", "commit_retryable"]);
    await controller.retryPhoto(clientMessageId, (stage) => stages.push(stage));
    expect(photoApi.analyze).toHaveBeenCalledOnce();
    expect(photoApi.commit).toHaveBeenCalledTimes(2);
    expect(photoApi.commit.mock.calls[1][0]).toEqual(photoApi.commit.mock.calls[0][0]);
    expect(stages.slice(-2)).toEqual(["committing", "completed"]);
    expect(controller.photoDelivery(clientMessageId)).toBe("sent");
  });

  it("does not retain a failed commit after its owner controller is disposed", async () => {
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    let rejectCommit!: (error: Error) => void;
    const commitWait = new Promise<never>((_, reject) => { rejectCommit = reject; });
    const photoApi = {
      analyze: vi.fn(async () => ({ photo: { id: "22222222-2222-4222-8222-222222222222", messageId: clientMessageId, createdAt: now }, reply: { replyGroupId: `${clientMessageId}:assistant`, bubbles: [] } })),
      commit: vi.fn(() => commitWait), delete: vi.fn(), fetchContent: vi.fn(),
    };
    const store = photoCloudStore();
    const controller = createChatController({ store, profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() }, photoApi, authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!, now: () => now, nextId: () => clientMessageId });
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel: vi.fn(), terminal: vi.fn() } satisfies PhotoSendLease;
    await controller.hydrate();
    const sending = controller.sendPhoto(lease, "");
    await vi.waitFor(() => expect(photoApi.commit).toHaveBeenCalledOnce());
    controller.dispose();
    rejectCommit(new Error("photo_unavailable"));
    await sending;
    expect(lease.markRetryable).not.toHaveBeenCalled();
    expect(lease.terminal).toHaveBeenCalled();
    expect(controller.photoDelivery(clientMessageId)).not.toBe("retryable");
  });

  it("deletes a hydrated photo with the shared authoritative revision", async () => {
    const photoId = "22222222-2222-4222-8222-222222222222";
    const hydrated: LocalChatSnapshot = {
      ...EMPTY_LOCAL_CHAT,
      lastOpeningAt: now,
      timeline: [{
        id: "11111111-1111-4111-8111-111111111111", type: "photo", role: "user", photoId,
        caption: "", origin: "photo", createdAt: now, delivery: "sent",
      }],
    };
    const deleted: RemoteChatSnapshot = {
      timeline: [], lastOpeningAt: now, lastConversationAt: now, version: 3, revision: 12, updatedAt: now,
    };
    const cloudStore = createCloudLocalStateStore({
      remote: {
        load: async () => ({
          timeline: hydrated.timeline, lastOpeningAt: hydrated.lastOpeningAt,
          lastConversationAt: hydrated.lastConversationAt, version: 3, revision: 11, updatedAt: now,
        }),
        save: async () => { throw new Error("unexpected ordinary save"); },
      },
      cache: { load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined },
      now: () => now,
    });
    const photoApi = {
      analyze: vi.fn(), commit: vi.fn(),
      delete: vi.fn(async () => deleted), fetchContent: vi.fn(),
    };
    const controller = createChatController({
      store: cloudStore,
      profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() },
      photoApi, authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(cloudStore)!, now: () => now, nextId: () => "unused",
    });

    await controller.hydrate();
    await controller.deletePhoto(photoId);

    expect(photoApi.delete).toHaveBeenCalledWith({ photoId, expectedRevision: 11 });
    expect(controller.state.snapshot.timeline).toEqual([]);
  });

  it("uses the revision returned by photo commit for the following ordinary text save", async () => {
    const photoMessageId = "11111111-1111-4111-8111-111111111111";
    const photoId = "22222222-2222-4222-8222-222222222222";
    const remoteSaveRevisions: number[] = [];
    const cloudStore = createCloudLocalStateStore({
      remote: {
        load: async () => ({ timeline: [], lastOpeningAt: now, lastConversationAt: now, version: 3, revision: 4, updatedAt: now }),
        save: async (input) => {
          remoteSaveRevisions.push(input.expectedRevision);
          return { ...input.snapshot, revision: input.expectedRevision + 1, updatedAt: now };
        },
      },
      cache: { load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined },
      now: () => now,
    });
    const photoApi = {
      analyze: vi.fn(async () => ({
        photo: { id: photoId, messageId: photoMessageId, createdAt: now },
        reply: { replyGroupId: `${photoMessageId}:assistant`, bubbles: [{ id: `${photoMessageId}:assistant:0`, text: "見えたよ", createdAt: now, sequence: 0 as const, delivery: "sent" as const, origin: "photo_analysis" as const, sourcePhotoMessageId: photoMessageId }] },
      })),
      commit: vi.fn(async ({ expectedRevision, snapshot }) => ({ ...snapshot, revision: expectedRevision + 1 })),
      delete: vi.fn(), fetchContent: vi.fn(),
    };
    const ids = ["opening-unused", photoMessageId, "text-after-photo"];
    const controller = createChatController({
      store: cloudStore,
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond: async ({ clientMessageId }) => groupedReply(clientMessageId) },
      photoApi,
      authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(cloudStore)!,
      now: () => now,
      nextId: () => ids.shift()!,
      requirePersistBeforeChat: true,
    });
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel: vi.fn(), terminal: vi.fn() } satisfies PhotoSendLease;

    await controller.hydrate();
    await controller.sendPhoto(lease, "見て");
    await controller.send("続きも話そう");

    expect(photoApi.commit).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4 }));
    expect(remoteSaveRevisions[0]).toBe(5);
    expect(remoteSaveRevisions).toEqual([5, 6]);
  });

  it("rejects forged, cross-store, and mutable coordinator replacements before photo analysis", async () => {
    const store = photoCloudStore(3);
    const otherStore = photoCloudStore(8);
    const genuine = getAuthoritativeRevisionCoordinator(store)!;
    const other = getAuthoritativeRevisionCoordinator(otherStore)!;
    expect(Object.isFrozen(genuine)).toBe(true);
    const candidates = [
      { mutate: vi.fn() },
      other,
      { mutate: genuine.mutate },
    ];

    for (const candidate of candidates) {
      const terminal = vi.fn();
      const analyze = vi.fn();
      const deletePhoto = vi.fn();
      const controller = createChatController({
        store,
        profileApi: { get: async () => profile, save: async () => profile },
        chatApi: { respond: vi.fn() },
        photoApi: { analyze, commit: vi.fn(), delete: deletePhoto, fetchContent: vi.fn() },
        authoritativeRevisionCoordinator: candidate,
        now: () => now,
        nextId: () => "11111111-1111-4111-8111-111111111111",
      });
      await controller.hydrate();
      await controller.sendPhoto({
        blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(),
        finish: vi.fn(), cancel: vi.fn(), terminal,
      }, "見て");
      await controller.deletePhoto("22222222-2222-4222-8222-222222222222");
      expect(analyze).not.toHaveBeenCalled();
      expect(deletePhoto).not.toHaveBeenCalled();
      expect(terminal).toHaveBeenCalledOnce();
    }
  });

  it("retains one Blob for a same-ID retry and releases it after the durable receipt commits", async () => {
    const markRetryable = vi.fn(); const finish = vi.fn(); const terminal = vi.fn();
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable, finish, cancel: vi.fn(), terminal } satisfies PhotoSendLease;
    const clientMessageId = "11111111-1111-4111-8111-111111111111";
    const photoId = "22222222-2222-4222-8222-222222222222";
    let attempts = 0;
    const photoApi = {
      analyze: vi.fn(async () => {
        attempts += 1; if (attempts === 1) throw new Error("photo_unavailable");
        return { photo: { id: photoId, messageId: clientMessageId, createdAt: now }, reply: { replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "再試行できた", createdAt: now, sequence: 0 as const, delivery: "sent" as const, origin: "photo_analysis" as const, sourcePhotoMessageId: clientMessageId }] } };
      }),
      commit: vi.fn(async ({ snapshot }) => ({ ...snapshot, revision: 1 })), delete: vi.fn(), fetchContent: vi.fn(),
    };
    const store = photoCloudStore();
    const controller = createChatController({ store, profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() }, photoApi, authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!, now: () => now, nextId: () => clientMessageId });
    await controller.hydrate();
    expect(await controller.sendPhoto(lease, "見て")).toBe(clientMessageId);
    expect(markRetryable).toHaveBeenCalledOnce(); expect(finish).not.toHaveBeenCalled();
    await controller.retryPhoto(clientMessageId);
    expect(photoApi.analyze.mock.calls.map(([input]) => input.clientMessageId)).toEqual([clientMessageId, clientMessageId]);
    expect(finish).toHaveBeenCalledOnce(); expect(terminal).not.toHaveBeenCalled();
  });

  it("terminally disposes an ambiguous photo without retrying", async () => {
    const terminal = vi.fn();
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel: vi.fn(), terminal } satisfies PhotoSendLease;
    const photoApi = { analyze: vi.fn(async () => { throw new Error("photo_ambiguous"); }), commit: vi.fn(), delete: vi.fn(), fetchContent: vi.fn() };
    const store = photoCloudStore();
    const controller = createChatController({ store, profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: vi.fn() }, photoApi, authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!, now: () => now, nextId: () => "11111111-1111-4111-8111-111111111111" });
    await controller.hydrate(); await controller.sendPhoto(lease, "見て"); await controller.retryPhoto("11111111-1111-4111-8111-111111111111");
    expect(photoApi.analyze).toHaveBeenCalledOnce(); expect(terminal).toHaveBeenCalledOnce(); expect(lease.markRetryable).not.toHaveBeenCalled();
    expect(controller.photoDelivery("11111111-1111-4111-8111-111111111111")).toBe("terminal");
  });

  it("reports a transient photo failure as retryable without exposing its cause", async () => {
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel: vi.fn(), terminal: vi.fn() } satisfies PhotoSendLease;
    const store = photoCloudStore();
    const controller = createChatController({
      store,
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond: vi.fn() },
      photoApi: { analyze: vi.fn(async () => { throw new Error("untrusted provider detail"); }), commit: vi.fn(), delete: vi.fn(), fetchContent: vi.fn() },
      authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!,
      now: () => now,
      nextId: () => "11111111-1111-4111-8111-111111111111",
    });

    await controller.hydrate();
    await controller.sendPhoto(lease, "見て");

    expect(controller.photoDelivery("11111111-1111-4111-8111-111111111111")).toBe("retryable");
  });

  it("releases a retryable photo and removes its local optimistic item when the owner cancels", async () => {
    const cancel = vi.fn();
    const lease = { blob: () => new Blob(["jpeg"], { type: "image/jpeg" }), markRetryable: vi.fn(), finish: vi.fn(), cancel, terminal: vi.fn() } satisfies PhotoSendLease;
    const store = photoCloudStore();
    const controller = createChatController({
      store,
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond: vi.fn() },
      photoApi: { analyze: vi.fn(async () => { throw new Error("photo_unavailable"); }), commit: vi.fn(), delete: vi.fn(), fetchContent: vi.fn() },
      authoritativeRevisionCoordinator: getAuthoritativeRevisionCoordinator(store)!,
      now: () => now,
      nextId: () => "11111111-1111-4111-8111-111111111111",
    });

    await controller.hydrate();
    await controller.sendPhoto(lease, "見て");
    await controller.cancelPhoto("11111111-1111-4111-8111-111111111111");
    await controller.retryPhoto("11111111-1111-4111-8111-111111111111");

    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.photoDelivery("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(controller.state.snapshot.timeline).not.toContainEqual(expect.objectContaining({ type: "photo", id: "11111111-1111-4111-8111-111111111111" }));
  });

  it("does not duplicate a reply group when the same client message is retried", async () => {
    let attempts = 0;
    const observations: unknown[] = [];
    const recent = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now, lastConversationAt: now };
    const controller = createChatController({
      store: { load: async () => recent, save: async () => undefined },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: {
        respond: async ({ clientMessageId }) => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          return groupedReply(clientMessageId, ["おかえり", "待ってたよ"]);
        },
      },
      now: () => now,
      nextId: () => "user-1",
      onCausalCueObservation: (observation) => observations.push(observation),
    });
    await controller.hydrate();
    await controller.send("ただいま");
    await controller.retryChat("user-1");
    await controller.retryChat("user-1");

    expect(attempts).toBe(2);
    expect(observations).toEqual([
      { type: "received", requestId: "user-1" },
      { type: "waiting", requestId: "user-1" },
      { type: "failed", requestId: "user-1" },
      { type: "retry", requestId: "user-1" },
      { type: "waiting", requestId: "user-1" },
      { type: "delivered", requestId: "user-1", replyGroupId: "user-1:assistant" },
    ]);
    expect(controller.state.snapshot.timeline.filter((item) => item.type === "message" && item.replyGroupId === "user-1:assistant"))
      .toHaveLength(2);
  });

  it("persists the optimistic message before requesting a reply and retains it on failure", async () => {
    const events: string[] = [];
    const controller = createChatController({
      store: {
        load: async () => EMPTY_LOCAL_CHAT,
        save: async (snapshot) => { events.push(`save:${snapshot.timeline.at(-1)?.id}`); },
      },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond: async ({ kind }) => { events.push(`request:${kind}`); throw new YuiRequestError("network"); } },
      now: () => now,
      nextId: () => "message-1",
    });

    await controller.hydrate();
    await controller.send("ただいま");

    expect(events).toContain("save:message-1");
    expect(events.indexOf("save:message-1")).toBeLessThan(events.indexOf("request:reply"));
    expect(controller.state.snapshot.timeline).toContainEqual(expect.objectContaining({ id: "message-1", delivery: "failed" }));
    expect(controller.state.failureByMessageId).toEqual({ "message-1": "network" });
  });

  it("does not call OpenAI when hosted persistence of the pending message fails", async () => {
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => groupedReply(clientMessageId));
    const recent = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now, lastConversationAt: now };
    const controller = createChatController({
      store: { load: async () => recent, save: async () => { throw new Error("cloud offline"); } },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond },
      now: () => now,
      nextId: () => "message-cloud",
      requirePersistBeforeChat: true,
    });
    await controller.hydrate();

    await controller.send("ただいま");

    expect(respond).not.toHaveBeenCalled();
    expect(controller.state.snapshot.timeline).toContainEqual(expect.objectContaining({
      id: "message-cloud",
      text: "ただいま",
      delivery: "failed",
    }));
  });

  it("keeps local-only chat usable when best-effort persistence fails", async () => {
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => groupedReply(clientMessageId));
    const recent = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now, lastConversationAt: now };
    const controller = createChatController({
      store: { load: async () => recent, save: async () => { throw new Error("indexeddb offline"); } },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond },
      now: () => now,
      nextId: () => "message-local",
    });
    await controller.hydrate();

    await controller.send("ただいま");

    expect(respond).toHaveBeenCalledTimes(1);
    expect(controller.state.snapshot.timeline).toContainEqual(expect.objectContaining({
      id: "message-local:assistant:0",
      delivery: "sent",
    }));
  });

  it("serializes rapid sends so each request sees its own persisted optimistic snapshot", async () => {
    const persisted: string[][] = [];
    const requested: string[][] = [];
    const ids = ["opening-1", "message-1", "message-2"];
    const controller = createChatController({
      store: { load: async () => EMPTY_LOCAL_CHAT, save: async (snapshot) => { persisted.push(snapshot.timeline.map((item) => item.id)); } },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond: async (input) => { requested.push(input.timeline.map((item) => item.id)); return groupedReply(input.clientMessageId, ["了解しました"]); } },
      now: () => now,
      nextId: () => ids.shift() ?? "extra",
    });
    await controller.hydrate();
    await Promise.all([controller.send("一つ目"), controller.send("二つ目")]);

    expect(persisted).toContainEqual(expect.arrayContaining(["message-1"]));
    expect(persisted).toContainEqual(expect.arrayContaining(["message-1", "message-2"]));
    expect(requested.at(-1)).toEqual(expect.arrayContaining(["message-1", "message-2"]));
  });

  it("does not let a disposed controller settle a delayed profile save into local state", async () => {
    let resolveProfile: ((value: Profile) => void) | undefined;
    const saves: string[][] = [];
    const controller = createChatController({
      store: { load: async () => EMPTY_LOCAL_CHAT, save: async (snapshot) => { saves.push(snapshot.timeline.map((item) => item.id)); } },
      profileApi: { get: async () => null, save: async () => new Promise<Profile>((resolve) => { resolveProfile = resolve; }) },
      chatApi: { respond: async () => { throw new Error("not used"); } },
      now: () => now,
      nextId: () => "name-1",
    });

    await controller.hydrate();
    const submitting = controller.saveProfile({ displayName: "大輝", addressingStyle: "san" });
    await Promise.resolve();
    controller.dispose();
    resolveProfile?.(profile);
    await submitting;

    expect(controller.state.profile).toBeNull();
    expect(controller.state.snapshot.timeline).toEqual([]);
    expect(saves.filter((ids) => ids.some((id) => id.startsWith("name-1:")))).toHaveLength(0);
  });
});

it('durably replaces assistant life cards, suppresses equal writes and rejects user targets',async()=>{
 const card={kind:'maps' as const,origin:null,destination:'東京駅',travelMode:'transit' as const};
 const item={id:'a:0',type:'message' as const,role:'assistant' as const,text:'道順です',createdAt:now,delivery:'sent' as const,flow:'external_context' as const,replyGroupId:'a',sequence:0 as const,lifeCard:card};
 let saved:LocalChatSnapshot={...EMPTY_LOCAL_CHAT,lastOpeningAt:now,timeline:[item]};const save=vi.fn(async(s:LocalChatSnapshot)=>{saved=s;});
 const controller=createChatController({store:{load:async()=>saved,save},profileApi:{get:async()=>profile,save:async()=>profile},chatApi:{respond:vi.fn()},now:()=>now,nextId:()=> 'id'});await controller.hydrate();
 const next={...card,destination:'品川駅'};await controller.updateLifeCard(item.id,next);expect(saved.timeline[0]).toMatchObject({lifeCard:next});expect(save).toHaveBeenCalledOnce();await controller.updateLifeCard(item.id,next);expect(save).toHaveBeenCalledOnce();await expect(controller.updateLifeCard('missing',next)).rejects.toThrow('Life card target is invalid');
 const failed={...card,destination:'京都駅'};save.mockRejectedValueOnce(new Error('conflict'));await expect(controller.updateLifeCard(item.id,failed)).rejects.toThrow('conflict');expect(controller.state.snapshot.timeline[0]).toMatchObject({lifeCard:next});
});

it('serializes draft persistence behind a pending life card save without restoring the old card',async()=>{
 const card={kind:'maps' as const,origin:null,destination:'東京駅',travelMode:'transit' as const};
 const item={id:'a:0',type:'message' as const,role:'assistant' as const,text:'道順です',createdAt:now,delivery:'sent' as const,flow:'external_context' as const,replyGroupId:'a',sequence:0 as const,lifeCard:card};
 let saved:LocalChatSnapshot={...EMPTY_LOCAL_CHAT,lastOpeningAt:now,timeline:[item]};let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const save=vi.fn(async(s:LocalChatSnapshot)=>{if(save.mock.calls.length===1)await gate;saved=s;});
 const controller=createChatController({store:{load:async()=>saved,save},profileApi:{get:async()=>profile,save:async()=>profile},chatApi:{respond:vi.fn()},now:()=>now,nextId:()=> 'id'});await controller.hydrate();
 const next={...card,destination:'品川駅'};const updating=controller.updateLifeCard(item.id,next);await Promise.resolve();const typing=controller.updateDraft('続けて入力');expect(save).toHaveBeenCalledOnce();release();await updating;await typing;
 expect(saved.draft).toBe('続けて入力');expect(saved.timeline[0]).toMatchObject({lifeCard:next});expect(controller.state.snapshot).toEqual(saved);
});

it("persists voice turns in order and retries a failed save without duplicating the transcript", async () => {
  const save = vi.fn(async (_snapshot: LocalChatSnapshot) => undefined);
  const respond = vi.fn(async () => groupedReply("unexpected"));
  const controller = createChatController({
    store: { load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save },
    profileApi: { get: async () => profile, save: async () => profile },
    chatApi: { respond }, now: () => now, nextId: () => "unused",
  });
  await controller.hydrate();
  const first = { id: "voice:user", role: "user" as const, text: "こんにちは", createdAt: now };
  save.mockRejectedValueOnce(new Error("offline"));
  await expect(controller.appendVoiceTurn(first)).rejects.toThrow("offline");
  expect(controller.state.snapshot.timeline).toMatchObject([{ id: first.id, text: first.text }]);
  await controller.appendVoiceTurn(first);
  await controller.appendVoiceTurn({ ...first, id: "voice:assistant", role: "assistant", text: "こんにちはなのだ" });
  expect(controller.state.snapshot.timeline.map(item => item.id)).toEqual(["voice:user", "voice:assistant"]);
  expect(save.mock.lastCall?.[0].timeline).toEqual(controller.state.snapshot.timeline);
  expect(respond).not.toHaveBeenCalled();
  controller.dispose();
  await controller.appendVoiceTurn({ ...first, id: "voice:late" });
  expect(controller.state.snapshot.timeline).toHaveLength(2);
});

it("flushes the final voice turn before saving the ended call", async () => {
 const saved: string[][]=[];
 const controller=createChatController({store:{load:async()=>({...EMPTY_LOCAL_CHAT,lastOpeningAt:now}),save:async s=>{saved.push(s.timeline.map(x=>x.id));}},profileApi:{get:async()=>profile,save:async()=>profile},chatApi:{respond:async()=>groupedReply('unused')},now:()=>now,nextId:()=> 'unused'});
 await controller.hydrate();
 const turn=controller.appendVoiceTurn({id:'voice:last',role:'assistant',text:'またね',createdAt:now});
 const flush=controller.flush();await Promise.all([turn,flush]);
 expect(saved.at(-1)).toEqual(['voice:last']);
 controller.dispose();
});

it("stops pending generation, keeps the user text, and ignores a late reply while the next send completes", async () => {
  let finish!: (reply: ChatReply) => void;
  let signal: AbortSignal | undefined;
  let id = 0;
  const respond = vi.fn().mockImplementationOnce((_input, abortSignal) => {
    signal = abortSignal;
    return new Promise<ChatReply>(resolve => { finish = resolve; });
  }).mockImplementation(async input => groupedReply(input.clientMessageId, ["次の返事"]));
  const controller = createChatController({
    store: { load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => {} },
    profileApi: { get: async () => profile, save: async () => profile },
    chatApi: { respond }, now: () => now, nextId: () => `stop-${++id}`,
  });
  await controller.hydrate();
  const first = controller.send("長い説明をお願い");
  await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  controller.stopGeneration();
  expect(signal?.aborted).toBe(true);
  expect(controller.state.snapshot.timeline).toMatchObject([{text: "長い説明をお願い", delivery: "sent"}]);
  await first;
  await controller.send("次の質問");
  finish(groupedReply("stop-2", ["遅れて届いた返事"]));
  await Promise.resolve();
  expect(controller.state.snapshot.timeline.some(item => item.type === "message" && item.text === "遅れて届いた返事")).toBe(false);
  expect(controller.state.snapshot.timeline.some(item => item.type === "message" && item.text === "次の返事")).toBe(true);
  expect(controller.state.failureByMessageId).toEqual({});
});

it("stops during persistence without starting generation or losing the saved user text", async () => {
  let release!: () => void;
  const saves: LocalChatSnapshot[] = [];
  const respond = vi.fn();
  const controller = createChatController({
    store: { load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async snapshot => {
      saves.push(snapshot);
      if (saves.length === 1) await new Promise<void>(resolve => { release = resolve; });
    } },
    profileApi: { get: async () => profile, save: async () => profile },
    chatApi: { respond }, now: () => now, nextId: () => "persist-stop",
  });
  await controller.hydrate();
  const sent = controller.send("保存中も停止");
  await vi.waitFor(() => expect(saves).toHaveLength(1));
  controller.stopGeneration();
  release();
  await sent;
  await controller.flush();
  expect(respond).not.toHaveBeenCalled();
  expect(saves.at(-1)?.timeline).toMatchObject([{text: "保存中も停止", delivery: "sent"}]);
});

it("honors stop immediately after send, before the queued dispatch starts", async () => {
  const respond = vi.fn();
  const controller = createChatController({
    store: {load: async () => ({...EMPTY_LOCAL_CHAT,lastOpeningAt:now}),save:async()=>{}},
    profileApi:{get:async()=>profile,save:async()=>profile},chatApi:{respond},now:()=>now,nextId:()=>"instant-stop",
  });
  await controller.hydrate();
  const sent=controller.send("そのまま残して");
  controller.stopGeneration();
  await sent;
  expect(respond).not.toHaveBeenCalled();
  expect(controller.state.snapshot.timeline).toMatchObject([{text:"そのまま残して",delivery:"sent"}]);
});

it("recovers a restored searching message without pretending its old request is still running", async () => {
  const respond=vi.fn();
  const snapshot={...EMPTY_LOCAL_CHAT,lastOpeningAt:now,timeline:[{id:"old-search",type:"message" as const,role:"user" as const,text:"最新ニュースを検索して",createdAt:now,delivery:"sending" as const}]};
  const controller=createChatController({store:{load:async()=>snapshot,save:async()=>{}},profileApi:{get:async()=>profile,save:async()=>profile},chatApi:{respond},now:()=>now,nextId:()=>"recover"});
  await controller.hydrate();
  expect(controller.state.snapshot.timeline).toMatchObject([{id:"old-search",text:"最新ニュースを検索して",delivery:"failed"}]);
  expect(controller.state.failureByMessageId["old-search"]).toBe("interrupted");
  expect(respond).not.toHaveBeenCalled();
});

it("restores a pending user message as delivered when its matching reply is already in history", async () => {
  const snapshot={...EMPTY_LOCAL_CHAT,lastOpeningAt:now,timeline:[
    {id:"old-search",type:"message" as const,role:"user" as const,text:"検索して",createdAt:now,delivery:"sending" as const},
    {id:"old-search:assistant:0",replyGroupId:"old-search:assistant",sequence:0 as const,type:"message" as const,role:"assistant" as const,text:"結果",createdAt:now,delivery:"sent" as const},
  ]};
  const controller=createChatController({store:{load:async()=>snapshot,save:async()=>{}},profileApi:{get:async()=>profile,save:async()=>profile},chatApi:{respond:vi.fn()},now:()=>now,nextId:()=>"recover"});
  await controller.hydrate();
  expect(controller.state.snapshot.timeline[0]).toMatchObject({delivery:"sent"});
  expect(controller.state.failureByMessageId).toEqual({});
});
