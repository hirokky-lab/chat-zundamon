export type ProactiveTriggerSource = "time" | "one_time_reminder" | "calendar_tasks";
export type ProactivePurpose = "greeting" | "reminder" | "calendar_task" | "recommendation";
export type ProactiveTemplateId = "app_open_greeting_v1" | "one_time_reminder_v1" | "calendar_task_v1";

export type ProactiveCandidate = Readonly<{
  id: string;
  source: ProactiveTriggerSource;
  sourceRef: string;
  templateId: ProactiveTemplateId;
  purpose: ProactivePurpose;
  text: string;
  dedupeKey: string;
  contextRef: string;
  createdAt: string;
  expiresAt: string;
  timeZone: string;
  explicitlyRequested: boolean;
}>;

export type ProactiveTriggerContext = Readonly<{ ownerId: string; openedAt: string }>;
export interface ProactiveTriggerAdapter {
  collect(context: ProactiveTriggerContext): Promise<readonly ProactiveCandidate[]>;
}

export type ProactiveAdmissionState = Readonly<{
  enabled: boolean;
  ownerOnly: boolean;
  appIsOpen: boolean;
  notificationsEnabled: boolean;
  now: string;
  outstandingCandidateId: string | null;
  deliveredDedupeKeys: readonly string[];
}>;

export type ProactiveAdmission =
  | Readonly<{ status: "admitted"; candidate: ProactiveCandidate }>
  | Readonly<{ status: "suppressed"; reason: "disabled" | "owner_required" | "app_closed" | "notifications_off" | "duplicate" | "unanswered" | "unsafe_content" | "unsolicited" | "explicit_request_required" | "invalid_candidate" | "expired" }>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const CONTEXT_REF = /^talk:[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const APPROVED_TEMPLATES: Readonly<Record<ProactiveTemplateId, Readonly<{
  source: ProactiveTriggerSource;
  purpose: Exclude<ProactivePurpose, "recommendation">;
  text: string;
}>>> = {
  app_open_greeting_v1: { source: "time", purpose: "greeting", text: "おかえりなさい。今日もここにいますよ" },
  one_time_reminder_v1: { source: "one_time_reminder", purpose: "reminder", text: "そろそろ、頼まれていた確認の時間です" },
  calendar_task_v1: { source: "calendar_tasks", purpose: "calendar_task", text: "予定していたことを確認する時間です" },
};

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validCandidate(value: ProactiveCandidate): boolean {
  return SAFE_ID.test(value.id)
    && SAFE_ID.test(value.dedupeKey)
    && SAFE_ID.test(value.sourceRef)
    && CONTEXT_REF.test(value.contextRef)
    && validInstant(value.createdAt)
    && validInstant(value.expiresAt)
    && validTimeZone(value.timeZone)
    && typeof value.text === "string"
    && value.text.trim() === value.text
    && [...value.text].length >= 1
    && [...value.text].length <= 160;
}

export function admitProactiveCandidate(candidate: ProactiveCandidate, state: ProactiveAdmissionState): ProactiveAdmission {
  if (!state.enabled) return { status: "suppressed", reason: "disabled" };
  if (!state.ownerOnly) return { status: "suppressed", reason: "owner_required" };
  if (!state.appIsOpen) return { status: "suppressed", reason: "app_closed" };
  if (!state.notificationsEnabled) return { status: "suppressed", reason: "notifications_off" };
  if (!validInstant(state.now) || !validCandidate(candidate)) return { status: "suppressed", reason: "invalid_candidate" };
  if (Date.parse(candidate.expiresAt) <= Date.parse(state.now)) return { status: "suppressed", reason: "expired" };
  if (state.deliveredDedupeKeys.includes(candidate.dedupeKey)) return { status: "suppressed", reason: "duplicate" };
  if (state.outstandingCandidateId !== null) return { status: "suppressed", reason: "unanswered" };
  if (candidate.purpose === "recommendation") return { status: "suppressed", reason: "unsolicited" };
  if ((candidate.source === "one_time_reminder" || candidate.source === "calendar_tasks") && !candidate.explicitlyRequested) {
    return { status: "suppressed", reason: "explicit_request_required" };
  }
  const template = APPROVED_TEMPLATES[candidate.templateId];
  if (!template || template.source !== candidate.source || template.purpose !== candidate.purpose || template.text !== candidate.text) {
    return { status: "suppressed", reason: "unsafe_content" };
  }
  return { status: "admitted", candidate };
}

export function createFixtureTriggerAdapter(candidates: readonly ProactiveCandidate[]): ProactiveTriggerAdapter {
  const fixture = candidates.map((candidate) => ({ ...candidate }));
  return { collect: async () => fixture.map((candidate) => ({ ...candidate })) };
}

export type ProactiveDeliveryStatus = "delivered" | "dismissed" | "deferred" | "unneeded" | "cancelled";
export type ProactiveDelivery = Readonly<{
  candidateId: string;
  sourceRef: string;
  dedupeKey: string;
  contextRef: string;
  timeZone: string;
  status: ProactiveDeliveryStatus;
  deliveredAt: string;
  updatedAt: string;
}>;

export type ProactiveDeliveryEvent =
  | Readonly<{ type: "delivered"; candidate: ProactiveCandidate; deliveredAt: string }>
  | Readonly<{ type: "dismiss" | "later" | "unneeded" | "cancel"; candidateId: string; at: string }>;

export function reduceProactiveDelivery(current: null, event: Extract<ProactiveDeliveryEvent, { type: "delivered" }>): ProactiveDelivery;
export function reduceProactiveDelivery(current: ProactiveDelivery | null, event: ProactiveDeliveryEvent): ProactiveDelivery | null;
export function reduceProactiveDelivery(current: ProactiveDelivery | null, event: ProactiveDeliveryEvent): ProactiveDelivery | null {
  if (event.type === "delivered") {
    if (current?.candidateId === event.candidate.id) return current;
    return {
      candidateId: event.candidate.id,
      sourceRef: event.candidate.sourceRef,
      dedupeKey: event.candidate.dedupeKey,
      contextRef: event.candidate.contextRef,
      timeZone: event.candidate.timeZone,
      status: "delivered",
      deliveredAt: event.deliveredAt,
      updatedAt: event.deliveredAt,
    };
  }
  if (!current || current.candidateId !== event.candidateId) return current;
  const status = event.type === "dismiss" ? "dismissed"
    : event.type === "later" ? "deferred"
      : event.type === "unneeded" ? "unneeded"
        : "cancelled";
  if (current.status === status) return current;
  if (current.status !== "delivered") return current;
  return { ...current, status, updatedAt: event.at };
}

export type PresenceState = "listening" | "thinking" | "speaking" | "idle";
export type PresenceEvent = Readonly<{ state: PresenceState; occurredAt: string; source: "talk" | "voice" }>;
export type PresenceEventChannel = Readonly<{
  publish(event: PresenceEvent): void;
  subscribe(listener: (event: PresenceEvent) => void): () => void;
}>;

export function createPresenceEventChannel(): PresenceEventChannel {
  const listeners = new Set<(event: PresenceEvent) => void>();
  return {
    publish(event) { for (const listener of listeners) listener({ ...event }); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
