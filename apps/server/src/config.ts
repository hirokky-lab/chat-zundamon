import { z } from "zod";
import type { ExternalToolFlags } from "./external-tools.js";

declare const process: { env: Record<string, string | undefined> };

const localVoicevoxUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "http:" &&
    !url.username &&
    !url.password &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}, "ZUNDAMON_VOICEVOX_BASE_URL must be a credential-free local HTTP URL");

const positiveDecimal = z.coerce.number().finite().positive();

const commonSchema = z.object({
  chatModel: z.literal("gpt-5.6-luna"),
  memoryModel: z.literal("gpt-5.6-luna"),
  openaiApiKey: z.string().min(1),
  port: z.coerce.number().int().positive(),
  realtimeModel: z.literal("gpt-realtime-2.1-mini"),
  transcriptionModel: z.literal("gpt-4o-mini-transcribe"),
  webSearchModel: z.literal("gpt-5.6-luna"),
  webSearchTimeoutMs: z.coerce.number().int().positive(),
  calendarReadTimeoutMs: z.coerce.number().int().positive(),
  tasksReadTimeoutMs: z.coerce.number().int().positive(),
  voicevoxBaseUrls: z.array(localVoicevoxUrl).min(1),
  voicevoxStatusTimeoutMs: z.coerce.number().int().positive(),
  voicevoxQueryTimeoutMs: z.coerce.number().int().positive(),
  voicevoxSynthesisTimeoutMs: z.coerce.number().int().positive(),
});

type CommonConfig = z.infer<typeof commonSchema> & {
  sakuraAiApiKey?: string;
  externalToolFlags: ExternalToolFlags;
  integratedUiEnabled: boolean;
  prismEchoEnabled: boolean;
  googleAssistantWrite?: {calendar:boolean;tasks:boolean};
};
export type CostLimits = {
  dailyUsd: number;
  monthlyUsd: number;
  chatUsd: number;
  memoryUsd: number;
  transcriptionUsd: number;
  realtimeUsd: number;
  searchUsd: number;
  calendarUsd: number;
  notificationUsd: number;
  imageUsd: number;
  workUsd: number;
  avatarUsd: number;
  storageUsd: number;
};
export type LocalServerConfig = CommonConfig & {
  mode: "local";
  automaticChatMemoryMode: "disabled";
  dbPath: string;
  usageLogPath: string;
};
export type HostedServerConfig = CommonConfig & {
  mode: "hosted";
  automaticChatMemoryMode: "hosted_authoritative_snapshot";
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseServiceRoleKey: string;
  allowedEmail: string;
  allowedOrigin: string;
  cronSecret: string;
  backupKeyBase64: string;
  blobReadWriteToken?: string;
  costLimits: CostLimits;
  googleOAuth?: {
    clientId: string;
    clientSecret: string;
    tokenKey: Buffer;
    keyVersion: string;
    redirectUri: string;
  };
};
export type ServerConfig = LocalServerConfig | HostedServerConfig;

