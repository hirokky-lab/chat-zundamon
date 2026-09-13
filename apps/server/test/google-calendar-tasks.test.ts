import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
  GOOGLE_CALENDAR_TASKS_QUOTA,
  GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,
  GOOGLE_TASKS_READONLY_SCOPE,
  assertGoogleConnectionOwner,
  canonicalCalendarTasksContextJson,
  createCalendarTasksUntrustedContext,
  createGoogleCalendarTasksReadService,
  GoogleCalendarTasksRepositoryError,
  createSupabaseGoogleCalendarTasksConnectionRepository,
  makeInMemoryGoogleCalendarTasksConnectionRepository,
  makeInMemoryGoogleCalendarTasksQuotaRepository,
  createSupabaseGoogleCalendarTasksQuotaRepository,
  parseCalendarTasksUntrustedContext,
  requiredGoogleScope,
} from "../src/google-calendar-tasks";
import type { RequestUser } from "../src/request-user";
import { ALL_EXTERNAL_TOOLS_OFF, createExternalToolBoundary, type ExternalToolTelemetryEvent } from "../src/external-tools";
import type { CostGuard } from "../src/cost-guard";

const ownerA: RequestUser = {
  userId: "00000000-0000-0000-0000-00000000000a",
  email: "owner-a@example.test",
  accessToken: "owner-a-token",
};
const ownerB: RequestUser = {
  userId: "00000000-0000-0000-0000-00000000000b",
  email: "owner-b@example.test",
  accessToken: "owner-b-token",
};

