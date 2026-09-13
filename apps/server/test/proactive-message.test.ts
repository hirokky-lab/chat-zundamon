import { describe, expect, it, vi } from "vitest";
import { createFixtureTriggerAdapter, type ProactiveCandidate } from "@yui/domain";
import {
  createMemoryProactiveDeliveryRepository,
  createNoopPushAdapter,
  createProactiveMessageService,
  type ProactiveTelemetry,
} from "../src/proactive-message";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-29T17:30:00.000Z";
const candidate: ProactiveCandidate = {
  id: "reminder-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  source: "one_time_reminder",
  sourceRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  templateId: "one_time_reminder_v1",
  purpose: "reminder",
  text: "そろそろ、頼まれていた確認の時間です",
  dedupeKey: "reminder:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  contextRef: "talk:reminder:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-08-29T17:00:00.000Z",
  expiresAt: "2026-08-29T18:00:00.000Z",
  timeZone: "Asia/Tokyo",
  explicitlyRequested: true,
};

function harness(options: { enabled?: boolean; candidates?: ProactiveCandidate[]; cancelReminder?: (ownerId: string, reminderId: string) => Promise<{ status: "cancelled"; reminderId: string } | { status: "failure"; code: string }>; telemetry?: ProactiveTelemetry } = {}) {
  const trigger = createFixtureTriggerAdapter(options.candidates ?? [candidate]);
  const collect = vi.spyOn(trigger, "collect");
  const repository = createMemoryProactiveDeliveryRepository();
  const service = createProactiveMessageService({
    enabled: options.enabled ?? true,
    trigger,
    repository,
    now: () => NOW,
    cancelReminder: options.cancelReminder,
    telemetry: options.telemetry,
  });
  return { service, collect, repository };
}

