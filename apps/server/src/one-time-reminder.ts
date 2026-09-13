import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  prepareOneTimeReminder,
  type OneTimeReminderInput,
  type QuietHours,
  type QuietHoursChoice,
  type ReadyOneTimeReminder,
} from "@yui/domain";

export type ReminderState = "prepared" | "confirmed" | "cancelled";

export type ReminderConfirmation = Readonly<{
  reminderId: string;
  payloadDigest: string;
  confirmationExpiresAt: string;
  hmacKeyVersion: string;
  signature: string;
}>;

export type ReminderRecord = Readonly<{
  id: string;
  ownerId: string;
  clientRequestId: string;
  state: ReminderState;
  safeSummary: string;
  requestedAt: string;
  scheduledAt: string;
  requestedLocalDateTime: string;
  scheduledLocalDateTime: string;
  timeZone: string;
  quietHours: QuietHours | null;
  quietHoursChoice: QuietHoursChoice | null;
  preparedAt: string;
  confirmationExpiresAt: string;
  payloadDigest: string;
  hmacKeyVersion: string;
  signature: string;
  maxAttempts: 1;
  confirmedAt: string | null;
  cancelledAt: string | null;
}>;

export type ReminderRepository = {
  createPrepared(record: ReminderRecord): Promise<{ record: ReminderRecord }>;
  get(ownerId: string, reminderId: string): Promise<ReminderRecord | null>;
  confirm(ownerId: string, reminderId: string, confirmedAt: string): Promise<ReminderRecord | null>;
  cancel(ownerId: string, reminderId: string, cancelledAt: string): Promise<ReminderRecord | null>;
};

export type PrepareReminderInput = Omit<OneTimeReminderInput, "now"> & Readonly<{
  ownerId: string;
  clientRequestId: string;
  confirmationExpiresAt: string;
}>;

type FixedFailureCode =
  | "invalid_request"
  | "conflict"
  | "invalid_confirmation"
  | "expired"
  | "invalid_state"
  | "not_found"
  | "persistence_failed";

export type ReminderServiceResult =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "choice_required"; choices: readonly ["requested_time", "quiet_hours_end"] }>
  | Readonly<{ status: "prepared"; confirmation: ReminderConfirmation }>
  | Readonly<{ status: "confirmed"; reminderId: string }>
  | Readonly<{ status: "cancelled"; reminderId: string }>
  | Readonly<{ status: "failure"; code: FixedFailureCode }>;

