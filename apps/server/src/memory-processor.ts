import { createHash } from "node:crypto";
import OpenAI from "openai";
import { isMemoryAvailable, normalizeMemory, type MemoryRecord, type TranscriptTurn } from "../../../packages/domain/src/index.js";
import { automaticMemoryProcessingKey } from "../../../packages/domain/src/automatic-memory-key.js";
import type { MemoryAction } from "../../../packages/domain/src/memory.js";
import type { CostGuard, CostReservation } from "./cost-guard.js";
import { MEMORY_ACTION_LEASE_MS, type AutomaticMemoryOutbox, type MemoryRepositoryV2 } from "./db.js";
import type { MemoryExtractionUsage, MemoryExtractor } from "./memory-extractor.js";
import { validateMemoryAction } from "./memory-policy.js";
import { preflightAutomaticMemory, selectAutomaticMemoryAction, type AutomaticMemorySourceContext } from "./memory-auto-policy.js";
import { memoryActionSchema } from "./memory-schema.js";
import type { RequestUser } from "./request-user.js";
import { toUsageRow, type UsageInput, type UsageLog } from "./usage-log.js";
import type { VoiceMemoryCoordinator } from "./voice-memory-coordinator.js";

export type MemoryProcessInput = {
  sourceMessageId: string;
  sourceOccurredAt: string;
  sourceOrigin?: "voice";
  sourceContext?: AutomaticMemorySourceContext;
  explicitMemoryTargetTurnIndexes?: number[];
  turns: Array<TranscriptTurn & { provenance: "context" | "authoritative_source" }>;
};

export type MemoryProcessingReceipt = {
  sourceMessageId: string;
  state: "pending" | "completed" | "failed";
  appliedCount: number;
};

export type AutomaticMemoryOutcome = "success" | "failure" | "cancel" | "timeout" | "retry";

export type AutomaticMemoryTelemetryEvent = {
  featureArea: "automatic_memory";
  idempotencyKey: `sha256:${string}`;
  outcome: AutomaticMemoryOutcome;
  latencyMs: number;
  charged: boolean;
  appliedCount: number;
};

export type AutomaticMemoryTelemetry = {
  record(event: AutomaticMemoryTelemetryEvent): void | Promise<void>;
};

type MemoryProcessorOptions = {
  extractor: MemoryExtractor;
  repository: MemoryRepositoryV2;
  usageLog: UsageLog;
  costGuard: CostGuard;
  maximumUsd: number;
  automaticMemoryEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  voiceMemoryEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  memoryMasterEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  policyVersion?: "natural-v1";
  voiceCoordinator?: VoiceMemoryCoordinator;
  telemetry?: AutomaticMemoryTelemetry;
  now?: () => Date;
};

type AutomaticExtraction = {
  actions?: unknown[];
  usage?: MemoryExtractionUsage;
};

const noTelemetry: AutomaticMemoryTelemetry = { record: () => undefined };
class AutomaticMemoryDisabledError extends Error {}

function stableSourceKey(sourceMessageId: string): string {
  return createHash("sha256").update(sourceMessageId).digest("hex");
}

function costRequestId(sourceMessageId: string, attemptIndex: number): string {
  return `auto-memory:${stableSourceKey(sourceMessageId)}:${attemptIndex}`;
}

function usageSessionId(sourceMessageId: string, attemptIndex: number): string {
  return costRequestId(sourceMessageId, attemptIndex);
}

function selectPresentedTargets(records: readonly MemoryRecord[], turns: MemoryProcessInput["turns"], now: Date): MemoryRecord[] {
  const userText = normalizeMemory(turns
    .filter((turn) => turn.role === "user" && turn.provenance === "authoritative_source")
    .map((turn) => turn.text)
    .join("\n"));
  if (!userText) return [];
  return records
    .filter((record) => isMemoryAvailable(record, now))
    .filter((record) => userText.includes(record.normalizedContent))
    .slice(0, 3);
}

