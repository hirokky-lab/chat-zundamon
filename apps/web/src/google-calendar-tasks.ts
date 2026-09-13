import { createGoogleSourceChoiceStore, type GoogleSourceChoiceStore } from "./google-source-choice";
export type GoogleService = "calendar" | "tasks";
export type GoogleReadRequest = "availability" | "event_type" | "task_summary";

export type GoogleConnectionStatus = Readonly<{
  service: GoogleService;
  state: "disabled" | "disconnected" | "connected";
  homeVisible: boolean;
}>;

export type GoogleServiceSettings = Readonly<{
  calendar: GoogleConnectionStatus;
  tasks: GoogleConnectionStatus;
}>;

export type GoogleCalendarTasksApi = {
  getSettings(): Promise<GoogleServiceSettings>;
  beginConnection(service: GoogleService, purpose?: "read" | "write"): Promise<string>;
  setHomeVisible(service: GoogleService, visible: boolean): Promise<GoogleConnectionStatus>;
  stopService(service: GoogleService): Promise<void>;
  checkCount(service: GoogleService, request: GoogleReadRequest, requestId: string): Promise<void>;
  preview(service: GoogleService, signal?: AbortSignal, sourceId?: string): Promise<GooglePreviewResult>;
  sources?(service: GoogleService, signal?: AbortSignal): Promise<GoogleSourceListResult>;
  sourceChoices?: GoogleSourceChoiceStore;
};

export type GoogleCalendarTasksFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const GOOGLE_ACCOUNT_REMOVAL_URL = "https://myaccount.google.com/permissions";

export const DISABLED_GOOGLE_SERVICE_SETTINGS: GoogleServiceSettings = Object.freeze({
  calendar: Object.freeze({ service: "calendar", state: "disabled", homeVisible: false }),
  tasks: Object.freeze({ service: "tasks", state: "disabled", homeVisible: false }),
});

export function afterGoogleReconnect(status: GoogleConnectionStatus): GoogleConnectionStatus {
  return { ...status, state: "connected", homeVisible: false };
}

function normalizeStatus(status: GoogleConnectionStatus, service: GoogleService): GoogleConnectionStatus {
  if (status.service !== service || !["disabled", "disconnected", "connected"].includes(status.state)) {
    throw new Error("Invalid Google service status");
  }
  return {
    service,
    state: status.state,
    homeVisible: status.state === "connected" ? status.homeVisible === true : false,
  };
}

export function createLocalGoogleCalendarTasksApi(initial: GoogleServiceSettings = DISABLED_GOOGLE_SERVICE_SETTINGS): GoogleCalendarTasksApi {
  let settings: GoogleServiceSettings = {
    calendar: normalizeStatus(initial.calendar, "calendar"),
    tasks: normalizeStatus(initial.tasks, "tasks"),
  };
  const copy = (): GoogleServiceSettings => ({
    calendar: { ...settings.calendar },
    tasks: { ...settings.tasks },
  });
  return {
    async getSettings() { return copy(); },
    async beginConnection() { throw new Error("Google service is not configured"); },
    async setHomeVisible(service, visible) {
      const current = settings[service];
      if (current.state !== "connected") throw new Error("Google service is not connected");
      const updated = { ...current, homeVisible: visible };
      settings = { ...settings, [service]: updated };
      return { ...updated };
    },
    async stopService(service) {
      settings = {
        ...settings,
        [service]: { service, state: "disconnected", homeVisible: false },
      };
    },
    async checkCount() { throw new Error("Google service is not configured"); },
    async preview() { throw new Error("Google service is not configured"); },
  };
}

