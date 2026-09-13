import {registerGoogleWrites,type GoogleWrites} from './google-writes.js';
import {registerGmailRoutes,type GmailService} from './gmail.js';
import type {GmailAssistantGateway} from './gmail-assistant.js';
import type {DriveSummaryGateway} from './drive-summary.js';
import {registerGoogleDriveRoutes,type DriveService} from './google-drive.js';
import { createSupabaseBackupStore } from "./supabase-backup-store.js";
import {createSakuraSpeechGateway, registerSakuraSpeechRoutes, type SakuraSpeechGateway} from "./sakura-speech.js";
import { createHostedLifeServices } from './life-settings-hosted.js';
import { registerLifeSettingsRoutes } from './life-settings-routes.js';
import { createHostedGoogleAssistantService } from './google-assistant-hosted.js';
import { registerGoogleAssistantRoutes, type GoogleAssistantService } from './google-assistant.js';
import { createTalkLifeRouter } from './talk-life-router.js';
import { createOpenAITalkLifeIntentGateway, type TalkLifeIntentGateway } from './talk-life-intent.js';
import Fastify from "fastify";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { loadConfig } from "./config.js";
import { createMemoryRepository, makeTestRepository, MEMORY_ACTION_LEASE_MS } from "./db.js";
import type { MemoryRepository } from "./db.js";
import { createOpenAIMemoryExtractor } from "./memory-extractor.js";
import type { MemoryExtractor } from "./memory-extractor.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import {
  createOpenAIRealtimeGateway,
  registerRealtimeRoutes,
} from "./realtime.js";
import type { RealtimeGateway } from "./realtime.js";
import {
  createDiscardingUsageLog,
  createNdjsonUsageLog,
  registerUsageRoute,
} from "./usage-log.js";
import type { UsageLog } from "./usage-log.js";
import { createProfileRepository } from "./profile-db.js";
import type { ProfileRepository } from "./profile-db.js";
import { registerProfileRoutes } from "./profile-routes.js";
import { createOpenAIChatGateway, registerChatRoutes } from "./chat.js";
import type { ChatGateway } from "./chat.js";
import { createOpenAIWebSearchGateway, type WebSearchGateway } from "./web-search.js";
import {
  createOpenAITranscriptionGateway,
  registerTranscriptionRoutes,
} from "./transcription.js";
import type { TranscriptionGateway } from "./transcription.js";
import { LOCAL_USER, type RequestUser } from "./request-user.js";
import { registerAuthentication } from "./auth.js";
import type { AuthVerifier } from "./auth.js";
import { createSupabaseAuthVerifier } from "./auth.js";
import { registerBrowserConfigRoute, type BrowserConfig } from "./browser-config.js";
import type { HostedServerConfig } from "./config.js";
import {
  createSupabaseChatStateRepository,
  createSupabaseMemoryRepository,
  createSupabaseMemorySettingsRepository,
  createSupabaseProfileRepository,
  createSupabaseUsageLog,
} from "./hosted-repositories.js";
import {
  createSupabaseAuthClient,
  createSupabaseServiceMutationClientFactory,
  createSupabaseUserClientFactory,
  createSupabasePhotoServiceClient,
} from "./supabase-client.js";
import { createSupabasePhotoRepository, type PhotoRepository } from "./photo-repository.js";
import { createOpenAIPhotoAnalysisGateway, registerPhotoRoutes, type PhotoAnalysisGateway } from "./photo.js";
import { createSupabasePhotoStorage, type PhotoStorage } from "./photo-storage.js";
import { TtsProviderError } from "./tts.js";
import type { TtsProvider } from "./tts.js";
import { createVoicevoxNemoProvider } from "./voicevox-nemo.js";
import { z } from "zod";
import {
  createSupabaseCostGuard,
  createUnlimitedCostGuard,
  type CostGuard,
} from "./cost-guard.js";
import type { CostLimits } from "./config.js";
import { registerChatStateRoutes, type ChatStateRepository } from "./chat-state-routes.js";
import { createWriteGate, type WriteGate } from "./write-gate.js";
import {
  createSupabaseMigrationImporter,
  registerMigrationExportRoute,
  registerMigrationImportRoute,
  type MigrationImporter,
} from "./migration-routes.js";
import {
  createBackupService,
  createSupabaseBackupRepository,
  registerBackupRoute,
  type BackupService,
} from "./backup.js";
import { MemoryProcessor, type AutomaticMemoryTelemetry } from "./memory-processor.js";
import { AuthoritativeMemoryTurnSource, type AutomaticMemorySourceResult } from "./memory-turn-source.js";
import { createMemoryRetriever } from "./memory-retriever.js";
import { createMemorySettingsRepository, registerMemorySettingsRoutes, type MemorySettingsRepository } from "./memory-settings.js";
import { VoiceMemoryCoordinator } from "./voice-memory-coordinator.js";
import {
  ALL_EXTERNAL_TOOLS_OFF,
  createExternalToolBoundary,
  type ExternalToolBoundary,
  type ExternalToolConfirmationVerifier,
  type ExternalToolFlags,
  type ExternalToolTelemetry,
} from "./external-tools.js";
import {
  createGoogleCalendarTasksRuntime,
  type GoogleCalendarTasksFactory,
  type GoogleCalendarTasksRuntime,
} from "./google-calendar-tasks-runtime.js";
import {
  createGoogleCalendarTasksReadService,
  createSupabaseGoogleCalendarTasksConnectionRepository,
  createSupabaseGoogleCalendarTasksQuotaRepository,
  makeInMemoryGoogleCalendarTasksQuotaRepository,
  makeInMemoryGoogleCalendarTasksConnectionRepository,
  type GoogleCalendarTasksConnectionRepository,
  type GoogleCalendarTasksQuotaRepository,
  type GoogleCalendarTasksReadService,
} from "./google-calendar-tasks.js";
import { registerGoogleCalendarTasksRoutes } from "./google-calendar-tasks-routes.js";
import type { GoogleOAuthService } from "./google-oauth.js";
import { createGoogleOAuthService } from "./google-oauth.js";
import { createSupabaseGoogleCalendarTasksOAuthRepository } from "./google-oauth-hosted-repository.js";
import { createGoogleCalendarTasksFetchTransport, createGoogleOAuthRuntime } from "./google-oauth-runtime.js";
import { createGoogleCalendarTasksReadGateway } from "./google-calendar-tasks-provider.js";
import { createGoogleCalendarTasksPreviewGateway, type GoogleCalendarTasksPreviewGateway } from "./google-calendar-tasks-preview-provider.js";
import { createGoogleCalendarTasksPreviewService } from "./google-calendar-tasks-preview.js";
import {
  createMemoryVisualStylePreferenceRepository,
  createSupabaseVisualStylePreferenceRepository,
  registerVisualStylePreferenceRoutes,
  type VisualStylePreferenceRepository,
} from "./visual-style-preferences.js";

