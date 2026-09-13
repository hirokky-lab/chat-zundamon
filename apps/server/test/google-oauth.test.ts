import { describe, expect, it, vi } from "vitest";
import {
  createGoogleOAuthService,
  makeInMemoryGoogleCalendarTasksOAuthRepository,
  type GoogleOAuthExchange,
} from "../src/google-oauth";
import {
  GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE, GOOGLE_CALENDAR_LIST_READONLY_SCOPE, acceptedGoogleReadScopes,
  GOOGLE_TASKS_READONLY_SCOPE,
} from "../src/google-calendar-tasks";
import type { RequestUser } from "../src/request-user";

const owner: RequestUser = {
  userId: "00000000-0000-0000-0000-0000000000a1",
  email: "owner@example.test",
  accessToken: "owner-access-token",
};

function exchange(scopes: readonly string[]): GoogleOAuthExchange {
  return {
    async exchange() {
      return {
        googleSubject: "google-subject-a",
        grantedScopes: scopes,
        refreshToken: Buffer.from("refresh-token", "utf8"),
      };
    },
  };
}

describe("Google Calendar/Tasks OAuth service", () => {
  it("starts a Calendar-only authorization request without plaintext state in storage", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const service = createGoogleOAuthService({
      repository,
      exchange: exchange(["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 7), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });

    const started = await service.begin({ owner, service: "calendar" });

    expect(started.authorizationUrl).toContain(encodeURIComponent(GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE));
    expect(started.authorizationUrl).toContain(encodeURIComponent(GOOGLE_CALENDAR_LIST_READONLY_SCOPE));
    expect(started.authorizationUrl).not.toContain(encodeURIComponent(GOOGLE_TASKS_READONLY_SCOPE));
    expect(JSON.stringify(repository.snapshot())).not.toContain(started.state);
    expect(repository.snapshot().attempts).toHaveLength(1);
    expect(started.authorizationUrl).toContain("redirect_uri=https%3A%2F%2Fpreview.example.test%2Fapi%2Fgoogle-calendar-tasks%2Fcallback");
    expect(new URL(started.authorizationUrl).searchParams.get("prompt")).toBe("consent");
    expect(new URL(started.authorizationUrl).searchParams.get("nonce")).toBeTruthy();
    expect(JSON.stringify(repository.snapshot())).not.toContain(new URL(started.authorizationUrl).searchParams.get("nonce")!);
    expect(repository.snapshot().attempts[0]?.codeVerifier).toBeUndefined();
  });

  it("rejects a callback that expands Calendar consent into Tasks and saves no connection", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const service = createGoogleOAuthService({
      repository,
      exchange: exchange(["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE, GOOGLE_TASKS_READONLY_SCOPE]),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 8), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });

    const started = await service.begin({ owner, service: "calendar" });

    await expect(service.complete({ owner, code: "authorization-code", state: started.state, signal: new AbortController().signal })).resolves.toMatchObject({ status: "rejected" });
    expect(repository.snapshot().connections).toEqual([]);
  });

  it("consumes state exactly once before accepting a callback", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const service = createGoogleOAuthService({
      repository,
      exchange: exchange(["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 9), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });

    const started = await service.begin({ owner, service: "calendar" });

    await expect(service.complete({ owner, code: "authorization-code", state: started.state, signal: new AbortController().signal })).resolves.toMatchObject({ status: "connected", service: "calendar", googleSubject: "google-subject-a" });
    await expect(service.complete({ owner, code: "authorization-code", state: started.state, signal: new AbortController().signal })).resolves.toMatchObject({ status: "rejected" });
    expect(repository.snapshot().connections).toHaveLength(1);
  });

  it("consumes a disabled-service callback without exchanging or saving credentials", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const exchangeCall = vi.fn(async () => ({
      googleSubject: "google-subject-a",
      grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE],
      refreshToken: Buffer.from("refresh-token", "utf8"),
    }));
    const service = createGoogleOAuthService({
      repository,
      exchange: { exchange: exchangeCall },
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 14), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });
    const started = await service.begin({ owner, service: "calendar" });

    await expect(service.complete({
      owner,
      code: "authorization-code",
      state: started.state,
      signal: new AbortController().signal,
      isServiceEnabled: () => false,
    })).resolves.toEqual({ status: "rejected", reason: "feature_disabled" });

    expect(repository.snapshot().connections).toEqual([]);
    expect(exchangeCall).not.toHaveBeenCalled();
  });

  it("derives the callback owner from opaque state rather than a caller-supplied identity", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const service = createGoogleOAuthService({
      repository,
      exchange: exchange(["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 11), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });
    const started = await service.begin({ owner, service: "calendar" });

    await expect(service.complete({
      owner: { ...owner, userId: "00000000-0000-0000-0000-0000000000a2" },
      code: "authorization-code",
      state: started.state,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: "connected", ownerId: owner.userId });
    expect(repository.snapshot().connections).toHaveLength(1);
  });

  it("rejects a tampered opaque callback state without consuming the original attempt", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const service = createGoogleOAuthService({
      repository,
      exchange: exchange(["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 13), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });
    const started = await service.begin({ owner, service: "calendar" });
    const signal = new AbortController().signal;

    const tampered = `${started.state.slice(0, -1)}${started.state.endsWith("A") ? "B" : "A"}`;
    await expect(service.complete({ owner, code: "authorization-code", state: tampered, signal }))
      .resolves.toEqual({ status: "rejected", reason: "invalid_state" });
    await expect(service.complete({ owner, code: "authorization-code", state: started.state, signal }))
      .resolves.toMatchObject({ status: "connected", service: "calendar", googleSubject: "google-subject-a", ownerId: owner.userId });
  });

  it("collapses an OAuth exchange failure into a safe rejection", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    const service = createGoogleOAuthService({
      repository,
      exchange: { exchange: async () => { throw new Error("provider failure"); } },
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 12), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });
    const started = await service.begin({ owner, service: "calendar" });

    await expect(service.complete({ owner, code: "authorization-code", state: started.state, signal: new AbortController().signal }))
      .resolves.toEqual({ status: "rejected", reason: "exchange_unavailable" });
    expect(repository.snapshot().connections).toEqual([]);
  });

  it("expires an authorization state after five minutes", async () => {
    const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
    let now = new Date("2026-08-28T00:00:00.000Z");
    const service = createGoogleOAuthService({
      repository,
      exchange: exchange(["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE]),
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 10), redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
    });

    const started = await service.begin({ owner, service: "calendar" });
    now = new Date("2026-08-28T00:05:00.000Z");

    await expect(service.complete({ owner, code: "authorization-code", state: started.state, signal: new AbortController().signal })).resolves.toMatchObject({ status: "rejected" });
    expect(repository.snapshot().connections).toEqual([]);
  });
});


it("accepts legacy and expanded read scopes without permitting write or cross-service scopes", () => {
  const legacy = ["openid",GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE];
  expect(acceptedGoogleReadScopes(legacy,"calendar")).toBe(true);
  expect(acceptedGoogleReadScopes([...legacy, GOOGLE_CALENDAR_LIST_READONLY_SCOPE],"calendar")).toBe(true);
  expect(acceptedGoogleReadScopes([...legacy, GOOGLE_TASKS_READONLY_SCOPE],"calendar")).toBe(false);
  expect(acceptedGoogleReadScopes([...legacy, "https://www.googleapis.com/auth/calendar"],"calendar")).toBe(false);
  expect(acceptedGoogleReadScopes([...legacy, "openid"],"calendar")).toBe(false);
});
it("retains the newly granted calendar list scope in the saved credential", async () => {
  const repository = makeInMemoryGoogleCalendarTasksOAuthRepository();
  const scopes = ["openid",GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE,GOOGLE_CALENDAR_LIST_READONLY_SCOPE];
  const service = createGoogleOAuthService({repository,exchange:exchange(scopes),redirectUri:"https://preview.example.test/api/google-calendar-tasks/callback"});
  const started = await service.begin({owner,service:"calendar"});
  expect((await service.complete({owner,code:"code",state:started.state,signal:new AbortController().signal})).status).toBe("connected");
  expect((await repository.getConnectionForOwner({ownerId:owner.userId,service:"calendar"}))?.grantedScopes).toEqual(scopes);
});
