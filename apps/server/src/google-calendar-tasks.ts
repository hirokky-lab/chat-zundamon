import type { RequestUser } from "./request-user.js";
import type { ExternalToolBoundary, ExternalToolContext } from "./external-tools.js";
import {
  GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
  GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
  GOOGLE_CALENDAR_TASKS_QUOTA,
} from "./google-calendar-tasks-runtime.js";
import { googleCalendarTasksDiagnostic, type GoogleCalendarTasksDiagnosticReason } from "./google-calendar-tasks-diagnostics.js";

export { GOOGLE_CALENDAR_TASKS_MAXIMUM_USD, GOOGLE_CALENDAR_TASKS_QUOTA };

export const GOOGLE_OPENID_SCOPE = "openid";
export const GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const GOOGLE_CALENDAR_LIST_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const GOOGLE_TASKS_READONLY_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";

export type GoogleService = "calendar" | "tasks";

export type GoogleCalendarTasksReadRequest = "availability" | "event_type" | "task_summary";

export type GoogleCalendarTasksReadGateway = {
  read(
    input: { owner: RequestUser; service: GoogleService; request: GoogleCalendarTasksReadRequest },
    signal: AbortSignal,
  ): Promise<CalendarTasksUntrustedContext>;
};

export type CalendarTasksReadResult = Readonly<{
  status: "completed" | "failed";
  service: GoogleService;
  checkedAt: string;
}>;

export type GoogleCalendarTasksReadOutcome =
  | { status: "disabled" }
  | (CalendarTasksReadResult & { status: "completed"; context: CalendarTasksUntrustedContext })
  | (CalendarTasksReadResult & { status: "failed" });

export type GoogleCalendarTasksQuotaLease = {
  commit(): Promise<void>;
  release(): Promise<void>;
};

export type GoogleCalendarTasksQuotaRepository = {
  acquire(owner: RequestUser, service: GoogleService, now: Date, requestId: string): Promise<GoogleCalendarTasksQuotaLease | null>;
};

export type GoogleCalendarTasksReadService = {
  read(input: {
    owner: RequestUser;
    service: GoogleService;
    request: GoogleCalendarTasksReadRequest;
    requestId: string;
    context: ExternalToolContext;
    signal?: AbortSignal;
    diagnostic?: (reason: GoogleCalendarTasksDiagnosticReason) => void;
  }): Promise<GoogleCalendarTasksReadOutcome>;
};

export type CalendarTasksUntrustedContext = Readonly<{
  kind: "google_calendar_tasks_untrusted_context";
  version: "yui-calendar-tasks-context-v1";
  utf8ByteLength: number;
  text: string;
}>;

export type GoogleConnectionStatus = Readonly<{
  service: GoogleService;
  state: "disabled" | "disconnected" | "connected";
  homeVisible: boolean;
}>;

export type GoogleCalendarTasksConnectionRepository = {
  status(owner: RequestUser, service: GoogleService): Promise<GoogleConnectionStatus>;
  save(owner: RequestUser, input: { service: GoogleService; googleSubject: string }): Promise<void>;
  clear(owner: RequestUser, service: GoogleService): Promise<void>;
  setHomeVisible(owner: RequestUser, service: GoogleService, visible: boolean): Promise<void>;
};

type RpcResult = { data: unknown; error: unknown };
export type GoogleCalendarTasksRpcFactory = (owner: RequestUser) => {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
};

export type GoogleCalendarTasksRepositoryUnavailableReason = "schema" | "authorization" | "transport" | "unavailable";

/** A fixed, content-free category for hosted connection-control failures. */
export class GoogleCalendarTasksRepositoryError extends Error {
  constructor(readonly reason: GoogleCalendarTasksRepositoryUnavailableReason) {
    super("Google connection repository unavailable");
  }
}

export function requiredGoogleScope(service: GoogleService): string {
  return service === "calendar" ? GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE : GOOGLE_TASKS_READONLY_SCOPE;
}

export function createCalendarTasksUntrustedContext(text: string): CalendarTasksUntrustedContext {
  return {
    kind: "google_calendar_tasks_untrusted_context",
    version: "yui-calendar-tasks-context-v1",
    utf8ByteLength: Buffer.byteLength(text, "utf8"),
    text,
  };
}