declare module "fastify" {
  interface FastifyInstance {
    memoryRepository: MemoryRepository;
    profileRepository: ProfileRepository;
    memorySettingsRepository: MemorySettingsRepository;
    externalTools: ExternalToolBoundary;
    googleCalendarTasksRuntime: GoogleCalendarTasksRuntime;
    googleCalendarTasksConnectionRepository: GoogleCalendarTasksConnectionRepository;
    googleCalendarTasksReadService: GoogleCalendarTasksReadService;
  }
}

export type BuildAppOptions = {
  allowedOrigin?: string;
  googleWrites?:GoogleWrites; gmail?: GmailService;
  gmailAssistant?: GmailAssistantGateway;
  drive?: DriveService;
  driveSummary?: DriveSummaryGateway;
  authVerifier?: AuthVerifier;
  extractor?: MemoryExtractor;
  logger?: FastifyServerOptions["logger"];
  memoryRepository?: MemoryRepository;
  now?: () => Date;
  realtimeGateway?: RealtimeGateway;
  realtimeModel?: string;
  sakuraSpeechGateway?: SakuraSpeechGateway;
  usageLog?: UsageLog;
  profileRepository?: ProfileRepository;
  chatGateway?: ChatGateway;
  codexEnabled?: boolean;
  chatModel?: string;
  webSearchGateway?: WebSearchGateway;
  webSearchModel?: string;
  webSearchTimeoutMs?: number;
  provider?: TtsProvider;
  transcriptionGateway?: TranscriptionGateway;
  costGuard?: CostGuard;
  costLimits?: CostLimits;
  chatStateRepository?: ChatStateRepository;
  migrationExport?: boolean;
  migrationImporter?: MigrationImporter;
  backup?: { cronSecret: string; service: BackupService };
  automaticMemoryEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  voiceMemoryEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  recallMemoryEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  memoryEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
  memoryTelemetry?: AutomaticMemoryTelemetry;
  memorySettingsRepository?: MemorySettingsRepository;
  externalToolFlags?: ExternalToolFlags;
  calendarReadTimeoutMs?: number;
  tasksReadTimeoutMs?: number;
  googleCalendarTasksFactory?: GoogleCalendarTasksFactory;
  googleCalendarTasksConnectionRepository?: GoogleCalendarTasksConnectionRepository;
  googleCalendarTasksQuotaRepository?: GoogleCalendarTasksQuotaRepository;
  googleCalendarTasksPreviewGateway?: GoogleCalendarTasksPreviewGateway;
  googleOAuthService?: GoogleOAuthService;
  lifeServices?: ReturnType<typeof createHostedLifeServices>;
  googleAssistant?: GoogleAssistantService;
  lifeIntent?: TalkLifeIntentGateway;
  externalToolTelemetry?: ExternalToolTelemetry;
  externalToolConfirmationVerifier?: ExternalToolConfirmationVerifier;
  writeGate?: WriteGate;
  automaticChatMemoryMode?: "disabled" | "hosted_authoritative_snapshot";
  memoryTurnSource?: { load(user: RequestUser, input: { sourceMessageId: string; sourceOccurredAt: string }): Promise<AutomaticMemorySourceResult> };
  memoryPolicyVersion?: "natural-v1";
  browserConfig?: BrowserConfig;
  visualStylePreferenceRepository?: VisualStylePreferenceRepository;
  photoRepository?: PhotoRepository;
  photoStorage?: PhotoStorage;
  photoAnalysisGateway?: PhotoAnalysisGateway;
};

