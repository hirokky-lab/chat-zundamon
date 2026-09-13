import {
  canTransition,
  isMemoryTombstoneMatch,
  normalizeMemory,
  type MemoryAction,
  type MemoryCandidateProposal,
  type MemoryCandidateV2,
  type MemoryRecord,
  type MemorySensitivity,
  type MemoryTombstone,
  type MemoryWriteTrust,
} from "../../../packages/domain/src/memory.js";
import type { MemoryRepositoryV2, PreparedMemoryAction } from "./db.js";
import type { RequestUser } from "./request-user.js";
import { containsForbiddenSecret } from "@yui/domain";

export { containsForbiddenSecret } from "@yui/domain";

export type MemoryPolicyResult =
  | { ok: true; candidate: MemoryCandidateV2 }
  | {
    ok: false;
    reason:
      | "forbidden_secret"
      | "invalid_transition"
      | "tombstoned"
      | "unknown_target"
      | "requires_relearning_confirmation";
  };

export type MemoryActionPolicyResult =
  | { ok: true; action: ValidatedMemoryAction; candidate: MemoryCandidateV2 | null }
  | Extract<MemoryPolicyResult, { ok: false }>;

export type ApplyMemoryActionResult =
  | { ok: true; state: "applied" | "pending" | "completed" | "quarantined" | "disabled" }
  | Extract<MemoryPolicyResult, { ok: false }>;

type ValidatedMemoryAction = PreparedMemoryAction;

const sensitiveFacts = /(?:偏頭痛|頭痛|持病|通院|服薬|診断|病気|糖尿病|癌|がん(?!ば)|高血圧|年収|収入|借金|ローン|貯金(?!箱)|資産|家族|父|母|兄|姉|弟|妹|息子|娘|夫|妻|彼氏|彼女|恋人|離婚|失恋|悩み|不安|うつ|ストレス)/u;
const maxScheduleAnchorDistanceMs = 366 * 24 * 60 * 60 * 1000;

export function classifySensitivity(content: string): MemorySensitivity {
  return sensitiveFacts.test(content) ? "sensitive" : "normal";
}

