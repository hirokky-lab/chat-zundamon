import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { ALL_EXTERNAL_TOOLS_OFF } from "../src/external-tools";
import { createCalendarTasksUntrustedContext, makeInMemoryGoogleCalendarTasksConnectionRepository } from "../src/google-calendar-tasks";
import { LOCAL_USER } from "../src/request-user";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const baseOptions = { extractor: { extract: async () => ({ candidates: [] }) } };

describe("Google Calendar/Tasks guarded routes", () => {
  it("returns 404 before OAuth parsing or route construction while both flags are off", async () => {
    const app = buildApp({ ...baseOptions, externalToolFlags: ALL_EXTERNAL_TOOLS_OFF });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/google-calendar-tasks/status" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/google-calendar-tasks/calendar/connect" })).statusCode).toBe(404);
  });

  it("returns only independent safe statuses when a read feature is enabled", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await repository.save(LOCAL_USER, { service: "calendar", googleSubject: "subject-a" });
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksFactory: { parseSecret: () => { throw new Error("not used"); }, createConnectionRepository: () => { throw new Error("not used"); }, createReadGateway: () => ({ read: async () => { throw new Error("not used"); } }) },
      googleCalendarTasksConnectionRepository: repository,
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      calendar: { service: "calendar", state: "connected", homeVisible: false },
      tasks: { service: "tasks", state: "disabled", homeVisible: false },
    });
    expect(response.body).not.toMatch(/subject|scope|token/i);

    const visible = await app.inject({ method: "POST", url: "/api/google-calendar-tasks/calendar/home", payload: { visible: true } });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual({ service: "calendar", state: "connected", homeVisible: true });
    expect((await app.inject({ method: "DELETE", url: "/api/google-calendar-tasks/calendar" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/google-calendar-tasks/status" })).json().calendar).toEqual({ service: "calendar", state: "disconnected", homeVisible: false });
    expect((await app.inject({ method: "POST", url: "/api/google-calendar-tasks/tasks/home", payload: { visible: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/google-calendar-tasks/tasks" })).statusCode).toBe(404);
  });

  it("runs a connected Tasks count-only read without returning provider context", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await repository.save(LOCAL_USER, { service: "tasks", googleSubject: "subject-a" });
    const app = buildApp({
      ...baseOptions,
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, tasks_read: true },
      googleCalendarTasksConnectionRepository: repository,
      googleCalendarTasksFactory: {
        parseSecret: () => { throw new Error("not used"); },
        createConnectionRepository: () => { throw new Error("not used"); },
        createReadGateway: () => ({
          read: async () => createCalendarTasksUntrustedContext("タスクを3件確認しました。"),
        }),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/google-calendar-tasks/tasks/read",
      payload: { request: "task_summary", requestId: "tasks-smoke-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "completed", service: "tasks", checkedAt: "2026-08-29T00:00:00.000Z" });
    expect(response.body).not.toMatch(/3件|context|title|description|identifier|token/i);
  });

  it("returns only an ephemeral strict Calendar preview after an explicit owner request", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await repository.save(LOCAL_USER, { service: "calendar", googleSubject: "subject-a" });
    const preview = vi.fn(async () => ({
      service: "calendar" as const,
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [{ title: "朝会", start: { kind: "date_time" as const, value: "2026-09-01T10:00:00+09:00" } }],
    }));
    const app = buildApp({
      ...baseOptions,
      now: () => new Date("2026-09-01T01:02:03.000Z"),
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: repository,
      googleCalendarTasksPreviewGateway: { preview, sources: async () => { throw new Error("unused"); } },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/google-calendar-tasks/calendar/preview",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "calendar",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [{ title: "朝会", start: { kind: "date_time", value: "2026-09-01T10:00:00+09:00" } }],
    });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(response.body).not.toMatch(/subject|token|context|googleSubject/u);
  });

  it("fails closed before previewing when the service is disconnected or the request body drifts", async () => {
    const preview = vi.fn(async () => ({ service: "tasks" as const, checkedAt: "2026-09-01T01:02:03.000Z", items: [] }));
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, tasks_read: true },
      googleCalendarTasksPreviewGateway: { preview, sources: async () => { throw new Error("unused"); } },
    });
    apps.push(app);

    expect((await app.inject({
      method: "POST",
      url: "/api/google-calendar-tasks/tasks/preview",
      payload: {},
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: "/api/google-calendar-tasks/tasks/preview",
      payload: { requestId: "client-controlled" },
    })).statusCode).toBe(400);
    expect(preview).not.toHaveBeenCalled();
  });

  it("logs only a fixed internal reason while keeping the client error unchanged", async () => {
    const privateValues = ["private token", "private provider body", "private title"];
    const logLines: string[] = [];
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await repository.save(LOCAL_USER, { service: "calendar", googleSubject: "subject-a" });
    const app = buildApp({
      ...baseOptions,
      logger: { level: "info", stream: { write: (line: string) => logLines.push(line) } },
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: repository,
      googleCalendarTasksFactory: {
        parseSecret: () => { throw new Error("not used"); },
        createConnectionRepository: () => { throw new Error("not used"); },
        createReadGateway: () => ({ read: async () => { throw new Error(privateValues.join(" | ")); } }),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/google-calendar-tasks/calendar/read",
      payload: { request: "availability", requestId: "calendar-diagnostic-1" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Google service is unavailable" });
    const logs = logLines.join("\n");
    expect(logs).toContain('"event":"google_calendar_tasks_read_unavailable"');
    expect(logs).toContain('"reason":"unknown"');
    for (const privateValue of privateValues) expect(logs).not.toContain(privateValue);
    expect(response.body).not.toMatch(/credential|refresh|provider_transport|response_validation|unknown/u);
  });

  it("fails closed with a fixed status response when the hosted status repository is unavailable", async () => {
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: {
        status: async () => { throw new Error("hosted database response body must not reach the client"); },
        save: async () => undefined,
        clear: async () => undefined,
        setHomeVisible: async () => undefined,
      },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Google service status unavailable" });
    expect(response.body).not.toMatch(/database|response|body/i);
  });

  it("starts only the enabled service through an injected OAuth boundary", async () => {
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksFactory: { parseSecret: () => { throw new Error("not used"); }, createConnectionRepository: () => { throw new Error("not used"); }, createReadGateway: () => ({ read: async () => { throw new Error("not used"); } }) },
      googleOAuthService: { begin: async ({ service }) => ({ authorizationUrl: `https://accounts.google.com/${service}`, state: "not-exposed" }), complete: async () => ({ status: "rejected" }), discard: async () => undefined },
    });
    apps.push(app);

    expect((await app.inject({ method: "POST", url: "/api/google-calendar-tasks/calendar/connect" })).json()).toEqual({ authorizationUrl: "https://accounts.google.com/calendar" });
    expect((await app.inject({ method: "POST", url: "/api/google-calendar-tasks/tasks/connect" })).statusCode).toBe(404);
    const callback = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two" });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
  });

  it("accepts Google's allowlisted callback metadata without exposing it", async () => {
    const complete = vi.fn(async () => ({ status: "rejected" as const }));
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete,
        discard: async () => undefined,
      },
    });
    apps.push(app);

    const callback = await app.inject({
      method: "GET",
      url: "/api/google-calendar-tasks/callback?code=one&state=two&scope=openid&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com&path=google-calendar-tasks%2Fcallback",
    });

    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ code: "one", state: "two" }));
    const completeInput = complete.mock.calls[0]?.[0];
    expect(completeInput?.isServiceEnabled?.("calendar")).toBe(true);
    expect(completeInput?.isServiceEnabled?.("tasks")).toBe(false);
    expect(callback.body).not.toMatch(/scope|authuser|prompt|issuer/i);
  });

  it("rejects callback query expansion or duplicated values before OAuth completion", async () => {
    const complete = vi.fn(async () => ({ status: "rejected" as const }));
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete,
        discard: async () => undefined,
      },
    });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two&unexpected=three" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two&path=google-calendar-tasks%2Fother" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&code=two&state=three" })).statusCode).toBe(404);
    expect(complete).not.toHaveBeenCalled();
  });

  it("strips callback query values from automatic request logs", async () => {
    const logLines: string[] = [];
    const app = buildApp({
      ...baseOptions,
      logger: { level: "info", stream: { write: (line: string) => logLines.push(line) } },
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => ({ status: "rejected" }),
        discard: async () => undefined,
      },
    });
    apps.push(app);

    await app.inject({
      method: "GET",
      url: "/api/google-calendar-tasks/callback?code=secret-code&state=secret-state&path=google-calendar-tasks%2Fcallback",
    });

    const logs = logLines.join("\n");
    expect(logs).toContain("/api/google-calendar-tasks/callback");
    expect(logs).not.toMatch(/secret-code|secret-state|\?code=|\?state=/);
  });

  it("logs only a fixed callback rejection stage without OAuth values", async () => {
    const logLines: string[] = [];
    const app = buildApp({
      ...baseOptions,
      logger: { level: "info", stream: { write: (line: string) => logLines.push(line) } },
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, tasks_read: true },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/tasks", state: "not-exposed" }),
        complete: async () => ({ status: "rejected", reason: "exchange_unavailable" }),
        discard: async () => undefined,
      },
    });
    apps.push(app);

    await app.inject({
      method: "GET",
      url: "/api/google-calendar-tasks/callback?code=secret-code&state=secret-state&path=google-calendar-tasks%2Fcallback",
    });

    const logs = logLines.join("\n");
    expect(logs).toContain('"event":"google_oauth_callback_rejected"');
    expect(logs).toContain('"reason":"exchange_unavailable"');
    expect(logs).not.toMatch(/secret-code|secret-state|\?code=|\?state=/);
  });

  it("records a connected service for the authenticated callback owner", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: repository,
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => ({ status: "connected", service: "calendar", googleSubject: "subject-a", ownerId: LOCAL_USER.userId }),
        discard: async () => undefined,
      },
    });
    apps.push(app);

    const callback = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two" });
    expect(callback.statusCode).toBe(303);
    expect(await repository.status(LOCAL_USER, "calendar")).toEqual({
      service: "calendar", state: "connected", homeVisible: false,
    });
  });

  it("removes the OAuth credential before clearing the visible connection", async () => {
    const clear = vi.fn(async () => undefined);
    const discard = vi.fn(async () => undefined);
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: {
        status: async (_owner, service) => ({ service, state: "connected", homeVisible: false }),
        save: async () => undefined,
        clear,
        setHomeVisible: async () => undefined,
      },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => ({ status: "rejected" }),
        discard,
      },
    });
    apps.push(app);

    await expect(app.inject({ method: "DELETE", url: "/api/google-calendar-tasks/calendar" })).resolves.toMatchObject({ statusCode: 204 });
    expect(discard).toHaveBeenCalledWith({ owner: LOCAL_USER, service: "calendar" });
    expect(clear).toHaveBeenCalledWith(LOCAL_USER, "calendar");
    expect(discard.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it("redirects safely when an injected OAuth adapter rejects", async () => {
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => { throw new Error("provider failure"); },
        discard: async () => undefined,
      },
    });
    apps.push(app);

    const callback = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two" });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
  });

  it("compensates secure OAuth persistence when saving visible connection state fails", async () => {
    const discard = vi.fn(async () => undefined);
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: {
        status: async (_owner, service) => ({ service, state: "disconnected", homeVisible: false }),
        save: async () => { throw new Error("controls unavailable"); },
        clear: async () => undefined,
        setHomeVisible: async () => undefined,
      },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => ({ status: "connected", service: "calendar", googleSubject: "subject-a", ownerId: LOCAL_USER.userId }),
        discard,
      } as never,
    });
    apps.push(app);

    const callback = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two" });
    expect(callback.statusCode).toBe(303);
    expect(discard).toHaveBeenCalledWith({ owner: { userId: LOCAL_USER.userId, email: "", accessToken: "" }, service: "calendar" });
  });

  it("keeps the fixed redirect when injected compensation rejects", async () => {
    const app = buildApp({
      ...baseOptions,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleCalendarTasksConnectionRepository: {
        status: async (_owner, service) => ({ service, state: "disconnected", homeVisible: false }),
        save: async () => { throw new Error("controls unavailable"); },
        clear: async () => undefined,
        setHomeVisible: async () => undefined,
      },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => ({ status: "connected", service: "calendar", googleSubject: "subject-a", ownerId: LOCAL_USER.userId }),
        discard: async () => { throw new Error("secure cleanup unavailable"); },
      } as never,
    });
    apps.push(app);

    const callback = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two" });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
  });
});


