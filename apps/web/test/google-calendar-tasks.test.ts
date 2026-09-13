import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_ACCOUNT_REMOVAL_URL,
  afterGoogleReconnect,
  createBrowserGoogleCalendarTasksApi,
  createLocalGoogleCalendarTasksApi,
  DISABLED_GOOGLE_SERVICE_SETTINGS,
  type GoogleServiceSettings,
} from "../src/google-calendar-tasks";

const connected: GoogleServiceSettings = {
  calendar: { service: "calendar", state: "connected", homeVisible: true },
  tasks: { service: "tasks", state: "connected", homeVisible: true },
};

describe("Calendar/Tasks local settings", () => {
  it("recovers a transient status 503 with one status-only retry", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json(connected));
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);

    await expect(api.getSettings()).resolves.toEqual(connected);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(call).toEqual(["/api/google-calendar-tasks/status", expect.objectContaining({ method: "GET", cache: "no-store" })]);
    }
  });

  it("stops after one retry when the status service remains unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(createBrowserGoogleCalendarTasksApi(fetchImpl).getSettings()).resolves.toEqual(DISABLED_GOOGLE_SERVICE_SETTINGS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404])("does not retry a status permission or disabled response (%s)", async (status) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status }));
    await expect(createBrowserGoogleCalendarTasksApi(fetchImpl).getSettings()).resolves.toEqual(DISABLED_GOOGLE_SERVICE_SETTINGS);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed when a browser status response contains provider-shaped fields", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      calendar: { service: "calendar", state: "connected", homeVisible: false, token: "secret" },
      tasks: { service: "tasks", state: "disabled", homeVisible: false },
    }));
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);

    await expect(api.getSettings()).resolves.toEqual(DISABLED_GOOGLE_SERVICE_SETTINGS);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses same-origin authenticated methods for the one selected service only", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/calendar/home")) return Response.json({ service: "calendar", state: "connected", homeVisible: true });
      if (String(input).endsWith("/calendar") && init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 500 });
    });
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);

    await expect(api.setHomeVisible("calendar", true)).resolves.toEqual({ service: "calendar", state: "connected", homeVisible: true });
    await expect(api.stopService("calendar")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/google-calendar-tasks/calendar/home", expect.objectContaining({ method: "POST" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/google-calendar-tasks/calendar", expect.objectContaining({ method: "DELETE" }));
  });

  it("performs one count-only read with an exact content-free response", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      status: "completed",
      service: "calendar",
      checkedAt: "2026-08-29T00:00:00.000Z",
    }));
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);

    await expect(api.checkCount("calendar", "event_type", "preview-check-1")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("/api/google-calendar-tasks/calendar/read", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ request: "event_type", requestId: "preview-check-1" }),
    }));
  });

  it("rejects a count read response that carries provider content", async () => {
    const api = createBrowserGoogleCalendarTasksApi(async () => Response.json({
      status: "completed",
      service: "tasks",
      checkedAt: "2026-08-29T00:00:00.000Z",
      title: "must not cross the boundary",
    }));

    await expect(api.checkCount("tasks", "task_summary", "preview-check-2"))
      .rejects.toThrow("Google service read is unavailable");
  });

  it("fetches source choices and sends only the selected source ID in an explicit preview", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({service:"tasks",checkedAt:"2026-09-05T00:00:00.000Z",items:[{id:"work-list",title:"仕事"}]}), {status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({service:"tasks",checkedAt:"2026-09-05T00:00:00.000Z",items:[]}), {status:200}));
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);
    expect((await api.sources!("tasks")).items[0].title).toBe("仕事");
    await api.preview("tasks", undefined, "work-list");
    expect(fetchImpl).toHaveBeenNthCalledWith(1,"/api/google-calendar-tasks/tasks/sources",expect.objectContaining({method:"POST",body:"{}"}));
    expect(fetchImpl).toHaveBeenNthCalledWith(2,"/api/google-calendar-tasks/tasks/preview",expect.objectContaining({body:JSON.stringify({sourceId:"work-list"})}));
  });

  it("returns one strict ephemeral preview and rejects response drift", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      service: "calendar",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [{ title: "朝会", start: { kind: "date_time", value: "2026-09-01T10:00:00+09:00" } }],
    }));
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);

    await expect(api.preview("calendar")).resolves.toEqual({
      service: "calendar",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [{ title: "朝会", start: { kind: "date_time", value: "2026-09-01T10:00:00+09:00" } }],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/google-calendar-tasks/calendar/preview", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({}),
    }));

    const drifted = createBrowserGoogleCalendarTasksApi(async () => Response.json({
      service: "tasks",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [{ title: "タスク", due: null, notes: "private" }],
    }));
    await expect(drifted.preview("tasks")).rejects.toThrow("Google service preview is unavailable");
  });

  it("propagates preview cancellation without exposing an abort detail", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("private abort detail", "AbortError")), { once: true });
    }));
    const api = createBrowserGoogleCalendarTasksApi(fetchImpl);
    const controller = new AbortController();
    const request = api.preview("calendar", controller.signal);

    controller.abort();

    await expect(request).rejects.toThrow("Google service preview is unavailable");
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("reconnects hidden and points account-wide removal to an ordinary Google link", () => {
    expect(afterGoogleReconnect(connected.calendar)).toEqual({ service: "calendar", state: "connected", homeVisible: false });
    expect(GOOGLE_ACCOUNT_REMOVAL_URL).toBe("https://myaccount.google.com/permissions");
  });

  it("stops and hides only one local service while leaving the other available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const api = createLocalGoogleCalendarTasksApi(connected);
    try {
      await api.stopService("calendar");
      expect(await api.getSettings()).toEqual({
        calendar: { service: "calendar", state: "disconnected", homeVisible: false },
        tasks: connected.tasks,
      });
      await expect(api.setHomeVisible("calendar", true)).rejects.toThrow("Google service is not connected");
      await expect(api.setHomeVisible("tasks", false)).resolves.toEqual({ service: "tasks", state: "connected", homeVisible: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
