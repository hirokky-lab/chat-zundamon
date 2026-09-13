import { z } from "zod";
import type { ReminderRecord, ReminderRepository } from "./one-time-reminder.js";

type RpcResult = { data: unknown; error: unknown };
export type ReminderRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
};

export class HostedReminderRepositoryError extends Error {
  constructor() {
    super("Hosted reminder repository unavailable");
    this.name = "HostedReminderRepositoryError";
  }
}

const uuid = z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u)
  .transform((value) => value.replace(" ", "T"));
const quietTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::00)?$/u)
  .transform((value) => value.slice(0, 5));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const signature = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/u);

const rowSchema = z.object({
  id: uuid,
  owner_id: uuid,
  client_request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  state: z.enum(["prepared", "confirmed", "cancelled"]),
  safe_summary: z.string().trim().min(1).max(120).refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)),
  requested_at: instant,
  scheduled_at: instant,
  requested_local_datetime: localDateTime,
  scheduled_local_datetime: localDateTime,
  time_zone: z.string().min(1).max(128),
  quiet_hours_start: quietTime.nullable(),
  quiet_hours_end: quietTime.nullable(),
  quiet_hours_choice: z.enum(["requested_time", "quiet_hours_end"]).nullable(),
  prepared_at: instant,
  confirmation_expires_at: instant,
  payload_digest: digest,
  hmac_key_version: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/u),
  signature,
  max_attempts: z.literal(1),
  confirmed_at: instant.nullable(),
  cancelled_at: instant.nullable(),
}).strict().superRefine((row, context) => {
  const quietPair = row.quiet_hours_start === null && row.quiet_hours_end === null
    ? row.quiet_hours_choice === null
    : row.quiet_hours_start !== null && row.quiet_hours_end !== null;
  const stateTimes = row.state === "prepared"
    ? row.confirmed_at === null && row.cancelled_at === null
    : row.state === "confirmed"
      ? row.confirmed_at !== null && row.cancelled_at === null
      : row.cancelled_at !== null;
  if (!quietPair || !stateTimes) context.addIssue({ code: "custom", message: "invalid reminder row" });
});

function parseRow(value: unknown): ReminderRecord {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) throw new HostedReminderRepositoryError();
  const row = parsed.data;
  return {
    id: row.id,
    ownerId: row.owner_id,
    clientRequestId: row.client_request_id,
    state: row.state,
    safeSummary: row.safe_summary,
    requestedAt: row.requested_at,
    scheduledAt: row.scheduled_at,
    requestedLocalDateTime: row.requested_local_datetime,
    scheduledLocalDateTime: row.scheduled_local_datetime,
    timeZone: row.time_zone,
    quietHours: row.quiet_hours_start && row.quiet_hours_end
      ? { start: row.quiet_hours_start, end: row.quiet_hours_end }
      : null,
    quietHoursChoice: row.quiet_hours_choice,
    preparedAt: row.prepared_at,
    confirmationExpiresAt: row.confirmation_expires_at,
    payloadDigest: row.payload_digest,
    hmacKeyVersion: row.hmac_key_version,
    signature: row.signature,
    maxAttempts: row.max_attempts,
    confirmedAt: row.confirmed_at,
    cancelledAt: row.cancelled_at,
  };
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

async function call(client: ReminderRpcClient, name: string, args: Record<string, unknown>): Promise<RpcResult> {
  try {
    return await client.rpc(name, args);
  } catch {
    throw new HostedReminderRepositoryError();
  }
}

function assertIdentity(record: ReminderRecord, expected: {
  ownerId: string;
  reminderId: string;
  clientRequestId?: string;
}): ReminderRecord {
  if (record.ownerId !== expected.ownerId || record.id !== expected.reminderId
    || (expected.clientRequestId !== undefined && record.clientRequestId !== expected.clientRequestId)) {
    throw new HostedReminderRepositoryError();
  }
  return record;
}

async function checked(client: ReminderRpcClient, name: string, args: Record<string, unknown>): Promise<ReminderRecord> {
  const result = await call(client, name, args);
  if (result.error) throw new HostedReminderRepositoryError();
  return parseRow(result.data);
}

export function createHostedReminderRepository(client: ReminderRpcClient): ReminderRepository {
  const get: ReminderRepository["get"] = async (ownerId, reminderId) => {
    const result = await call(client, "get_one_time_reminder", { p_owner_id: ownerId, p_id: reminderId });
    if (errorCode(result.error) === "P0002") return null;
    if (result.error) throw new HostedReminderRepositoryError();
    return assertIdentity(parseRow(result.data), { ownerId, reminderId });
  };

  return {
    async createPrepared(record) {
      const stored = await checked(client, "prepare_one_time_reminder", {
        p_owner_id: record.ownerId,
        p_id: record.id,
        p_client_request_id: record.clientRequestId,
        p_safe_summary: record.safeSummary,
        p_requested_at: record.requestedAt,
        p_scheduled_at: record.scheduledAt,
        p_requested_local_datetime: record.requestedLocalDateTime,
        p_scheduled_local_datetime: record.scheduledLocalDateTime,
        p_time_zone: record.timeZone,
        p_quiet_hours_start: record.quietHours?.start ?? null,
        p_quiet_hours_end: record.quietHours?.end ?? null,
        p_quiet_hours_choice: record.quietHoursChoice,
        p_prepared_at: record.preparedAt,
        p_confirmation_expires_at: record.confirmationExpiresAt,
        p_payload_digest: record.payloadDigest,
        p_hmac_key_version: record.hmacKeyVersion,
        p_signature: record.signature,
      });
      return { record: assertIdentity(stored, {
        ownerId: record.ownerId,
        reminderId: record.id,
        clientRequestId: record.clientRequestId,
      }) };
    },
    get,
    async confirm(ownerId, reminderId, confirmedAt) {
      const current = await get(ownerId, reminderId);
      if (!current) return null;
      const confirmed = await checked(client, "confirm_one_time_reminder", {
        p_owner_id: ownerId,
        p_id: reminderId,
        p_payload_digest: current.payloadDigest,
        p_hmac_key_version: current.hmacKeyVersion,
        p_signature: current.signature,
        p_confirmed_at: confirmedAt,
      });
      return assertIdentity(confirmed, { ownerId, reminderId });
    },
    async cancel(ownerId, reminderId, cancelledAt) {
      const cancelled = await checked(client, "cancel_one_time_reminder", {
        p_owner_id: ownerId,
        p_id: reminderId,
        p_cancelled_at: cancelledAt,
      });
      return assertIdentity(cancelled, { ownerId, reminderId });
    },
  };
}
