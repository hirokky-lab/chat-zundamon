import { describe, expect, it, vi } from "vitest";
import { buildHostedApp } from "../src/app";
import type { HostedServerConfig } from "../src/config";
import { makeInMemoryGoogleCalendarTasksConnectionRepository } from "../src/google-calendar-tasks";

const config: HostedServerConfig = {
  mode: "hosted",
  automaticChatMemoryMode: "hosted_authoritative_snapshot",
  openaiApiKey: "openai-test",
  chatModel: "gpt-5.6-luna",
  memoryModel: "gpt-5.6-luna",
  realtimeModel: "gpt-realtime-2.1-mini",
  transcriptionModel: "gpt-4o-mini-transcribe",
  webSearchModel: "gpt-5.6-luna",
  webSearchTimeoutMs: 15_000,
  calendarReadTimeoutMs: 15_000,
  tasksReadTimeoutMs: 15_000,
  port: 3000,
  voicevoxBaseUrls: ["http://127.0.0.1:50121"],
  voicevoxStatusTimeoutMs: 2000,
  voicevoxQueryTimeoutMs: 5000,
  voicevoxSynthesisTimeoutMs: 15000,
  externalToolFlags: {
    web_search: false,
    youtube_search: false,
    calendar_read: false,
    tasks_read: false,
    one_time_reminder: false,
    photo_analysis: false,
    work_assist: false,
    avatar: false,
  },
  supabaseUrl: "https://project.supabase.co",
  supabasePublishableKey: "publishable-test",
  supabaseServiceRoleKey: "service-test",
  allowedEmail: "owner@example.com",
  allowedOrigin: "https://yui.example",
  cronSecret: "cron-test",
  backupKeyBase64: Buffer.alloc(32).toString("base64"),
  blobReadWriteToken: "blob-test",
  costLimits: {
    dailyUsd: 3, monthlyUsd: 10, chatUsd: 0.1, memoryUsd: 0.1, transcriptionUsd: 0.1, realtimeUsd: 1,
    searchUsd: 0.1, calendarUsd: 0.1, notificationUsd: 0.1, imageUsd: 0.1, workUsd: 0.1, avatarUsd: 0.1, storageUsd: 0.1,
  },
};

