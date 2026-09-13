import { parseTimeZone } from "./session.js";

export type QuietHours = Readonly<{
  start: string;
  end: string;
}>;

export type QuietHoursChoice = "requested_time" | "quiet_hours_end";

export type OneTimeReminderInput = Readonly<{
  safeSummary: string;
  requestedAt: string;
  timeZone: string;
  now: string;
  quietHours?: QuietHours;
  quietHoursChoice?: QuietHoursChoice;
}>;

export type ReadyOneTimeReminder = Readonly<{
  status: "ready";
  safeSummary: string;
  requestedAt: string;
  scheduledAt: string;
  requestedLocalDateTime: string;
  scheduledLocalDateTime: string;
  timeZone: string;
  quietHours: QuietHours | null;
  quietHoursChoice: QuietHoursChoice | null;
}>;

export type OneTimeReminderPreparation =
  | ReadyOneTimeReminder
  | Readonly<{
      status: "quiet_hours_choice_required";
      choices: readonly ["requested_time", "quiet_hours_end"];
    }>;

type LocalDateTime = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const QUIET_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CHOICES = ["requested_time", "quiet_hours_end"] as const;

function parseCanonicalInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) return null;
  return parsed;
}

function parseSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length < 1 || [...normalized].length > 120) return null;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) return null;
  return normalized;
}

function parseQuietHours(value: unknown): QuietHours | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "start" && key !== "end")) return null;
  if (typeof record.start !== "string" || typeof record.end !== "string") return null;
  if (!QUIET_TIME.test(record.start) || !QUIET_TIME.test(record.end) || record.start === record.end) return null;
  return { start: record.start, end: record.end };
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function isInsideQuietHours(localMinutes: number, quietHours: QuietHours): boolean {
  const start = timeToMinutes(quietHours.start);
  const end = timeToMinutes(quietHours.end);
  return start < end
    ? localMinutes >= start && localMinutes < end
    : localMinutes >= start || localMinutes < end;
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function localDateTimeAt(instant: Date, timeZone: string): LocalDateTime | null {
  const fields: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of localFormatter(timeZone).formatToParts(instant)) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(part.type)) {
      fields[part.type] = Number(part.value);
    }
  }
  const { year, month, day, hour, minute, second } = fields;
  if ([year, month, day, hour, minute, second].some((value) => !Number.isInteger(value))) return null;
  return {
    year: year!,
    month: month!,
    day: day!,
    hour: hour!,
    minute: minute!,
    second: second!,
  };
}

function formatLocalDateTime(value: LocalDateTime): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(value.year).padStart(4, "0")}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function addLocalDays(value: LocalDateTime, days: number): LocalDateTime {
  const shifted = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    ...value,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function findUniqueInstant(value: LocalDateTime, timeZone: string): Date | null {
  const localEpoch = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  const offsets = new Set<number>();

  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = new Date(localEpoch + hours * 60 * 60 * 1_000);
    const represented = localDateTimeAt(sample, timeZone);
    if (!represented) return null;
    const representedEpoch = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    offsets.add(representedEpoch - sample.getTime());
  }

  const matches = new Map<number, Date>();
  for (const offset of offsets) {
    const candidate = new Date(localEpoch - offset);
    const reproduced = localDateTimeAt(candidate, timeZone);
    if (reproduced && sameLocalDateTime(reproduced, value)) matches.set(candidate.getTime(), candidate);
  }
  return matches.size === 1 ? [...matches.values()][0]! : null;
}

function selectedQuietHoursEnd(
  requestedLocal: LocalDateTime,
  quietHours: QuietHours,
  timeZone: string,
): Date | null {
  const start = timeToMinutes(quietHours.start);
  const end = timeToMinutes(quietHours.end);
  const requestedMinutes = requestedLocal.hour * 60 + requestedLocal.minute;
  const [endHour, endMinute] = quietHours.end.split(":").map(Number);
  const endDate = start > end && requestedMinutes >= start
    ? addLocalDays(requestedLocal, 1)
    : requestedLocal;
  return findUniqueInstant({ ...endDate, hour: endHour, minute: endMinute, second: 0 }, timeZone);
}

export function prepareOneTimeReminder(input: OneTimeReminderInput): OneTimeReminderPreparation | null {
  if (typeof input !== "object" || input === null) return null;
  const safeSummary = parseSummary(input.safeSummary);
  const requested = parseCanonicalInstant(input.requestedAt);
  const now = parseCanonicalInstant(input.now);
  const timeZone = parseTimeZone(input.timeZone);
  if (!safeSummary || !requested || !now || !timeZone
    || requested.getUTCMilliseconds() !== 0 || requested.getTime() <= now.getTime()) return null;

  const requestedLocal = localDateTimeAt(requested, timeZone);
  if (!requestedLocal) return null;

  if (input.quietHours === undefined) {
    if (input.quietHoursChoice !== undefined) return null;
    return {
      status: "ready",
      safeSummary,
      requestedAt: requested.toISOString(),
      scheduledAt: requested.toISOString(),
      requestedLocalDateTime: formatLocalDateTime(requestedLocal),
      scheduledLocalDateTime: formatLocalDateTime(requestedLocal),
      timeZone,
      quietHours: null,
      quietHoursChoice: null,
    };
  }

  const quietHours = parseQuietHours(input.quietHours);
  if (!quietHours) return null;
  const requestedMinutes = requestedLocal.hour * 60 + requestedLocal.minute;
  if (!isInsideQuietHours(requestedMinutes, quietHours)) {
    if (input.quietHoursChoice !== undefined) return null;
    return {
      status: "ready",
      safeSummary,
      requestedAt: requested.toISOString(),
      scheduledAt: requested.toISOString(),
      requestedLocalDateTime: formatLocalDateTime(requestedLocal),
      scheduledLocalDateTime: formatLocalDateTime(requestedLocal),
      timeZone,
      quietHours,
      quietHoursChoice: null,
    };
  }

  if (input.quietHoursChoice === undefined) {
    return { status: "quiet_hours_choice_required", choices: CHOICES };
  }
  if (!CHOICES.includes(input.quietHoursChoice)) return null;

  const scheduled = input.quietHoursChoice === "requested_time"
    ? requested
    : selectedQuietHoursEnd(requestedLocal, quietHours, timeZone);
  if (!scheduled || scheduled.getTime() <= now.getTime()) return null;
  const scheduledLocal = localDateTimeAt(scheduled, timeZone);
  if (!scheduledLocal) return null;

  return {
    status: "ready",
    safeSummary,
    requestedAt: requested.toISOString(),
    scheduledAt: scheduled.toISOString(),
    requestedLocalDateTime: formatLocalDateTime(requestedLocal),
    scheduledLocalDateTime: formatLocalDateTime(scheduledLocal),
    timeZone,
    quietHours,
    quietHoursChoice: input.quietHoursChoice,
  };
}