function addDays(base: Date, days: number): string {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function trustedEventAnchor(trust: Pick<MemoryWriteTrust, "sourceOccurredAt" | "serverNow">): Date {
  const serverNow = new Date(trust.serverNow);
  const source = trust.sourceOccurredAt ? new Date(trust.sourceOccurredAt) : serverNow;
  return source.getTime() > serverNow.getTime() ? serverNow : source;
}

function trustedScheduleAnchor(trust: Pick<MemoryWriteTrust, "scheduleOccurredAt" | "serverNow">): Date | null {
  if (!trust.scheduleOccurredAt) return null;
  const anchor = new Date(trust.scheduleOccurredAt);
  const serverNow = new Date(trust.serverNow);
  if (!Number.isFinite(anchor.getTime()) || Math.abs(anchor.getTime() - serverNow.getTime()) > maxScheduleAnchorDistanceMs) return null;
  return anchor;
}

export function defaultExpiry(input: MemoryCandidateProposal, trust: Pick<MemoryWriteTrust, "origin" | "pinned" | "sourceOccurredAt" | "scheduleOccurredAt" | "serverNow">): string | null {
  if (trust.pinned || trust.origin === "explicit") return null;
  if (input.kind === "schedule") {
    const anchor = trustedScheduleAnchor(trust);
    return anchor ? addDays(anchor, 7) : null;
  }
  const anchor = trustedEventAnchor(trust);
  if (input.kind === "event" && input.retention === "light") return addDays(anchor, 3);
  if (input.kind === "event" && input.retention === "recent") return addDays(anchor, 30);
  return null;
}

function candidateFor(action: MemoryAction): MemoryCandidateProposal | undefined {
  if (action.type === "add" || action.type === "replace") return action.candidate;
  if (action.type === "mark_past") return action.replacement;
  return undefined;
}

function targetIdsFor(action: MemoryAction): string[] {
  if (action.type === "mark_uncertain") return action.targetMemoryIds;
  if (action.type === "add") return [];
  return [action.targetMemoryId];
}

function failure(reason: Extract<MemoryPolicyResult, { ok: false }> ["reason"]): Extract<MemoryPolicyResult, { ok: false }> {
  return { ok: false, reason };
}

function prepareCandidate(proposal: MemoryCandidateProposal, trust: MemoryWriteTrust): MemoryPolicyResult {
  if (containsForbiddenSecret(proposal.content)) return failure("forbidden_secret");
  if (proposal.kind === "event" && proposal.retention === null) return failure("invalid_transition");
  if (proposal.kind === "schedule" && !trust.pinned && trust.origin !== "explicit" && !trustedScheduleAnchor(trust)) return failure("invalid_transition");
  const eventAnchor = trustedEventAnchor(trust).toISOString();

  return {
    ok: true,
    candidate: {
      kind: proposal.kind,
      scope: proposal.scope,
      content: proposal.content,
      origin: trust.origin,
      sensitivity: classifySensitivity(proposal.content),
      importance: proposal.importance,
      sourceMessageId: trust.sourceMessageId,
      sourceOccurredAt: eventAnchor,
      validFrom: proposal.validFrom,
      validUntil: proposal.validUntil,
      expiresAt: defaultExpiry(proposal, trust),
      pinned: trust.pinned,
      supersedesId: null,
    },
  };
}

function actionWithCandidate(action: MemoryAction, candidate: MemoryCandidateV2): ValidatedMemoryAction {
  if (action.type === "add") return { ...action, candidate };
  if (action.type === "replace") return { ...action, candidate };
  if (action.type === "mark_past") return { ...action, replacement: candidate };
  return action;
}

function canTargetReceive(action: MemoryAction, target: MemoryRecord): boolean {
  if (action.type === "replace" || action.type === "mark_past") {
    return target.status === "active" || target.status === "uncertain";
  }
  if (action.type === "mark_uncertain") return canTransition(target.status, "uncertain") && target.status !== "expired";
  return true;
}

export function isTombstoneContentMatch(candidate: string, fingerprint: string): boolean {
  return isMemoryTombstoneMatch(candidate, fingerprint);
}

export function validateMemoryAction(input: {
  action: MemoryAction;
  records: readonly MemoryRecord[];
  tombstones: readonly MemoryTombstone[];
  allowedTargetIds: readonly string[];
  trust: MemoryWriteTrust;
}): MemoryActionPolicyResult {
  if (
    !Array.isArray(input.tombstones)
    || !Array.isArray(input.allowedTargetIds)
    || !input.trust
    || !Number.isFinite(new Date(input.trust.serverNow).getTime())
    || (input.trust.sourceOccurredAt !== null && !Number.isFinite(new Date(input.trust.sourceOccurredAt).getTime()))
    || (input.trust.scheduleOccurredAt !== null && !Number.isFinite(new Date(input.trust.scheduleOccurredAt).getTime()))
  ) return failure("invalid_transition");
  if (input.action.type === "mark_uncertain" && new Set(input.action.targetMemoryIds).size !== input.action.targetMemoryIds.length) {
    return failure("invalid_transition");
  }
  if (targetIdsFor(input.action).some((id) => !input.allowedTargetIds.includes(id))) return failure("unknown_target");
  const targets = targetIdsFor(input.action)
    .map((id) => input.records.find((record) => record.id === id));
  if (targets.some((record) => !record)) return failure("unknown_target");
  if (targets.some((record) => !canTargetReceive(input.action, record!))) return failure("invalid_transition");

  const candidate = candidateFor(input.action);
  if (!candidate) return { ok: true, action: input.action as ValidatedMemoryAction, candidate: null };

  const prepared = prepareCandidate(candidate, input.trust);
  if (!prepared.ok) return prepared;
  const blocked = input.tombstones.some((tombstone) => (
    tombstone.releasedAt === null
    && isTombstoneContentMatch(prepared.candidate.content, tombstone.normalizedFingerprint)
  ));
  if (blocked) {
    return failure(input.trust.origin === "explicit" ? "requires_relearning_confirmation" : "tombstoned");
  }

  return { ok: true, action: actionWithCandidate(input.action, prepared.candidate), candidate: prepared.candidate };
}

export async function applyMemoryAction(input: {
  user: RequestUser;
  action: MemoryAction;
  sourceMessageId: string;
  repository: MemoryRepositoryV2;
  allowedTargetIds: readonly string[];
  trust: Omit<MemoryWriteTrust, "sourceMessageId">;
}): Promise<ApplyMemoryActionResult> {
  if (await input.repository.getProcessing(input.user, input.sourceMessageId) === "completed") {
    return { ok: true, state: "completed" };
  }
  const [records, tombstones] = await Promise.all([
    input.repository.list(input.user),
    input.repository.listActiveTombstones(input.user),
  ]);
  const validation = validateMemoryAction({
    action: input.action,
    records,
    tombstones,
    allowedTargetIds: input.allowedTargetIds,
    trust: { ...input.trust, sourceMessageId: input.sourceMessageId },
  });
  if (!validation.ok) return validation;
  const state = await input.repository.applyPreparedAction(input.user, input.sourceMessageId, validation.action);
  return { ok: true, state };
}
