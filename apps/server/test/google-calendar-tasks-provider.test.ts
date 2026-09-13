import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarTasksReadGateway } from "../src/google-calendar-tasks-provider";
import { GoogleCalendarTasksDiagnosticError } from "../src/google-calendar-tasks-diagnostics";
import type { RequestUser } from "../src/request-user";

const owner: RequestUser = {
  userId: "00000000-0000-0000-0000-0000000000a1",
  email: "owner@example.test",
  accessToken: "owner-access-token",
};

function makeGateway(payload: unknown, status = 200) {
  const get = vi.fn(async () => ({ status, contentLength: Buffer.byteLength(JSON.stringify(payload), "utf8"), json: async () => payload }));
  const gateway = createGoogleCalendarTasksReadGateway({
    tokens: { getAccessToken: async () => "access-token" },
    transport: { get },
    now: () => new Date("2026-08-28T00:00:00.000Z"),
  });
  return { gateway, get };
}

describe("Google Calendar/Tasks GET-only provider gateway", () => {
  it.each([
    ["credential", new GoogleCalendarTasksDiagnosticError("credential")],
    ["refresh", new GoogleCalendarTasksDiagnosticError("refresh")],
    ["unknown", new Error("private token provider failure")],
  ] as const)("preserves only the fixed %s token-stage reason", async (reason, failure) => {
    const gateway = createGoogleCalendarTasksReadGateway({
      tokens: { getAccessToken: async () => { throw failure; } },
      transport: { get: async () => { throw new Error("must not run"); } },
    });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .rejects.toMatchObject({ reason, message: "Google Calendar/Tasks response unavailable" });
  });

  it("classifies provider transport and response validation separately without retaining payloads", async () => {
    const transportFailure = createGoogleCalendarTasksReadGateway({
      tokens: { getAccessToken: async () => "access-token" },
      transport: { get: async () => { throw new Error("private upstream transport body"); } },
    });
    const validationFailure = makeGateway({ items: [{ status: "confirmed", title: "private title", id: "private-id" }] }).gateway;

    await expect(transportFailure.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .rejects.toMatchObject({ reason: "provider_transport", message: "Google Calendar/Tasks response unavailable" });
    await expect(validationFailure.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .rejects.toMatchObject({ reason: "response_validation", message: "Google Calendar/Tasks response unavailable" });
  });

  it("classifies an aborted provider read as unknown instead of blaming transport", async () => {
    const controller = new AbortController();
    const gateway = createGoogleCalendarTasksReadGateway({
      tokens: { getAccessToken: async () => "access-token" },
      transport: { get: async () => {
        controller.abort();
        throw new Error("private abort detail");
      } },
    });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, controller.signal))
      .rejects.toMatchObject({ reason: "unknown", message: "Google Calendar/Tasks response unavailable" });
  });

  it("classifies cancellation during bounded response parsing as unknown", async () => {
    const controller = new AbortController();
    const gateway = createGoogleCalendarTasksReadGateway({
      tokens: { getAccessToken: async () => "access-token" },
      transport: { get: async () => ({
        status: 200,
        contentLength: 12,
        json: async () => {
          controller.abort();
          throw new Error("private partial response");
        },
      }) },
    });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, controller.signal))
      .rejects.toMatchObject({ reason: "unknown", message: "Google Calendar/Tasks response unavailable" });
  });

  it("uses one bounded Calendar GET and excludes private provider fields", async () => {
    const { gateway, get } = makeGateway({
      items: [{ status: "confirmed", id: "event-1", summary: "private", attendees: [{ email: "third@example.test" }] }],
    });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", redirect: "error" }));
  });

  it("rejects Calendar title, description, location, attendees, identifier, and unknown fields before constructing count-only context", async () => {
    const { gateway } = makeGateway({
      items: [{
        status: "confirmed",
        id: "private-event-id",
        summary: "private event title",
        description: "private event body",
        location: "private event location",
        attendees: [{ email: "third@example.test" }],
        unknownField: "private unknown value",
      }],
    });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
  });

  it("rejects malformed or oversized count sources for Calendar and Tasks before constructing context", async () => {
    const malformedItems = [
      { name: "negative-like", value: { length: -1 } },
      { name: "fractional-like", value: { length: 0.5 } },
      { name: "NaN-like", value: { length: "NaN" } },
      { name: "string-like", value: "" },
      { name: "missing", value: undefined },
    ] as const;

    for (const malformed of malformedItems) {
      const calendar = makeGateway({ items: malformed.value });
      const tasks = makeGateway({ items: malformed.value });
      await expect(calendar.gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal), malformed.name).rejects.toThrow("Google Calendar/Tasks response unavailable");
      await expect(tasks.gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal), malformed.name).rejects.toThrow("Google Calendar/Tasks response unavailable");
    }

    const calendar = makeGateway({ items: Array.from({ length: 11 }, () => ({ status: "confirmed" })) });
    const tasks = makeGateway({ items: Array.from({ length: 11 }, () => ({ status: "needsAction" })) });
    await expect(calendar.gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
    await expect(tasks.gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
  });

  it("returns one fixed error without echoing rejected provider fields or logging them", async () => {
    const privateValues = ["raw provider response", "private title", "private identifier", "token-like value", "unknown field value"];
    const { gateway } = makeGateway({
      items: [{
        status: "confirmed",
        summary: privateValues[1],
        id: privateValues[2],
        unknownField: privateValues[4],
      }],
      response: privateValues[0],
      token: privateValues[3],
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({ message: "Google Calendar/Tasks response unavailable" });
      expect(String(error)).not.toContain(privateValues[0]);
      expect(String(error)).not.toContain(privateValues[1]);
      expect(String(error)).not.toContain(privateValues[2]);
      expect(String(error)).not.toContain(privateValues[3]);
      expect(String(error)).not.toContain(privateValues[4]);
    } finally {
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    }
  });

  it("projects only a Calendar availability count from an exact response shape", async () => {
    const { gateway, get } = makeGateway({
      items: [{ status: "confirmed" }],
    });

    const result = await gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal);

    expect(result.text).toBe("予定の空き状況を1件確認しました。");
    expect(JSON.stringify(result)).not.toMatch(/confirmed|https?:|access-token/u);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      redirect: "error",
      url: expect.stringContaining("https://www.googleapis.com/calendar/v3/calendars/primary/events"),
    }));
    const url = new URL(get.mock.calls[0]![0].url);
    expect(url.searchParams.get("fields")).toBe("items(status)");
  });

  it.each([
    ["empty partial response", {}, 0],
    ["default confirmed status omitted", { items: [{}] }, 1],
    ["tentative event", { items: [{ status: "tentative" }] }, 1],
    ["cancelled event", { items: [{ status: "cancelled" }] }, 1],
  ] as const)("counts the documented Calendar partial response shape: %s", async (_name, payload, expectedCount) => {
    const { gateway } = makeGateway(payload);

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .resolves.toMatchObject({ text: `予定の空き状況を${expectedCount}件確認しました。` });
  });

  it("rejects an unknown Calendar event status without constructing count-only context", async () => {
    const { gateway } = makeGateway({ items: [{ status: "future-status" }] });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .rejects.toMatchObject({ reason: "response_validation", message: "Google Calendar/Tasks response unavailable" });
  });

  it("rejects an unknown Tasks response before constructing context", async () => {
    const { gateway, get } = makeGateway({ unexpected: true });

    await expect(gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects Tasks title, identifier, and unknown fields before constructing count-only context", async () => {
    const { gateway } = makeGateway({
      items: [{ status: "needsAction", id: "private-task-id", title: "private task title", notes: "private task body" }],
    });

    await expect(gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
  });

  it("rejects malformed Tasks dates before constructing context", async () => {
    const { gateway } = makeGateway({
      items: [{ status: "needsAction", due: "not-a-date", completed: "2026-08-28T00:00:00Z" }],
    });

    await expect(gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
  });

  it("requests and accepts only task status for count projection", async () => {
    const { gateway, get } = makeGateway({ items: [{ status: "needsAction" }] });

    await expect(gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal)).resolves.toMatchObject({
      text: "タスクを1件確認しました。",
    });
    const url = new URL(get.mock.calls[0]![0].url);
    expect(url.searchParams.get("fields")).toBe("items(status)");
  });

  it("treats a Tasks partial response with no items field as an empty count", async () => {
    const { gateway } = makeGateway({});

    await expect(gateway.read({ owner, service: "tasks", request: "task_summary" }, new AbortController().signal))
      .resolves.toMatchObject({ text: "タスクを0件確認しました。" });
  });

  it("does not admit a calendar-title request that would require non-minimal provider data", async () => {
    const { gateway, get } = makeGateway({ items: [] });

    await expect(gateway.read({ owner, service: "calendar", request: "calendar_title" as never }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a response above the fixed byte cap before JSON parsing", async () => {
    const get = vi.fn(async () => ({ status: 200, contentLength: 65 * 1024, json: async () => { throw new Error("must not parse"); } }));
    const gateway = createGoogleCalendarTasksReadGateway({ tokens: { getAccessToken: async () => "access-token" }, transport: { get } });
    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
  });

  it("passes the fixed byte cap to the transport before parsing a response with a misleading length", async () => {
    const json = vi.fn(async (maximumBytes: number) => {
      if (maximumBytes !== 64 * 1024) throw new Error("unbounded parse");
      throw new Error("response body exceeded cap");
    });
    const get = vi.fn(async () => ({ status: 200, contentLength: 1, json }));
    const gateway = createGoogleCalendarTasksReadGateway({ tokens: { getAccessToken: async () => "access-token" }, transport: { get } });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal)).rejects.toThrow("Google Calendar/Tasks response unavailable");
    expect(json).toHaveBeenCalledWith(64 * 1024);
  });

  it("accepts an omitted Content-Length only through the bounded response reader", async () => {
    const json = vi.fn(async (maximumBytes: number) => {
      expect(maximumBytes).toBe(64 * 1024);
      return { items: [] };
    });
    const get = vi.fn(async () => ({ status: 200, contentLength: -1, json }));
    const gateway = createGoogleCalendarTasksReadGateway({ tokens: { getAccessToken: async () => "access-token" }, transport: { get } });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .resolves.toMatchObject({ text: "予定の空き状況を0件確認しました。" });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid negative Content-Length before response parsing", async () => {
    const json = vi.fn(async () => ({ items: [] }));
    const get = vi.fn(async () => ({ status: 200, contentLength: -2, json }));
    const gateway = createGoogleCalendarTasksReadGateway({ tokens: { getAccessToken: async () => "access-token" }, transport: { get } });

    await expect(gateway.read({ owner, service: "calendar", request: "availability" }, new AbortController().signal))
      .rejects.toMatchObject({ reason: "response_validation" });
    expect(json).not.toHaveBeenCalled();
  });
});