describe("Google source route boundary", () => {
  it("lists and selects only after connection, enforcing body/flag boundaries without logging IDs", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    const sources = vi.fn(async () => ({service: "tasks" as const, checkedAt: "2026-09-01T01:02:03.000Z", items: [{id:"private-source", title:"Work"}]}));
    const preview = vi.fn(async () => ({service:"tasks" as const, checkedAt:"2026-09-01T01:02:03.000Z", items:[]}));
    const lines: string[] = [];
    const app = buildApp({...baseOptions, logger:{level:"info",stream:{write:(line:string)=>lines.push(line)}}, externalToolFlags:{...ALL_EXTERNAL_TOOLS_OFF,tasks_read:true}, googleCalendarTasksConnectionRepository:repository,googleCalendarTasksPreviewGateway:{sources,preview}});
    apps.push(app);
    expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/sources",payload:{}})).statusCode).toBe(409);
    expect(sources).not.toHaveBeenCalled();
    await repository.save(LOCAL_USER,{service:"tasks",googleSubject:"subject"});
    expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/sources",payload:{}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/calendar/sources",payload:{}})).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/sources",payload:{sourceId:"private-source"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/preview",payload:{sourceId:"private-source"}})).statusCode).toBe(200);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({sourceId:"private-source"}),expect.any(AbortSignal));
    for (const sourceId of ["", "..", "a\n", "x".repeat(1025)]) expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/preview",payload:{sourceId}})).statusCode).toBe(400);
    expect(lines.join("\n")).not.toContain("private-source");
    expect(sources).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);
  });
  it("requires owner authentication before listing", async () => {
    const app = buildApp({...baseOptions, authVerifier:{verify:async()=>null},allowedOrigin:"https://preview.example.test",externalToolFlags:{...ALL_EXTERNAL_TOOLS_OFF,tasks_read:true}});
    apps.push(app);
    expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/sources",payload:{}})).statusCode).toBe(401);
  });
});

it("does not enumerate Google sources after quota exhaustion", async () => {
  const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
  await repository.save(LOCAL_USER,{service:"tasks",googleSubject:"subject"});
  const sources = vi.fn(async () => ({service:"tasks" as const,checkedAt:"2026-09-01T01:02:03.000Z",items:[]}));
  const app = buildApp({...baseOptions,externalToolFlags:{...ALL_EXTERNAL_TOOLS_OFF,tasks_read:true},googleCalendarTasksConnectionRepository:repository,googleCalendarTasksQuotaRepository:{acquire:async()=>null},googleCalendarTasksPreviewGateway:{sources,preview:async()=>{throw new Error("unused");}}});
  apps.push(app);
  expect((await app.inject({method:"POST",url:"/api/google-calendar-tasks/tasks/sources",payload:{}})).statusCode).toBe(429);
  expect(sources).not.toHaveBeenCalled();
});
