import { describe, expect, it, vi } from "vitest";
import {
  createMemoryReminderRepository,
  createOneTimeReminderService,
  type ReminderRepository,
} from "../src/one-time-reminder";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const HMAC_KEY = "0123456789abcdef0123456789abcdef"; // gitleaks:allow -- synthetic unit-test fixture, never a real credential
const NOW = "2026-08-21T00:00:00.000Z";

const validInput = {
  ownerId: OWNER_A,
  clientRequestId: "request-1",
  safeSummary: "薬を確認する",
  requestedAt: "2026-08-22T01:00:00.000Z",
  timeZone: "Asia/Tokyo",
  confirmationExpiresAt: "2026-08-21T00:10:00.000Z",
};

function createHarness(options: { enabled?: boolean; ownerRepository?: ReminderRepository } = {}) {
  const baseRepository = options.ownerRepository ?? createMemoryReminderRepository();
  const calls = { createPrepared: 0, get: 0, confirm: 0, cancel: 0 };
  const repository: ReminderRepository = {
    async createPrepared(input) {
      calls.createPrepared += 1;
      return baseRepository.createPrepared(input);
    },
    async get(ownerId, reminderId) {
      calls.get += 1;
      return baseRepository.get(ownerId, reminderId);
    },
    async confirm(ownerId, reminderId, confirmedAt) {
      calls.confirm += 1;
      return baseRepository.confirm(ownerId, reminderId, confirmedAt);
    },
    async cancel(ownerId, reminderId, cancelledAt) {
      calls.cancel += 1;
      return baseRepository.cancel(ownerId, reminderId, cancelledAt);
    },
  };
  let now = NOW;
  let nextIdCalls = 0;
  const service = createOneTimeReminderService({
    enabled: options.enabled ?? true,
    repository,
    hmacKey: HMAC_KEY,
    hmacKeyVersion: "local-test-v1",
    now: () => new Date(now),
    nextId: () => {
      nextIdCalls += 1;
      return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    },
  });
  return {
    service,
    calls,
    setNow(value: string) { now = value; },
    nextIdCalls: () => nextIdCalls,
  };
}

