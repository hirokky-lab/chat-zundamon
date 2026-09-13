import type { ProactiveCandidate, ProactiveDeliveryStatus } from "@yui/domain";

export type ProactiveUiAction = "dismiss" | "later" | "unneeded" | "cancel";
export type ProactiveOpenResult =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "none"; reason: string }>
  | Readonly<{ status: "candidate"; candidate: ProactiveCandidate; actions: readonly ProactiveUiAction[] }>
  | Readonly<{ status: "failure"; code: string }>;
export type ProactiveActionResult =
  | Readonly<{ status: "updated"; candidateId: string; state: Exclude<ProactiveDeliveryStatus, "delivered"> }>
  | Readonly<{ status: "failure"; code: string }>;

export type ProactiveExperienceApi = Readonly<{
  open(input: Readonly<{ openedAt: string; notificationsEnabled: boolean }>): Promise<ProactiveOpenResult>;
  act(input: Readonly<{ candidateId: string; action: ProactiveUiAction }>): Promise<ProactiveActionResult>;
}>;

export type NotificationPreferenceStore = Readonly<{
  load(): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
}>;

export function createMemoryNotificationPreferenceStore(initial = false): NotificationPreferenceStore {
  let enabled = initial;
  return {
    load: async () => enabled,
    save: async (next) => { enabled = next; },
  };
}

const NOTIFICATION_PREFERENCE_KEY = "zundamon-ai-notifications-enabled-v1";
const PROACTIVE_DELIVERY_KEY = "zundamon-ai-proactive-delivery-v1";

export function createBrowserNotificationPreferenceStore(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): NotificationPreferenceStore {
  return {
    async load() { return storage.getItem(NOTIFICATION_PREFERENCE_KEY) === "true"; },
    async save(enabled) { storage.setItem(NOTIFICATION_PREFERENCE_KEY, enabled ? "true" : "false"); },
  };
}

type FixtureDelivery = Readonly<{ candidateId: string; dedupeKey: string; status: "delivered" | "dismissed" | "deferred" | "unneeded"; updatedAt: string }>;
const FIXTURE_DELIVERY_KEYS = ["candidateId", "dedupeKey", "status", "updatedAt"] as const;

function dateInTimeZone(instant: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return value.year && value.month && value.day ? `${value.year}-${value.month}-${value.day}` : null;
  } catch { return null; }
}

function readFixtureDelivery(storage: Pick<Storage, "getItem">): FixtureDelivery | null | undefined {
  try {
    const raw = storage.getItem(PROACTIVE_DELIVERY_KEY);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).sort().join("\0") !== FIXTURE_DELIVERY_KEYS.join("\0")) return null;
    if (typeof value.candidateId !== "string" || typeof value.dedupeKey !== "string" || typeof value.updatedAt !== "string") return null;
    if (!(["delivered", "dismissed", "deferred", "unneeded"] as const).includes(value.status as FixtureDelivery["status"])) return null;
    return value as FixtureDelivery;
  } catch { return null; }
}

export function createLocalFixtureProactiveApi(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  timeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): ProactiveExperienceApi {
  const candidateFor = (openedAt: string): ProactiveCandidate | null => {
    const zone = timeZone();
    const date = dateInTimeZone(openedAt, zone);
    const opened = Date.parse(openedAt);
    if (!date || !Number.isFinite(opened)) return null;
    return {
      id: `opening-${date.replaceAll("-", "")}`,
      source: "time",
      sourceRef: `time:${date}`,
      templateId: "app_open_greeting_v1",
      purpose: "greeting",
      text: "おかえりなさい。今日もここにいますよ",
      dedupeKey: `opening:${date}`,
      contextRef: "talk:latest",
      createdAt: new Date(opened).toISOString(),
      expiresAt: new Date(opened + 86_400_000).toISOString(),
      timeZone: zone,
      explicitlyRequested: false,
    };
  };
  return {
    async open(input) {
      if (!input.notificationsEnabled) return { status: "none", reason: "notifications_off" };
      const candidate = candidateFor(input.openedAt);
      if (!candidate) return { status: "failure", code: "invalid_request" };
      const stored = readFixtureDelivery(storage);
      if (stored === null) return { status: "failure", code: "invalid_request" };
      if (stored?.dedupeKey === candidate.dedupeKey && (stored.status === "dismissed" || stored.status === "unneeded")) {
        return { status: "none", reason: "duplicate" };
      }
      storage.setItem(PROACTIVE_DELIVERY_KEY, JSON.stringify({ candidateId: candidate.id, dedupeKey: candidate.dedupeKey, status: "delivered", updatedAt: input.openedAt } satisfies FixtureDelivery));
      return { status: "candidate", candidate, actions: ["dismiss", "later", "unneeded"] };
    },
    async act(input) {
      const stored = readFixtureDelivery(storage);
      if (!stored || stored.candidateId !== input.candidateId
        || (input.action !== "dismiss" && input.action !== "later" && input.action !== "unneeded")) {
        return { status: "failure", code: "not_found" };
      }
      const state = input.action === "later" ? "deferred" : input.action === "unneeded" ? "unneeded" : "dismissed";
      if (stored.status === state) return { status: "updated", candidateId: input.candidateId, state };
      if (stored.status !== "delivered") return { status: "failure", code: "not_found" };
      storage.setItem(PROACTIVE_DELIVERY_KEY, JSON.stringify({ ...stored, status: state, updatedAt: new Date().toISOString() } satisfies FixtureDelivery));
      return { status: "updated", candidateId: input.candidateId, state };
    },
  };
}

export type OsNotificationPermission = "granted" | "denied" | "default" | "unsupported";

export function readOsNotificationPermission(): OsNotificationPermission {
  const permission = globalThis.Notification?.permission;
  return permission === "granted" || permission === "denied" || permission === "default" ? permission : "unsupported";
}

export function osNotificationPermissionLabel(permission: OsNotificationPermission): string {
  if (permission === "granted") return "OS通知: 許可されています";
  if (permission === "denied") return "OS通知: 許可されていません";
  if (permission === "default") return "OS通知: 未選択です";
  return "OS通知: この環境では確認できません";
}
