import type { ExternalToolFlags } from "./external-tools.js";
import type { GoogleCalendarTasksReadGateway } from "./google-calendar-tasks.js";

export const GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS = 15_000;
export const GOOGLE_CALENDAR_TASKS_MAXIMUM_USD = 0.01;
export const GOOGLE_CALENDAR_TASKS_QUOTA = Object.freeze({ rollingMinute: 8, utcDay: 50 });

export type GoogleCalendarTasksRuntime = Readonly<{
  calendarEnabled: boolean;
  tasksEnabled: boolean;
  calendarTimeoutMs: number;
  tasksTimeoutMs: number;
  maximumUsd: number;
  quota: Readonly<{ rollingMinute: number; utcDay: number }>;
  readGateway: GoogleCalendarTasksReadGateway | null;
}>;

export type GoogleCalendarTasksFactory = {
  parseSecret(): never;
  createConnectionRepository(): never;
  createReadGateway(): GoogleCalendarTasksReadGateway;
};

export function createGoogleCalendarTasksRuntime(options: {
  flags: ExternalToolFlags;
  calendarTimeoutMs?: number;
  tasksTimeoutMs?: number;
  factory?: GoogleCalendarTasksFactory;
}): GoogleCalendarTasksRuntime {
  const readGateway = options.flags.calendar_read || options.flags.tasks_read
    ? (options.factory ?? createFailClosedGoogleCalendarTasksFactory()).createReadGateway()
    : null;
  const runtime: GoogleCalendarTasksRuntime = Object.freeze({
    calendarEnabled: options.flags.calendar_read,
    tasksEnabled: options.flags.tasks_read,
    calendarTimeoutMs: options.calendarTimeoutMs ?? GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
    tasksTimeoutMs: options.tasksTimeoutMs ?? GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
    maximumUsd: GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
    quota: GOOGLE_CALENDAR_TASKS_QUOTA,
    readGateway,
  });

  return runtime;
}

function createFailClosedGoogleCalendarTasksFactory(): GoogleCalendarTasksFactory {
  const unavailable = (): never => { throw new Error("Google Calendar/Tasks is not configured"); };
  return {
    parseSecret: unavailable,
    createConnectionRepository: unavailable,
    createReadGateway: () => ({ read: async (): Promise<never> => unavailable() }),
  };
}
