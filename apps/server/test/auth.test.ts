import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import { createSupabaseAuthVerifier } from "../src/auth";
import type { AuthVerifier } from "../src/auth";
import { ALL_EXTERNAL_TOOLS_OFF } from "../src/external-tools";

const noMemoryExtractor = { extract: async () => ({ candidates: [] }) };

function privateApp(verifier: AuthVerifier, logLines?: string[]) {
  return buildApp({
    authVerifier: verifier,
    allowedOrigin: "https://yui.example",
    extractor: noMemoryExtractor,
    logger: !logLines ? false : {
      level: "info",
      stream: { write: (line: string) => logLines.push(line) },
    },
    backup: { cronSecret: "cron-secret", service: { run: async () => ({ dailyPath: "backups/daily/test.json", weeklyPath: null }) } },
  });
}

describe("private YUI authentication", () => {
  it.each([
    [undefined, "missing"],
    ["Basic abc", "non-Bearer"],
    ["Bearer ", "empty bearer"],
  ])("rejects %s authorization without calling the verifier", async (authorization) => {
    const verify = vi.fn(async () => null);
    const app = privateApp({ verify });

    const response = await app.inject({
      method: "GET",
      url: "/api/profile",
      headers: authorization ? { authorization } : {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects an invalid token without logging the token or account email", async () => {
    const logLines: string[] = [];
    const app = privateApp({ verify: async () => null }, logLines);

    const response = await app.inject({
      method: "GET",
      url: "/api/profile",
      headers: { authorization: "Bearer private-token-value" },
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.stringify(response.json())).not.toContain("private-token-value");
    expect(logLines.join("\n")).not.toContain("private-token-value");
    expect(logLines.join("\n")).not.toContain("owner@example.com");
  });

  it("accepts the allowed authenticated user and exposes exact-origin CORS", async () => {
    const user = { userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid-token" };
    const verify = vi.fn(async () => user);
    const app = privateApp({ verify });

    const response = await app.inject({
      method: "GET",
      url: "/api/profile",
      headers: { authorization: "Bearer valid-token", origin: "https://yui.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledWith("valid-token");
    expect(response.headers["access-control-allow-origin"]).toBe("https://yui.example");
  });

  it("lets health checks and CORS preflight bypass bearer authentication", async () => {
    const verify = vi.fn(async () => null);
    const app = privateApp({ verify });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const functionHealth = await app.inject({ method: "GET", url: "/api/healthz" });
    const functionHealthWithCatchAllQuery = await app.inject({
      method: "GET",
      url: "/api/healthz?path=healthz",
    });
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/profile",
      headers: {
        origin: "https://yui.example",
        "access-control-request-method": "GET",
      },
    });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(functionHealth.statusCode).toBe(200);
    expect(functionHealth.json()).toEqual({ ok: true });
    expect(functionHealthWithCatchAllQuery.statusCode).toBe(200);
    expect(functionHealthWithCatchAllQuery.json()).toEqual({ ok: true });
    expect(preflight.statusCode).toBe(204);
    expect(verify).not.toHaveBeenCalled();
  });

  it("lets only the strict Google OAuth callback reach its state validation without a bearer token", async () => {
    const app = buildApp({
      authVerifier: { verify: async () => null },
      allowedOrigin: "https://yui.example",
      extractor: noMemoryExtractor,
      externalToolFlags: { ...ALL_EXTERNAL_TOOLS_OFF, calendar_read: true },
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/example", state: "not-exposed" }),
        complete: async () => ({ status: "rejected" as const }),
        discard: async () => undefined,
      },
    });

    const callback = await app.inject({ method: "GET", url: "/api/google-calendar-tasks/callback?code=one&state=two" });
    const connect = await app.inject({ method: "POST", url: "/api/google-calendar-tasks/calendar/connect" });

    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe("/");
    expect(connect.statusCode).toBe(401);
  });

  it("allows browser preflight for PATCH memory controls", async () => {
    const verify = vi.fn(async () => null);
    const app = privateApp({ verify });

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/memory-settings",
      headers: {
        origin: "https://yui.example",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(verify).not.toHaveBeenCalled();
  });

  it("lets the backup cron validate its own secret without treating it as a user token", async () => {
    const verify = vi.fn(async () => null);
    const app = privateApp({ verify });

    const response = await app.inject({
      method: "GET",
      url: "/api/cron/backup",
      headers: { authorization: "Bearer cron-secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("Supabase auth verifier", () => {
  it("normalizes the allowed email and returns only the verified identity", async () => {
    const getUser = vi.fn(async () => ({
      data: { user: { id: "00000000-0000-0000-0000-00000000000a", email: "OWNER@EXAMPLE.COM" } },
      error: null,
    }));
    const verifier = createSupabaseAuthVerifier({ auth: { getUser } }, " owner@example.com ");

    await expect(verifier.verify("secret-token")).resolves.toEqual({
      userId: "00000000-0000-0000-0000-00000000000a",
      email: "owner@example.com",
      accessToken: "secret-token",
    });
  });

  it("rejects a valid Supabase user with a different or missing email", async () => {
    for (const email of ["other@example.com", undefined]) {
      const verifier = createSupabaseAuthVerifier({
        auth: { getUser: async () => ({ data: { user: { id: "user-a", email } }, error: null }) },
      }, "owner@example.com");
      await expect(verifier.verify("secret-token")).resolves.toBeNull();
    }
  });
});
