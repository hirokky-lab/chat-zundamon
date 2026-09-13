export const VISUAL_STYLE_STORAGE_KEY = "zundamon-ai.visual-style.v1";
export const VISUAL_STYLE_PREFERENCE_STORAGE_KEY = "zundamon-ai.visual-style.preference.v1";
export const VISUAL_STYLE_PREFERENCE_BACKUP_STORAGE_KEY = "zundamon-ai.visual-style.preference.backup.v1";
export const VISUAL_STYLE_SYNC_PENDING_STORAGE_KEY = "zundamon-ai.visual-style.sync-pending.v1";

export type VisualStyle = "yui" | "minimal";
export type VisualStylePreference = Readonly<{ style: VisualStyle; revision: number; updatedAt: string }>;
export type VisualStylePreferenceState = Readonly<{
  preference: VisualStylePreference;
  syncPending: boolean;
  intentSequence?: number;
  intentOrigin?: string;
}>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function sanitizeVisualStyle(value: unknown): VisualStyle {
  return value === "minimal" ? "minimal" : "yui";
}

export function parseVisualStylePreference(value: unknown): VisualStylePreference | null {
  if (!isRecord(value) || !hasExactlyKeys(value, ["style", "revision", "updatedAt"])
    || (value.style !== "yui" && value.style !== "minimal")
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !isCanonicalTimestamp(value.updatedAt)) return null;
  return { style: value.style, revision: value.revision, updatedAt: value.updatedAt };
}

export function reconcileVisualStylePreference(
  local: VisualStylePreference | null,
  remote: VisualStylePreference | null,
): VisualStylePreference | null {
  if (!remote) return local;
  if (!local) return remote;
  if (remote.revision !== local.revision) return remote.revision > local.revision ? remote : local;
  if (remote.updatedAt !== local.updatedAt) return remote.updatedAt > local.updatedAt ? remote : local;
  return remote;
}

export function mergeVisualStylePreferenceState(
  current: VisualStylePreferenceState,
  incoming: VisualStylePreferenceState,
): VisualStylePreferenceState {
  const order = compareVisualStyleIntentOrder(current, incoming);
  if (order < 0) return adoptCommittedRevision(incoming, current);
  if (order > 0) return adoptCommittedRevision(current, incoming);
  if (current.syncPending && incoming.syncPending) {
    if (incoming.preference.updatedAt !== current.preference.updatedAt) {
      return incoming.preference.updatedAt > current.preference.updatedAt ? incoming : current;
    }
    return incoming.preference.style > current.preference.style ? incoming : current;
  }
  if (incoming.syncPending && !current.syncPending) return incoming;
  if (current.syncPending && !incoming.syncPending && incoming.preference.style !== current.preference.style) {
    return {
      ...current,
      preference: { ...current.preference, revision: Math.max(current.preference.revision, incoming.preference.revision) },
      syncPending: true,
    };
  }
  if (incoming.preference.updatedAt > current.preference.updatedAt) return incoming;
  if (current.syncPending && incoming.preference.updatedAt < current.preference.updatedAt) {
    return {
      ...current,
      preference: { ...current.preference, revision: Math.max(current.preference.revision, incoming.preference.revision) },
      syncPending: true,
    };
  }
  if (incoming.preference.revision > current.preference.revision) return incoming;
  return current;
}

export function shouldReconcileVisualStylePreference(syncPending: boolean): boolean {
  return !syncPending;
}

export function readVisualStyle(storage: Pick<StorageLike, "getItem"> | undefined = browserStorage()): VisualStyle {
  try {
    return sanitizeVisualStyle(storage?.getItem(VISUAL_STYLE_STORAGE_KEY));
  } catch {
    return "yui";
  }
}

export function readVisualStylePreference(storage: Pick<StorageLike, "getItem"> | undefined = browserStorage()): VisualStylePreference | null {
  return readStoredVisualStylePreference(storage)?.preference ?? null;
}

function readStoredVisualStylePreference(storage: Pick<StorageLike, "getItem"> | undefined = browserStorage()): VisualStylePreferenceState | null {
  try {
    const candidates = [VISUAL_STYLE_PREFERENCE_STORAGE_KEY, VISUAL_STYLE_PREFERENCE_BACKUP_STORAGE_KEY]
      .map((key) => {
        try { return parseStoredPreferenceRecord(storage?.getItem(key), storage); } catch { return null; }
      })
      .filter((value): value is VisualStylePreferenceState => value !== null);
    return candidates.reduce<VisualStylePreferenceState | null>((best, candidate) => {
      if (!best) return candidate;
      const order = compareVisualStyleIntentOrder(best, candidate);
      if (order < 0) return candidate;
      if (order > 0) return best;
      if (candidate.preference.updatedAt !== best.preference.updatedAt) {
        return candidate.preference.updatedAt > best.preference.updatedAt ? candidate : best;
      }
      return candidate.preference.style > best.preference.style ? candidate : best;
    }, null);
  } catch {
    return null;
  }
}

