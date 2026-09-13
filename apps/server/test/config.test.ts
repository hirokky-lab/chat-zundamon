import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("transcription configuration", () => {
  it("documents only the four non-secret Calendar and Tasks OFF preparation values", () => {
    const env = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(env).toContain("ZUNDAMON_CALENDAR_READ_ENABLED=false");
    expect(env).toContain("ZUNDAMON_TASKS_READ_ENABLED=false");
    expect(env).toContain("ZUNDAMON_CALENDAR_READ_TIMEOUT_MS=15000");
    expect(env).toContain("ZUNDAMON_TASKS_READ_TIMEOUT_MS=15000");
    expect(env).not.toMatch(/GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|VITE_.*GOOGLE.*SECRET/u);
  });

  it("keeps every costed OpenAI model fixed to its pricing table", () => {
    const config = loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "test-key",
      OPENAI_MEMORY_MODEL: "unpriced-memory-model",
      OPENAI_REALTIME_MODEL: "unpriced-realtime-model",
    });
    expect(config.memoryModel).toBe("gpt-5.6-luna");
    expect(config.realtimeModel).toBe("gpt-realtime-2.1-mini");
    expect(config.webSearchModel).toBe("gpt-5.6-luna");
    expect(config.webSearchTimeoutMs).toBe(15_000);
    expect(config.calendarReadTimeoutMs).toBe(15_000);
    expect(config.tasksReadTimeoutMs).toBe(15_000);
  });

  it("moves the local YUI default away from the fixed dashboard projection port and enables that adapter only with a valid local token", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" })).toMatchObject({ mode: "local", port: 4384, dashboardProjection: undefined });
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_DASHBOARD_PROJECTION_TOKEN: "a".repeat(32), ZUNDAMON_DASHBOARD_MIN_GENERATION: "2" }))
      .toMatchObject({ dashboardProjection: { minimumGeneration: 2 } });
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_DASHBOARD_PROJECTION_TOKEN: "invalid" })).toMatchObject({ dashboardProjection: undefined });
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_DASHBOARD_PROJECTION_TOKEN: "a".repeat(32) }))
      .toMatchObject({ dashboardProjection: undefined });
  });

  it("rejects an invalid web-search timeout without changing the fixed model", () => {
    expect(() => loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_WEB_SEARCH_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_CALENDAR_READ_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_TASKS_READ_TIMEOUT_MS: "0" })).toThrow();
    expect(loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "test-key",
      OPENAI_WEB_SEARCH_MODEL: "unpriced-model",
      ZUNDAMON_WEB_SEARCH_TIMEOUT_MS: "25000",
    })).toMatchObject({ webSearchModel: "gpt-5.6-luna", webSearchTimeoutMs: 25_000 });
  });

  it("keeps the transcription model fixed to the priced ASR model", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" }).transcriptionModel)
      .toBe("gpt-4o-mini-transcribe");
    expect(loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "test-key",
      OPENAI_TRANSCRIPTION_MODEL: "unpriced-model",
    }).transcriptionModel).toBe("gpt-4o-mini-transcribe");
  });

  it("keeps every cross-functional feature OFF unless its own exact flag is enabled", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" }).integratedUiEnabled).toBe(false);
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_INTEGRATED_UI_ENABLED: "TRUE" }).integratedUiEnabled).toBe(false);
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_INTEGRATED_UI_ENABLED: "true" }).integratedUiEnabled).toBe(true);
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" }).prismEchoEnabled).toBe(false);
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_PRISM_ECHO_ENABLED: "TRUE" }).prismEchoEnabled).toBe(false);
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_PRISM_ECHO_ENABLED: "true" }).prismEchoEnabled).toBe(true);
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" }).externalToolFlags).toEqual({
      web_search: false,
      youtube_search: false,
      calendar_read: false,
      tasks_read: false,
      one_time_reminder: false,
      photo_analysis: false,
      work_assist: false,
      avatar: false,
    });
    expect(loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "test-key",
      ZUNDAMON_WEB_SEARCH_ENABLED: "true",
      ZUNDAMON_CALENDAR_READ_ENABLED: "TRUE",
      ZUNDAMON_TASKS_READ_ENABLED: "true",
      ZUNDAMON_ONE_TIME_REMINDER_ENABLED: "TRUE",
    }).externalToolFlags).toMatchObject({
      web_search: true,
      calendar_read: false,
      tasks_read: true,
      one_time_reminder: false,
    });
    expect(loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "test-key",
      ZUNDAMON_ONE_TIME_REMINDER_ENABLED: "true",
    }).externalToolFlags.one_time_reminder).toBe(true);
  });

  it("documents the one-time reminder flag as OFF without adding provider configuration", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(example).toContain("ZUNDAMON_ONE_TIME_REMINDER_ENABLED=false");
    expect(example).not.toMatch(/(?:VAPID|APNS|PUSH_PROVIDER|REMINDER_HMAC)/);
  });

  it("fixes local chat automatic memory off and hosted reconstruction on regardless of legacy env", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key", YUI_AUTOMATIC_CHAT_MEMORY_MODE: "enabled" }))
      .toMatchObject({ mode: "local", automaticChatMemoryMode: "disabled" });
    expect(loadConfig({
      ZUNDAMON_MODE: "hosted", ZUNDAMON_OPENAI_API_KEY: "test-key", ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
      ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable", ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY: "service", ZUNDAMON_ALLOWED_EMAIL: "owner@example.com",
      ZUNDAMON_ALLOWED_ORIGIN: "https://yui.example", ZUNDAMON_CRON_SECRET: "cron", ZUNDAMON_BACKUP_KEY: Buffer.alloc(32).toString("base64"), ZUNDAMON_BLOB_READ_WRITE_TOKEN: "blob",
      YUI_AUTOMATIC_CHAT_MEMORY_MODE: "disabled",
    })).toMatchObject({ mode: "hosted", automaticChatMemoryMode: "hosted_authoritative_snapshot" });
  });

  it("orders a VOICEVOX override before Nemo and standard loopback endpoints without duplicates", () => {
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" }).voicevoxBaseUrls).toEqual([
      "http://127.0.0.1:50121", "http://127.0.0.1:50021",
    ]);
    expect(loadConfig({
      ZUNDAMON_OPENAI_API_KEY: "test-key",
      ZUNDAMON_VOICEVOX_BASE_URL: "http://127.0.0.1:50021",
    }).voicevoxBaseUrls).toEqual([
      "http://127.0.0.1:50021", "http://127.0.0.1:50121",
    ]);
  });
});

