import {
  createCalendarTasksUntrustedContext,
  type GoogleCalendarTasksReadGateway,
  type GoogleCalendarTasksReadRequest,
  type GoogleService,
} from "./google-calendar-tasks.js";
import type { RequestUser } from "./request-user.js";
import { GoogleCalendarTasksDiagnosticError, googleCalendarTasksDiagnostic } from "./google-calendar-tasks-diagnostics.js";

const CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS_DEFAULT_LIST_ENDPOINT = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
const MAX_RESULTS = 10;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type GoogleCalendarTasksAccessTokenProvider = {
  getAccessToken(input: { owner: RequestUser; service: GoogleService; signal: AbortSignal; expectedConnectionBinding?: string; requireWrite?: boolean }): Promise<string>;
};

export type GoogleCalendarTasksGetTransport = {
  get(input: {
    url: string;
    method: "GET";
    redirect: "error";
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<{ status: number; contentLength: number; json(maximumBytes: number): Promise<unknown> }>;
};

export function createGoogleCalendarTasksReadGateway(options: {
  tokens: GoogleCalendarTasksAccessTokenProvider;
  transport: GoogleCalendarTasksGetTransport;
  now?: () => Date;
}): GoogleCalendarTasksReadGateway {
  const now = options.now ?? (() => new Date());
  return {
    async read(input, signal) {
      const url = requestUrl(input.service, input.request, now());
      let accessToken: string;
      try {
        accessToken = await options.tokens.getAccessToken({ owner: input.owner, service: input.service, signal });
      } catch (error) {
        if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
        throw googleCalendarTasksDiagnostic(error);
      }
      if (signal.aborted || accessToken.length === 0) throw new GoogleCalendarTasksDiagnosticError("unknown");
      let response: Awaited<ReturnType<GoogleCalendarTasksGetTransport["get"]>>;
      try {
        response = await options.transport.get({
          url,
          method: "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          signal,
        });
      } catch {
        if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
        throw new GoogleCalendarTasksDiagnosticError("provider_transport");
      }
      if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
      if (response.status < 200 || response.status >= 300) {
        throw new GoogleCalendarTasksDiagnosticError("provider_transport");
      }
      if (!Number.isSafeInteger(response.contentLength) || response.contentLength < -1 || response.contentLength > MAX_RESPONSE_BYTES) {
        throw new GoogleCalendarTasksDiagnosticError("response_validation");
      }
      try {
        const payload = await response.json(MAX_RESPONSE_BYTES);
        const count = input.service === "calendar" ? parseCalendarCount(payload) : parseTasksCount(payload);
        return createCalendarTasksUntrustedContext(summaryFor(input.service, input.request, count));
      } catch {
        if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
        throw new GoogleCalendarTasksDiagnosticError("response_validation");
      }
    },
  };
}

function requestUrl(service: GoogleService, request: GoogleCalendarTasksReadRequest, now: Date): string {
  if (service === "calendar" && (request === "availability" || request === "event_type")) {
    const url = new URL(CALENDAR_EVENTS_ENDPOINT);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", String(MAX_RESULTS));
    url.searchParams.set("timeMin", now.toISOString());
    url.searchParams.set("fields", "items(status)");
    return url.toString();
  }
  if (service === "tasks" && request === "task_summary") {
    const url = new URL(TASKS_DEFAULT_LIST_ENDPOINT);
    url.searchParams.set("maxResults", String(MAX_RESULTS));
    url.searchParams.set("fields", "items(status)");
    return url.toString();
  }
  throw new Error("Google Calendar/Tasks response unavailable");
}

function parseCalendarCount(value: unknown): number {
  if (!isExactObject(value, []) && !isExactObject(value, ["items"])) throw new Error("invalid");
  const items = "items" in value ? value.items : [];
  if (!Array.isArray(items) || items.length > MAX_RESULTS) throw new Error("invalid");
  for (const item of items) {
    if ((!isExactObject(item, []) && !isExactObject(item, ["status"]))
      || (item.status !== undefined && item.status !== "confirmed" && item.status !== "tentative" && item.status !== "cancelled")) {
      throw new Error("invalid");
    }
  }
  return items.length;
}

function parseTasksCount(value: unknown): number {
  if (!isExactObject(value, []) && !isExactObject(value, ["items"])) throw new Error("invalid");
  const items = "items" in value ? value.items : [];
  if (!Array.isArray(items) || items.length > MAX_RESULTS) throw new Error("invalid");
  for (const item of items) {
    if (!isTaskItem(item)) {
      throw new Error("invalid");
    }
  }
  return items.length;
}

function isTaskItem(value: unknown): value is { status: "needsAction" | "completed" } {
  return isExactObject(value, ["status"]) && (value.status === "needsAction" || value.status === "completed");
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function summaryFor(service: GoogleService, request: GoogleCalendarTasksReadRequest, count: number): string {
  if (service === "calendar") {
    return request === "availability"
      ? `予定の空き状況を${count}件確認しました。`
      : `予定を${count}件確認しました。`;
  }
  return `タスクを${count}件確認しました。`;
}