export type OneTimeReminderService = {
  prepare(input: PrepareReminderInput): Promise<ReminderServiceResult>;
  confirm(input: Readonly<{ ownerId: string; confirmation: ReminderConfirmation }>): Promise<ReminderServiceResult>;
  cancel(input: Readonly<{ ownerId: string; reminderId: string }>): Promise<ReminderServiceResult>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HMAC_SHA256 = /^hmac-sha256:[a-f0-9]{64}$/;
const KEY_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;

function cloneRecord(record: ReminderRecord): ReminderRecord {
  return {
    ...record,
    quietHours: record.quietHours ? { ...record.quietHours } : null,
  };
}

export function createMemoryReminderRepository(): ReminderRepository {
  const byId = new Map<string, ReminderRecord>();
  const byOwnerRequest = new Map<string, string>();
  const ownerRequestKey = (ownerId: string, clientRequestId: string) => `${ownerId}\u0000${clientRequestId}`;

  return {
    async createPrepared(record) {
      const requestKey = ownerRequestKey(record.ownerId, record.clientRequestId);
      const existingId = byOwnerRequest.get(requestKey);
      if (existingId) return { record: cloneRecord(byId.get(existingId)!) };
      if (byId.has(record.id)) throw new Error("reminder_id_conflict");
      const stored = cloneRecord(record);
      byId.set(record.id, stored);
      byOwnerRequest.set(requestKey, record.id);
      return { record: cloneRecord(stored) };
    },
    async get(ownerId, reminderId) {
      const record = byId.get(reminderId);
      return record?.ownerId === ownerId ? cloneRecord(record) : null;
    },
    async confirm(ownerId, reminderId, confirmedAt) {
      const record = byId.get(reminderId);
      if (!record || record.ownerId !== ownerId || record.state !== "prepared") return null;
      const confirmed: ReminderRecord = { ...record, state: "confirmed", confirmedAt };
      byId.set(reminderId, confirmed);
      return cloneRecord(confirmed);
    },
    async cancel(ownerId, reminderId, cancelledAt) {
      const record = byId.get(reminderId);
      if (!record || record.ownerId !== ownerId) return null;
      if (record.state === "cancelled") return cloneRecord(record);
      const cancelled: ReminderRecord = { ...record, state: "cancelled", cancelledAt };
      byId.set(reminderId, cancelled);
      return cloneRecord(cancelled);
    },
  };
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function payloadForDigest(
  ownerId: string,
  clientRequestId: string,
  prepared: ReadyOneTimeReminder,
  confirmationExpiresAt: string,
): string {
  return JSON.stringify({
    ownerId,
    clientRequestId,
    safeSummary: prepared.safeSummary,
    requestedAt: prepared.requestedAt,
    scheduledAt: prepared.scheduledAt,
    requestedLocalDateTime: prepared.requestedLocalDateTime,
    scheduledLocalDateTime: prepared.scheduledLocalDateTime,
    timeZone: prepared.timeZone,
    quietHours: prepared.quietHours,
    quietHoursChoice: prepared.quietHoursChoice,
    confirmationExpiresAt,
    maxAttempts: 1,
  });
}

function digestForRecord(record: ReminderRecord): string {
  const prepared: ReadyOneTimeReminder = {
    status: "ready",
    safeSummary: record.safeSummary,
    requestedAt: record.requestedAt,
    scheduledAt: record.scheduledAt,
    requestedLocalDateTime: record.requestedLocalDateTime,
    scheduledLocalDateTime: record.scheduledLocalDateTime,
    timeZone: record.timeZone,
    quietHours: record.quietHours,
    quietHoursChoice: record.quietHoursChoice,
  };
  return `sha256:${createHash("sha256")
    .update(payloadForDigest(record.ownerId, record.clientRequestId, prepared, record.confirmationExpiresAt))
    .digest("hex")}`;
}

function confirmationPayload(value: Omit<ReminderConfirmation, "signature">): string {
  return JSON.stringify({
    reminderId: value.reminderId,
    payloadDigest: value.payloadDigest,
    confirmationExpiresAt: value.confirmationExpiresAt,
    hmacKeyVersion: value.hmacKeyVersion,
  });
}

function signatureFor(value: Omit<ReminderConfirmation, "signature">, hmacKey: string | Uint8Array): string {
  return `hmac-sha256:${createHmac("sha256", hmacKey).update(confirmationPayload(value)).digest("hex")}`;
}

function confirmationFromRecord(record: ReminderRecord): ReminderConfirmation {
  return {
    reminderId: record.id,
    payloadDigest: record.payloadDigest,
    confirmationExpiresAt: record.confirmationExpiresAt,
    hmacKeyVersion: record.hmacKeyVersion,
    signature: record.signature,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validConfirmation(value: unknown): value is ReminderConfirmation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = ["reminderId", "payloadDigest", "confirmationExpiresAt", "hmacKeyVersion", "signature"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return false;
  return typeof record.reminderId === "string" && UUID.test(record.reminderId)
    && typeof record.payloadDigest === "string" && SHA256.test(record.payloadDigest)
    && canonicalInstant(record.confirmationExpiresAt) !== null
    && typeof record.hmacKeyVersion === "string" && KEY_VERSION.test(record.hmacKeyVersion)
    && typeof record.signature === "string" && HMAC_SHA256.test(record.signature);
}

export function createOneTimeReminderService(options: Readonly<{
  enabled: boolean;
  repository: ReminderRepository;
  hmacKey: string | Uint8Array;
  hmacKeyVersion: string;
  now: () => Date;
  nextId: () => string;
}>): OneTimeReminderService {
  if (options.enabled && (Buffer.from(options.hmacKey).byteLength < 32 || !KEY_VERSION.test(options.hmacKeyVersion))) {
    throw new Error("invalid_reminder_hmac_configuration");
  }
  const disabled = (): ReminderServiceResult => ({ status: "disabled" });

  return {
    async prepare(input) {
      if (!options.enabled) return disabled();
      const nowDate = options.now();
      const now = Number.isFinite(nowDate.getTime()) ? nowDate.toISOString() : null;
      const confirmationExpiresAt = canonicalInstant(input?.confirmationExpiresAt);
      if (!now || !confirmationExpiresAt || !UUID.test(input?.ownerId ?? "")
        || !CLIENT_REQUEST_ID.test(input?.clientRequestId ?? "") || !KEY_VERSION.test(options.hmacKeyVersion)) {
        return { status: "failure", code: "invalid_request" };
      }
      const prepared = prepareOneTimeReminder({
        safeSummary: input.safeSummary,
        requestedAt: input.requestedAt,
        timeZone: input.timeZone,
        now,
        quietHours: input.quietHours,
        quietHoursChoice: input.quietHoursChoice,
      });
      if (!prepared) return { status: "failure", code: "invalid_request" };
      if (prepared.status === "quiet_hours_choice_required") {
        return { status: "choice_required", choices: prepared.choices };
      }
      if (confirmationExpiresAt <= now || confirmationExpiresAt > prepared.scheduledAt) {
        return { status: "failure", code: "invalid_request" };
      }

      const reminderId = options.nextId();
      if (!UUID.test(reminderId)) return { status: "failure", code: "invalid_request" };
      const payloadDigest = `sha256:${createHash("sha256")
        .update(payloadForDigest(input.ownerId, input.clientRequestId, prepared, confirmationExpiresAt))
        .digest("hex")}`;
      const unsigned = { reminderId, payloadDigest, confirmationExpiresAt, hmacKeyVersion: options.hmacKeyVersion };
      const signature = signatureFor(unsigned, options.hmacKey);
      const record: ReminderRecord = {
        id: reminderId,
        ownerId: input.ownerId,
        clientRequestId: input.clientRequestId,
        state: "prepared",
        safeSummary: prepared.safeSummary,
        requestedAt: prepared.requestedAt,
        scheduledAt: prepared.scheduledAt,
        requestedLocalDateTime: prepared.requestedLocalDateTime,
        scheduledLocalDateTime: prepared.scheduledLocalDateTime,
        timeZone: prepared.timeZone,
        quietHours: prepared.quietHours,
        quietHoursChoice: prepared.quietHoursChoice,
        preparedAt: now,
        confirmationExpiresAt,
        payloadDigest,
        hmacKeyVersion: options.hmacKeyVersion,
        signature,
        maxAttempts: 1,
        confirmedAt: null,
        cancelledAt: null,
      };
      try {
        const stored = await options.repository.createPrepared(record);
        const storedConfirmation = confirmationFromRecord(stored.record);
        const expectedStoredSignature = signatureFor({
          reminderId: storedConfirmation.reminderId,
          payloadDigest: storedConfirmation.payloadDigest,
          confirmationExpiresAt: storedConfirmation.confirmationExpiresAt,
          hmacKeyVersion: storedConfirmation.hmacKeyVersion,
        }, options.hmacKey);
        if (digestForRecord(stored.record) !== stored.record.payloadDigest
          || !safeEqual(stored.record.signature, expectedStoredSignature)
          || stored.record.payloadDigest !== payloadDigest
          || stored.record.confirmationExpiresAt !== confirmationExpiresAt
          || stored.record.hmacKeyVersion !== options.hmacKeyVersion) {
          return { status: "failure", code: "conflict" };
        }
        if (stored.record.state === "confirmed") return { status: "confirmed", reminderId: stored.record.id };
        if (stored.record.state === "cancelled") return { status: "cancelled", reminderId: stored.record.id };
        return { status: "prepared", confirmation: storedConfirmation };
      } catch {
        return { status: "failure", code: "persistence_failed" };
      }
    },

    async confirm(input) {
      if (!options.enabled) return disabled();
      if (!UUID.test(input?.ownerId ?? "") || !validConfirmation(input?.confirmation)) {
        return { status: "failure", code: "invalid_confirmation" };
      }
      const confirmation = input.confirmation;
      if (confirmation.hmacKeyVersion !== options.hmacKeyVersion) {
        return { status: "failure", code: "invalid_confirmation" };
      }
      const expectedSignature = signatureFor({
        reminderId: confirmation.reminderId,
        payloadDigest: confirmation.payloadDigest,
        confirmationExpiresAt: confirmation.confirmationExpiresAt,
        hmacKeyVersion: confirmation.hmacKeyVersion,
      }, options.hmacKey);
      if (!safeEqual(confirmation.signature, expectedSignature)) {
        return { status: "failure", code: "invalid_confirmation" };
      }

      try {
        const record = await options.repository.get(input.ownerId, confirmation.reminderId);
        if (!record || record.id !== confirmation.reminderId
          || digestForRecord(record) !== record.payloadDigest
          || record.payloadDigest !== confirmation.payloadDigest
          || record.confirmationExpiresAt !== confirmation.confirmationExpiresAt
          || record.hmacKeyVersion !== confirmation.hmacKeyVersion
          || !safeEqual(record.signature, confirmation.signature)) {
          return { status: "failure", code: "invalid_confirmation" };
        }
        if (record.state === "cancelled") return { status: "failure", code: "invalid_state" };
        if (record.state === "confirmed") return { status: "confirmed", reminderId: record.id };
        const nowDate = options.now();
        if (!Number.isFinite(nowDate.getTime())) return { status: "failure", code: "invalid_confirmation" };
        const now = nowDate.toISOString();
        if (now >= record.confirmationExpiresAt) return { status: "failure", code: "expired" };
        const confirmed = await options.repository.confirm(input.ownerId, record.id, now);
        return confirmed
          ? { status: "confirmed", reminderId: confirmed.id }
          : { status: "failure", code: "invalid_state" };
      } catch {
        return { status: "failure", code: "persistence_failed" };
      }
    },

    async cancel(input) {
      if (!options.enabled) return disabled();
      if (!UUID.test(input?.ownerId ?? "") || !UUID.test(input?.reminderId ?? "")) {
        return { status: "failure", code: "invalid_request" };
      }
      try {
        const existing = await options.repository.get(input.ownerId, input.reminderId);
        if (!existing) return { status: "failure", code: "not_found" };
        if (existing.state === "cancelled") return { status: "cancelled", reminderId: existing.id };
        const nowDate = options.now();
        if (!Number.isFinite(nowDate.getTime())) return { status: "failure", code: "invalid_request" };
        const cancelled = await options.repository.cancel(input.ownerId, input.reminderId, nowDate.toISOString());
        return cancelled
          ? { status: "cancelled", reminderId: cancelled.id }
          : { status: "failure", code: "invalid_state" };
      } catch {
        return { status: "failure", code: "persistence_failed" };
      }
    },
  };
}
