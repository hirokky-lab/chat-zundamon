import { describe, expect, it } from "vitest";
import {
  admitProactiveCandidate,
  createFixtureTriggerAdapter,
  createPresenceEventChannel,
  reduceProactiveDelivery,
  type ProactiveCandidate,
} from "../src/proactive-message";

const candidate: ProactiveCandidate = {
  id: "opening-20260829",
  source: "time",
  sourceRef: "time:2026-08-29",
  templateId: "app_open_greeting_v1",
  purpose: "greeting",
  text: "おかえりなさい。今日もここにいますよ",
  dedupeKey: "opening:2026-08-29",
  contextRef: "talk:latest",
  createdAt: "2026-08-29T17:00:00.000Z",
  expiresAt: "2026-08-29T18:00:00.000Z",
  timeZone: "Asia/Tokyo",
  explicitlyRequested: false,
};

const admission = {
  enabled: true,
  ownerOnly: true,
  appIsOpen: true,
  notificationsEnabled: true,
  now: "2026-08-29T17:30:00.000Z",
  outstandingCandidateId: null,
  deliveredDedupeKeys: [] as string[],
};

describe("proactive message admission", () => {
  it("admits one safe app-open candidate without inventing a deep-night rule", () => {
    expect(admitProactiveCandidate(candidate, admission)).toEqual({ status: "admitted", candidate });
    expect(admitProactiveCandidate({ ...candidate, createdAt: "2026-08-29T17:00:00.000Z", timeZone: "Pacific/Honolulu" }, admission)).toEqual({
      status: "admitted",
      candidate: { ...candidate, createdAt: "2026-08-29T17:00:00.000Z", timeZone: "Pacific/Honolulu" },
    });
  });

  it.each([
    ["feature off", { ...admission, enabled: false }, "disabled"],
    ["not owner-only", { ...admission, ownerOnly: false }, "owner_required"],
    ["app closed", { ...admission, appIsOpen: false }, "app_closed"],
    ["notifications off", { ...admission, notificationsEnabled: false }, "notifications_off"],
    ["duplicate", { ...admission, deliveredDedupeKeys: [candidate.dedupeKey] }, "duplicate"],
    ["unanswered initiative", { ...admission, outstandingCandidateId: "previous" }, "unanswered"],
  ] as const)("suppresses %s", (_label, state, reason) => {
    expect(admitProactiveCandidate(candidate, state)).toEqual({ status: "suppressed", reason });
  });

  it.each([
    ["guilt", "返事がないと悲しいです"],
    ["engagement pressure", "最近来てくれないですね"],
    ["monetization", "有料プランもおすすめです"],
    ["arbitrary recommendation disguised as greeting", "今日は新しいアプリを試しませんか"],
  ])("rejects %s wording even when metadata claims greeting", (_label, text) => {
    expect(admitProactiveCandidate({ ...candidate, text }, admission)).toEqual({ status: "suppressed", reason: "unsafe_content" });
  });

  it("fails closed when the approved template does not match source and purpose", () => {
    expect(admitProactiveCandidate({ ...candidate, templateId: "one_time_reminder_v1" }, admission)).toEqual({ status: "suppressed", reason: "unsafe_content" });
  });

  it("rejects unsolicited recommendations and non-explicit reminder triggers", () => {
    expect(admitProactiveCandidate({ ...candidate, purpose: "recommendation" }, admission)).toEqual({ status: "suppressed", reason: "unsolicited" });
    expect(admitProactiveCandidate({ ...candidate, source: "one_time_reminder", purpose: "reminder" }, admission)).toEqual({ status: "suppressed", reason: "explicit_request_required" });
  });

  it("fails closed for malformed timezone, expiry, identity, and context", () => {
    expect(admitProactiveCandidate({ ...candidate, timeZone: "Mars/Olympus" }, admission)).toEqual({ status: "suppressed", reason: "invalid_candidate" });
    expect(admitProactiveCandidate({ ...candidate, expiresAt: admission.now }, admission)).toEqual({ status: "suppressed", reason: "expired" });
    expect(admitProactiveCandidate({ ...candidate, id: "private body\n" }, admission)).toEqual({ status: "suppressed", reason: "invalid_candidate" });
    expect(admitProactiveCandidate({ ...candidate, contextRef: "https://example.com" }, admission)).toEqual({ status: "suppressed", reason: "invalid_candidate" });
  });
});

