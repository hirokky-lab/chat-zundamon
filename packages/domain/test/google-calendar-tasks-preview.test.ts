import { describe, expect, it } from "vitest";
import { parseGooglePreviewResult } from "../src/google-calendar-tasks-preview";

const checkedAt = "2026-09-01T14:00:00.000Z";

describe("Google Calendar/Tasks preview contract", () => {
  it("accepts exact bounded Calendar timed and all-day items", () => {
    expect(parseGooglePreviewResult({
      service: "calendar",
      checkedAt,
      items: [
        { title: "打合せ", start: { kind: "date_time", value: "2026-09-02T09:30:00+09:00" } },
        { title: "休み", start: { kind: "all_day", value: "2026-09-03" } },
      ],
    }, "calendar")).toEqual({
      service: "calendar",
      checkedAt,
      items: [
        { title: "打合せ", start: { kind: "date_time", value: "2026-09-02T09:30:00+09:00" } },
        { title: "休み", start: { kind: "all_day", value: "2026-09-03" } },
      ],
    });
  });

  it("accepts exact bounded Tasks items with date-only optional due", () => {
    expect(parseGooglePreviewResult({
      service: "tasks",
      checkedAt,
      items: [{ title: "提出", due: "2026-09-04" }, { title: "確認", due: null }],
    }, "tasks")).toEqual({
      service: "tasks",
      checkedAt,
      items: [{ title: "提出", due: "2026-09-04" }, { title: "確認", due: null }],
    });
  });

  it.each([
    ["service mismatch", { service: "tasks", checkedAt, items: [] }, "calendar"],
    ["unknown top-level field", { service: "calendar", checkedAt, items: [], raw: "leak" }, "calendar"],
    ["unknown Calendar field", { service: "calendar", checkedAt, items: [{ title: "予定", start: { kind: "all_day", value: "2026-09-03" }, id: "leak" }] }, "calendar"],
    ["unknown start field", { service: "calendar", checkedAt, items: [{ title: "予定", start: { kind: "all_day", value: "2026-09-03", zone: "leak" } }] }, "calendar"],
    ["four Calendar items", { service: "calendar", checkedAt, items: Array.from({ length: 4 }, (_, index) => ({ title: `予定${index}`, start: { kind: "all_day", value: "2026-09-03" } })) }, "calendar"],
    ["six Tasks items", { service: "tasks", checkedAt, items: Array.from({ length: 6 }, (_, index) => ({ title: `タスク${index}`, due: null })) }, "tasks"],
    ["invalid checkedAt", { service: "tasks", checkedAt: "2026-09-01", items: [] }, "tasks"],
    ["invalid date-time", { service: "calendar", checkedAt, items: [{ title: "予定", start: { kind: "date_time", value: "2026-09-03T10:00:00" } }] }, "calendar"],
    ["impossible all-day date", { service: "calendar", checkedAt, items: [{ title: "予定", start: { kind: "all_day", value: "2026-02-30" } }] }, "calendar"],
    ["impossible due date", { service: "tasks", checkedAt, items: [{ title: "提出", due: "2026-02-30" }] }, "tasks"],
    ["empty title", { service: "tasks", checkedAt, items: [{ title: "", due: null }] }, "tasks"],
    ["control character", { service: "calendar", checkedAt, items: [{ title: "予定\n漏えい", start: { kind: "all_day", value: "2026-09-03" } }] }, "calendar"],
    ["title too long", { service: "tasks", checkedAt, items: [{ title: "あ".repeat(121), due: null }] }, "tasks"],
  ] as const)("rejects %s", (_name, value, service) => {
    expect(() => parseGooglePreviewResult(value, service)).toThrow("Invalid Google preview result");
  });
});

it("rejects duplicate, control-bearing and oversized source lists", async () => {
  const { parseGoogleSourceListResult } = await import("../src/index");
  const result = {service:"tasks",checkedAt:"2026-09-01T00:00:00.000Z",items:[{id:"work",title:"仕事"}]};
  expect(parseGoogleSourceListResult(result,"tasks")).toEqual(result);
  expect(() => parseGoogleSourceListResult(result,"calendar")).toThrow();
  for (const items of [[...result.items,...result.items],[{id:"bad\n",title:"仕事"}],Array.from({length:101},(_,i)=>({id:String(i),title:"List"}))]) {
    expect(() => parseGoogleSourceListResult({...result,items},"tasks")).toThrow();
  }
});