const localCostLimits: CostLimits = {
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
};

const speechRequestSchema = z.object({
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  text: z.string(),
});

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const memoryRepository = options.memoryRepository ?? makeTestRepository();
  const profileRepository = options.profileRepository ?? createProfileRepository(":memory:");
  const memorySettingsRepository = options.memorySettingsRepository ?? createMemorySettingsRepository(":memory:");
  const visualStylePreferenceRepository = options.visualStylePreferenceRepository ?? createMemoryVisualStylePreferenceRepository(options.now);
  const extractor = options.extractor ?? defaultExtractor();
  const usageLog = options.usageLog ?? createDiscardingUsageLog();
  const provider = options.provider ?? unavailableTtsProvider();
  const costGuard = options.costGuard ?? createUnlimitedCostGuard();
  const costLimits = options.costLimits ?? localCostLimits;
  const writeGate = options.writeGate ?? createWriteGate();
  const memoryRetriever = createMemoryRetriever({
    repository: memoryRepository,
    recallEnabled: options.memoryEnabled ?? options.recallMemoryEnabled ?? (async (user) => (await memorySettingsRepository.get(user)).memoryEnabled),
  });
  const app = Fastify({ logger: withQuerySafeRequestSerializer(options.logger ?? false) });
  const voiceMemoryCoordinator = new VoiceMemoryCoordinator();
  const externalToolFlags = options.externalToolFlags ?? ALL_EXTERNAL_TOOLS_OFF;
  const googleCalendarTasksRuntime = createGoogleCalendarTasksRuntime({
    flags: externalToolFlags,
    calendarTimeoutMs: options.calendarReadTimeoutMs,
    tasksTimeoutMs: options.tasksReadTimeoutMs,
    factory: options.googleCalendarTasksFactory,
  });
  const googleCalendarTasksConnectionRepository = options.googleCalendarTasksConnectionRepository
    ?? makeInMemoryGoogleCalendarTasksConnectionRepository();
  const googleCalendarTasksQuotaRepository = options.googleCalendarTasksQuotaRepository
    ?? makeInMemoryGoogleCalendarTasksQuotaRepository();
  const externalTools = createExternalToolBoundary({
    flags: externalToolFlags,
    costGuard,
    maximumUsdByArea: {
      search: costLimits.searchUsd,
      calendar: costLimits.calendarUsd,
      notification: costLimits.notificationUsd,
      image: costLimits.imageUsd,
      work: costLimits.workUsd,
      avatar: costLimits.avatarUsd,
      storage: costLimits.storageUsd,
    },
    confirmationVerifier: options.externalToolConfirmationVerifier,
    telemetry: options.externalToolTelemetry ?? {
      record: (event) => app.log.info(event, "External tool processing"),
    },
    now: options.now,
  });
  const googleCalendarTasksReadService = createGoogleCalendarTasksReadService({
    boundary: externalTools,
    connections: googleCalendarTasksConnectionRepository,
    quota: googleCalendarTasksQuotaRepository,
    gateway: googleCalendarTasksRuntime.readGateway ?? { read: async () => { throw new Error("Google Calendar/Tasks is disabled"); } },
    now: options.now,
  });
  const googleCalendarTasksPreviewService = createGoogleCalendarTasksPreviewService({
    boundary: externalTools,
    connections: googleCalendarTasksConnectionRepository,
    quota: googleCalendarTasksQuotaRepository,
    gateway: options.googleCalendarTasksPreviewGateway ?? { preview: async () => { throw new Error("Google Calendar/Tasks preview is disabled"); }, sources: async () => { throw new Error("Google Calendar/Tasks sources is disabled"); } },
    now: options.now,
  });

  if (!options.authVerifier) {
    app.addHook("onReady", async () => {
      if (typeof memoryRepository.cleanupStaleVoiceProcessing !== "function") return;
      const lease = writeGate.enter("background_job");
      if (!lease) return;
      const cleanupNow = options.now?.() ?? new Date();
      const cutoff = new Date(cleanupNow.getTime() - MEMORY_ACTION_LEASE_MS).toISOString();
      try {
        await memoryRepository.cleanupStaleVoiceProcessing(LOCAL_USER, cutoff).catch(() => {
          app.log.warn("Stale voice memory cleanup unavailable");
        });
      } finally { lease.release(); }
    });
  }

  app.decorate("memoryRepository", memoryRepository);
  app.decorate("profileRepository", profileRepository);
  app.decorate("memorySettingsRepository", memorySettingsRepository);
  app.decorate("externalTools", externalTools);
  app.decorate("googleCalendarTasksRuntime", googleCalendarTasksRuntime);
  app.decorate("googleCalendarTasksConnectionRepository", googleCalendarTasksConnectionRepository);
  app.decorate("googleCalendarTasksReadService", googleCalendarTasksReadService);
  app.decorateRequest("yuiUser");
  if (options.authVerifier) {
    if (!options.allowedOrigin) throw new Error("allowedOrigin is required with authVerifier");
    registerAuthentication(app, {
      verifier: options.authVerifier,
      allowedOrigin: options.allowedOrigin,
    });
  } else {
    app.addHook("onRequest", async (request) => {
      request.yuiUser = LOCAL_USER;
    });
  }
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/healthz", async () => ({ ok: true }));
  if (options.browserConfig) registerBrowserConfigRoute(app, options.browserConfig);
  if (googleCalendarTasksRuntime.calendarEnabled || googleCalendarTasksRuntime.tasksEnabled) {
    registerGoogleCalendarTasksRoutes(app, {
      connections: googleCalendarTasksConnectionRepository,
      readService: googleCalendarTasksReadService,
      previewService: googleCalendarTasksPreviewService,
      enabled: { calendar: googleCalendarTasksRuntime.calendarEnabled, tasks: googleCalendarTasksRuntime.tasksEnabled },
      oauth: options.googleOAuthService,
    });
  }
  if (options.chatStateRepository) {
    registerChatStateRoutes(app, {
      repository: options.chatStateRepository,
      now: options.now ?? (() => new Date()),
      writeGate,
    });
  }
  registerMemoryRoutes(app, {
    memoryRepository,
    writeGate,
    processor: new MemoryProcessor({
      extractor,
      repository: memoryRepository,
      usageLog,
      costGuard,
      maximumUsd: costLimits.memoryUsd,
      automaticMemoryEnabled: options.memoryEnabled ?? options.automaticMemoryEnabled ?? (async (user) => (await memorySettingsRepository.get(user)).memoryEnabled),
      memoryMasterEnabled: options.memoryEnabled ?? (async (user) => (await memorySettingsRepository.get(user)).memoryEnabled),
      voiceMemoryEnabled: options.memoryEnabled ?? options.voiceMemoryEnabled ?? (async (user) => (await memorySettingsRepository.get(user)).memoryEnabled),
      policyVersion: options.memoryPolicyVersion,
      voiceCoordinator: voiceMemoryCoordinator,
      telemetry: options.memoryTelemetry ?? {
        record: (event) => app.log.info(event, "Automatic memory processing"),
      },
      now: options.now ?? (() => new Date()),
    }),
    automaticChatMemoryMode: options.automaticChatMemoryMode ?? "disabled",
    memoryTurnSource: options.memoryTurnSource,
  });
  registerMemorySettingsRoutes(app, {
    repository: memorySettingsRepository,
    memoryRepository,
    voiceCoordinator: voiceMemoryCoordinator,
    now: options.now,
    writeGate,
  });
  registerVisualStylePreferenceRoutes(app, { repository: visualStylePreferenceRepository, writeGate });
  registerProfileRoutes(app, { profileRepository, writeGate });
  if (options.migrationExport) registerMigrationExportRoute(app, { profileRepository, memoryRepository });
  if (options.migrationImporter) registerMigrationImportRoute(app, options.migrationImporter, writeGate);
  if (options.backup) registerBackupRoute(app, { ...options.backup, writeGate });
  registerUsageRoute(app, usageLog, costGuard, costLimits.realtimeUsd, writeGate);
  app.get("/api/tts/status", async (_request, reply) => {
    try {
      return await provider.status();
    } catch {
      return reply.code(503).send({ available: false });
    }
  });
  app.post("/api/tts/speech", async (request, reply) => {
    const parsed = speechRequestSchema.safeParse(request.body);
    const text = parsed.success ? parsed.data.text.trim() : "";
    if (!parsed.success || !text || [...text].length > 160) {
      return reply.code(400).send({ error: "Invalid speech request" });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortOnResponseClose);
    try {
      const result = await provider.synthesize({ ...parsed.data, text }, controller.signal);
      return reply.header("Cache-Control", "no-store").type(result.contentType).send(result.audio);
    } catch (error) {
      const kind = error instanceof TtsProviderError ? error.kind : "upstream";
      if (kind === "cancelled") return reply.code(499).send();
      const statusCode = kind === "timeout" ? 504 : kind === "upstream" ? 502 : 503;
      return reply.code(statusCode).send({ error: "Speech synthesis unavailable" });
    } finally {
      request.raw.removeListener("aborted", abort);
      reply.raw.removeListener("close", abortOnResponseClose);
    }
  });
  registerGoogleDriveRoutes(app,options.drive);
  registerGoogleWrites(app,options.googleWrites);
  registerGmailRoutes(app,options.gmail);
  if(options.lifeServices) registerLifeSettingsRoutes(app,options.lifeServices);
  if(options.googleAssistant) registerGoogleAssistantRoutes(app,options.googleAssistant);
  const talkLife = options.lifeServices && options.lifeIntent ? createTalkLifeRouter({
    ...options.lifeServices, intent:options.lifeIntent, gmail:options.gmail, gmailAssistant:options.gmailAssistant, google:options.googleAssistant, drive:options.drive, driveSummary:options.driveSummary,
    sources:googleCalendarTasksPreviewService, chatState:options.chatStateRepository,
    costGuard,maximumUsd:Math.min(costLimits.chatUsd,0.03),now:options.now,
  }) : undefined;
  if (options.chatGateway) {
    registerChatRoutes(app, {
      chatGateway: options.chatGateway,
      codexEnabled: options.codexEnabled,
      talkLife,
      lifeSettings: options.lifeServices?.settings,
      chatModel: options.chatModel ?? "gpt-5.6-luna",
      memoryRepository,
      memoryRetriever,
      now: options.now ?? (() => new Date()),
      profileRepository,
      usageLog,
      costGuard,
      maximumUsd: costLimits.chatUsd,
      externalTools,
      webSearchGateway: options.webSearchGateway,
      webSearchModel: options.webSearchModel ?? "gpt-5.6-luna",
      webSearchTimeoutMs: options.webSearchTimeoutMs ?? 15_000,
      memoryEnabled: options.memoryEnabled ?? (async (user) => (await memorySettingsRepository.get(user)).memoryEnabled),
      writeGate,
    });
  }
  if (options.transcriptionGateway) {
    registerTranscriptionRoutes(app, {
      transcriptionGateway: options.transcriptionGateway,
      usageLog,
      now: options.now ?? (() => new Date()),
      costGuard,
      maximumUsd: costLimits.transcriptionUsd,
      writeGate,
    });
  }
  if (options.photoRepository && options.photoStorage && options.photoAnalysisGateway) {
    registerPhotoRoutes(app, {
      enabled: () => externalToolFlags.photo_analysis,
      repository: options.photoRepository,
      storage: options.photoStorage,
      gateway: options.photoAnalysisGateway,
      writeGate,
      costGuard,
      maximumUsd: costLimits.imageUsd,
    });
  }
  if (options.sakuraSpeechGateway) registerSakuraSpeechRoutes(app, options.sakuraSpeechGateway);
  if (options.realtimeGateway) {
    registerRealtimeRoutes(app, {
      memoryRetriever,
      now: options.now ?? (() => new Date()),
      realtimeGateway: options.realtimeGateway,
      zundamonEnabled: !!options.sakuraSpeechGateway,
      realtimeModel: options.realtimeModel ?? "gpt-realtime-2.1-mini",
      profileRepository,
      costGuard,
      maximumUsd: costLimits.realtimeUsd,
      chatStateRepository: options.chatStateRepository,
      writeGate,
    });
  }

  return app;
}