function classifiedOutcome(error: unknown, signal?: AbortSignal): Exclude<AutomaticMemoryOutcome, "success" | "retry"> {
  if (signal?.aborted || error instanceof OpenAI.APIUserAbortError) return "cancel";
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "cancel";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "failure";
}

function withoutModelTimeAuthority(action: MemoryAction): MemoryAction {
  if (action.type === "add" || action.type === "replace") {
    return {
      ...action,
      candidate: { ...action.candidate, sourceOccurredAt: null, validFrom: null, validUntil: null },
    };
  }
  if (action.type === "mark_past" && action.replacement) {
    return {
      ...action,
      replacement: { ...action.replacement, sourceOccurredAt: null, validFrom: null, validUntil: null },
    };
  }
  return action;
}

function voiceCandidateContent(action: MemoryAction): string | null {
  if (action.type === "add" || action.type === "replace") return action.candidate.content;
  if (action.type === "mark_past" && action.replacement) return action.replacement.content;
  return null;
}

function canonicalVoiceText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, "");
}

function ngrams(value: string, size: number): Set<string> {
  const points = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index + size <= points.length; index += 1) {
    result.add(points.slice(index, index + size).join(""));
  }
  return result;
}

function overlapCoverage(candidate: string, sources: readonly string[], size: number): number {
  const candidateGrams = ngrams(candidate, size);
  if (candidateGrams.size === 0) return 0;
  const sourceGrams = new Set(sources.flatMap((source) => [...ngrams(source, size)]));
  return [...candidateGrams].filter((gram) => sourceGrams.has(gram)).length / candidateGrams.size;
}

function normalizedEditSimilarity(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0 || b.length === 0) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + (a[leftIndex - 1] === b[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length]! / Math.max(a.length, b.length);
}

function hasShortNearCopy(candidate: string, sources: readonly string[]): boolean {
  const candidatePoints = Array.from(candidate);
  const threshold = candidatePoints.length === 4 ? 0.75 : 0.8;
  const minimumWindow = Math.max(1, candidatePoints.length - 1);
  const maximumWindow = candidatePoints.length + 1;
  for (const source of sources) {
    const sourcePoints = Array.from(source);
    for (let windowSize = minimumWindow; windowSize <= maximumWindow; windowSize += 1) {
      if (sourcePoints.length < windowSize) continue;
      for (let start = 0; start + windowSize <= sourcePoints.length; start += 1) {
        const window = sourcePoints.slice(start, start + windowSize).join("");
        if (normalizedEditSimilarity(candidate, window) >= threshold) return true;
      }
    }
  }
  return false;
}

function areWindowsWithinOneEdit(
  left: readonly string[],
  leftStart: number,
  leftLength: number,
  right: readonly string[],
  rightStart: number,
  rightLength: number,
): boolean {
  if (Math.abs(leftLength - rightLength) > 1) return false;
  if (leftLength === rightLength) {
    let differences = 0;
    for (let index = 0; index < leftLength; index += 1) {
      if (left[leftStart + index] !== right[rightStart + index] && ++differences > 1) return false;
    }
    return true;
  }
  const leftIsShorter = leftLength < rightLength;
  const shorter = leftIsShorter ? left : right;
  const shorterStart = leftIsShorter ? leftStart : rightStart;
  const shorterLength = leftIsShorter ? leftLength : rightLength;
  const longer = leftIsShorter ? right : left;
  const longerStart = leftIsShorter ? rightStart : leftStart;
  const longerLength = leftIsShorter ? rightLength : leftLength;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorterLength && longIndex < longerLength) {
    if (shorter[shorterStart + shortIndex] === longer[longerStart + longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      longIndex += 1;
    }
  }
  return true;
}

