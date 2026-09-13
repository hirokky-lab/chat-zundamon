import { describe, expect, it } from "vitest";
import { prepareOneTimeReminder } from "../src/reminder";

const baseInput = {
  safeSummary: "薬を確認する",
  requestedAt: "2026-08-22T01:00:00.000Z",
  timeZone: "Asia/Tokyo",
  now: "2026-08-21T00:00:00.000Z",
};

describe("one-time reminder preparation", () => {
  it("keeps the confirmed instant when quiet hours are unset", () => {
    expect(prepareOneTimeReminder(baseInput)).toEqual({
      status: "ready",
      safeSummary: "薬を確認する",
      requestedAt: "2026-08-22T01:00:00.000Z",
      scheduledAt: "2026-08-22T01:00:00.000Z",
      requestedLocalDateTime: "2026-08-22T10:00:00",
      scheduledLocalDateTime: "2026-08-22T10:00:00",
      timeZone: "Asia/Tokyo",
      quietHours: null,
      quietHoursChoice: null,
    });
  });

  it("requires an explicit choice when the requested time intersects quiet hours", () => {
    expect(prepareOneTimeReminder({
      ...baseInput,
      safeSummary: "明日の準備",
      requestedAt: "2026-08-21T14:30:00.000Z",
      quietHours: { start: "23:00", end: "08:00" },
    })).toEqual({
      status: "quiet_hours_choice_required",
      choices: ["requested_time", "quiet_hours_end"],
    });
  });

  it("preserves the requested instant when the user prioritizes it", () => {
    expect(prepareOneTimeReminder({
      ...baseInput,
      requestedAt: "2026-08-21T14:30:00.000Z",
      quietHours: { start: "23:00", end: "08:00" },
      quietHoursChoice: "requested_time",
    })).toMatchObject({
      status: "ready",
      scheduledAt: "2026-08-21T14:30:00.000Z",
      scheduledLocalDateTime: "2026-08-21T23:30:00",
      quietHoursChoice: "requested_time",
    });
  });

  it("uses the next quiet-hours end only after an explicit choice", () => {
    expect(prepareOneTimeReminder({
      ...baseInput,
      requestedAt: "2026-08-21T14:30:00.000Z",
      quietHours: { start: "23:00", end: "08:00" },
      quietHoursChoice: "quiet_hours_end",
    })).toMatchObject({
      status: "ready",
      scheduledAt: "2026-08-21T23:00:00.000Z",
      scheduledLocalDateTime: "2026-08-22T08:00:00",
      quietHoursChoice: "quiet_hours_end",
    });
  });

  it("resolves a same-day quiet-hours end without changing the calendar day", () => {
    expect(prepareOneTimeReminder({
      ...baseInput,
      requestedAt: "2026-08-21T04:30:00.000Z",
      quietHours: { start: "12:00", end: "15:00" },
      quietHoursChoice: "quiet_hours_end",
    })).toMatchObject({
      status: "ready",
      scheduledAt: "2026-08-21T06:00:00.000Z",
      scheduledLocalDateTime: "2026-08-21T15:00:00",
    });
  });

  it.each([
    ["invalid timezone", { ...baseInput, timeZone: "Mars/Olympus" }],
    ["invalid requested instant", { ...baseInput, requestedAt: "tomorrow" }],
    ["non-canonical requested instant", { ...baseInput, requestedAt: "2026-08-22T01:00:00Z" }],
    ["subsecond requested instant", { ...baseInput, requestedAt: "2026-08-22T01:00:00.123Z" }],
    ["non-future requested instant", { ...baseInput, requestedAt: "2026-08-21T00:00:00.000Z" }],
    ["invalid current instant", { ...baseInput, now: "today" }],
    ["empty summary", { ...baseInput, safeSummary: "   " }],
    ["control character", { ...baseInput, safeSummary: "確認\nする" }],
    ["overlong summary", { ...baseInput, safeSummary: "あ".repeat(121) }],
    ["malformed quiet start", { ...baseInput, quietHours: { start: "9:00", end: "10:00" } }],
    ["malformed quiet end", { ...baseInput, quietHours: { start: "09:00", end: "24:00" } }],
    ["equal quiet boundaries", { ...baseInput, quietHours: { start: "09:00", end: "09:00" } }],
    ["unnecessary choice without quiet hours", { ...baseInput, quietHoursChoice: "requested_time" }],
    ["unnecessary choice outside quiet hours", {
      ...baseInput,
      quietHours: { start: "23:00", end: "08:00" },
      quietHoursChoice: "requested_time",
    }],
    ["unknown choice", {
      ...baseInput,
      requestedAt: "2026-08-21T14:30:00.000Z",
      quietHours: { start: "23:00", end: "08:00" },
      quietHoursChoice: "later" as "requested_time",
    }],
  ])("fails closed for %s", (_label, input) => {
    expect(prepareOneTimeReminder(input)).toBeNull();
  });

  it("fails closed when a selected quiet-hours end does not exist across DST", () => {
    expect(prepareOneTimeReminder({
      safeSummary: "確認する",
      requestedAt: "2026-03-08T06:30:00.000Z",
      timeZone: "America/New_York",
      now: "2026-03-08T00:00:00.000Z",
      quietHours: { start: "01:00", end: "02:30" },
      quietHoursChoice: "quiet_hours_end",
    })).toBeNull();
  });

  it("fails closed when a selected quiet-hours end is ambiguous across DST", () => {
    expect(prepareOneTimeReminder({
      safeSummary: "確認する",
      requestedAt: "2026-11-01T04:30:00.000Z",
      timeZone: "America/New_York",
      now: "2026-11-01T00:00:00.000Z",
      quietHours: { start: "00:00", end: "01:30" },
      quietHoursChoice: "quiet_hours_end",
    })).toBeNull();
  });
});