describe("proactive message local fixture service", () => {
  it("does no adapter or repository work while the feature is disabled", async () => {
    const { service, collect, repository } = harness({ enabled: false });
    const get = vi.spyOn(repository, "get");
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toEqual({ status: "disabled" });
    expect(collect).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns one owner-scoped Talk candidate and persists no body text", async () => {
    const { service, repository } = harness();
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toEqual({
      status: "candidate",
      candidate,
      actions: ["dismiss", "later", "unneeded", "cancel"],
    });
    const stored = await repository.get(OWNER_A, candidate.id);
    expect(stored).toMatchObject({ candidateId: candidate.id, contextRef: candidate.contextRef, timeZone: candidate.timeZone, status: "delivered" });
    expect(JSON.stringify(stored)).not.toContain(candidate.text);
    await expect(repository.get(OWNER_B, candidate.id)).resolves.toBeNull();
  });

  it("replays the same outstanding fixture on reopen instead of adding another delivery", async () => {
    const { service, repository } = harness();
    const save = vi.spyOn(repository, "save");
    const first = await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    const second = await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    expect(second).toEqual(first);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("honors the notification master switch without reading OS Focus state", async () => {
    const { service } = harness();
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: false })).resolves.toEqual({ status: "none", reason: "notifications_off" });
  });

  it("does not replay an expired delivery", async () => {
    const { service } = harness();
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await expect(service.open({ ownerId: OWNER_A, openedAt: candidate.expiresAt, notificationsEnabled: true })).resolves.toEqual({ status: "none", reason: "expired" });
  });

  it("fails closed when an adapter mutates a stored candidate template or text", async () => {
    let next: ProactiveCandidate = candidate;
    const repository = createMemoryProactiveDeliveryRepository();
    const service = createProactiveMessageService({ enabled: true, trigger: { collect: async () => [next] }, repository, now: () => NOW });
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    next = { ...candidate, text: "返事がないと悲しいです", templateId: "app_open_greeting_v1" };
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toEqual({ status: "none", reason: "unsafe_content" });
  });

  it.each([
    ["source", { source: "time" as const }],
    ["sourceRef", { sourceRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    ["templateId", { templateId: "calendar_task_v1" as const }],
  ])("fails closed when stored replay %s identity changes independently", async (_field, mutation) => {
    const { service, repository } = harness();
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    const stored = await repository.get(OWNER_A, candidate.id);
    if (!stored) throw new Error("stored delivery required");
    await repository.save(OWNER_A, { ...stored, ...mutation });
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toEqual({ status: "none", reason: "unsafe_content" });
  });

  it.each(["dismiss", "later", "unneeded"] as const)("applies %s idempotently", async (action) => {
    const { service, repository } = harness();
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    const save = vi.spyOn(repository, "save");
    const first = await service.act({ ownerId: OWNER_A, candidateId: candidate.id, action });
    const second = await service.act({ ownerId: OWNER_A, candidateId: candidate.id, action });
    expect(second).toEqual(first);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale different action without rewriting a settled delivery", async () => {
    const cancelReminder = vi.fn(async (_ownerId: string, reminderId: string) => ({ status: "cancelled" as const, reminderId }));
    const { service, repository } = harness({ cancelReminder });
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "dismiss" });
    const before = await repository.get(OWNER_A, candidate.id);
    const save = vi.spyOn(repository, "save");

    await expect(service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "cancel" }))
      .resolves.toEqual({ status: "failure", code: "not_found" });
    expect(await repository.get(OWNER_A, candidate.id)).toEqual(before);
    expect(save).not.toHaveBeenCalled();
    expect(cancelReminder).not.toHaveBeenCalled();
  });

  it("redelivers a deferred candidate on the next app open, then keeps it outstanding", async () => {
    const { service, repository } = harness();
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "later" });
    const save = vi.spyOn(repository, "save");
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toMatchObject({ status: "candidate", candidate });
    await expect(repository.get(OWNER_A, candidate.id)).resolves.toMatchObject({ status: "delivered" });
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("replays an existing unanswered candidate before a deferred candidate regardless of trigger order", async () => {
    const deferred = candidate;
    const outstanding: ProactiveCandidate = {
      ...candidate,
      id: "reminder-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      sourceRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      dedupeKey: "reminder:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      contextRef: "talk:reminder:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    let next: readonly ProactiveCandidate[] = [deferred];
    const repository = createMemoryProactiveDeliveryRepository();
    const service = createProactiveMessageService({ enabled: true, trigger: { collect: async () => next }, repository, now: () => NOW });
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await service.act({ ownerId: OWNER_A, candidateId: deferred.id, action: "later" });
    next = [outstanding];
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    next = [deferred, outstanding];
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toMatchObject({ status: "candidate", candidate: outstanding });
    await expect(repository.get(OWNER_A, deferred.id)).resolves.toMatchObject({ status: "deferred" });
  });

  it("cancels an explicit one-time reminder once and never a foreign owner's candidate", async () => {
    const cancelReminder = vi.fn(async (_ownerId: string, reminderId: string) => ({ status: "cancelled" as const, reminderId }));
    const { service } = harness({ cancelReminder });
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await expect(service.act({ ownerId: OWNER_B, candidateId: candidate.id, action: "cancel" })).resolves.toEqual({ status: "failure", code: "not_found" });
    const first = await service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "cancel" });
    const second = await service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "cancel" });
    expect(first).toEqual({ status: "updated", candidateId: candidate.id, state: "cancelled" });
    expect(second).toEqual(first);
    expect(cancelReminder).toHaveBeenCalledTimes(1);
    expect(cancelReminder).toHaveBeenCalledWith(OWNER_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("fails closed without a reminder cancellation adapter and keeps delivery outstanding", async () => {
    const { service, repository } = harness();
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await expect(service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "cancel" })).resolves.toEqual({ status: "failure", code: "cancellation_failed" });
    await expect(repository.get(OWNER_A, candidate.id)).resolves.toMatchObject({ status: "delivered" });
  });

  it.each([
    { status: "failure" as const, code: "already_cancelled" },
    { status: "cancelled" as const, reminderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ])("does not claim cancellation for an unconfirmed reminder result %#", async (cancelResult) => {
    const { service, repository } = harness({ cancelReminder: vi.fn(async () => cancelResult) });
    await service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true });
    await expect(service.act({ ownerId: OWNER_A, candidateId: candidate.id, action: "cancel" })).resolves.toEqual({ status: "failure", code: "cancellation_failed" });
    await expect(repository.get(OWNER_A, candidate.id)).resolves.toMatchObject({ status: "delivered" });
  });

  it("returns a fixed failure and body-free telemetry when the fixture fails", async () => {
    const telemetry = { record: vi.fn() };
    const trigger = { collect: vi.fn(async () => { throw new Error(candidate.text); }) };
    const service = createProactiveMessageService({ enabled: true, trigger, repository: createMemoryProactiveDeliveryRepository(), now: () => NOW, telemetry });
    await expect(service.open({ ownerId: OWNER_A, openedAt: NOW, notificationsEnabled: true })).resolves.toEqual({ status: "failure", code: "trigger_unavailable" });
    expect(telemetry.record).toHaveBeenCalledWith({ kind: "open_failed", code: "trigger_unavailable" });
    expect(JSON.stringify(telemetry.record.mock.calls)).not.toContain(candidate.text);
  });
});

describe("no-op Web Push fixture", () => {
  it("performs no delivery, uses no token or body, is not Time Sensitive, and opens the same Talk context", async () => {
    const adapter = createNoopPushAdapter();
    await expect(adapter.deliver({ notificationId: "notification-1", contextRef: candidate.contextRef })).resolves.toEqual({
      status: "not_run",
      timeSensitive: false,
      openTarget: { view: "talk", contextRef: candidate.contextRef },
    });
  });
});