describe("Google Calendar/Tasks connection controls", () => {
  it("creates one canonical four-key untrusted context envelope", () => {
    const context = createCalendarTasksUntrustedContext("2026-08-16 10:00 busy");
    expect(context).toEqual({
      kind: "google_calendar_tasks_untrusted_context",
      version: "yui-calendar-tasks-context-v1",
      utf8ByteLength: 21,
      text: "2026-08-16 10:00 busy",
    });
    const framed = canonicalCalendarTasksContextJson(context);
    expect(framed).toBe('{"kind":"google_calendar_tasks_untrusted_context","version":"yui-calendar-tasks-context-v1","utf8ByteLength":21,"text":"2026-08-16 10:00 busy"}');
    expect(parseCalendarTasksUntrustedContext(framed)).toEqual(context);
  });

  it.each([
    '{"kind":"google_calendar_tasks_untrusted_context","version":"yui-calendar-tasks-context-v1","utf8ByteLength":1,"text":"予定","extra":true}',
    '{"kind":"google_calendar_tasks_untrusted_context","version":"yui-calendar-tasks-context-v1","utf8ByteLength":1,"text":"予定"}',
    '{"text":"予定","kind":"google_calendar_tasks_untrusted_context","version":"yui-calendar-tasks-context-v1","utf8ByteLength":6}',
    '{"context":{"kind":"google_calendar_tasks_untrusted_context","version":"yui-calendar-tasks-context-v1","utf8ByteLength":6,"text":"予定"}}',
  ])("rejects a non-canonical, mismatched, wrapped, or extra-field context: %s", (value) => {
    expect(() => parseCalendarTasksUntrustedContext(value)).toThrow("Invalid Calendar/Tasks context");
  });

  it("requires the one read-only scope for the requested service", () => {
    expect(requiredGoogleScope("calendar")).toBe(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE);
    expect(requiredGoogleScope("tasks")).toBe(GOOGLE_TASKS_READONLY_SCOPE);

    expect(() => assertGoogleConnectionOwner({
      ownerId: ownerA.userId,
      expectedGoogleSubject: "sub-a",
      returnedGoogleSubject: "sub-a",
      grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE],
      service: "calendar",
    })).not.toThrow();
    expect(() => assertGoogleConnectionOwner({
      ownerId: ownerA.userId,
      expectedGoogleSubject: "sub-a",
      returnedGoogleSubject: "sub-a",
      grantedScopes: [GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE],
      service: "calendar",
    })).toThrow("Required Google openid scope missing");
    expect(() => assertGoogleConnectionOwner({
      ownerId: ownerA.userId,
      expectedGoogleSubject: "sub-a",
      returnedGoogleSubject: "sub-a",
      grantedScopes: ["openid"],
      service: "calendar",
    })).toThrow("Required Google scope missing");
    expect(() => assertGoogleConnectionOwner({
      ownerId: ownerA.userId,
      expectedGoogleSubject: "sub-a",
      returnedGoogleSubject: "sub-a",
      grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE, GOOGLE_TASKS_READONLY_SCOPE],
      service: "calendar",
    })).toThrow("Unexpected Google service scope");
  });

  it("rejects an empty owner or mismatched Google subject", () => {
    expect(() => assertGoogleConnectionOwner({
      ownerId: "",
      expectedGoogleSubject: "sub-a",
      returnedGoogleSubject: "sub-a",
      grantedScopes: [GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE],
      service: "calendar",
    })).toThrow("Google connection owner missing");
    expect(() => assertGoogleConnectionOwner({
      ownerId: ownerA.userId,
      expectedGoogleSubject: "sub-a",
      returnedGoogleSubject: "sub-b",
      grantedScopes: [GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE],
      service: "calendar",
    })).toThrow("Google subject mismatch");
  });

  it("keeps owners and services separate and clears only the stopped service", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();

    await repository.save(ownerA, { service: "calendar", googleSubject: "sub-a" });
    await repository.setHomeVisible(ownerA, "calendar", true);
    await repository.save(ownerA, { service: "tasks", googleSubject: "sub-a" });
    await repository.save(ownerB, { service: "calendar", googleSubject: "sub-b" });
    await repository.clear(ownerA, "tasks");

    expect(await repository.status(ownerA, "calendar")).toEqual({
      service: "calendar",
      state: "connected",
      homeVisible: true,
    });
    expect(await repository.status(ownerA, "tasks")).toEqual({
      service: "tasks",
      state: "disconnected",
      homeVisible: false,
    });
    expect(await repository.status(ownerB, "calendar")).toEqual({
      service: "calendar",
      state: "connected",
      homeVisible: false,
    });
  });

  it("always reconnects with Home hidden", async () => {
    const repository = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await repository.save(ownerA, { service: "calendar", googleSubject: "sub-a" });
    await repository.setHomeVisible(ownerA, "calendar", true);
    await repository.clear(ownerA, "calendar");
    await repository.save(ownerA, { service: "calendar", googleSubject: "sub-a-new" });

    expect(await repository.status(ownerA, "calendar")).toEqual({
      service: "calendar",
      state: "connected",
      homeVisible: false,
    });
  });

  it("binds hosted RPCs to the request owner and returns only safe status fields", async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      data: name === "get_google_calendar_tasks_status"
        ? { service: args.p_service, state: "connected", homeVisible: false }
        : { service: args.p_service, state: "connected", homeVisible: false },
      error: null,
    }));
    const factory = vi.fn(() => ({ rpc }));
    const repository = createSupabaseGoogleCalendarTasksConnectionRepository(factory);

    await expect(repository.status(ownerA, "calendar")).resolves.toEqual({
      service: "calendar",
      state: "connected",
      homeVisible: false,
    });
    await repository.save(ownerA, { service: "tasks", googleSubject: "sub-a" });
    await repository.setHomeVisible(ownerA, "tasks", true);
    await repository.clear(ownerA, "calendar");

    expect(factory).toHaveBeenCalledTimes(4);
    expect(factory).toHaveBeenNthCalledWith(1, ownerA);
    expect(rpc).toHaveBeenNthCalledWith(1, "get_google_calendar_tasks_status", { p_service: "calendar" });
    expect(rpc).toHaveBeenNthCalledWith(2, "save_google_calendar_tasks_control", {
      p_service: "tasks",
      p_google_subject: "sub-a",
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "set_google_calendar_tasks_home_visible", {
      p_service: "tasks",
      p_visible: true,
    });
    expect(rpc).toHaveBeenNthCalledWith(4, "clear_google_calendar_tasks_service", { p_service: "calendar" });
  });

  it("fails closed without exposing malformed hosted data or raw errors", async () => {
    const malformed = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => ({ data: { service: "calendar", state: "connected", homeVisible: false, token: "no" }, error: null }),
    }));
    const failed = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => ({ data: null, error: new Error("raw provider or database body") }),
    }));

    await expect(malformed.status(ownerA, "calendar")).rejects.toThrow("Google connection repository unavailable");
    await expect(failed.status(ownerA, "calendar")).rejects.toThrow("Google connection repository unavailable");
  });

  it("classifies malformed hosted status data as unavailable", async () => {
    const repository = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => ({ data: { service: "calendar", state: "connected", homeVisible: false, privateValue: "must-not-leak" }, error: null }),
    }));

    await expect(repository.status(ownerA, "calendar")).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("rejects a hosted status that names a different service than the request", async () => {
    const repository = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => ({ data: { service: "tasks", state: "connected", homeVisible: false }, error: null }),
    }));

    await expect(repository.status(ownerA, "calendar")).rejects.toThrow("Google connection repository unavailable");
  });

  it.each([
    ["schema", "PGRST202"],
    ["schema", "42883"],
    ["authorization", "42501"],
    ["unavailable", "unexpected"],
  ] as const)("classifies a hosted RPC failure as only the fixed %s category", async (reason, code) => {
    const repository = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => ({ data: null, error: { code, message: "private provider body" } }),
    }));

    const rejected = repository.status(ownerA, "calendar");
    await expect(rejected).rejects.toThrow(GoogleCalendarTasksRepositoryError);
    await expect(rejected).rejects.toMatchObject({ reason });
  });

  it("classifies a schema-cache style RPC failure without logging its message", async () => {
    const repository = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => ({ data: null, error: { message: "Could not find the function in the schema cache" } }),
    }));

    await expect(repository.status(ownerA, "calendar")).rejects.toMatchObject({ reason: "schema" });
  });

  it("classifies a rejected hosted RPC transport without exposing its body", async () => {
    const repository = createSupabaseGoogleCalendarTasksConnectionRepository(() => ({
      rpc: async () => { throw new Error("private transport failure"); },
    }));

    await expect(repository.status(ownerA, "calendar")).rejects.toMatchObject({ reason: "transport" });
  });
});