function withQuerySafeRequestSerializer(
  logger: FastifyServerOptions["logger"],
): FastifyServerOptions["logger"] {
  if (!logger) return logger;
  const base = logger === true ? {} : logger;
  return {
    ...base,
    serializers: {
      ...base.serializers,
      req(request: {
        method?: string;
        url?: string;
        headers?: { host?: string };
        socket?: { remoteAddress?: string; remotePort?: number };
      }) {
        const url = typeof request.url === "string" ? request.url.split("?", 1)[0] : request.url;
        return {
          method: request.method,
          url,
          host: request.headers?.host,
          remoteAddress: request.socket?.remoteAddress,
          remotePort: request.socket?.remotePort,
        };
      },
    },
  };
}

function unavailableTtsProvider(): TtsProvider {
  return {
    status: async () => { throw new TtsProviderError("unavailable"); },
    synthesize: async () => { throw new TtsProviderError("unavailable"); },
  };
}

function defaultExtractor(): MemoryExtractor {
  const config = loadConfig();
  return createOpenAIMemoryExtractor({
    apiKey: config.openaiApiKey,
    model: config.memoryModel,
  });
}

export function buildProductionApp(): FastifyInstance {
  const config = loadConfig();
  if (config.mode !== "local") {
    throw new Error("Hosted mode must use buildHostedApp");
  }
  return buildApp({
    extractor: createOpenAIMemoryExtractor({
      apiKey: config.openaiApiKey,
      model: config.memoryModel,
    }),
    memoryRepository: createMemoryRepository(config.dbPath),
    profileRepository: createProfileRepository(config.dbPath),
    memorySettingsRepository: createMemorySettingsRepository(config.dbPath),
    logger: true,
    chatGateway: createOpenAIChatGateway({ apiKey: config.openaiApiKey }),
    chatModel: config.chatModel,
    webSearchGateway: createOpenAIWebSearchGateway({ apiKey: config.openaiApiKey }),
    webSearchModel: config.webSearchModel,
    webSearchTimeoutMs: config.webSearchTimeoutMs,
    provider: createVoicevoxNemoProvider({
      baseUrls: config.voicevoxBaseUrls,
      statusTimeoutMs: config.voicevoxStatusTimeoutMs,
      queryTimeoutMs: config.voicevoxQueryTimeoutMs,
      synthesisTimeoutMs: config.voicevoxSynthesisTimeoutMs,
    }),
    realtimeGateway: createOpenAIRealtimeGateway({
      apiKey: config.openaiApiKey,
    }),
    realtimeModel: config.realtimeModel,
    sakuraSpeechGateway: config.sakuraAiApiKey ? createSakuraSpeechGateway({apiKey:config.sakuraAiApiKey}) : undefined,
    usageLog: createNdjsonUsageLog(config.usageLogPath),
    transcriptionGateway: createOpenAITranscriptionGateway({ apiKey: config.openaiApiKey }),
    migrationExport: true,
    externalToolFlags: config.externalToolFlags,
    calendarReadTimeoutMs: config.calendarReadTimeoutMs,
    tasksReadTimeoutMs: config.tasksReadTimeoutMs,
  });
}

