export type WriteKind = "user_mutation" | "memory_processing" | "backup_cron" | "photo_cleanup_cron" | "proactive_cron" | "background_job";

/** Auditable inventory of state-changing sinks; reads deliberately do not appear here. */
export const SEMANTIC_MUTATION_BOUNDARIES = {
  chat: "user_mutation", realtime: "user_mutation", transcription: "user_mutation",
  chatState: "user_mutation", profile: "user_mutation", memory: "memory_processing",
  memorySettings: "user_mutation", migrationImport: "user_mutation", usageReserveSettle: "background_job",
  oneTimeReminder: "user_mutation",
  backupCron: "backup_cron", photoCleanupCron: "photo_cleanup_cron", proactiveCron: "proactive_cron",
  startupCleanup: "background_job",
} as const satisfies Record<string, WriteKind>;

export type WriteGate = {
  enter(kind: WriteKind): { release(): void } | null;
  closeForRestore(): void;
  waitForDrain(): Promise<void>;
  openAfterVerifiedRestore(): void;
  isOpen(): boolean;
};

declare const restoreCapabilityBrand: unique symbol;
export type RestoreWriteCapability = { readonly [restoreCapabilityBrand]: true };
export type RestoreWriteSession = {
  runMutation<T>(operation: string, work: (capability: RestoreWriteCapability) => Promise<T>): Promise<T>;
};

type RestoreSessionState = { gate: WriteGate; active: boolean; capabilities: Set<object> };
type GateState = { readonly open: boolean; readonly active: number; activeRestore: RestoreSessionState | null };
type RestoreCapabilityState = { session: RestoreSessionState; operation: string };
const gateStates = new WeakMap<WriteGate, GateState>();
const restoreCapabilities = new WeakMap<object, RestoreCapabilityState>();

/** Serializes semantic mutations with restore.  The restore-only permit is kept private to this module. */
export function createWriteGate(): WriteGate {
  let open = true;
  let active = 0;
  const waiters = new Set<() => void>();
  const drain = () => {
    if (active !== 0) return;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const gate: WriteGate = {
    enter(_kind) {
      if (!open) return null;
      active += 1;
      let released = false;
      return { release() {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      } };
    },
    closeForRestore() { open = false; },
    waitForDrain() {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
    openAfterVerifiedRestore() { open = true; },
    isOpen() { return open; },
  };
  gateStates.set(gate, { get open() { return open; }, get active() { return active; }, activeRestore: null });
  return gate;
}

/**
 * The only restore capability boundary. The opaque capability never escapes this module: callers
 * supply a callback, and protected restore mutations are invoked from that closed callback only.
 */
export async function runClosedRestore<T>(gate: WriteGate, work: (session: RestoreWriteSession) => Promise<T>): Promise<T> {
  const state = gateStates.get(gate);
  if (!state || state.open || state.active !== 0 || state.activeRestore) throw new Error("restore_gate_not_drained");
  const restoreState: RestoreSessionState = { gate, active: true, capabilities: new Set() };
  state.activeRestore = restoreState;
  const session: RestoreWriteSession = {
    async runMutation(operation, mutation) {
      if (!restoreState.active || state.activeRestore !== restoreState || state.open || state.active !== 0) {
        throw new Error("invalid_restore_write_capability");
      }
      const capability = {} as RestoreWriteCapability;
      const capabilityObject = capability as object;
      restoreState.capabilities.add(capabilityObject);
      restoreCapabilities.set(capabilityObject, { session: restoreState, operation });
      try {
        const result = await mutation(capability);
        if (restoreCapabilities.has(capabilityObject)) throw new Error("restore_write_capability_not_consumed");
        return result;
      } finally {
        restoreCapabilities.delete(capabilityObject);
        restoreState.capabilities.delete(capabilityObject);
      }
    },
  };
  try {
    return await work(session);
  } finally {
    restoreState.active = false;
    for (const capability of restoreState.capabilities) restoreCapabilities.delete(capability);
    restoreState.capabilities.clear();
    if (state.activeRestore === restoreState) state.activeRestore = null;
  }
}

/** Runtime validation used by restore-only dependency facades at every mutation boundary. */
export async function runRestoreMutation<T>(
  gate: WriteGate,
  capability: RestoreWriteCapability,
  operation: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const capabilityObject = capability as unknown as object;
  const issued = capabilityObject && restoreCapabilities.get(capabilityObject);
  const state = gateStates.get(gate);
  if (!issued || !state || issued.session.gate !== gate || issued.session !== state.activeRestore
    || !issued.session.active || issued.operation !== operation || state.open || state.active !== 0) {
    throw new Error("invalid_restore_write_capability");
  }
  restoreCapabilities.delete(capabilityObject);
  issued.session.capabilities.delete(capabilityObject);
  return mutation();
}

/** Attach one idempotent semantic lease release to every HTTP completion path. */
export function releaseLeaseOnResponseEnd(
  response: { once(event: "finish" | "close" | "error", listener: () => void): unknown },
  lease: { release(): void },
): void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };
  response.once("finish", release);
  response.once("close", release);
  response.once("error", release);
}