export function readInitialVisualStylePreferenceState(
  storage: Pick<StorageLike, "getItem"> | undefined = browserStorage(),
  now: () => string = () => new Date().toISOString(),
): VisualStylePreferenceState {
  let rawStyle: unknown;
  try { rawStyle = storage?.getItem(VISUAL_STYLE_STORAGE_KEY); } catch { rawStyle = undefined; }
  const visibleStyle = sanitizeVisualStyle(rawStyle);
  const stored = readStoredVisualStylePreference(storage);
  if (!stored) {
    return {
      preference: { style: visibleStyle, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z" },
      syncPending: readVisualStylePreferenceSyncPending(storage),
      intentSequence: 0,
      intentOrigin: "",
    };
  }
  if ((rawStyle === "yui" || rawStyle === "minimal") && visibleStyle !== stored.preference.style) {
    if (stored.syncPending || (stored.intentSequence ?? 0) > 0 || (stored.intentOrigin ?? "") !== "") return stored;
    return {
      preference: { style: visibleStyle, revision: stored.preference.revision, updatedAt: now() },
      syncPending: true,
    };
  }
  return stored;
}

export function applyVisualStyle(style: VisualStyle, root: HTMLElement = document.documentElement): void {
  root.dataset.yuiStyle = sanitizeVisualStyle(style);
}

export function persistVisualStyle(style: VisualStyle, storage: Pick<StorageLike, "setItem"> | undefined = browserStorage()): VisualStyle {
  const safeStyle = sanitizeVisualStyle(style);
  try {
    storage?.setItem(VISUAL_STYLE_STORAGE_KEY, safeStyle);
  } catch {
    // Presentation keeps the current safe style when device storage is unavailable.
  }
  return safeStyle;
}

export function persistVisualStylePreference(
  preference: VisualStylePreference,
  storage: StorageLike | undefined = browserStorage(),
  syncPending = false,
  intentOrder?: Readonly<{ sequence: number; origin: string }>,
): VisualStylePreference {
  const safe = { ...preference, style: sanitizeVisualStyle(preference.style) };
  const prior = readStoredVisualStylePreference(storage);
  const order = intentOrder ?? { sequence: (prior?.intentSequence ?? 0) + 1, origin: "local" };
  const record = JSON.stringify({ ...safe, syncPending, intentSequence: order.sequence, intentOrigin: order.origin });
  try { storage?.setItem(VISUAL_STYLE_PREFERENCE_STORAGE_KEY, record); } catch { /* backup remains recoverable */ }
  try { storage?.setItem(VISUAL_STYLE_PREFERENCE_BACKUP_STORAGE_KEY, record); } catch { /* primary remains recoverable */ }
  try { storage?.setItem(VISUAL_STYLE_STORAGE_KEY, safe.style); } catch { /* authoritative record remains recoverable */ }
  try { storage?.setItem(VISUAL_STYLE_SYNC_PENDING_STORAGE_KEY, syncPending ? "pending" : "settled"); } catch { /* the preference record carries the same state */ }
  return safe;
}

export function readVisualStylePreferenceSyncPending(
  storage: Pick<StorageLike, "getItem"> | undefined = browserStorage(),
): boolean {
  try {
    const stored = readStoredVisualStylePreference(storage);
    if (stored) return stored.syncPending;
    return storage?.getItem(VISUAL_STYLE_SYNC_PENDING_STORAGE_KEY) === "pending";
  } catch {
    return false;
  }
}

export function persistVisualStylePreferenceSyncPending(
  pending: boolean,
  storage: StorageLike | undefined = browserStorage(),
): void {
  try {
    const state = readStoredVisualStylePreference(storage);
    if (state) persistVisualStylePreference(state.preference, storage, pending, {
      sequence: state.intentSequence ?? 0,
      origin: state.intentOrigin ?? "",
    });
    else storage?.setItem(VISUAL_STYLE_SYNC_PENDING_STORAGE_KEY, pending ? "pending" : "settled");
  } catch {
    // A storage failure cannot change the current presentation.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseStoredPreferenceRecord(
  raw: string | null | undefined,
  storage: Pick<StorageLike, "getItem"> | undefined,
): VisualStylePreferenceState | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as unknown;
  const legacy = parseVisualStylePreference(value);
  if (legacy) return {
    preference: legacy,
    syncPending: storage?.getItem(VISUAL_STYLE_SYNC_PENDING_STORAGE_KEY) === "pending",
    intentSequence: 0,
    intentOrigin: "",
  };
  return parseVisualStylePreferenceState(value);
}

export function parseVisualStylePreferenceState(value: unknown): VisualStylePreferenceState | null {
  if (!isRecord(value)) return null;
  const oldRecord = hasExactlyKeys(value, ["style", "revision", "updatedAt", "syncPending"]);
  const orderedRecord = hasExactlyKeys(value, ["style", "revision", "updatedAt", "syncPending", "intentSequence", "intentOrigin"]);
  if ((!oldRecord && !orderedRecord) || typeof value.syncPending !== "boolean") return null;
  const preference = parseVisualStylePreference({ style: value.style, revision: value.revision, updatedAt: value.updatedAt });
  if (!preference) return null;
  if (!orderedRecord) return { preference, syncPending: value.syncPending, intentSequence: 0, intentOrigin: "" };
  if (typeof value.intentSequence !== "number" || !Number.isSafeInteger(value.intentSequence) || value.intentSequence < 0
    || typeof value.intentOrigin !== "string" || value.intentOrigin.length > 128) return null;
  return { preference, syncPending: value.syncPending, intentSequence: value.intentSequence, intentOrigin: value.intentOrigin };
}

export function compareVisualStyleIntentOrder(left: VisualStylePreferenceState, right: VisualStylePreferenceState): number {
  const leftSequence = left.intentSequence ?? 0;
  const rightSequence = right.intentSequence ?? 0;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return (left.intentOrigin ?? "").localeCompare(right.intentOrigin ?? "");
}

function adoptCommittedRevision(
  winner: VisualStylePreferenceState,
  other: VisualStylePreferenceState,
): VisualStylePreferenceState {
  if (!winner.syncPending || other.syncPending || other.preference.revision <= winner.preference.revision) return winner;
  return { ...winner, preference: { ...winner.preference, revision: other.preference.revision } };
}