export type BuildHostedAppOptions = {
  config?: HostedServerConfig;
  authVerifier?: AuthVerifier;
  logger?: FastifyServerOptions["logger"];
  memoryRepository?: MemoryRepository;
  profileRepository?: ProfileRepository;
  usageLog?: UsageLog;
  costGuard?: CostGuard;
  chatStateRepository?: ChatStateRepository;
  migrationImporter?: MigrationImporter;
  googleCalendarTasksFactory?: GoogleCalendarTasksFactory;
  googleCalendarTasksConnectionRepository?: GoogleCalendarTasksConnectionRepository;
  googleCalendarTasksQuotaRepository?: GoogleCalendarTasksQuotaRepository;
  googleCalendarTasksPreviewGateway?: GoogleCalendarTasksPreviewGateway;
  googleOAuthService?: GoogleOAuthService;
  lifeServices?: ReturnType<typeof createHostedLifeServices>;
  googleAssistant?: GoogleAssistantService;
  lifeIntent?: TalkLifeIntentGateway;
  photoRepository?: PhotoRepository;
  photoStorage?: PhotoStorage;
  photoAnalysisGateway?: PhotoAnalysisGateway;
};

export function createHostedGoogleRuntime(
  config: Pick<HostedServerConfig, "googleOAuth" | "allowedEmail" | "externalToolFlags" | "googleAssistantWrite">,
  memoryMutationFactory: ReturnType<typeof createSupabaseServiceMutationClientFactory>,
) {
  return config.googleOAuth ? (() => {
    const repository = createSupabaseGoogleCalendarTasksOAuthRepository({
      rpcForOwner: (ownerId) => memoryMutationFactory({ userId: ownerId, email: config.allowedEmail, accessToken: "" }),
      key: config.googleOAuth.tokenKey,
      keyVersion: config.googleOAuth.keyVersion,
    });
    const runtime = createGoogleOAuthRuntime({
      clientId: config.googleOAuth.clientId,
      clientSecret: config.googleOAuth.clientSecret,
      redirectUri: config.googleOAuth.redirectUri,
      repository,
    });
    const unavailable = (): never => { throw new Error("Google Calendar/Tasks server configuration only"); };
    return {
      assistant: createHostedGoogleAssistantService({
        rpcForOwner:ownerId=>memoryMutationFactory({userId:ownerId,email:config.allowedEmail,accessToken:""}),
        oauthRepository:repository,tokens:runtime.tokens,key:config.googleOAuth.tokenKey,keyVersion:config.googleOAuth.keyVersion,
        flags:{calendarRead:config.externalToolFlags.calendar_read,tasksRead:config.externalToolFlags.tasks_read,
          calendarWrite:config.googleAssistantWrite?.calendar===true,tasksWrite:config.googleAssistantWrite?.tasks===true},
      }),
      oauth: createGoogleOAuthService({
        repository,
        exchange: runtime.exchange,
        clientId: config.googleOAuth.clientId,
        redirectUri: config.googleOAuth.redirectUri,
        callbackStateKey: config.googleOAuth.tokenKey,
        isWriteEnabled: service=>config.googleAssistantWrite?.[service]===true,
      }),
      factory: {
        parseSecret: unavailable,
        createConnectionRepository: unavailable,
        createReadGateway: () => createGoogleCalendarTasksReadGateway({
          tokens: runtime.tokens,
          transport: createGoogleCalendarTasksFetchTransport(),
        }),
      } satisfies GoogleCalendarTasksFactory,
      previewGateway: createGoogleCalendarTasksPreviewGateway({
        tokens: runtime.tokens,
        transport: createGoogleCalendarTasksFetchTransport(),
      }),
    };
  })() : undefined;
}