describe("one-time reminder local confirmation boundary", () => {
  it("rejects an empty HMAC key when enabled but does not require one while disabled", async () => {
    const repository = createMemoryReminderRepository();
    expect(() => createOneTimeReminderService({
      enabled: true,
      repository,
      hmacKey: "",
      hmacKeyVersion: "local-test-v1",
      now: () => new Date(NOW),
      nextId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })).toThrow("invalid_reminder_hmac_configuration");

    const disabled = createOneTimeReminderService({
      enabled: false,
      repository,
      hmacKey: "",
      hmacKeyVersion: "",
      now: () => new Date(NOW),
      nextId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await expect(disabled.prepare(validInput)).resolves.toEqual({ status: "disabled" });
  });

  it("does zero persistence or identity work while the feature is disabled", async () => {
    const harness = createHarness({ enabled: false });
    await expect(harness.service.prepare(validInput)).resolves.toEqual({ status: "disabled" });
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: {} as never })).resolves.toEqual({ status: "disabled" });
    await expect(harness.service.cancel({ ownerId: OWNER_A, reminderId: "anything" })).resolves.toEqual({ status: "disabled" });
    expect(harness.calls).toEqual({ createPrepared: 0, get: 0, confirm: 0, cancel: 0 });
    expect(harness.nextIdCalls()).toBe(0);
  });

  it("does not persist a quiet-hours collision until the user chooses", async () => {
    const harness = createHarness();
    await expect(harness.service.prepare({
      ...validInput,
      requestedAt: "2026-08-21T14:30:00.000Z",
      quietHours: { start: "23:00", end: "08:00" },
    })).resolves.toEqual({
      status: "choice_required",
      choices: ["requested_time", "quiet_hours_end"],
    });
    expect(harness.calls.createPrepared).toBe(0);
    expect(harness.nextIdCalls()).toBe(0);
  });

  it("prepares a minimal signed confirmation envelope with one maximum attempt", async () => {
    const repository = createMemoryReminderRepository();
    const harness = createHarness({ ownerRepository: repository });
    const result = await harness.service.prepare(validInput);
    expect(result).toMatchObject({
      status: "prepared",
      confirmation: {
        reminderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        confirmationExpiresAt: "2026-08-21T00:10:00.000Z",
        hmacKeyVersion: "local-test-v1",
        signature: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      },
    });
    expect(JSON.stringify(result)).not.toContain(validInput.safeSummary);
    await expect(repository.get(OWNER_A, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).resolves.toMatchObject({
      state: "prepared",
      maxAttempts: 1,
      safeSummary: "薬を確認する",
    });
  });

  it("fails closed before persistence when ID generation is not UUID v4", async () => {
    const repository = createMemoryReminderRepository();
    const createPrepared = vi.spyOn(repository, "createPrepared");
    const service = createOneTimeReminderService({
      enabled: true,
      repository,
      hmacKey: HMAC_KEY,
      hmacKeyVersion: "local-test-v1",
      now: () => new Date(NOW),
      nextId: () => "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
    });
    await expect(service.prepare(validInput)).resolves.toEqual({ status: "failure", code: "invalid_request" });
    expect(createPrepared).not.toHaveBeenCalled();
  });

  it("is idempotent per owner and client request only for the exact same payload", async () => {
    const harness = createHarness();
    const first = await harness.service.prepare(validInput);
    const duplicate = await harness.service.prepare(validInput);
    expect(duplicate).toEqual(first);
    expect(harness.nextIdCalls()).toBe(2);
    await expect(harness.service.prepare({ ...validInput, safeSummary: "別の内容" })).resolves.toEqual({ status: "failure", code: "conflict" });
  });

  it("returns the persisted terminal state for an idempotent prepare replay", async () => {
    const confirmedHarness = createHarness();
    const confirmedPreparation = await confirmedHarness.service.prepare(validInput);
    if (confirmedPreparation.status !== "prepared") throw new Error("expected prepared result");
    await confirmedHarness.service.confirm({ ownerId: OWNER_A, confirmation: confirmedPreparation.confirmation });
    await expect(confirmedHarness.service.prepare(validInput)).resolves.toEqual({
      status: "confirmed",
      reminderId: confirmedPreparation.confirmation.reminderId,
    });

    const cancelledHarness = createHarness();
    const cancelledPreparation = await cancelledHarness.service.prepare(validInput);
    if (cancelledPreparation.status !== "prepared") throw new Error("expected prepared result");
    await cancelledHarness.service.cancel({ ownerId: OWNER_A, reminderId: cancelledPreparation.confirmation.reminderId });
    await expect(cancelledHarness.service.prepare(validInput)).resolves.toEqual({
      status: "cancelled",
      reminderId: cancelledPreparation.confirmation.reminderId,
    });
  });

  it("separates owners even when client request IDs match", async () => {
    let sequence = 0;
    const repository = createMemoryReminderRepository();
    const service = createOneTimeReminderService({
      enabled: true,
      repository,
      hmacKey: HMAC_KEY,
      hmacKeyVersion: "local-test-v1",
      now: () => new Date(NOW),
      nextId: () => `${++sequence}`.padStart(8, "0") + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const first = await service.prepare(validInput);
    const second = await service.prepare({ ...validInput, ownerId: OWNER_B });
    expect(first).toMatchObject({ status: "prepared" });
    expect(second).toMatchObject({ status: "prepared" });
    expect(first).not.toEqual(second);
  });

  it("confirms once and treats an exact duplicate confirmation idempotently", async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation })).resolves.toEqual({
      status: "confirmed",
      reminderId: prepared.confirmation.reminderId,
    });
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation })).resolves.toEqual({
      status: "confirmed",
      reminderId: prepared.confirmation.reminderId,
    });
    expect(harness.calls.confirm).toBe(1);
  });

  it("keeps an already confirmed exact replay idempotent after the original confirmation window", async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    await harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation });
    harness.setNow("2026-08-21T00:10:00.000Z");
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation })).resolves.toEqual({
      status: "confirmed",
      reminderId: prepared.confirmation.reminderId,
    });
    expect(harness.calls.confirm).toBe(1);
  });

  it.each([
    ["foreign owner", (confirmation: Record<string, string>) => ({ ownerId: OWNER_B, confirmation })],
    ["digest tamper", (confirmation: Record<string, string>) => ({ ownerId: OWNER_A, confirmation: { ...confirmation, payloadDigest: `sha256:${"0".repeat(64)}` } })],
    ["signature tamper", (confirmation: Record<string, string>) => ({ ownerId: OWNER_A, confirmation: { ...confirmation, signature: `hmac-sha256:${"0".repeat(64)}` } })],
    ["key version mismatch", (confirmation: Record<string, string>) => ({ ownerId: OWNER_A, confirmation: { ...confirmation, hmacKeyVersion: "unknown-v2" } })],
    ["expiry tamper", (confirmation: Record<string, string>) => ({ ownerId: OWNER_A, confirmation: { ...confirmation, confirmationExpiresAt: "2026-08-21T00:20:00.000Z" } })],
  ])("fails closed for %s without mutating state", async (_label, mutate) => {
    const harness = createHarness();
    const prepared = await harness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    await expect(harness.service.confirm(mutate(prepared.confirmation) as never)).resolves.toEqual({ status: "failure", code: "invalid_confirmation" });
    expect(harness.calls.confirm).toBe(0);
  });

  it("re-hashes the complete stored payload before confirmation", async () => {
    const stored = createMemoryReminderRepository();
    let tamperReads = false;
    const repository: ReminderRepository = {
      createPrepared: (record) => stored.createPrepared(record),
      async get(ownerId, reminderId) {
        const record = await stored.get(ownerId, reminderId);
        return record && tamperReads ? { ...record, scheduledAt: "2026-08-22T02:00:00.000Z" } : record;
      },
      confirm: (ownerId, reminderId, confirmedAt) => stored.confirm(ownerId, reminderId, confirmedAt),
      cancel: (ownerId, reminderId, cancelledAt) => stored.cancel(ownerId, reminderId, cancelledAt),
    };
    const harness = createHarness({ ownerRepository: repository });
    const prepared = await harness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    tamperReads = true;
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation })).resolves.toEqual({
      status: "failure",
      code: "invalid_confirmation",
    });
    expect(harness.calls.confirm).toBe(0);
  });

  it("fails closed after confirmation expiry", async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    harness.setNow("2026-08-21T00:10:00.000Z");
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation })).resolves.toEqual({ status: "failure", code: "expired" });
    expect(harness.calls.confirm).toBe(0);
  });

  it("cancels prepared and confirmed reminders, and cancellation is idempotent", async () => {
    const preparedHarness = createHarness();
    const prepared = await preparedHarness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    await expect(preparedHarness.service.cancel({ ownerId: OWNER_A, reminderId: prepared.confirmation.reminderId })).resolves.toEqual({
      status: "cancelled",
      reminderId: prepared.confirmation.reminderId,
    });
    await expect(preparedHarness.service.cancel({ ownerId: OWNER_A, reminderId: prepared.confirmation.reminderId })).resolves.toEqual({
      status: "cancelled",
      reminderId: prepared.confirmation.reminderId,
    });

    const confirmedHarness = createHarness();
    const other = await confirmedHarness.service.prepare(validInput);
    if (other.status !== "prepared") throw new Error("expected prepared result");
    await confirmedHarness.service.confirm({ ownerId: OWNER_A, confirmation: other.confirmation });
    await expect(confirmedHarness.service.cancel({ ownerId: OWNER_A, reminderId: other.confirmation.reminderId })).resolves.toMatchObject({ status: "cancelled" });
  });

  it("refuses confirmation after cancellation", async () => {
    const harness = createHarness();
    const prepared = await harness.service.prepare(validInput);
    if (prepared.status !== "prepared") throw new Error("expected prepared result");
    await harness.service.cancel({ ownerId: OWNER_A, reminderId: prepared.confirmation.reminderId });
    await expect(harness.service.confirm({ ownerId: OWNER_A, confirmation: prepared.confirmation })).resolves.toEqual({ status: "failure", code: "invalid_state" });
    expect(harness.calls.confirm).toBe(0);
  });

  it("returns fixed failures when persistence throws and does not expose error text", async () => {
    const repository = createMemoryReminderRepository();
    vi.spyOn(repository, "createPrepared").mockRejectedValueOnce(new Error("private reminder body"));
    const harness = createHarness({ ownerRepository: repository });
    const result = await harness.service.prepare(validInput);
    expect(result).toEqual({ status: "failure", code: "persistence_failed" });
    expect(JSON.stringify(result)).not.toContain("private reminder body");
  });
});