export function loadConfig(env = process.env): ServerConfig {
  const parsedCommon = commonSchema.parse({
    chatModel: "gpt-5.6-luna",
    memoryModel: "gpt-5.6-luna",
    openaiApiKey: env.ZUNDAMON_OPENAI_API_KEY,
    port: env.ZUNDAMON_PORT ?? "4384",
    realtimeModel: "gpt-realtime-2.1-mini",
    transcriptionModel: "gpt-4o-mini-transcribe",
    webSearchModel: "gpt-5.6-luna",
    webSearchTimeoutMs: env.ZUNDAMON_WEB_SEARCH_TIMEOUT_MS ?? "15000",
    calendarReadTimeoutMs: env.ZUNDAMON_CALENDAR_READ_TIMEOUT_MS ?? "15000",
    tasksReadTimeoutMs: env.ZUNDAMON_TASKS_READ_TIMEOUT_MS ?? "15000",
    voicevoxBaseUrls: uniqueVoicevoxBaseUrls(env.ZUNDAMON_VOICEVOX_BASE_URL),
    voicevoxStatusTimeoutMs: env.ZUNDAMON_VOICEVOX_STATUS_TIMEOUT_MS ?? "2000",
    voicevoxQueryTimeoutMs: env.ZUNDAMON_VOICEVOX_QUERY_TIMEOUT_MS ?? "5000",
    voicevoxSynthesisTimeoutMs: env.ZUNDAMON_VOICEVOX_SYNTHESIS_TIMEOUT_MS ?? "15000",
  });
  const common: CommonConfig = {
    ...parsedCommon,
    sakuraAiApiKey: env.ZUNDAMON_SAKURA_AI_API_KEY?.trim() || undefined,
    integratedUiEnabled: env.ZUNDAMON_INTEGRATED_UI_ENABLED === "true",
    prismEchoEnabled: env.ZUNDAMON_PRISM_ECHO_ENABLED === "true",
    googleAssistantWrite: {calendar:env.ZUNDAMON_CALENDAR_WRITE_ENABLED === "true", tasks:env.ZUNDAMON_TASKS_WRITE_ENABLED === "true"},
    externalToolFlags: {
      web_search: env.ZUNDAMON_WEB_SEARCH_ENABLED === "true",
      youtube_search: env.ZUNDAMON_YOUTUBE_SEARCH_ENABLED === "true",
      calendar_read: env.ZUNDAMON_CALENDAR_READ_ENABLED === "true",
      tasks_read: env.ZUNDAMON_TASKS_READ_ENABLED === "true",
      one_time_reminder: env.ZUNDAMON_ONE_TIME_REMINDER_ENABLED === "true",
      photo_analysis: env.ZUNDAMON_PHOTO_ANALYSIS_ENABLED === "true",
      avatar: env.ZUNDAMON_AVATAR_ENABLED === "true",
    },
  };

  if (env.ZUNDAMON_MODE !== "hosted") {
    return {
      ...common,
      mode: "local",
      automaticChatMemoryMode: "disabled",
      dbPath: z.string().min(1).parse(env.ZUNDAMON_DB_PATH ?? "./data/zundamon-ai.sqlite"),
      usageLogPath: z.string().min(1).parse(env.ZUNDAMON_USAGE_LOG_PATH ?? "./data/zundamon-usage.ndjson"),
    };
  }

  const backupKeyBase64 = z.string().min(1).parse(env.ZUNDAMON_BACKUP_KEY);
  if (!isExactly32ByteBase64(backupKeyBase64)) throw new Error("Invalid ZUNDAMON_BACKUP_KEY");
  return {
    ...common,
    mode: "hosted",
    automaticChatMemoryMode: "hosted_authoritative_snapshot",
    supabaseUrl: z.url().parse(env.ZUNDAMON_SUPABASE_URL),
    supabasePublishableKey: z.string().min(1).parse(env.ZUNDAMON_SUPABASE_PUBLISHABLE_KEY),
    supabaseServiceRoleKey: z.string().min(1).parse(env.ZUNDAMON_SUPABASE_SERVICE_ROLE_KEY),
    allowedEmail: z.email().transform((value) => value.toLowerCase()).parse(env.ZUNDAMON_ALLOWED_EMAIL),
    allowedOrigin: z.url().parse(env.ZUNDAMON_ALLOWED_ORIGIN),
    cronSecret: z.string().min(1).parse(env.ZUNDAMON_CRON_SECRET),
    backupKeyBase64,
    blobReadWriteToken: undefined, // Legacy setting is no longer used for backups.
    googleOAuth: hostedGoogleOAuth(env, env.ZUNDAMON_ALLOWED_ORIGIN),
    costLimits: {
      dailyUsd: positiveDecimal.parse(env.ZUNDAMON_DAILY_MAX_USD ?? "3"),
      monthlyUsd: positiveDecimal.parse(env.ZUNDAMON_MONTHLY_MAX_USD ?? "10"),
      chatUsd: positiveDecimal.parse(env.ZUNDAMON_CHAT_MAX_USD ?? "0.10"),
      memoryUsd: positiveDecimal.parse(env.ZUNDAMON_MEMORY_MAX_USD ?? "0.10"),
      transcriptionUsd: positiveDecimal.parse(env.ZUNDAMON_TRANSCRIPTION_MAX_USD ?? "0.10"),
      realtimeUsd: positiveDecimal.parse(env.ZUNDAMON_REALTIME_MAX_USD ?? "1"),
      searchUsd: positiveDecimal.parse(env.ZUNDAMON_SEARCH_MAX_USD ?? "0.10"),
      calendarUsd: positiveDecimal.parse(env.ZUNDAMON_CALENDAR_MAX_USD ?? "0.10"),
      notificationUsd: positiveDecimal.parse(env.ZUNDAMON_NOTIFICATION_MAX_USD ?? "0.10"),
      imageUsd: positiveDecimal.parse(env.ZUNDAMON_IMAGE_MAX_USD ?? "0.10"),
      workUsd: positiveDecimal.parse(env.ZUNDAMON_WORK_MAX_USD ?? "0.10"),
      avatarUsd: positiveDecimal.parse(env.ZUNDAMON_AVATAR_MAX_USD ?? "0.10"),
      storageUsd: positiveDecimal.parse(env.ZUNDAMON_STORAGE_MAX_USD ?? "0.10"),
    },
  };
}

export function hostedGoogleOAuth(env: Record<string, string | undefined>, allowedOrigin: string | undefined): HostedServerConfig["googleOAuth"] {
  const clientId = env.ZUNDAMON_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.ZUNDAMON_GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const tokenKeyBase64 = env.ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_B64;
  const keyVersion = env.ZUNDAMON_GOOGLE_OAUTH_TOKEN_KEY_VERSION?.trim();
  if (!clientId || !clientSecret || !tokenKeyBase64 || !keyVersion || !allowedOrigin) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,64}$/u.test(keyVersion) || !isExactly32ByteBase64(tokenKeyBase64)) return undefined;
  try {
    return {
      clientId,
      clientSecret,
      tokenKey: Buffer.from(tokenKeyBase64, "base64"),
      keyVersion,
      redirectUri: new URL("/api/google-calendar-tasks/callback", z.url().parse(allowedOrigin)).toString(),
    };
  } catch {
    return undefined;
  }
}

function isExactly32ByteBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}

function uniqueVoicevoxBaseUrls(override: string | undefined): string[] {
  return [...new Set([
    ...(override ? [override] : []),
    "http://127.0.0.1:50121",
    "http://127.0.0.1:50021",
  ])];
}