export function canonicalCalendarTasksContextJson(value: CalendarTasksUntrustedContext): string {
  return JSON.stringify({
    kind: value.kind,
    version: value.version,
    utf8ByteLength: value.utf8ByteLength,
    text: value.text,
  });
}

export function parseCalendarTasksUntrustedContext(value: string): CalendarTasksUntrustedContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid Calendar/Tasks context");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Calendar/Tasks context");
  const source = parsed as Record<string, unknown>;
  if (
    Object.keys(source).join(",") !== "kind,version,utf8ByteLength,text"
    || source.kind !== "google_calendar_tasks_untrusted_context"
    || source.version !== "yui-calendar-tasks-context-v1"
    || typeof source.utf8ByteLength !== "number"
    || !Number.isSafeInteger(source.utf8ByteLength)
    || source.utf8ByteLength < 0
    || typeof source.text !== "string"
    || Buffer.byteLength(source.text, "utf8") !== source.utf8ByteLength
  ) throw new Error("Invalid Calendar/Tasks context");
  const context: CalendarTasksUntrustedContext = {
    kind: source.kind,
    version: source.version,
    utf8ByteLength: source.utf8ByteLength,
    text: source.text,
  };
  if (canonicalCalendarTasksContextJson(context) !== value) throw new Error("Invalid Calendar/Tasks context");
  return context;
}

export function makeInMemoryGoogleCalendarTasksQuotaRepository(): GoogleCalendarTasksQuotaRepository {
  type Entry = { id: number; requestId: string; acquiredAt: number; utcDay: string; state: "pending" | "committed" };
  const entries = new Map<string, Entry[]>();
  let nextId = 0;
  return {
    async acquire(owner, service, now, requestId) {
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs) || !validQuotaRequestId(requestId)) return null;
      const key = `${owner.userId}:${service}`;
      const utcDay = now.toISOString().slice(0, 10);
      const active = (entries.get(key) ?? []).filter((entry) => entry.state === "committed"
        ? entry.utcDay === utcDay
        : entry.acquiredAt > nowMs - 60_000);
      entries.set(key, active);
      if (active.some((entry) => entry.requestId === requestId)) return null;
      if (
        active.filter((entry) => entry.acquiredAt > nowMs - 60_000).length >= GOOGLE_CALENDAR_TASKS_QUOTA.rollingMinute
        || active.filter((entry) => entry.utcDay === utcDay).length >= GOOGLE_CALENDAR_TASKS_QUOTA.utcDay
      ) return null;
      const entry: Entry = { id: nextId += 1, requestId, acquiredAt: nowMs, utcDay, state: "pending" };
      active.push(entry);
      let settled = false;
      return {
        async commit() {
          if (settled) return;
          settled = true;
          entry.state = "committed";
        },
        async release() {
          if (settled) return;
          settled = true;
          const current = entries.get(key) ?? [];
          entries.set(key, current.filter((candidate) => candidate.id !== entry.id));
        },
      };
    },
  };
}

export function createSupabaseGoogleCalendarTasksQuotaRepository(
  factory: GoogleCalendarTasksRpcFactory,
): GoogleCalendarTasksQuotaRepository {
  return {
    async acquire(owner, service, now, requestId) {
      if (!Number.isFinite(now.getTime()) || !validQuotaRequestId(requestId)) return null;
      let result: RpcResult;
      try {
        result = await factory(owner).rpc("acquire_google_calendar_tasks_quota", {
          p_service: service,
          p_request_id: requestId,
        });
      } catch {
        throw new Error("Google Calendar/Tasks quota unavailable");
      }
      if (result.error) throw new Error("Google Calendar/Tasks quota unavailable");
      if (result.data !== true) return null;
      let settled = false;
      const settle = async (operation: "commit_google_calendar_tasks_quota" | "release_google_calendar_tasks_quota"): Promise<void> => {
        if (settled) return;
        const completed = await factory(owner).rpc(operation, { p_service: service, p_request_id: requestId });
        if (completed.error || completed.data !== true) throw new Error("Google Calendar/Tasks quota unavailable");
        settled = true;
      };
      return {
        commit: () => settle("commit_google_calendar_tasks_quota"),
        release: () => settle("release_google_calendar_tasks_quota"),
      };
    },
  };
}

