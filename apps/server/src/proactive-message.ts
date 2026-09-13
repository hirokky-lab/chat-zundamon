import {
  admitProactiveCandidate,
  reduceProactiveDelivery,
  type ProactiveCandidate,
  type ProactiveDelivery,
  type ProactiveTriggerAdapter,
  type ProactiveTriggerSource,
  type ProactiveTemplateId,
} from "@yui/domain";

export type StoredProactiveDelivery = ProactiveDelivery & Readonly<{ source: ProactiveTriggerSource; templateId: ProactiveTemplateId }>;
export type ProactiveDeliveryRepository = Readonly<{
  get(ownerId: string, candidateId: string): Promise<StoredProactiveDelivery | null>;
  list(ownerId: string): Promise<readonly StoredProactiveDelivery[]>;
  save(ownerId: string, delivery: StoredProactiveDelivery): Promise<void>;
}>;

export type ProactiveTelemetry = Readonly<{
  record(event: Readonly<{ kind: "open_failed" | "action_failed"; code: string }>): void;
}>;

export type ProactiveAction = "dismiss" | "later" | "unneeded" | "cancel";
export type ProactiveOpenResult =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "none"; reason: string }>
  | Readonly<{ status: "candidate"; candidate: ProactiveCandidate; actions: readonly ProactiveAction[] }>
  | Readonly<{ status: "failure"; code: "invalid_request" | "trigger_unavailable" | "persistence_failed" }>;
export type ProactiveActionResult =
  | Readonly<{ status: "updated"; candidateId: string; state: ProactiveDelivery["status"] }>
  | Readonly<{ status: "failure"; code: "invalid_request" | "not_found" | "persistence_failed" | "cancellation_failed" }>;
export type ReminderCancellationResult =
  | Readonly<{ status: "cancelled"; reminderId: string }>
  | Readonly<{ status: "failure"; code: string }>;

const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const ACTIONS = ["dismiss", "later", "unneeded", "cancel"] as const;

function clone(delivery: StoredProactiveDelivery): StoredProactiveDelivery {
  return { ...delivery };
}

export function createMemoryProactiveDeliveryRepository(): ProactiveDeliveryRepository {
  const values = new Map<string, StoredProactiveDelivery>();
  const key = (ownerId: string, candidateId: string) => `${ownerId}:${candidateId}`;
  return {
    async get(ownerId, candidateId) {
      const found = values.get(key(ownerId, candidateId));
      return found ? clone(found) : null;
    },
    async list(ownerId) {
      return [...values.entries()]
        .filter(([storedKey]) => storedKey.startsWith(`${ownerId}:`))
        .map(([, delivery]) => clone(delivery));
    },
    async save(ownerId, delivery) {
      values.set(key(ownerId, delivery.candidateId), clone(delivery));
    },
  };
}

export type ProactiveMessageService = Readonly<{
  open(input: Readonly<{ ownerId: string; openedAt: string; notificationsEnabled: boolean }>): Promise<ProactiveOpenResult>;
  act(input: Readonly<{ ownerId: string; candidateId: string; action: ProactiveAction }>): Promise<ProactiveActionResult>;
}>;

function isInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function actionStatus(action: ProactiveAction): ProactiveDelivery["status"] {
  if (action === "dismiss") return "dismissed";
  if (action === "later") return "deferred";
  if (action === "unneeded") return "unneeded";
  return "cancelled";
}