describe("Google Calendar/Tasks fake read boundary", () => {
  const maximumUsdByArea = { search: 0.1, calendar: 0.1, notification: 0.1, image: 0.1, work: 0.1, avatar: 0.1, storage: 0.1 };
  const context = { conversationId: "primary", channel: "chat" as const, personaId: "yui" as const, memoryScope: "shared" as const };
  const now = new Date("2026-08-21T00:00:00.000Z");

  function harness(options: { enabled?: boolean; gatewayRead?: (input: unknown, signal: AbortSignal) => Promise<ReturnType<typeof createCalendarTasksUntrustedContext>> } = {}) {
    const reserve = vi.fn<CostGuard["reserve"]>(async ({ requestId }) => ({ requestId, settle: async () => undefined, hold: async () => undefined }));
    const telemetry: ExternalToolTelemetryEvent[] = [];
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: options.enabled ?? true, tasks_read: options.enabled ?? true },
      costGuard: { reserve }, maximumUsdByArea, telemetry: { record: (event) => telemetry.push(event) }, now: () => now,
    });
    const connections = makeInMemoryGoogleCalendarTasksConnectionRepository();
    const quota = makeInMemoryGoogleCalendarTasksQuotaRepository();
    const gateway = { read: vi.fn(options.gatewayRead ?? (async () => createCalendarTasksUntrustedContext("2026-08-21 10:00 busy"))) };
    const service = createGoogleCalendarTasksReadService({ boundary, connections, quota, gateway, now: () => now });
    return { service, reserve, telemetry, connections, quota, gateway };
  }

  it.each(["calendar", "tasks"] as const)("does no connection, quota, provider, cost, or telemetry work while %s read is OFF", async (serviceName) => {
    const state = harness({ enabled: false });
    const status = vi.spyOn(state.connections, "status");
    const acquire = vi.spyOn(state.quota, "acquire");
    await expect(state.service.read({ owner: ownerA, service: serviceName, request: serviceName === "calendar" ? "availability" : "task_summary", requestId: "read-off", context })).resolves.toEqual({ status: "disabled" });
    expect(status).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(state.gateway.read).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.telemetry).toEqual([]);
  });

  it.each([
    ["calendar", "availability"],
    ["tasks", "task_summary"],
  ] as const)("runs one owner-scoped %s fake read through the bounded external-tool path", async (serviceName, request) => {
    const state = harness();
    await state.connections.save(ownerA, { service: serviceName, googleSubject: "sub-a" });
    const result = await state.service.read({ owner: ownerA, service: serviceName, request, requestId: `read-${serviceName}`, context });

    expect(result).toMatchObject({ status: "completed", service: serviceName, checkedAt: now.toISOString() });
    expect(result.status === "completed" ? result.context.text : null).toBe("2026-08-21 10:00 busy");
    expect(state.gateway.read).toHaveBeenCalledWith({ owner: ownerA, service: serviceName, request }, expect.any(AbortSignal));
    expect(state.reserve).toHaveBeenCalledWith(expect.objectContaining({ feature: "calendar", maximumUsd: GOOGLE_CALENDAR_TASKS_MAXIMUM_USD }));
    expect(state.telemetry).toMatchObject([{ feature: `${serviceName}_read`, outcome: "success", actualUsd: 0, quotaUnits: 1 }]);
    expect(JSON.stringify(state.telemetry)).not.toMatch(/busy|owner-a|sub-a|read-calendar|read-tasks/u);
  });

  it("returns only a classified failure when connection, quota, context, or gateway work is unsafe", async () => {
    const disconnected = harness();
    await expect(disconnected.service.read({ owner: ownerA, service: "calendar", request: "availability", requestId: "disconnected", context }))
      .resolves.toEqual({ status: "failed", service: "calendar", checkedAt: now.toISOString() });

    const quotaBlocked = harness();
    await quotaBlocked.connections.save(ownerA, { service: "calendar", googleSubject: "sub-a" });
    vi.spyOn(quotaBlocked.quota, "acquire").mockResolvedValue(null);
    await expect(quotaBlocked.service.read({ owner: ownerA, service: "calendar", request: "availability", requestId: "quota", context }))
      .resolves.toEqual({ status: "failed", service: "calendar", checkedAt: now.toISOString() });
    expect(quotaBlocked.gateway.read).not.toHaveBeenCalled();

    const malformed = harness({ gatewayRead: async () => ({ ...createCalendarTasksUntrustedContext("2026-08-21 10:00 busy"), extra: "raw" } as never) });
    await malformed.connections.save(ownerA, { service: "calendar", googleSubject: "sub-a" });
    await expect(malformed.service.read({ owner: ownerA, service: "calendar", request: "availability", requestId: "malformed", context }))
      .resolves.toEqual({ status: "failed", service: "calendar", checkedAt: now.toISOString() });

    const failed = harness({ gatewayRead: async () => { throw new Error("raw provider failure body"); } });
    await failed.connections.save(ownerA, { service: "tasks", googleSubject: "sub-a" });
    const result = await failed.service.read({ owner: ownerA, service: "tasks", request: "task_summary", requestId: "failed", context });
    expect(result).toEqual({ status: "failed", service: "tasks", checkedAt: now.toISOString() });
    expect(JSON.stringify(result)).not.toContain("raw provider failure body");
    expect(JSON.stringify(failed.telemetry)).not.toContain("raw provider failure body");
  });

  it("fails before provider work when conservative cost reservation is unavailable", async () => {
    const gateway = { read: vi.fn(async () => createCalendarTasksUntrustedContext("2026-08-21 10:00 busy")) };
    const boundary = createExternalToolBoundary({
      flags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      costGuard: { reserve: async () => { throw new Error("private cost backend body"); } },
      maximumUsdByArea,
    });
    const connections = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await connections.save(ownerA, { service: "calendar", googleSubject: "sub-a" });
    const service = createGoogleCalendarTasksReadService({
      boundary, connections, quota: makeInMemoryGoogleCalendarTasksQuotaRepository(), gateway, now: () => now,
    });
    const result = await service.read({ owner: ownerA, service: "calendar", request: "availability", requestId: "cost-failure", context });
    expect(result).toEqual({ status: "failed", service: "calendar", checkedAt: now.toISOString() });
    expect(gateway.read).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private cost backend body");
  });

  it("keeps the fixed timeout and maps timeout to content-free failure metadata", async () => {
    const run = vi.fn(async (request: { timeoutMs: number }) => {
      expect(request.timeoutMs).toBe(15_000);
      return { status: "timeout" as const };
    });
    const service = createGoogleCalendarTasksReadService({
      boundary: { flags: () => ({ ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true }), run } as never,
      connections: makeInMemoryGoogleCalendarTasksConnectionRepository(), quota: makeInMemoryGoogleCalendarTasksQuotaRepository(),
      gateway: { read: async () => new Promise(() => undefined) }, now: () => now,
    });
    await expect(service.read({ owner: ownerA, service: "calendar", request: "availability", requestId: "timeout", context }))
      .resolves.toEqual({ status: "failed", service: "calendar", checkedAt: now.toISOString() });
    expect(run).toHaveBeenCalledOnce();
  });

  it("commits quota before provider dispatch so timeout cannot bypass cross-host limits", async () => {
    let resolveGateway!: (value: ReturnType<typeof createCalendarTasksUntrustedContext>) => void;
    let markGatewayStarted!: () => void;
    const gatewayResult = new Promise<ReturnType<typeof createCalendarTasksUntrustedContext>>((resolve) => { resolveGateway = resolve; });
    const gatewayStarted = new Promise<void>((resolve) => { markGatewayStarted = resolve; });
    const commit = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const connections = makeInMemoryGoogleCalendarTasksConnectionRepository();
    await connections.save(ownerA, { service: "calendar", googleSubject: "sub-a" });
    const boundary = {
      flags: () => ({ ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true }),
      run: vi.fn(async (request: { execute(input: { signal: AbortSignal }): Promise<unknown> }) => {
        const controller = new AbortController();
        const execution = request.execute({ signal: controller.signal });
        await gatewayStarted;
        controller.abort();
        resolveGateway(createCalendarTasksUntrustedContext("2026-08-21 10:00 busy"));
        await expect(execution).rejects.toThrow("Calendar/Tasks read aborted");
        return { status: "timeout" as const };
      }),
    };
    const service = createGoogleCalendarTasksReadService({
      boundary: boundary as never,
      connections,
      quota: { acquire: async () => ({ commit, release }) },
      gateway: { read: async () => { markGatewayStarted(); return gatewayResult; } },
      now: () => now,
    });

    await expect(service.read({ owner: ownerA, service: "calendar", request: "availability", requestId: "late-timeout", context }))
      .resolves.toEqual({ status: "failed", service: "calendar", checkedAt: now.toISOString() });
    expect(commit).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("enforces independent owner and service rolling-minute quota before the fake gateway", async () => {
    const quota = makeInMemoryGoogleCalendarTasksQuotaRepository();
    const leases = [];
    for (let index = 0; index < GOOGLE_CALENDAR_TASKS_QUOTA.rollingMinute; index += 1) {
      const lease = await quota.acquire(ownerA, "calendar", now, `minute-${index}`);
      expect(lease).not.toBeNull();
      await lease!.commit();
      leases.push(lease);
    }
    await expect(quota.acquire(ownerA, "calendar", now, "minute-over")).resolves.toBeNull();
    await expect(quota.acquire(ownerA, "tasks", now, "tasks-one")).resolves.not.toBeNull();
    await expect(quota.acquire(ownerB, "calendar", now, "owner-b-one")).resolves.not.toBeNull();
  });

  it("enforces the UTC-day quota and releases failed attempts without consuming it", async () => {
    const quota = makeInMemoryGoogleCalendarTasksQuotaRepository();
    const released = await quota.acquire(ownerA, "calendar", now, "released");
    await released!.release();
    for (let index = 0; index < GOOGLE_CALENDAR_TASKS_QUOTA.utcDay; index += 1) {
      const at = new Date(now.getTime() + index * 120_000);
      const lease = await quota.acquire(ownerA, "calendar", at, `day-${index}`);
      expect(lease).not.toBeNull();
      await lease!.commit();
    }
    await expect(quota.acquire(ownerA, "calendar", new Date(now.getTime() + 12_000_000), "day-over")).resolves.toBeNull();
  });

  it("rejects a service-incompatible read shape before connection, quota, cost, or provider work", async () => {
    const state = harness();
    const status = vi.spyOn(state.connections, "status");
    const acquire = vi.spyOn(state.quota, "acquire");
    await expect(state.service.read({ owner: ownerA, service: "tasks", request: "availability", requestId: "wrong-shape", context }))
      .resolves.toEqual({ status: "failed", service: "tasks", checkedAt: now.toISOString() });
    expect(status).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(state.reserve).not.toHaveBeenCalled();
    expect(state.gateway.read).not.toHaveBeenCalled();
  });
});

