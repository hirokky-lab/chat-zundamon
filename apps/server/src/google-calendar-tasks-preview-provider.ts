import { aggregateCalendarPreview } from './google-calendar-aggregate.js';
import {
  parseGooglePreviewResult,
  parseGoogleSourceListResult, isValidGoogleSourceId, type GoogleSourceListResult,
  type CalendarPreviewItem,
  type GoogleCalendarPreviewResult,
  type GooglePreviewResult,
  type GooglePreviewService,
  type GoogleTasksPreviewResult,
} from "@yui/domain";
import type {
  GoogleCalendarTasksAccessTokenProvider,
  GoogleCalendarTasksGetTransport,
} from "./google-calendar-tasks-provider.js";
import { GoogleCalendarTasksDiagnosticError, googleCalendarTasksDiagnostic } from "./google-calendar-tasks-diagnostics.js";
import type { RequestUser } from "./request-user.js";

const CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS_DEFAULT_LIST_ENDPOINT = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
const MAX_RESPONSE_BYTES = 64 * 1024;
const UNTITLED = "（タイトルなし）";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const DUE_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export type GoogleCalendarTasksPreviewGateway = {
  sources(input: { owner: RequestUser; service: GooglePreviewService }, signal: AbortSignal): Promise<GoogleSourceListResult>;
  preview(
    input: { owner: RequestUser; service: GooglePreviewService; sourceId?: string },
    signal: AbortSignal,
  ): Promise<GooglePreviewResult>;
};

export function createGoogleCalendarTasksPreviewGateway(options: {
  tokens: GoogleCalendarTasksAccessTokenProvider;
  transport: GoogleCalendarTasksGetTransport;
  now?: () => Date;
}): GoogleCalendarTasksPreviewGateway {
  const now = options.now ?? (() => new Date());
  async function read(input: { owner: RequestUser; service: GooglePreviewService; sourceId?: string }, signal: AbortSignal, sources: boolean): Promise<GooglePreviewResult | GoogleSourceListResult> {
    if (input.sourceId !== undefined && !isValidGoogleSourceId(input.sourceId)) throw new GoogleCalendarTasksDiagnosticError("response_validation");
    const checkedAt = now();
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
        url: sources ? sourcesUrl(input.service) : previewUrl(input.service, checkedAt, input.sourceId),
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
    if (response.status < 200 || response.status >= 300) throw new GoogleCalendarTasksDiagnosticError("provider_transport");
    if (!Number.isSafeInteger(response.contentLength) || response.contentLength < -1 || response.contentLength > MAX_RESPONSE_BYTES) {
      throw new GoogleCalendarTasksDiagnosticError("response_validation");
    }

    try {
      const payload = await response.json(MAX_RESPONSE_BYTES);
      if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
      if (sources) return projectSources(payload, input.service, checkedAt.toISOString());
      const projected = input.service === "calendar"
        ? projectCalendar(payload, checkedAt.toISOString())
        : projectTasks(payload, checkedAt.toISOString());
      return parseGooglePreviewResult(projected, input.service);
    } catch {
      if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
      throw new GoogleCalendarTasksDiagnosticError("response_validation");
    }
  }
  return {
    preview: async (input, signal) => {
      if(input.service==='calendar' && input.sourceId===undefined){
        const sources=parseGoogleSourceListResult(await read(input,signal,true),'calendar');
        return aggregateCalendarPreview({sources,signal,read:async sourceId=>parseGooglePreviewResult(await read({...input,sourceId},signal,false),'calendar') as GoogleCalendarPreviewResult});
      }
      return parseGooglePreviewResult(await read(input,signal,false),input.service);
    },
    sources: async (input, signal) => parseGoogleSourceListResult(await read(input, signal, true), input.service),
  };
}