function validQuotaRequestId(value: string): boolean {
  return /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

export function createGoogleCalendarTasksReadService(options: {
  boundary: ExternalToolBoundary;
  connections: Pick<GoogleCalendarTasksConnectionRepository, "status">;
  quota: GoogleCalendarTasksQuotaRepository;
  gateway: GoogleCalendarTasksReadGateway;
  now?: () => Date;
}): GoogleCalendarTasksReadService {
  const now = options.now ?? (() => new Date());
  return {
    async read(input) {
      const feature = input.service === "calendar" ? "calendar_read" : "tasks_read";
      if (!options.boundary.flags()[feature]) return { status: "disabled" };
      const validRequest = input.service === "calendar"
        ? input.request === "availability" || input.request === "event_type"
        : input.request === "task_summary";
      if (!validRequest) return { status: "failed", service: input.service, checkedAt: now().toISOString() };
      let diagnosticReason: GoogleCalendarTasksDiagnosticReason = "unknown";
      const boundaryResult = await options.boundary.run({
        user: input.owner,
        requestId: input.requestId,
        attempt: 1,
        feature,
        operation: "read",
        costArea: "calendar",
        maximumUsd: GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
        context: input.context,
        input: { service: input.service, request: input.request },
        timeoutMs: GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
        signal: input.signal,
        execute: async ({ signal }) => {
          const connection = await options.connections.status(input.owner, input.service);
          if (connection.state !== "connected" || connection.service !== input.service) throw new Error("Calendar/Tasks connection unavailable");
          if (signal.aborted) throw new Error("Calendar/Tasks read aborted");
          const lease = await options.quota.acquire(input.owner, input.service, now(), input.requestId);
          if (!lease) throw new Error("Calendar/Tasks quota unavailable");
          await lease.commit();
          let received: CalendarTasksUntrustedContext;
          try {
            received = await options.gateway.read({ owner: input.owner, service: input.service, request: input.request }, signal);
          } catch (error) {
            diagnosticReason = googleCalendarTasksDiagnostic(error).reason;
            throw error;
          }
          const parsed = parseCalendarTasksUntrustedContext(JSON.stringify(received));
          if (signal.aborted) throw new Error("Calendar/Tasks read aborted");
          return { value: parsed, actualUsd: 0, quotaUnits: 1 };
        },
      });
      if (boundaryResult.status === "disabled") return { status: "disabled" };
      const checkedAt = now().toISOString();
      if (boundaryResult.status === "success") {
        return { status: "completed", service: input.service, checkedAt, context: boundaryResult.value };
      }
      input.diagnostic?.(diagnosticReason);
      return { status: "failed", service: input.service, checkedAt };
    },
  };
}

export function assertGoogleConnectionOwner(input: {
  ownerId: string;
  expectedGoogleSubject: string;
  returnedGoogleSubject: string;
  grantedScopes: readonly string[];
  service: GoogleService;
}): void {
  if (input.ownerId.trim().length === 0) throw new Error("Google connection owner missing");
  if (!validGoogleSubject(input.expectedGoogleSubject) || input.expectedGoogleSubject !== input.returnedGoogleSubject) {
    throw new Error("Google subject mismatch");
  }

  const required = requiredGoogleScope(input.service);
  const scopes = new Set(input.grantedScopes);
  if (!scopes.has(GOOGLE_OPENID_SCOPE)) throw new Error("Required Google openid scope missing");
  if (!scopes.has(required)) throw new Error("Required Google scope missing");
  const allowed = new Set([GOOGLE_OPENID_SCOPE, required, ...(input.service === "calendar" ? [GOOGLE_CALENDAR_LIST_READONLY_SCOPE] : [])]);
  if (scopes.size !== input.grantedScopes.length || input.grantedScopes.some((scope) => !allowed.has(scope))) {
    throw new Error("Unexpected Google service scope");
  }
}

export function makeInMemoryGoogleCalendarTasksConnectionRepository(): GoogleCalendarTasksConnectionRepository {
  const controls = new Map<string, { googleSubject: string; homeVisible: boolean }>();
  const key = (owner: RequestUser, service: GoogleService): string => `${assertOwner(owner)}:${service}`;

  return {
    async status(owner, service) {
      const control = controls.get(key(owner, service));
      return control
        ? { service, state: "connected", homeVisible: control.homeVisible }
        : { service, state: "disconnected", homeVisible: false };
    },
    async save(owner, input) {
      if (!validGoogleSubject(input.googleSubject)) throw new Error("Invalid Google subject");
      controls.set(key(owner, input.service), { googleSubject: input.googleSubject, homeVisible: false });
    },
    async clear(owner, service) {
      controls.delete(key(owner, service));
    },
    async setHomeVisible(owner, service, visible) {
      const serviceKey = key(owner, service);
      const control = controls.get(serviceKey);
      if (!control) throw new Error("Google connection not found");
      controls.set(serviceKey, { ...control, homeVisible: visible });
    },
  };
}

export function createSupabaseGoogleCalendarTasksConnectionRepository(
  factory: GoogleCalendarTasksRpcFactory,
): GoogleCalendarTasksConnectionRepository {
  const callStatus = async (owner: RequestUser, name: string, args: Record<string, unknown>, expectedService: GoogleService): Promise<GoogleConnectionStatus> => {
    let result: RpcResult;
    try { result = await factory(owner).rpc(name, args); } catch { throw new GoogleCalendarTasksRepositoryError("transport"); }
    if (result.error) throw repositoryError(result.error);
    let status: GoogleConnectionStatus;
    try { status = parseGoogleConnectionStatus(result.data); } catch { throw new GoogleCalendarTasksRepositoryError("unavailable"); }
    if (status.service !== expectedService) throw new GoogleCalendarTasksRepositoryError("unavailable");
    return status;
  };
  return {
    status: (owner, service) => callStatus(owner, "get_google_calendar_tasks_status", { p_service: service }, service),
    async save(owner, input) {
      await callStatus(owner, "save_google_calendar_tasks_control", {
        p_service: input.service,
        p_google_subject: input.googleSubject,
      }, input.service);
    },
    async clear(owner, service) {
      const result = await factory(owner).rpc("clear_google_calendar_tasks_service", { p_service: service });
      if (result.error) throw repositoryError(result.error);
    },
    async setHomeVisible(owner, service, visible) {
      await callStatus(owner, "set_google_calendar_tasks_home_visible", { p_service: service, p_visible: visible }, service);
    },
  };
}

function repositoryError(value: unknown): GoogleCalendarTasksRepositoryError {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const code = source?.code;
  const message = typeof source?.message === "string" ? source.message : "";
  if (code === "PGRST202" || code === "PGRST204" || code === "42883" || code === "42P01" || code === "42703") {
    return new GoogleCalendarTasksRepositoryError("schema");
  }
  if (code === "42501" || code === "PGRST301") return new GoogleCalendarTasksRepositoryError("authorization");
  if (/schema cache|could not find (the )?function|function .* does not exist/i.test(message)) {
    return new GoogleCalendarTasksRepositoryError("schema");
  }
  if (/permission denied|not authorized/i.test(message)) return new GoogleCalendarTasksRepositoryError("authorization");
  return new GoogleCalendarTasksRepositoryError("unavailable");
}

function assertOwner(owner: RequestUser): string {
  if (owner.userId.trim().length === 0) throw new Error("Google connection owner missing");
  return owner.userId;
}

function validGoogleSubject(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseGoogleConnectionStatus(value: unknown): GoogleConnectionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google connection repository unavailable");
  const source = value as Record<string, unknown>;
  if (
    (source.service !== "calendar" && source.service !== "tasks")
    || (source.state !== "disabled" && source.state !== "disconnected" && source.state !== "connected")
    || typeof source.homeVisible !== "boolean"
    || Object.keys(source).length !== 3
  ) throw new Error("Google connection repository unavailable");
  return { service: source.service, state: source.state, homeVisible: source.homeVisible };
}

export function googleReadScopes(service: GoogleService): readonly string[] {
  return [GOOGLE_OPENID_SCOPE, requiredGoogleScope(service), ...(service === "calendar" ? [GOOGLE_CALENDAR_LIST_READONLY_SCOPE] : [])];
}
export function acceptedGoogleReadScopes(scopes: readonly string[], service: GoogleService): boolean {
  const allowed = new Set(googleReadScopes(service));
  return scopes.length === new Set(scopes).size && scopes.includes(GOOGLE_OPENID_SCOPE)
    && scopes.includes(requiredGoogleScope(service)) && scopes.every(scope => allowed.has(scope));
}