describe("hosted Google Calendar/Tasks quota repository", () => {
  it("uses owner-bound RPCs and settles one acquired request exactly once", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const quota = createSupabaseGoogleCalendarTasksQuotaRepository(() => ({ rpc }));

    const lease = await quota.acquire(ownerA, "calendar", new Date("2026-08-29T00:00:00.000Z"), "calendar-read-1");
    expect(lease).not.toBeNull();
    await lease!.commit();
    await lease!.commit();

    expect(rpc).toHaveBeenNthCalledWith(1, "acquire_google_calendar_tasks_quota", {
      p_service: "calendar",
      p_request_id: "calendar-read-1",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "commit_google_calendar_tasks_quota", {
      p_service: "calendar",
      p_request_id: "calendar-read-1",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("fails closed for duplicate, malformed, or unavailable hosted quota results", async () => {
    for (const data of [false, null, "true", { acquired: true }]) {
      const quota = createSupabaseGoogleCalendarTasksQuotaRepository(() => ({ rpc: async () => ({ data, error: null }) }));
      await expect(quota.acquire(ownerA, "tasks", new Date("2026-08-29T00:00:00.000Z"), "tasks-read-1")).resolves.toBeNull();
    }
    const unavailable = createSupabaseGoogleCalendarTasksQuotaRepository(() => ({ rpc: async () => ({ data: null, error: { message: "private database body" } }) }));
    await expect(unavailable.acquire(ownerA, "tasks", new Date("2026-08-29T00:00:00.000Z"), "tasks-read-1")).rejects.toThrow("Google Calendar/Tasks quota unavailable");
  });
});
