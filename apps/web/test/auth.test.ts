import { describe, expect, it, vi } from "vitest";
import { createSupabaseAuthClient } from "../src/auth";
import { AuthExpiredError, createAuthorizedFetch } from "../src/authorized-fetch";
import { loadHostedBrowserConfig, parseHostedBrowserConfig } from "../src/hosted-config";

const session = {
  access_token: "token-1",
  user: { id: "user-1", email: "owner@example.com" },
};

describe("browser authentication", () => {
  it.each([null, new Error("provider private detail")])("uses Google with only the current origin root as redirect and masks failures %#", async (error) => {
    window.history.replaceState({}, "", "/private?next=https://untrusted.example/#secret");
    const signInWithOAuth = vi.fn(async () => ({ data: {}, error }));
    const client = createSupabaseAuthClient({ auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async () => ({ data: { session }, error: null }),
      signInWithOtp: async () => ({ data: {}, error: null }),
      verifyOtp: async () => ({ data: { session }, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithOAuth,
    } });
    try {
      if (error) await expect(client.signInWithGoogle!()).rejects.toThrow("Authentication failed");
      else await expect(client.signInWithGoogle!()).resolves.toBeUndefined();
      expect(signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: `${window.location.origin}/` } });
    } finally { window.history.replaceState({}, "", "/"); }
  });

  it("uses non-registering email OTP and returns only the safe session fields", async () => {
    const signInWithOtp = vi.fn(async () => ({ data: {}, error: null }));
    const verifyOtp = vi.fn(async () => ({ data: { session }, error: null }));
    const client = createSupabaseAuthClient({
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        signInWithPassword: async () => ({ data: { session }, error: null }),
        signInWithOtp,
        verifyOtp,
        updateUser: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    });

    await client.requestOtp("owner@example.com");
    const verified = await client.verifyOtp("owner@example.com", "123456");

    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "owner@example.com",
      options: { shouldCreateUser: false },
    });
    expect(verifyOtp).toHaveBeenCalledWith({ email: "owner@example.com", token: "123456", type: "email" });
    expect(verified).toEqual({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
  });

  it("does not accept a Supabase session without a verified email identity", async () => {
    const client = createSupabaseAuthClient({
      auth: {
        getSession: async () => ({ data: { session: { ...session, user: { id: "user-1" } } }, error: null }),
        signInWithPassword: async () => ({ data: { session: null }, error: null }),
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async () => ({ data: { session: null }, error: null }),
        updateUser: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    });

    await expect(client.getSession()).resolves.toBeNull();
    await expect(client.verifyOtp("owner@example.com", "000000")).rejects.toThrow("Authentication failed");
  });

  it("signs in and changes the password without leaving the installed app", async () => {
    const signInWithPassword = vi.fn(async () => ({ data: { session }, error: null }));
    const updateUser = vi.fn(async () => ({ data: {}, error: null }));
    const client = createSupabaseAuthClient({
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        signInWithPassword,
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async () => ({ data: { session: null }, error: null }),
        updateUser,
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      },
    });

    await expect(client.signInWithPassword("OWNER@example.com", "long-password"))
      .resolves.toEqual({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    await expect(client.updatePassword("new-long-password")).resolves.toBeUndefined();

    expect(signInWithPassword).toHaveBeenCalledWith({ email: "owner@example.com", password: "long-password" });
    expect(updateUser).toHaveBeenCalledWith({ password: "new-long-password" });
  });
});

describe("authorized API fetch", () => {
  it("keeps API requests relative when the hosted API base is same-origin", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const authorized = createAuthorizedFetch({
      apiBaseUrl: "",
      getSession: async () => ({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" }),
      fetchImpl,
    });

    await authorized("/api/profile", { method: "PUT" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/profile");
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("reads the latest token for every API request and preserves multipart boundaries", async () => {
    let token = "first";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const authorized = createAuthorizedFetch({
      apiBaseUrl: "https://api.yui.example/",
      getSession: async () => ({ accessToken: token, userId: "user-1", email: "owner@example.com" }),
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(null, { status: 204 });
      },
    });

    await authorized("/api/profile");
    token = "second";
    const form = new FormData();
    form.append("audio", new Blob(["voice"], { type: "audio/webm" }), "voice.webm");
    await authorized("/api/chat/transcriptions", { method: "POST", body: form, signal: new AbortController().signal });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.yui.example/api/profile",
      "https://api.yui.example/api/chat/transcriptions",
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer first");
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBe("Bearer second");
    expect(new Headers(requests[1]?.init?.headers).has("Content-Type")).toBe(false);
    expect(requests[1]?.init?.body).toBe(form);
    expect(requests[1]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a 401 into an auth-expired signal without exposing the response body", async () => {
    const onAuthExpired = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const authorized = createAuthorizedFetch({
      apiBaseUrl: "https://api.yui.example",
      getSession: async () => ({ accessToken: "expired", userId: "user-1", email: "owner@example.com" }),
      onAuthExpired,
      fetchImpl: async () => ({ status: 401, ok: false, body: { cancel } } as unknown as Response),
    });

    await expect(authorized("/api/realtime/calls", { method: "POST" })).rejects.toBeInstanceOf(AuthExpiredError);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not call the API when there is no current session", async () => {
    const fetchImpl = vi.fn();
    const authorized = createAuthorizedFetch({
      apiBaseUrl: "https://api.yui.example",
      getSession: async () => null,
      fetchImpl,
    });

    await expect(authorized("/api/profile")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("hosted browser configuration", () => {
  it("keeps complete static hosted configuration without a runtime request", async () => {
    const fetchImpl = vi.fn();

    await expect(loadHostedBrowserConfig({
      VITE_ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
      VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable",
      VITE_ZUNDAMON_API_BASE_URL: "/",
    }, fetchImpl)).resolves.toEqual({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      apiBaseUrl: "",
      photoAnalysisEnabled: false,
      integratedUiEnabled: false,
      prismEchoEnabled: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads public browser settings once from the protected same origin", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      photoAnalysisEnabled: true,
      prismEchoEnabled: true,
      integratedUiEnabled: true,
    }));

    await expect(loadHostedBrowserConfig({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl)).resolves.toEqual({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      apiBaseUrl: "",
      photoAnalysisEnabled: true,
      prismEchoEnabled: true,
      integratedUiEnabled: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/browser-config", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it("does not read a failed runtime configuration response body", async () => {
    const json = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json }) as unknown as Response);

    await expect(loadHostedBrowserConfig({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl))
      .rejects.toThrow("Hosted browser configuration is unavailable");
    expect(json).not.toHaveBeenCalled();
  });

  it("bounds the runtime configuration request and fails closed on timeout", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      });

      const result = loadHostedBrowserConfig({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl, 25);
      const failure = expect(result).rejects.toThrow("Hosted browser configuration is unavailable");
      expect(requestSignal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(25);
      await failure;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout active while the runtime configuration body is read", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          json: () => new Promise<unknown>((_resolve, reject) => {
            requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }),
        } as Response;
      });

      const result = loadHostedBrowserConfig({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl, 25);
      const failure = expect(result).rejects.toThrow("Hosted browser configuration is unavailable");
      await vi.advanceTimersByTimeAsync(25);
      await failure;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {},
    { supabaseUrl: "http://project.supabase.co", supabasePublishableKey: "publishable" },
    { supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "" },
    { supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "publishable", photoAnalysisEnabled: false, prismEchoEnabled: false, integratedUiEnabled: false, extra: "unknown" },
    { supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "publishable", photoAnalysisEnabled: false },
    { supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "publishable", photoAnalysisEnabled: false, prismEchoEnabled: "true" },
    { supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "publishable", photoAnalysisEnabled: false, prismEchoEnabled: false, integratedUiEnabled: "true" },
  ])("fails closed for an invalid runtime browser configuration %#", async (body) => {
    const fetchImpl = vi.fn(async () => Response.json(body));

    await expect(loadHostedBrowserConfig({ VITE_ZUNDAMON_API_BASE_URL: "/" }, fetchImpl))
      .rejects.toThrow("Hosted browser configuration is invalid");
  });

  it("uses same-origin API paths only for the exact slash sentinel", () => {
    expect(parseHostedBrowserConfig({
      VITE_ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
      VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable",
      VITE_ZUNDAMON_API_BASE_URL: "/",
    })).toEqual({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      apiBaseUrl: "",
      photoAnalysisEnabled: false,
      integratedUiEnabled: false,
      prismEchoEnabled: false,
    });
  });

  it.each(["//", "/api", "/api/", "profile"])("rejects unsafe relative API base %s", (apiBaseUrl) => {
    expect(() => parseHostedBrowserConfig({
      VITE_ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
      VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable",
      VITE_ZUNDAMON_API_BASE_URL: apiBaseUrl,
    })).toThrow("Hosted browser configuration is invalid");
  });

  it("enables hosted mode only when every public browser setting is present", () => {
    expect(parseHostedBrowserConfig({})).toBeNull();
    expect(parseHostedBrowserConfig({
      VITE_ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
      VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable",
      VITE_ZUNDAMON_API_BASE_URL: "https://api.yui.example/",
    })).toEqual({
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "publishable",
      apiBaseUrl: "https://api.yui.example",
      photoAnalysisEnabled: false,
      integratedUiEnabled: false,
      prismEchoEnabled: false,
    });
    expect(() => parseHostedBrowserConfig({ VITE_ZUNDAMON_SUPABASE_URL: "https://project.supabase.co" }))
      .toThrow("Hosted browser configuration is incomplete");
  });

  it("rejects non-HTTPS hosted origins before rendering the app", () => {
    expect(() => parseHostedBrowserConfig({
      VITE_ZUNDAMON_SUPABASE_URL: "http://project.supabase.co",
      VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable",
      VITE_ZUNDAMON_API_BASE_URL: "https://api.yui.example",
    })).toThrow("Hosted browser configuration is invalid");
  });
});