function hasSubstantialLocalCopy(candidate: string, sources: readonly string[]): boolean {
  const minimumSpan = 12;
  const candidatePoints = Array.from(candidate);
  if (candidatePoints.length < minimumSpan) return false;
  const sourcePointSets = sources.map((source) => Array.from(source));
  for (let candidateStart = 0; candidateStart + minimumSpan <= candidatePoints.length; candidateStart += 1) {
    for (const sourcePoints of sourcePointSets) {
      for (const sourceLength of [minimumSpan - 1, minimumSpan, minimumSpan + 1]) {
        for (let sourceStart = 0; sourceStart + sourceLength <= sourcePoints.length; sourceStart += 1) {
          if (areWindowsWithinOneEdit(candidatePoints, candidateStart, minimumSpan, sourcePoints, sourceStart, sourceLength)) return true;
        }
      }
    }
  }
  return false;
}

function isConciseVoiceGist(action: MemoryAction, turns: MemoryProcessInput["turns"]): boolean {
  const content = voiceCandidateContent(action);
  if (content === null) return true;
  if (content.length > 80 || /[\r\n「」『』“”"«»‹›〝〟]/u.test(content)) return false;
  const candidate = canonicalVoiceText(content);
  if (!candidate) return false;
  const sources = turns
    .filter((turn) => turn.role === "user" && turn.provenance === "authoritative_source")
    .map((turn) => canonicalVoiceText(turn.text))
    .filter(Boolean);
  if (sources.length === 0) return false;
  if (sources.some((source) => source.includes(candidate) || candidate.includes(source))) return false;
  const candidateLength = Array.from(candidate).length;
  if (candidateLength >= 4 && candidateLength <= 11) {
    if (hasShortNearCopy(candidate, sources)) return false;
  }
  if (candidateLength >= 12 && (hasSubstantialLocalCopy(candidate, sources) || overlapCoverage(candidate, sources, 3) >= 0.82)) return false;
  return overlapCoverage(candidate, sources, 2) >= 0.4;
}

function isGroundedInExplicitVoiceTarget(action: MemoryAction, turns: MemoryProcessInput["turns"]): boolean {
  const content = voiceCandidateContent(action);
  if (content === null) return true;
  if (content.length > 80 || /[\r\n「」『』“”"«»‹›〝〟]/u.test(content)) return false;
  const candidate = canonicalVoiceText(content);
  if (!candidate) return false;
  const sources = turns
    .filter((turn) => turn.role === "user" && turn.provenance === "authoritative_source")
    .map((turn) => canonicalVoiceText(turn.text))
    .filter(Boolean);
  if (sources.length === 0 || sources.some((source) => source === candidate)) return false;
  return overlapCoverage(candidate, sources, 2) >= 0.4;
}

export class MemoryProcessor {
  private readonly now: () => Date;
  private readonly telemetry: AutomaticMemoryTelemetry;

  constructor(private readonly options: MemoryProcessorOptions) {
    this.now = options.now ?? (() => new Date());
    this.telemetry = options.telemetry ?? noTelemetry;
  }

  async process(user: RequestUser, input: MemoryProcessInput, signal?: AbortSignal): Promise<MemoryProcessingReceipt> {
    if (this.options.policyVersion && !preflightAutomaticMemory(input).eligible) {
      return { sourceMessageId: input.sourceMessageId, state: "completed", appliedCount: 0 };
    }
    if (!(await this.enabled(user, input))) {
      return { sourceMessageId: input.sourceMessageId, state: "failed", appliedCount: 0 };
    }
    const lease = input.sourceOrigin === "voice"
      ? this.options.voiceCoordinator?.acquire(user, signal)
      : null;
    if (input.sourceOrigin === "voice" && this.options.voiceCoordinator && !lease) {
      return { sourceMessageId: input.sourceMessageId, state: "failed", appliedCount: 0 };
    }
    const baseSignal = lease?.signal ?? signal;
    const processingSignal = input.sourceOrigin === "voice"
      ? AbortSignal.any([
        ...(baseSignal ? [baseSignal] : []),
        AbortSignal.timeout(MEMORY_ACTION_LEASE_MS - 1_000),
      ])
      : baseSignal;
    try {
      return await this.processEnabled(user, input, processingSignal);
    } finally {
      lease?.release();
    }
  }

  private async processEnabled(user: RequestUser, input: MemoryProcessInput, signal?: AbortSignal): Promise<MemoryProcessingReceipt> {
    const startedAt = this.now();
    const policyPreflight = this.options.policyVersion ? preflightAutomaticMemory(input) : null;
    const processingSourceId = this.options.policyVersion && input.sourceOrigin !== "voice"
      ? automaticMemoryProcessingKey(user.userId, input.sourceMessageId, this.options.policyVersion)
      : input.sourceMessageId;
    if (input.sourceOrigin === "voice") {
      const cutoff = new Date(startedAt.getTime() - MEMORY_ACTION_LEASE_MS).toISOString();
      await this.options.repository.cleanupStaleVoiceProcessing(user, cutoff);
    }
    const claim = await this.options.repository.claimAutomaticProcessing(
      user,
      processingSourceId,
      input.sourceOrigin === "voice" ? "voice" : "text",
    );
    if (claim.state === "disabled") {
      return { sourceMessageId: input.sourceMessageId, state: "failed", appliedCount: 0 };
    }
    if (claim.state !== "claimed") {
      return { sourceMessageId: input.sourceMessageId, state: claim.state, appliedCount: claim.appliedCount };
    }
    if (claim.retry) {
      await this.record(processingSourceId, "retry", startedAt, false, claim.appliedCount);
    }

    let appliedCount = claim.appliedCount;
    let charged = false;
    try {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await this.ensureEnabled(user, input);
      const records = await this.options.repository.listForRecall ? await this.options.repository.listForRecall(user) : await this.options.repository.list(user);
      const targets = selectPresentedTargets(records, input.turns, startedAt);
      const allowedTargetIds = targets.map((record) => record.id);
      const trust = {
        origin: input.sourceOrigin === "voice" ? "voice" as const : "extracted" as const,
        pinned: false,
        sourceMessageId: input.sourceMessageId,
        sourceOccurredAt: input.sourceOccurredAt,
        scheduleOccurredAt: null,
        serverNow: startedAt.toISOString(),
      };
      let outbox = await this.options.repository.getAutomaticOutbox(user, processingSourceId);
      await this.ensureEnabled(user, input);
      let reservation: CostReservation | undefined;
      if (!outbox) {
        const latestAttempt = await this.options.repository.getLatestAutomaticExtractionAttempt(user, processingSourceId);
        if (latestAttempt?.state === "dispatched") {
          const abandoned = await this.reserveAttempt(user, processingSourceId, latestAttempt.attemptIndex);
          await abandoned.hold();
          await this.options.repository.setAutomaticExtractionAttemptState(user, processingSourceId, latestAttempt.attemptIndex, "held");
          charged = true;
        }
        const attempt = await this.options.repository.prepareAutomaticExtractionAttempt(user, processingSourceId);
        reservation = await this.reserveAttempt(user, processingSourceId, attempt.attemptIndex);
        await this.options.repository.setAutomaticExtractionAttemptState(user, processingSourceId, attempt.attemptIndex, "dispatched");
        charged = true;
        let extraction: AutomaticExtraction;
        try {
          await this.ensureEnabled(user, input);
          const extractionTurns = input.sourceOrigin === "voice"
            ? input.turns.filter((turn) => turn.role === "user" && turn.provenance === "authoritative_source")
            : input.turns;
          extraction = await this.options.extractor.extract(extractionTurns, {
            mode: "automatic",
            targets: targets.map((record) => ({ id: record.id, content: record.content })),
            sourceOrigin: input.sourceOrigin,
            explicitMemoryIntent: input.sourceOrigin === "voice" && (input.explicitMemoryTargetTurnIndexes?.length ?? 0) > 0,
            signal,
          }) as AutomaticExtraction;
          if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
          await this.ensureEnabled(user, input);
        } catch (error) {
          charged = true;
          await reservation.hold().catch(() => undefined);
          await this.options.repository.setAutomaticExtractionAttemptState(user, processingSourceId, attempt.attemptIndex, "held").catch(() => undefined);
          throw error;
        }
        const tombstones = await this.options.repository.listActiveTombstones(user);
        const extractedActions = Array.isArray(extraction.actions) ? extraction.actions : [];
        const explicitVoiceTarget = input.sourceOrigin === "voice" && (input.explicitMemoryTargetTurnIndexes?.length ?? 0) > 0;
        const actionPlan = this.options.policyVersion
          ? [selectAutomaticMemoryAction(extractedActions, policyPreflight?.eligible ? policyPreflight.authoritativeText : undefined, explicitVoiceTarget, policyPreflight?.eligible ? policyPreflight.category : undefined)]
            .flatMap((action) => action ? [withoutModelTimeAuthority(action)] : [])
          : extractedActions.slice(0, 3)
          .flatMap((rawAction) => {
            const parsed = memoryActionSchema.safeParse(rawAction);
            if (!parsed.success) return [];
            const action = withoutModelTimeAuthority(parsed.data as MemoryAction);
            if (input.sourceOrigin === "voice" && !isConciseVoiceGist(action, input.turns)) return [];
            const explicitTargetTurns = input.sourceOrigin === "voice"
              ? (input.explicitMemoryTargetTurnIndexes ?? []).flatMap((index) => input.turns[index] ? [input.turns[index]!] : [])
              : [];
            const pinned = explicitTargetTurns.length > 0 && isGroundedInExplicitVoiceTarget(action, explicitTargetTurns);
            const validation = validateMemoryAction({ action, records, tombstones, allowedTargetIds, trust: { ...trust, pinned } });
            return validation.ok ? [action] : [];
          });
        const endedAt = this.now().toISOString();
        outbox = await this.options.repository.saveAutomaticOutbox(user, processingSourceId, {
          attemptIndex: attempt.attemptIndex,
          actions: actionPlan,
          usage: extraction.usage ? {
            startedAt: startedAt.toISOString(),
            endedAt,
            ...extraction.usage,
          } : null,
        });
      }
      this.ensureNotAborted(signal);
      await this.ensureEnabled(user, input);
      if (!outbox.usageSettled) {
        reservation ??= await this.reserveAttempt(user, processingSourceId, outbox.attemptIndex);
        charged = await this.settleOutboxUsage(user, processingSourceId, outbox, reservation);
        await this.options.repository.setAutomaticExtractionAttemptState(
          user,
          processingSourceId,
          outbox.attemptIndex,
          outbox.usage ? "settled" : "held",
        );
        await this.options.repository.markAutomaticOutboxUsageSettled(user, processingSourceId);
      }
      this.ensureNotAborted(signal);
      for (const [index, rawAction] of outbox.actions.entries()) {
        this.ensureNotAborted(signal);
        await this.ensureEnabled(user, input);
        const parsed = memoryActionSchema.safeParse(rawAction);
        if (!parsed.success) continue;
        const existing = await this.options.repository.getAutomaticActionProcessing(user, processingSourceId, index);
        if (existing === "completed") continue;
        const [currentRecords, currentTombstones] = await Promise.all([
          this.options.repository.list(user),
          this.options.repository.listActiveTombstones(user),
        ]);
        const explicitTargetTurns = input.sourceOrigin === "voice"
          ? (input.explicitMemoryTargetTurnIndexes ?? []).flatMap((turnIndex) => input.turns[turnIndex] ? [input.turns[turnIndex]!] : [])
          : [];
        const pinned = explicitTargetTurns.length > 0
          && isGroundedInExplicitVoiceTarget(parsed.data as MemoryAction, explicitTargetTurns);
        const validation = validateMemoryAction({
          action: parsed.data as MemoryAction,
          records: currentRecords,
          tombstones: currentTombstones,
          allowedTargetIds,
          trust: { ...trust, pinned },
        });
        if (!validation.ok) continue;
        await this.ensureEnabled(user, input);
        const state = await this.options.repository.applyPreparedAutomaticAction(
          user,
          processingSourceId,
          index,
          validation.action,
        );
        if (state === "disabled") throw new AutomaticMemoryDisabledError();
        if (state === "applied") appliedCount += 1;
        else if (state !== "completed") throw new Error("Automatic memory action receipt unavailable");
      }
      appliedCount = (await Promise.all([0, 1, 2].map((index) => (
        this.options.repository.getAutomaticActionProcessing(user, processingSourceId, index)
      )))).filter((state) => state === "completed").length;
      this.ensureNotAborted(signal);
      await this.ensureEnabled(user, input);
      await this.options.repository.setAutomaticProcessing(user, processingSourceId, "completed", appliedCount);
      await this.record(processingSourceId, "success", startedAt, charged, appliedCount);
      return { sourceMessageId: input.sourceMessageId, state: "completed", appliedCount };
    } catch (error) {
      if (input.sourceOrigin === "voice") {
        await this.options.repository.failAutomaticVoiceProcessing(user, processingSourceId, appliedCount).catch(() => undefined);
      } else {
        await this.options.repository.setAutomaticProcessing(user, processingSourceId, "failed", appliedCount).catch(() => undefined);
      }
      await this.record(processingSourceId, classifiedOutcome(error, signal), startedAt, charged, appliedCount);
      return { sourceMessageId: input.sourceMessageId, state: "failed", appliedCount };
    }
  }

  private enabled(user: RequestUser, input: MemoryProcessInput): Promise<boolean> {
    return Promise.resolve((this.options.memoryMasterEnabled?.(user) ?? true)).then((masterEnabled) => masterEnabled && (input.sourceOrigin === "voice"
      ? this.options.voiceMemoryEnabled?.(user) ?? true
      : this.options.automaticMemoryEnabled?.(user) ?? true));
  }

  private async ensureEnabled(user: RequestUser, input: MemoryProcessInput): Promise<void> {
    if (!(await this.enabled(user, input))) throw new AutomaticMemoryDisabledError();
  }

  private ensureNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  }

  private reserveAttempt(user: RequestUser, sourceMessageId: string, attemptIndex: number): Promise<CostReservation> {
    return this.options.costGuard.reserve({
      user,
      requestId: costRequestId(sourceMessageId, attemptIndex),
      feature: "memory",
      maximumUsd: this.options.maximumUsd,
    });
  }

  private async settleOutboxUsage(
    user: RequestUser,
    sourceMessageId: string,
    outbox: AutomaticMemoryOutbox,
    reservation: CostReservation,
  ): Promise<boolean> {
    if (!outbox.usage) {
      await reservation.hold();
      return true;
    }
    const usageInput: UsageInput = {
      sessionId: usageSessionId(sourceMessageId, outbox.attemptIndex),
      ...outbox.usage,
    };
    await this.options.usageLog.append(user, usageInput);
    await reservation.settle(toUsageRow(user, usageInput).estimatedMemoryUsd);
    return true;
  }

  private async record(sourceMessageId: string, outcome: AutomaticMemoryOutcome, startedAt: Date, charged: boolean, appliedCount: number): Promise<void> {
    const latencyMs = Math.max(0, this.now().getTime() - startedAt.getTime());
    try {
      await this.telemetry.record({
        featureArea: "automatic_memory",
        idempotencyKey: `sha256:${stableSourceKey(sourceMessageId)}`,
        outcome,
        latencyMs,
        charged,
        appliedCount,
      });
    } catch {
      // Metrics must not affect memory processing or visible replies.
    }
  }
}