describe("hosted configuration", () => {
  const validHostedEnv = {
    ZUNDAMON_MODE: "hosted",
    ZUNDAMON_OPENAI_API_KEY: "openai-placeholder",
    ZUNDAMON_SUPABASE_URL: "https://project.supabase.co",
    ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: "publishable-placeholder",
    ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY: "service-role-placeholder",
    ZUNDAMON_ALLOWED_EMAIL: "owner@example.com",
    ZUNDAMON_ALLOWED_ORIGIN: "https://yui.example",
    ZUNDAMON_CRON_SECRET: "cron-placeholder",
    ZUNDAMON_BACKUP_KEY: Buffer.alloc(32, 7).toString("base64"),
    ZUNDAMON_BLOB_READ_WRITE_TOKEN: "blob-placeholder",
  };

  it("starts hosted configuration without a Vercel token", () => {
    expect(() => loadConfig({ ...validHostedEnv, ZUNDAMON_BLOB_READ_WRITE_TOKEN: undefined })).not.toThrow();
  });

  it("requires every hosted secret and a 32-byte backup key", () => {
    expect(() => loadConfig({ ...validHostedEnv, ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow();
    expect(() => loadConfig({ ...validHostedEnv, ZUNDAMON_BACKUP_KEY: Buffer.alloc(31).toString("base64") })).toThrow();
    expect(() => loadConfig({ ...validHostedEnv, ZUNDAMON_BACKUP_KEY: "not-base64" })).toThrow();
  });

  it("parses hosted identity, origin, and fixed self-use cost defaults", () => {
    const config = loadConfig(validHostedEnv);
    expect(config).toMatchObject({
      mode: "hosted",
      supabaseUrl: "https://project.supabase.co",
      allowedEmail: "owner@example.com",
      allowedOrigin: "https://yui.example",
      costLimits: {
        dailyUsd: 3,
        monthlyUsd: 10,
        chatUsd: 0.1,
        memoryUsd: 0.1,
        transcriptionUsd: 0.1,
        realtimeUsd: 1,
        searchUsd: 0.1,
        calendarUsd: 0.1,
        notificationUsd: 0.1,
        imageUsd: 0.1,
        workUsd: 0.1,
        avatarUsd: 0.1,
        storageUsd: 0.1,
      },
    });
    expect(config).not.toHaveProperty("dashboardProjection");
  });

  it("accepts only positive cost overrides and keeps local SQLite defaults", () => {
    expect(loadConfig({ ...validHostedEnv, ZUNDAMON_DAILY_MAX_USD: "1.25" }).costLimits.dailyUsd).toBe(1.25);
    expect(() => loadConfig({ ...validHostedEnv, ZUNDAMON_CHAT_MAX_USD: "0" })).toThrow();
    expect(loadConfig({ ZUNDAMON_OPENAI_API_KEY: "test-key" })).toMatchObject({
      mode: "local",
      dbPath: "./data/zundamon-ai.sqlite",
      usageLogPath: "./data/zundamon-usage.ndjson",
    });
  });

  it("enables the Google OAuth runtime only with a complete server-only credential set", () => {
    const key = Buffer.alloc(32, 9).toString("base64");
    expect(loadConfig({ ...validHostedEnv, ZUNDAMON_GOOGLE_OAUTH_CLIENT_ID: "client-id" }))
      .toMatchObject({ mode: "hosted", googleOAuth: undefined });

    expect(loadConfig({
      ...validHostedEnv,
      ZUNDAMON_GOOGLE_OAUTH_CLIENT_ID: "client-id",
      ZUNDAMON_GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_B64: key,
      ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_VERSION: "r1",
    })).toMatchObject({
      mode: "hosted",
      googleOAuth: { clientId: "client-id", keyVersion: "r1" },
    });
  });
});