describe("hosted app", () => {
  it("registers the photo route only through the enabled hosted boundary", async () => {
    const photoConfig = {
      ...config,
      externalToolFlags: { ...config.externalToolFlags, photo_analysis: true },
    };
    const photoRepository = {
      claim: vi.fn(), beginUpload: vi.fn(), completeUpload: vi.fn(), claimAnalysis: vi.fn(), complete: vi.fn(), fail: vi.fn(),
      getActive: vi.fn(), claimCleanup: vi.fn(), markVerified: vi.fn(), getStorageScanCursor: vi.fn(), saveStorageScanCursor: vi.fn(), registerOrphan: vi.fn(),
    };
    const app = buildHostedApp({
      config: photoConfig,
      logger: false,
      authVerifier: { verify: async () => ({ userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" }) },
      memoryRepository: { list: async () => [] },
      profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
      photoRepository,
      photoStorage: {},
      photoAnalysisGateway: { analyze: vi.fn() },
    } as Parameters<typeof buildHostedApp>[0]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/photo-responses",
        headers: { authorization: "Bearer valid", origin: config.allowedOrigin },
      });
      expect(response.statusCode).toBe(400);
      expect(photoRepository.claim).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("does not expose Google read or revoke routes while Calendar and Tasks are OFF", async () => {
    const app = buildHostedApp({
      config,
      logger: false,
      authVerifier: { verify: async () => ({ userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" }) },
      memoryRepository: { list: async () => [] },
      profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
    });
    try {
      for (const url of ["/api/google/calendar", "/api/google/tasks", "/api/google/revoke"]) {
        expect((await app.inject({ method: "GET", url, headers: { authorization: "Bearer valid" } })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("exposes an owner-scoped Google connection repository", async () => {
    const app = buildHostedApp({
      config,
      logger: false,
      authVerifier: { verify: async () => ({ userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" }) },
      memoryRepository: { list: async () => [] },
      profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
    });

    const repository = (app as typeof app & {
      googleCalendarTasksConnectionRepository?: {
        status(user: { userId: string; email: string; accessToken: string }, service: "calendar" | "tasks"): Promise<unknown>;
      };
    }).googleCalendarTasksConnectionRepository;
    expect(repository).toBeDefined();
    await app.close();
  });

  it("exposes both disabled Google runtime states without constructing Google dependencies", async () => {
    const google = {
      parseSecret: vi.fn(),
      createConnectionRepository: vi.fn(),
      createReadGateway: vi.fn(),
    };
    const app = buildHostedApp({
      config,
      logger: false,
      googleCalendarTasksFactory: google,
      authVerifier: { verify: async () => ({ userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" }) },
      memoryRepository: { list: async () => [] },
      profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
    });

    expect((app as typeof app & { googleCalendarTasksRuntime?: unknown }).googleCalendarTasksRuntime).toMatchObject({
      calendarEnabled: false,
      tasksEnabled: false,
      calendarTimeoutMs: 15_000,
      tasksTimeoutMs: 15_000,
      maximumUsd: 0.01,
      quota: { rollingMinute: 8, utcDay: 50 },
    });
    expect(google.parseSecret).not.toHaveBeenCalled();
    expect(google.createConnectionRepository).not.toHaveBeenCalled();
    expect(google.createReadGateway).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses the injected OAuth boundary only when Calendar is enabled", async () => {
    const calendarConfig = {
      ...config,
      externalToolFlags: { ...config.externalToolFlags, calendar_read: true },
    };
    const app = buildHostedApp({
      config: calendarConfig,
      logger: false,
      authVerifier: { verify: async () => ({ userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" }) },
      memoryRepository: { list: async () => [] },
      profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
      googleCalendarTasksConnectionRepository: makeInMemoryGoogleCalendarTasksConnectionRepository(),
      googleOAuthService: {
        begin: async () => ({ authorizationUrl: "https://accounts.google.com/calendar", state: "not-exposed" }),
        complete: async () => ({ status: "rejected" }),
        discard: async () => undefined,
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/google-calendar-tasks/calendar/connect",
        headers: { authorization: "Bearer valid", origin: config.allowedOrigin },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authorizationUrl: "https://accounts.google.com/calendar" });
    } finally {
      await app.close();
    }
  });

  it("starts with injected hosted boundaries and performs no local persistence", async () => {
    const user = { userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" };
    const app = buildHostedApp({
      config,
      logger: false,
      authVerifier: { verify: async () => user },
      memoryRepository: { list: async () => [] },
      profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
    });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const profile = await app.inject({ method: "GET", url: "/api/profile", headers: { authorization: "Bearer valid" } });
    expect(health.statusCode).toBe(200);
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual({ profile: null });
    expect(app.externalTools.flags()).toEqual(config.externalToolFlags);

    for (const url of ["/api/reminders", "/api/reminders/confirm", "/api/reminders/cancel", "/api/push/subscribe"]) {
      const unavailable = await app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer valid", origin: config.allowedOrigin },
        payload: {},
      });
      expect(unavailable.statusCode, url).toBe(404);
    }
  });

  it("reconstructs hosted chat memory from the injected authoritative snapshot repository", async () => {
    const user = { userId: "00000000-0000-0000-0000-00000000000a", email: "owner@example.com", accessToken: "valid" };
    const get = vi.fn(async () => null);
    const app = buildHostedApp({
      config, logger: false, authVerifier: { verify: async () => user },
      chatStateRepository: { get, save: vi.fn(), saveReconciled: vi.fn(), commitPhoto: vi.fn(), deletePhoto: vi.fn(), deleteWholeChat: vi.fn() } as never,
      memoryRepository: { list: async () => [] }, profileRepository: { get: async () => null, save: async () => { throw new Error("unused"); } },
      usageLog: { append: async () => undefined },
    });
    const response = await app.inject({
      method: "POST", url: "/api/memory/process",
      headers: { authorization: "Bearer valid", origin: config.allowedOrigin },
      payload: { sourceMessageId: "message-1", sourceOccurredAt: "2026-08-13T00:00:00.000Z" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ sourceMessageId: "message-1", state: "completed", appliedCount: 0 });
    expect(get).toHaveBeenCalledWith(user);
  });
});