export function buildHostedApp(options: BuildHostedAppOptions = {}): FastifyInstance {
  const loaded = options.config ?? loadConfig();
  if (loaded.mode !== "hosted") throw new Error("YUI_MODE=hosted is required");
  const config = loaded;
  const factory = createSupabaseUserClientFactory(
    config.supabaseUrl,
    config.supabasePublishableKey,
  );
  const memoryMutationFactory = createSupabaseServiceMutationClientFactory(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
  );
  const hostedGoogle = createHostedGoogleRuntime(config, memoryMutationFactory);
  const authVerifier = options.authVerifier ?? createSupabaseAuthVerifier(
    createSupabaseAuthClient(config.supabaseUrl, config.supabasePublishableKey),
    config.allowedEmail,
  );
  const chatStateRepository = options.chatStateRepository ?? createSupabaseChatStateRepository(factory, memoryMutationFactory);
  return buildApp({
    allowedOrigin: config.allowedOrigin,
    browserConfig: {
      supabaseUrl: config.supabaseUrl,
      supabasePublishableKey: config.supabasePublishableKey,
      photoAnalysisEnabled: config.externalToolFlags.photo_analysis,
      integratedUiEnabled: config.integratedUiEnabled,
      prismEchoEnabled: config.prismEchoEnabled,
    },
    authVerifier,
    costGuard: options.costGuard ?? createSupabaseCostGuard({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      limits: config.costLimits,
    }),
    costLimits: config.costLimits,
    externalToolFlags: config.externalToolFlags,
    calendarReadTimeoutMs: config.calendarReadTimeoutMs,
    tasksReadTimeoutMs: config.tasksReadTimeoutMs,
    googleCalendarTasksFactory: options.googleCalendarTasksFactory ?? hostedGoogle?.factory,
    googleCalendarTasksConnectionRepository: options.googleCalendarTasksConnectionRepository
      ?? createSupabaseGoogleCalendarTasksConnectionRepository(memoryMutationFactory),
    googleCalendarTasksQuotaRepository: options.googleCalendarTasksQuotaRepository
      ?? createSupabaseGoogleCalendarTasksQuotaRepository(memoryMutationFactory),
    googleCalendarTasksPreviewGateway: options.googleCalendarTasksPreviewGateway ?? hostedGoogle?.previewGateway,
    googleOAuthService: options.googleOAuthService ?? hostedGoogle?.oauth,
    lifeServices: options.lifeServices ?? createHostedLifeServices({createUserClient:factory}),
    googleAssistant:options.googleAssistant ?? hostedGoogle?.assistant,
    lifeIntent:options.lifeIntent ?? createOpenAITalkLifeIntentGateway(config.openaiApiKey,config.chatModel),
    chatStateRepository,
    automaticChatMemoryMode: config.automaticChatMemoryMode,
    memoryPolicyVersion: "natural-v1",
    memoryTurnSource: new AuthoritativeMemoryTurnSource(chatStateRepository),
    logger: options.logger ?? true,
    extractor: createOpenAIMemoryExtractor({
      apiKey: config.openaiApiKey,
      model: config.memoryModel,
    }),
    memoryRepository: options.memoryRepository ?? createSupabaseMemoryRepository(factory, memoryMutationFactory),
    memorySettingsRepository: createSupabaseMemorySettingsRepository(factory, memoryMutationFactory),
    profileRepository: options.profileRepository ?? createSupabaseProfileRepository(factory),
    visualStylePreferenceRepository: createSupabaseVisualStylePreferenceRepository(factory),
    usageLog: options.usageLog ?? createSupabaseUsageLog(factory),
    chatGateway: createOpenAIChatGateway({ apiKey: config.openaiApiKey }),
    chatModel: config.chatModel,
    webSearchGateway: createOpenAIWebSearchGateway({ apiKey: config.openaiApiKey }),
    webSearchModel: config.webSearchModel,
    webSearchTimeoutMs: config.webSearchTimeoutMs,
    realtimeGateway: createOpenAIRealtimeGateway({ apiKey: config.openaiApiKey }),
    realtimeModel: config.realtimeModel,
    sakuraSpeechGateway: config.sakuraAiApiKey ? createSakuraSpeechGateway({apiKey:config.sakuraAiApiKey}) : undefined,
    transcriptionGateway: createOpenAITranscriptionGateway({ apiKey: config.openaiApiKey }),
    migrationImporter: options.migrationImporter ?? createSupabaseMigrationImporter(memoryMutationFactory),
    backup: {
      cronSecret: config.cronSecret,
      service: createBackupService({
        repository: createSupabaseBackupRepository(config.supabaseUrl, config.supabaseServiceRoleKey),
        blobs: createSupabaseBackupStore(config.supabaseUrl, config.supabaseServiceRoleKey),
        key: Buffer.from(config.backupKeyBase64, "base64"),
      }),
    },
    photoRepository: options.photoRepository ?? createSupabasePhotoRepository(createSupabasePhotoServiceClient(config.supabaseUrl, config.supabaseServiceRoleKey)),
    photoStorage: options.photoStorage ?? createSupabasePhotoStorage(config.supabaseUrl, config.supabaseServiceRoleKey),
    photoAnalysisGateway: options.photoAnalysisGateway ?? createOpenAIPhotoAnalysisGateway({ apiKey: config.openaiApiKey, maxRetries: 0 }),
  });
}