/** A same-origin, authenticated status reader. Any malformed or failed reply is disabled locally. */
export function createBrowserGoogleCalendarTasksApi(fetchImpl: GoogleCalendarTasksFetch, ownerId?: string): GoogleCalendarTasksApi {
  const sourceChoices = createGoogleSourceChoiceStore(ownerId);
  return {
    sourceChoices,
    async sources(service, signal) {
      try {
        const response = await fetchImpl(`/api/google-calendar-tasks/${service}/sources`, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: "{}", signal });
        if (!response.ok) throw new Error("unavailable");
        return parseGoogleSourceListResult(await response.json(), service);
      } catch { throw new Error("Google source list is unavailable"); }
    },
    async getSettings() {
      try {
        const readStatus = () => fetchImpl("/api/google-calendar-tasks/status", {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        let response = await readStatus();
        // A transient status outage must not strand a connected service until reload.
        // This bounded retry reads connection metadata only, never provider content.
        if (response.status === 503) response = await readStatus();
        if (!response.ok) return DISABLED_GOOGLE_SERVICE_SETTINGS;
        const settings = parseGoogleServiceSettings(await response.json());
        for (const service of ["calendar", "tasks"] as const) {
          if (settings[service].state === "disconnected") sourceChoices.set(service, null);
        }
        return settings;
      } catch {
        return DISABLED_GOOGLE_SERVICE_SETTINGS;
      }
    },
    async beginConnection(service, purpose) {
      try {
        const response = await fetchImpl(`/api/google-calendar-tasks/${service}/connect`, {
          method: "POST", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json", ...(purpose?{"Content-Type":"application/json"}:{}) }, ...(purpose?{body:JSON.stringify({purpose})}:{}),
        });
        if (!response.ok) throw new Error("unavailable");
        const value = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value as object).join(",") !== "authorizationUrl") throw new Error("unavailable");
        const url = new URL((value as { authorizationUrl?: unknown }).authorizationUrl as string);
        if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") throw new Error("unavailable");
        return url.toString();
      } catch { throw new Error("Google service changes are unavailable"); }
    },
    async setHomeVisible(service, visible) {
      try {
        const response = await fetchImpl(`/api/google-calendar-tasks/${service}/home`, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ visible }),
        });
        if (!response.ok) throw new Error("unavailable");
        const value = await response.json();
        if (!isExactStatus(value, service)) throw new Error("unavailable");
        if (!visible) sourceChoices.set(service, null);
        return normalizeStatus(value, service);
      } catch {
        throw new Error("Google service changes are unavailable");
      }
    },
    async stopService(service) {
      try {
        const response = await fetchImpl(`/api/google-calendar-tasks/${service}`, {
          method: "DELETE",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (response.status !== 204) throw new Error("unavailable");
        sourceChoices.set(service, null);
      } catch {
        throw new Error("Google service changes are unavailable");
      }
    },
    async checkCount(service, request, requestId) {
      try {
        const response = await fetchImpl(`/api/google-calendar-tasks/${service}/read`, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ request, requestId }),
        });
        if (!response.ok) throw new Error("unavailable");
        const value = await response.json();
        if (!isExactReadResult(value, service)) throw new Error("unavailable");
      } catch {
        throw new Error("Google service read is unavailable");
      }
    },
    async preview(service, signal, sourceId) {
      try {
        const response = await fetchImpl(`/api/google-calendar-tasks/${service}/preview`, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(sourceId ? { sourceId } : {}),
          signal,
        });
        if (!response.ok) throw new Error("unavailable");
        return parseGooglePreviewResult(await response.json(), service);
      } catch {
        throw new Error("Google service preview is unavailable");
      }
    },
  };
}

function isExactReadResult(value: unknown, service: GoogleService): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return Object.keys(source).sort().join(",") === "checkedAt,service,status"
    && source.service === service
    && source.status === "completed"
    && typeof source.checkedAt === "string";
}

function parseGoogleServiceSettings(value: unknown): GoogleServiceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DISABLED_GOOGLE_SERVICE_SETTINGS;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "calendar,tasks") return DISABLED_GOOGLE_SERVICE_SETTINGS;
  try {
    if (!isExactStatus(source.calendar, "calendar") || !isExactStatus(source.tasks, "tasks")) throw new Error("invalid");
    return { calendar: normalizeStatus(source.calendar, "calendar"), tasks: normalizeStatus(source.tasks, "tasks") };
  } catch {
    return DISABLED_GOOGLE_SERVICE_SETTINGS;
  }
}

function isExactStatus(value: unknown, service: GoogleService): value is GoogleConnectionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return Object.keys(source).sort().join(",") === "homeVisible,service,state"
    && source.service === service
    && typeof source.homeVisible === "boolean"
    && (source.state === "disabled" || source.state === "disconnected" || source.state === "connected");
}
import { parseGooglePreviewResult, parseGoogleSourceListResult, type GoogleSourceListResult, type GooglePreviewResult } from "@yui/domain";
