import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarTasksFetchTransport, createGoogleOAuthRuntime } from "../src/google-oauth-runtime";
import { GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE, GOOGLE_CALENDAR_LIST_READONLY_SCOPE } from "../src/google-calendar-tasks";
import { GoogleCalendarTasksDiagnosticError } from "../src/google-calendar-tasks-diagnostics";

const owner = { userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.test", accessToken: "owner-token" };

describe("hosted Google OAuth runtime", () => {
  it("distinguishes stored credential failure from refresh endpoint failure", async () => {
    const credentialRuntime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => { throw new Error("private encrypted credential body"); },
      },
      http: { post: async () => { throw new Error("must not run"); }, get: async () => { throw new Error("unused"); } },
    });
    const refreshRuntime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: { post: async () => ({ status: 400, readJson: async () => ({ private: "provider body" }) }), get: async () => { throw new Error("unused"); } },
    });

    await expect(credentialRuntime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal }))
      .rejects.toEqual(new GoogleCalendarTasksDiagnosticError("credential"));
    await expect(refreshRuntime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal }))
      .rejects.toEqual(new GoogleCalendarTasksDiagnosticError("refresh"));
  });

  it("keeps cancellation separate from credential and refresh diagnostics", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: { post: async () => { throw new Error("must not run"); }, get: async () => { throw new Error("unused"); } },
    });

    await expect(runtime.tokens.getAccessToken({ owner, service: "calendar", signal: controller.signal }))
      .rejects.toMatchObject({ reason: "unknown", message: "Google Calendar/Tasks response unavailable" });
  });

  it("accepts Google's bounded refresh token expiry metadata without retaining it", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = { alg: "RS256", kid: "test-key", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: "client",
      sub: "subject",
      nonce: "nonce",
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    const idToken = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey).toString("base64url")}`;
    const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "test-key", use: "sig", alg: "RS256" };
    const runtime = createGoogleOAuthRuntime({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined,
        consumeAttemptByStateHashForOwner: async () => null,
        saveConnection: async () => undefined,
        clearConnection: async () => undefined,
        getConnectionForOwner: async () => null,
      },
      http: {
        post: async () => ({
          status: 200,
          readJson: async () => ({
            access_token: "access-token",
            expires_in: 3600,
            id_token: idToken,
            refresh_token: "refresh-token",
            refresh_token_expires_in: 604800,
            scope: `openid ${GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE}`,
            token_type: "Bearer",
          }),
        }),
        get: async () => ({ status: 200, readJson: async () => ({ keys: [jwk] }) }),
      },
    });

    await expect(runtime.exchange.exchange({
      code: "code",
      service: "calendar",
      codeVerifier: Buffer.from("verifier", "ascii"),
      expectedNonceDigest: `sha256:${createHash("sha256").update("nonce", "utf8").digest("hex")}`,
      expectedIssuer: "https://accounts.google.com",
      expectedAudience: "client",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      googleSubject: "subject",
      grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE],
      refreshToken: Buffer.from("refresh-token", "utf8"),
    });
  });

  it("cancels an oversized chunked response before draining its remaining body", async () => {
    let cancelled = false;
    let emitted = 0;
    const chunks = [new Uint8Array(32 * 1024), new Uint8Array(33 * 1024), new Uint8Array(1)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[emitted];
        emitted += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(stream, { headers: { "content-length": "1" } }));
    try {
      const response = await createGoogleCalendarTasksFetchTransport().get({ url: "https://www.googleapis.com/example", method: "GET", redirect: "error", headers: {}, signal: new AbortController().signal });
      await expect(response.json(64 * 1024)).rejects.toThrow("Google OAuth exchange unavailable");
      expect(cancelled).toBe(true);
      expect(emitted).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refreshes a Calendar access token only when the stored scope remains exact", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      readJson: async () => ({ access_token: "access-token", expires_in: 3600, token_type: "Bearer", scope: `openid ${GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE}` }),
    }));
    const runtime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: { post, get: async () => { throw new Error("unused"); } },
    });

    await expect(runtime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal })).resolves.toBe("access-token");
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0].body.get("grant_type")).toBe("refresh_token");
  });

  it("refreshes an expanded Calendar read scope and accepts its returned scopes", async () => {
    const post = vi.fn(async () => ({
      status: 200,
      readJson: async () => ({ access_token: "access-token", expires_in: 3600, token_type: "Bearer", scope: `openid ${GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE} ${GOOGLE_CALENDAR_LIST_READONLY_SCOPE}` }),
    }));
    const runtime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE, GOOGLE_CALENDAR_LIST_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: { post, get: async () => { throw new Error("unused"); } },
    });

    await expect(runtime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal })).resolves.toBe("access-token");
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0].body.get("grant_type")).toBe("refresh_token");
  });

  it("accepts Google OpenID refresh metadata without retaining it", async () => {
    const runtime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: {
        post: async () => ({
          status: 200,
          readJson: async () => ({
            access_token: "access-token",
            expires_in: 3600,
            id_token: "signed-id-token-is-not-retained",
            refresh_token_expires_in: 604800,
            scope: `openid ${GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE}`,
            token_type: "Bearer",
          }),
        }),
        get: async () => { throw new Error("unused"); },
      },
    });

    await expect(runtime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal }))
      .resolves.toBe("access-token");
  });

  it.each([
    { id_token: "", refresh_token_expires_in: 604800 },
    { id_token: "signed-id-token", refresh_token_expires_in: 0 },
    { id_token: "signed-id-token", refresh_token_expires_in: 1.5 },
    { id_token: "signed-id-token", refresh_token_expires_in: Number.MAX_SAFE_INTEGER + 1 },
    { id_token: "signed-id-token", refresh_token_expires_in: "604800" },
  ])("rejects malformed optional OpenID refresh metadata", async (metadata) => {
    const runtime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: {
        post: async () => ({ status: 200, readJson: async () => ({ access_token: "access-token", expires_in: 3600, token_type: "Bearer", ...metadata }) }),
        get: async () => { throw new Error("unused"); },
      },
    });

    await expect(runtime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal }))
      .rejects.toEqual(new GoogleCalendarTasksDiagnosticError("refresh"));
  });

  it("fails closed when the provider reports an expanded refresh scope", async () => {
    const runtime = createGoogleOAuthRuntime({
      clientId: "client", clientSecret: "secret", redirectUri: "https://preview.example.test/api/google-calendar-tasks/callback",
      repository: {
        createAttempt: async () => undefined, consumeAttemptByStateHashForOwner: async () => null, saveConnection: async () => undefined, clearConnection: async () => undefined,
        getConnectionForOwner: async () => ({ ownerId: owner.userId, service: "calendar", googleSubject: "subject", grantedScopes: ["openid", GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE], refreshToken: Buffer.from("refresh", "utf8") }),
      },
      http: { post: async () => ({ status: 200, readJson: async () => ({ access_token: "access-token", expires_in: 3600, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/calendar" }) }), get: async () => { throw new Error("unused"); } },
    });

    await expect(runtime.tokens.getAccessToken({ owner, service: "calendar", signal: new AbortController().signal }))
      .rejects.toMatchObject({ reason: "refresh", message: "Google Calendar/Tasks response unavailable" });
  });
});
