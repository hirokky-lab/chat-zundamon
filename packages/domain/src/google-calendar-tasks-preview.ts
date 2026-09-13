export type GooglePreviewService = "calendar" | "tasks";

export type CalendarPreviewItem = Readonly<{
  calendar?: Readonly<{id:string;title:string}>;
  title: string;
  start: Readonly<
    | { kind: "date_time"; value: string }
    | { kind: "all_day"; value: string }
  >;
}>;

export type TaskPreviewItem = Readonly<{
  title: string;
  due: string | null;
}>;

export type GoogleCalendarPreviewResult = Readonly<{
  service: "calendar";
  checkedAt: string;
  items: readonly CalendarPreviewItem[];
}>;

export type GoogleTasksPreviewResult = Readonly<{
  service: "tasks";
  checkedAt: string;
  items: readonly TaskPreviewItem[];
}>;

export type GooglePreviewResult = GoogleCalendarPreviewResult | GoogleTasksPreviewResult;

const INVALID_RESULT = "Invalid Google preview result";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const DATE_TIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function parseGooglePreviewResult(value: unknown, expected: GooglePreviewService): GooglePreviewResult {
  if (!isExactObject(value, ["checkedAt", "items", "service"]) || value.service !== expected || !validCheckedAt(value.checkedAt)) {
    throw new Error(INVALID_RESULT);
  }
  if (!Array.isArray(value.items)) throw new Error(INVALID_RESULT);
  if (expected === "calendar") {
    if (value.items.length > 3) throw new Error(INVALID_RESULT);
    const items = value.items.map(parseCalendarItem);
    return { service: "calendar", checkedAt: value.checkedAt, items };
  }
  if (value.items.length > 5) throw new Error(INVALID_RESULT);
  const items = value.items.map(parseTaskItem);
  return { service: "tasks", checkedAt: value.checkedAt, items };
}

function parseCalendarItem(value: unknown): CalendarPreviewItem {
  if (!(isExactObject(value, ["start", "title"]) || isExactObject(value, ["start", "title", "calendar"])) || !validTitle(value.title) || !isExactObject(value.start, ["kind", "value"])) {
    throw new Error(INVALID_RESULT);
  }
  let calendar: CalendarPreviewItem['calendar'];
  if ('calendar' in value) {
    if (!isExactObject(value.calendar,['id','title']) || !isValidGoogleSourceId(value.calendar.id) || !validTitle(value.calendar.title)) throw new Error(INVALID_RESULT);
    calendar={id:value.calendar.id,title:value.calendar.title};
  }
  if (value.start.kind === "date_time" && validDateTime(value.start.value)) {
    return { ...(calendar?{calendar}:{}), title: value.title, start: { kind: "date_time", value: value.start.value } };
  }
  if (value.start.kind === "all_day" && validDateOnly(value.start.value)) {
    return { ...(calendar?{calendar}:{}), title: value.title, start: { kind: "all_day", value: value.start.value } };
  }
  throw new Error(INVALID_RESULT);
}

function parseTaskItem(value: unknown): TaskPreviewItem {
  if (!isExactObject(value, ["due", "title"]) || !validTitle(value.title)) throw new Error(INVALID_RESULT);
  if (value.due !== null && !validDateOnly(value.due)) throw new Error(INVALID_RESULT);
  return { title: value.title, due: value.due };
}

function validTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 120
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value);
}

function validCheckedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_TIME_WITH_ZONE.test(value) || !validDateOnly(value.slice(0, 10))) return false;
  return Number.isFinite(Date.parse(value));
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}


export type GoogleSourceListResult = Readonly<{
  service: GooglePreviewService;
  checkedAt: string;
  items: readonly Readonly<{ id: string; title: string }>[];
}>;

export function isValidGoogleSourceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && value.trim() === value && !CONTROL_CHARACTERS.test(value)
    && value !== "." && value !== "..";
}

export function parseGoogleSourceListResult(value: unknown, expected: GooglePreviewService): GoogleSourceListResult {
  if (!isExactObject(value, ["service", "checkedAt", "items"]) || value.service !== expected
    || !validCheckedAt(value.checkedAt) || !Array.isArray(value.items) || value.items.length > 100) throw new Error(INVALID_RESULT);
  const seen = new Set<string>();
  const items = value.items.map(item => {
    if (!isExactObject(item, ["id", "title"]) || !isValidGoogleSourceId(item.id) || !validTitle(item.title) || seen.has(item.id)) throw new Error(INVALID_RESULT);
    seen.add(item.id);
    return { id: item.id, title: item.title };
  });
  return { service: expected, checkedAt: value.checkedAt, items };
}