export function createProactiveMessageService(options: Readonly<{
  enabled: boolean;
  trigger: ProactiveTriggerAdapter;
  repository: ProactiveDeliveryRepository;
  now: () => string;
  cancelReminder?: (ownerId: string, reminderId: string) => Promise<ReminderCancellationResult>;
  telemetry?: ProactiveTelemetry;
}>): ProactiveMessageService {
  return {
    async open(input) {
      if (!options.enabled) return { status: "disabled" };
      if (!OWNER_ID.test(input?.ownerId ?? "") || !isInstant(input?.openedAt ?? "") || typeof input?.notificationsEnabled !== "boolean") {
        return { status: "failure", code: "invalid_request" };
      }
      if (!input.notificationsEnabled) return { status: "none", reason: "notifications_off" };
      let candidates: readonly ProactiveCandidate[];
      try {
        candidates = await options.trigger.collect({ ownerId: input.ownerId, openedAt: input.openedAt });
      } catch {
        options.telemetry?.record({ kind: "open_failed", code: "trigger_unavailable" });
        return { status: "failure", code: "trigger_unavailable" };
      }
      try {
        const history = await options.repository.list(input.ownerId);
        const replayCandidate = async (candidate: ProactiveCandidate, replay: StoredProactiveDelivery): Promise<ProactiveOpenResult> => {
          const identityMatches = replay.dedupeKey === candidate.dedupeKey
            && replay.contextRef === candidate.contextRef
            && replay.source === candidate.source
            && replay.sourceRef === candidate.sourceRef
            && replay.templateId === candidate.templateId;
          if (!identityMatches) return { status: "none", reason: "unsafe_content" };
          const admission = admitProactiveCandidate(candidate, {
            enabled: true,
            ownerOnly: true,
            appIsOpen: true,
            notificationsEnabled: true,
            now: input.openedAt,
            outstandingCandidateId: null,
            deliveredDedupeKeys: history.filter((delivery) => delivery.candidateId !== candidate.id).map((delivery) => delivery.dedupeKey),
          });
          if (admission.status === "suppressed") return { status: "none", reason: admission.reason };
          if (replay.status === "deferred") {
            await options.repository.save(input.ownerId, { ...replay, status: "delivered", updatedAt: input.openedAt });
          }
          return { status: "candidate", candidate, actions: ACTIONS };
        };

        const outstanding = history.find((delivery) => delivery.status === "delivered");
        if (outstanding) {
          const candidate = candidates.find((item) => item.id === outstanding.candidateId);
          return candidate ? replayCandidate(candidate, outstanding) : { status: "none", reason: "unanswered" };
        }
        for (const candidate of candidates) {
          const replay = history.find((delivery) => delivery.candidateId === candidate.id && delivery.status === "deferred");
          if (!replay) continue;
          return replayCandidate(candidate, replay);
        }
        let lastReason = candidates.length === 0 ? "no_candidate" : "suppressed";
        for (const candidate of candidates) {
          const admission = admitProactiveCandidate(candidate, {
            enabled: true,
            ownerOnly: true,
            appIsOpen: true,
            notificationsEnabled: input.notificationsEnabled,
            now: input.openedAt,
            outstandingCandidateId: history.find((delivery) => delivery.status === "delivered")?.candidateId ?? null,
            deliveredDedupeKeys: history.filter((delivery) => delivery.status !== "deferred").map((delivery) => delivery.dedupeKey),
          });
          if (admission.status === "suppressed") { lastReason = admission.reason; continue; }
          const delivery = reduceProactiveDelivery(null, { type: "delivered", candidate, deliveredAt: input.openedAt });
          await options.repository.save(input.ownerId, { ...delivery, source: candidate.source, templateId: candidate.templateId });
          return { status: "candidate", candidate, actions: ACTIONS };
        }
        return { status: "none", reason: lastReason };
      } catch {
        options.telemetry?.record({ kind: "open_failed", code: "persistence_failed" });
        return { status: "failure", code: "persistence_failed" };
      }
    },

    async act(input) {
      if (!OWNER_ID.test(input?.ownerId ?? "") || !CANDIDATE_ID.test(input?.candidateId ?? "") || !ACTIONS.includes(input?.action)) {
        return { status: "failure", code: "invalid_request" };
      }
      try {
        const current = await options.repository.get(input.ownerId, input.candidateId);
        if (!current) return { status: "failure", code: "not_found" };
        const target = actionStatus(input.action);
        if (current.status === target) return { status: "updated", candidateId: current.candidateId, state: current.status };
        if (current.status !== "delivered") return { status: "failure", code: "not_found" };
        if (input.action === "cancel") {
          if (current.source !== "one_time_reminder" || !options.cancelReminder) {
            options.telemetry?.record({ kind: "action_failed", code: "cancellation_failed" });
            return { status: "failure", code: "cancellation_failed" };
          }
          try {
            const result = await options.cancelReminder(input.ownerId, current.sourceRef);
            if (result.status !== "cancelled" || result.reminderId !== current.sourceRef) {
              options.telemetry?.record({ kind: "action_failed", code: "cancellation_failed" });
              return { status: "failure", code: "cancellation_failed" };
            }
          } catch {
            options.telemetry?.record({ kind: "action_failed", code: "cancellation_failed" });
            return { status: "failure", code: "cancellation_failed" };
          }
        }
        const updated = reduceProactiveDelivery(current, { type: input.action, candidateId: input.candidateId, at: options.now() });
        if (!updated) return { status: "failure", code: "not_found" };
        await options.repository.save(input.ownerId, { ...updated, source: current.source, templateId: current.templateId });
        return { status: "updated", candidateId: updated.candidateId, state: updated.status };
      } catch {
        options.telemetry?.record({ kind: "action_failed", code: "persistence_failed" });
        return { status: "failure", code: "persistence_failed" };
      }
    },
  };
}

export type PushDeliveryAdapter = Readonly<{
  deliver(input: Readonly<{ notificationId: string; contextRef: string }>): Promise<Readonly<{
    status: "not_run";
    timeSensitive: false;
    openTarget: Readonly<{ view: "talk"; contextRef: string }>;
  }>>;
}>;

export function createNoopPushAdapter(): PushDeliveryAdapter {
  return {
    async deliver(input) {
      return { status: "not_run", timeSensitive: false, openTarget: { view: "talk", contextRef: input.contextRef } };
    },
  };
}