describe("replaceable trigger and delivery contracts", () => {
  it("collects time, explicit reminder, and future calendar/task fixtures through one interface", async () => {
    const adapter = createFixtureTriggerAdapter([
      candidate,
      { ...candidate, id: "reminder-1", source: "one_time_reminder", sourceRef: "11111111-1111-4111-8111-111111111111", templateId: "one_time_reminder_v1", purpose: "reminder", text: "そろそろ、頼まれていた確認の時間です", dedupeKey: "reminder:1", explicitlyRequested: true },
      { ...candidate, id: "calendar-1", source: "calendar_tasks", sourceRef: "calendar:item-1", templateId: "calendar_task_v1", purpose: "calendar_task", text: "予定していたことを確認する時間です", dedupeKey: "calendar:1", explicitlyRequested: true },
    ]);
    await expect(adapter.collect({ ownerId: "11111111-1111-4111-8111-111111111111", openedAt: admission.now })).resolves.toHaveLength(3);
  });

  it("reduces dismiss, later, unneeded, and cancellation idempotently without retaining body text", () => {
    const delivered = reduceProactiveDelivery(null, { type: "delivered", candidate, deliveredAt: admission.now });
    expect(delivered).toEqual({
      candidateId: candidate.id,
      sourceRef: candidate.sourceRef,
      dedupeKey: candidate.dedupeKey,
      contextRef: candidate.contextRef,
      timeZone: candidate.timeZone,
      status: "delivered",
      deliveredAt: admission.now,
      updatedAt: admission.now,
    });
    expect(JSON.stringify(delivered)).not.toContain(candidate.text);
    for (const action of ["dismiss", "later", "unneeded", "cancel"] as const) {
      const event = { type: action, candidateId: candidate.id, at: "2026-08-29T17:31:00.000Z" } as const;
      const once = reduceProactiveDelivery(delivered, event);
      expect(reduceProactiveDelivery(once, event)).toBe(once);
    }
  });

  it("never invents delivery state for an unknown candidate action", () => {
    expect(reduceProactiveDelivery(null, { type: "dismiss", candidateId: candidate.id, at: admission.now })).toBeNull();
  });

  it("does not let a stale different action overwrite a settled delivery", () => {
    const delivered = reduceProactiveDelivery(null, { type: "delivered", candidate, deliveredAt: admission.now });
    const dismissed = reduceProactiveDelivery(delivered, {
      type: "dismiss",
      candidateId: candidate.id,
      at: "2026-08-29T17:31:00.000Z",
    });
    if (!dismissed) throw new Error("dismissed delivery required");

    expect(reduceProactiveDelivery(dismissed, {
      type: "later",
      candidateId: candidate.id,
      at: "2026-08-29T17:32:00.000Z",
    })).toBe(dismissed);
  });

  it("publishes body-free listening/thinking/speaking/idle events without a Live2D dependency", () => {
    const received: unknown[] = [];
    const channel = createPresenceEventChannel();
    const unsubscribe = channel.subscribe((event) => received.push(event));
    for (const state of ["listening", "thinking", "speaking", "idle"] as const) {
      channel.publish({ state, occurredAt: admission.now, source: "talk" });
    }
    unsubscribe();
    channel.publish({ state: "idle", occurredAt: admission.now, source: "talk" });
    expect(received).toEqual([
      { state: "listening", occurredAt: admission.now, source: "talk" },
      { state: "thinking", occurredAt: admission.now, source: "talk" },
      { state: "speaking", occurredAt: admission.now, source: "talk" },
      { state: "idle", occurredAt: admission.now, source: "talk" },
    ]);
    expect(JSON.stringify(received)).not.toContain(candidate.text);
  });
});