function previewUrl(service: GooglePreviewService, now: Date, sourceId?: string): string {
  if (service === "calendar") {
    const url = new URL(sourceId === undefined ? CALENDAR_EVENTS_ENDPOINT : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(sourceId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "3");
    url.searchParams.set("timeMin", now.toISOString());
    url.searchParams.set("fields", "items(status,summary,start(date,dateTime))");
    return url.toString();
  }
  const url = new URL(sourceId === undefined ? TASKS_DEFAULT_LIST_ENDPOINT : `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(sourceId)}/tasks`);
  url.searchParams.set("showCompleted", "false");
  url.searchParams.set("showDeleted", "false");
  url.searchParams.set("showHidden", "false");
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("fields", "items(status,title,due)");
  return url.toString();
}

function projectCalendar(value: unknown, checkedAt: string): GoogleCalendarPreviewResult {
  const source = parseItemsEnvelope(value, 3);
  const items: CalendarPreviewItem[] = [];
  for (const candidate of source) {
    if (!isExactSubset(candidate, ["start", "status", "summary"])) throw new Error("invalid");
    if (candidate.status === "cancelled") continue;
    const status = candidate.status ?? "confirmed";
    if (status !== "confirmed" && status !== "tentative") throw new Error("invalid");
    const title = normalizeTitle(candidate.summary);
    if (!isExactObject(candidate.start, ["dateTime"]) && !isExactObject(candidate.start, ["date"])) throw new Error("invalid");
    if ("dateTime" in candidate.start) {
      if (!validDateTime(candidate.start.dateTime)) throw new Error("invalid");
      items.push({ title, start: { kind: "date_time", value: candidate.start.dateTime } });
      continue;
    }
    if (!validDateOnly(candidate.start.date)) throw new Error("invalid");
    items.push({ title, start: { kind: "all_day", value: candidate.start.date } });
  }
  return { service: "calendar", checkedAt, items };
}

function projectTasks(value: unknown, checkedAt: string): GoogleTasksPreviewResult {
  const source = parseItemsEnvelope(value, 5);
  const items = source.map((candidate) => {
    if (!isExactSubset(candidate, ["due", "status", "title"]) || candidate.status !== "needsAction") throw new Error("invalid");
    const title = normalizeTitle(candidate.title);
    if (candidate.due !== undefined && !validDateTime(candidate.due)) throw new Error("invalid");
    return { title, due: candidate.due === undefined ? null : candidate.due.slice(0, 10) };
  });
  return { service: "tasks", checkedAt, items };
}

function parseItemsEnvelope(value: unknown, maximum: number): readonly Record<string, unknown>[] {
  if (!isExactObject(value, []) && !isExactObject(value, ["items"])) throw new Error("invalid");
  const items = "items" in value ? value.items : [];
  if (!Array.isArray(items) || items.length > maximum || items.some((item) => !isRecord(item))) throw new Error("invalid");
  return items as readonly Record<string, unknown>[];
}

function normalizeTitle(value: unknown): string {
  if (value === undefined) return UNTITLED;
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) throw new Error("invalid");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 120) throw new Error("invalid");
  return normalized;
}

function validDateTime(value: unknown): value is string {
  return typeof value === "string"
    && DUE_WITH_ZONE.test(value)
    && validDateOnly(value.slice(0, 10))
    && Number.isFinite(Date.parse(value));
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isExactSubset(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}


function sourcesUrl(service: GooglePreviewService): string {
  const url = new URL(service === "calendar" ? "https://www.googleapis.com/calendar/v3/users/me/calendarList" : "https://tasks.googleapis.com/tasks/v1/users/@me/lists");
  url.searchParams.set("maxResults", "100");
  url.searchParams.set("fields", service === "calendar" ? "nextPageToken,items(id,summary,accessRole)" : "nextPageToken,items(id,title)");
  if (service === "calendar") url.searchParams.set("minAccessRole", "reader");
  return url.toString();
}

function projectSources(value: unknown, service: GooglePreviewService, checkedAt: string): GoogleSourceListResult {
  const items = parseItemsEnvelope(value, 100).map(item => {
    if (!isExactSubset(item, service === "calendar" ? ["id", "summary", "accessRole"] : ["id", "title"])) throw new Error("invalid");
    if (service === "calendar" && item.accessRole !== undefined && !["reader", "writer", "owner"].includes(item.accessRole as string)) throw new Error("invalid");
    return { id: item.id, title: normalizeTitle(service === "calendar" ? item.summary : item.title) };
  });
  return parseGoogleSourceListResult({ service, checkedAt, items }, service);
}
