import { describe, expect, it, vi } from "vitest";
import { createHostedReminderRepository, HostedReminderRepositoryError } from "../src/hosted-reminder-repository";
import type { ReminderRecord } from "../src/one-time-reminder";

const record: ReminderRecord = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerId: "11111111-1111-4111-8111-111111111111",
  clientRequestId: "request-1",
  state: "prepared",
  safeSummary: "薬を確認する",
  requestedAt: "2026-08-22T01:00:00.000Z",
  scheduledAt: "2026-08-22T01:00:00.000Z",
  requestedLocalDateTime: "2026-08-22T10:00:00",
  scheduledLocalDateTime: "2026-08-22T10:00:00",
  timeZone: "Asia/Tokyo",
  quietHours: null,
  quietHoursChoice: null,
  preparedAt: "2026-08-21T00:00:00.000Z",
  confirmationExpiresAt: "2026-08-21T00:10:00.000Z",
  payloadDigest: `sha256:${"a".repeat(64)}`,
  hmacKeyVersion: "owner-v1",
  signature: `hmac-sha256:${"b".repeat(64)}`,
  maxAttempts: 1,
  confirmedAt: null,
  cancelledAt: null,
};

const row = {
  id: record.id,
  owner_id: record.ownerId,
  client_request_id: record.clientRequestId,
  state: record.state,
  safe_summary: record.safeSummary,
  requested_at: record.requestedAt,
  scheduled_at: record.scheduledAt,
  requested_local_datetime: record.requestedLocalDateTime,
  scheduled_local_datetime: record.scheduledLocalDateTime,
  time_zone: record.timeZone,
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_choice: null,
  prepared_at: record.preparedAt,
  confirmation_expires_at: record.confirmationExpiresAt,
  payload_digest: record.payloadDigest,
  hmac_key_version: record.hmacKeyVersion,
  signature: record.signature,
  max_attempts: 1,
  confirmed_at: null,
  cancelled_at: null,
};

describe("hosted one-time reminder repository", () => {
  it("maps the exact prepared record to the owner-scoped RPC without content expansion", async () => {
    const rpc = vi.fn(async () => ({ data: row, error: null }));
    const repository = createHostedReminderRepository({ rpc });

    await expect(repository.createPrepared(record)).resolves.toEqual({ record });
    expect(rpc).toHaveBeenCalledWith("prepare_one_time_reminder", {
      p_owner_id: record.ownerId,
      p_id: record.id,
      p_client_request_id: record.clientRequestId,
      p_safe_summary: record.safeSummary,
      p_requested_at: record.requestedAt,
      p_scheduled_at: record.scheduledAt,
      p_requested_local_datetime: record.requestedLocalDateTime,
      p_scheduled_local_datetime: record.scheduledLocalDateTime,
      p_time_zone: record.timeZone,
      p_quiet_hours_start: null,
      p_quiet_hours_end: null,
      p_quiet_hours_choice: null,
      p_prepared_at: record.preparedAt,
      p_confirmation_expires_at: record.confirmationExpiresAt,
      p_payload_digest: record.payloadDigest,
      p_hmac_key_version: record.hmacKeyVersion,
      p_signature: record.signature,
    });
  });

  it("uses owner-scoped get, confirm, and cancel RPCs and parses terminal states", async () => {
    const confirmed = { ...row, state: "confirmed", confirmed_at: "2026-08-21T00:05:00.000Z" };
    const cancelled = { ...row, state: "cancelled", cancelled_at: "2026-08-21T00:06:00.000Z" };
    const rpc = vi.fn(async (name: string) => ({
      data: name === "confirm_one_time_reminder" ? confirmed : name === "cancel_one_time_reminder" ? cancelled : row,
      error: null,
    }));
    const repository = createHostedReminderRepository({ rpc });

    await expect(repository.get(record.ownerId, record.id)).resolves.toEqual(record);
    await expect(repository.confirm(record.ownerId, record.id, "2026-08-21T00:05:00.000Z"))
      .resolves.toMatchObject({ state: "confirmed", confirmedAt: "2026-08-21T00:05:00.000Z" });
    await expect(repository.cancel(record.ownerId, record.id, "2026-08-21T00:06:00.000Z"))
      .resolves.toMatchObject({ state: "cancelled", cancelledAt: "2026-08-21T00:06:00.000Z" });
    expect(rpc).toHaveBeenNthCalledWith(1, "get_one_time_reminder", { p_owner_id: record.ownerId, p_id: record.id });
    expect(rpc).toHaveBeenNthCalledWith(2, "get_one_time_reminder", { p_owner_id: record.ownerId, p_id: record.id });
    expect(rpc).toHaveBeenNthCalledWith(3, "confirm_one_time_reminder", {
      p_owner_id: record.ownerId,
      p_id: record.id,
      p_payload_digest: record.payloadDigest,
      p_hmac_key_version: record.hmacKeyVersion,
      p_signature: record.signature,
      p_confirmed_at: "2026-08-21T00:05:00.000Z",
    });
    expect(rpc).toHaveBeenNthCalledWith(4, "cancel_one_time_reminder", {
      p_owner_id: record.ownerId,
      p_id: record.id,
      p_cancelled_at: "2026-08-21T00:06:00.000Z",
    });
  });

  it("fails closed on RPC errors, unknown fields, or malformed rows without exposing provider details", async () => {
    for (const result of [
      { data: null, error: { message: "private provider detail" } },
      { data: { ...row, raw_response: "private provider detail" }, error: null },
      { data: { ...row, max_attempts: 2 }, error: null },
    ]) {
      const repository = createHostedReminderRepository({ rpc: vi.fn(async () => result) });
      await expect(repository.get(record.ownerId, record.id)).rejects.toEqual(new HostedReminderRepositoryError());
    }
  });

  it("rejects rows that do not match the requested owner, reminder, or client request", async () => {
    for (const mismatched of [
      { ...row, owner_id: "22222222-2222-4222-8222-222222222222" },
      { ...row, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ]) {
      const repository = createHostedReminderRepository({ rpc: vi.fn(async () => ({ data: mismatched, error: null })) });
      await expect(repository.get(record.ownerId, record.id)).rejects.toEqual(new HostedReminderRepositoryError());
    }

    const repository = createHostedReminderRepository({
      rpc: vi.fn(async () => ({ data: { ...row, client_request_id: "other-request" }, error: null })),
    });
    await expect(repository.createPrepared(record)).rejects.toEqual(new HostedReminderRepositoryError());
  });

  it("normalizes rejected RPC promises without exposing transport details", async () => {
    const repository = createHostedReminderRepository({
      rpc: vi.fn(async () => { throw new Error("token=private-transport-detail"); }),
    });

    for (const operation of [
      () => repository.get(record.ownerId, record.id),
      () => repository.createPrepared(record),
      () => repository.confirm(record.ownerId, record.id, "2026-08-21T00:05:00.000Z"),
      () => repository.cancel(record.ownerId, record.id, "2026-08-21T00:06:00.000Z"),
    ]) {
      await expect(operation()).rejects.toEqual(new HostedReminderRepositoryError());
    }
  });
});
