import {MenuHomeContext} from "./components/MenuPage";
import {createBgmApi, type BgmApi} from './bgm/player';
import {useBgm} from './bgm/use-bgm';
import { CodexTask, useCodexTask } from './components/CodexTask';
import { createCodexApi, withCodex, type CodexApi } from './codex';
import { AvatarLoading } from "./components/AvatarLoading";
import { createVrmCloud, type VrmCloud } from "./vrm/vrm-cloud";
import { useCharacterPreference } from './vrm/vrm-preference';
import { stageDialogue } from "./stage-dialogue";
import { useWallpaper } from "./wallpaper";
import { conversationExpression } from './live2d/conversation-motion';
import {VoiceConnection,type VoiceSettings} from './screens/VoiceConnection';
import {AIConnection} from './screens/AIConnection';
import {createAIConnectionApi,type AIConnectionApi} from './ai-connection';
import {createWritesApi,type WritesApi} from './google-writes';
import {createGmailApi,type GmailApi} from './gmail';
import {createDriveApi,type DriveApi} from './google-drive';
import { GoogleConnections } from './screens/GoogleConnections';
import { readLocalProfileDetails, saveLocalProfileDetails } from "./local-profile-details";
import { SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { PRODUCT_NAME, ZUNDAMON_CHARACTER } from "@yui/domain";
import {createAvatarSpeech, type AvatarSpeechPlayer} from "./avatar-speech";
import {createBrowserSpeechPlayer, speechFailureMessage} from "./sakura-speech";
import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import {
  browserMemoryApi,
  createBrowserRealtimeClient,
  browserChatApi,
  browserProfileApi,
  browserTranscriptionApi,
  createChatApi,
  createDashboardProgressApi,
  createVisualStylePreferenceApi,
  createMemoryApi,
  createPhotoApi,
  createProfileApi,
  createTranscriptionApi,
  type ChatApi,
  type DashboardProgress,
  type DashboardProgressApi,
  type MemoryApi,
  type ProfileApi,
  type PhotoApi,
  type RealtimeClientFactory,
  type TranscriptionApi,
  type VisualStylePreferenceApi,
} from "./api";
import type { CallCard, ChatMessage, TimelineItem } from "@yui/domain";
import type { RealtimeClient } from "./realtime-client";
import {
  initialSessionState,
  sessionReducer,
} from "./session-reducer";
import { createChatController, initialChatState, type ChatController } from "./chat-controller";
import { createBrowserLocalStateStore, createMemoryLocalStateStore, type LocalStateStore } from "./local-state";
import { Chat } from "./screens/Chat";
import { createLifeServicesApi, type LifeServicesApi } from "./life-services";
import { LifeSettings } from "./screens/LifeSettings";
import { LifeCardView } from "./LifeCard";
import { browserPhotoPreparationDeps, preparePhoto, type PreparedPhoto } from "./photo-preparation";
import { createPhotoComposer } from "./photo-composer";
import { classifyPhotoPreparationError, photoPresentationMessage, photoProgressError, photoProgressMessage, type PhotoPresentationError } from "./photo-presentation";
import type { PhotoProgressStage } from "./chat-controller";
import { ProfileSettings } from "./screens/ProfileSettings";
import { SavedMemories } from "./screens/SavedMemories";
import { Session } from "./screens/Session";
import { Setup } from "./screens/Setup";
import { Splash } from "./screens/Splash";
import { createDictationController, type DictationController, type DictationState } from "./dictation";
import { microphoneFailureMessage } from "./microphone-error";
import { createRealtimeClient, createVoiceMemorySourceId } from "./realtime-client";
import { createAuthorizedFetch } from "./authorized-fetch";
import { createCloudLocalStateStore, createRemoteStateApi, getAuthoritativeRevisionCoordinator, inheritAuthoritativeRevisionCoordinator } from "./cloud-state";
import type { AuthClient, AuthSession } from "./auth";
import { Login } from "./screens/Login";
import { createMigrationApi, type MigrationApi } from "./migration";
import {
  createCallStartAttempt,
  finishCallStart,
  type CallStartAttempt,
} from "./call-start";
import {
  createBrowserMemorySyncPendingStore,
  createMemorySyncQueue,
  shouldExcludeAutomaticMemorySource,
  type MemorySyncPendingStore,
  type MemorySyncQueue,
} from "./memory-sync";
import {
  EMPTY_NEWS_VIEW_MODEL,
  DEFAULT_YUI_PORTRAIT,
  INTEGRATED_UI_DEFAULT_ENABLED,
  moveIntegratedUiView,
  type IntegratedUiView,
  type YuiPortrait,
} from "./integrated-ui";
import { Home } from "./screens/Home";
import { IntegratedNavigation } from "./screens/IntegratedNavigation";
import { News } from "./screens/News";
import {
  EMPTY_HOME_MANAGEMENT_MODEL,
  moveHomeWidget,
  setHomeServiceConnection,
  setHomeServiceHomeVisible,
  setHomeWeatherLocation,
  toHomeViewModel,
  type HomeManagementView,
  type HomeServiceId,
  type HomeWidget,
} from "./home-management";
import { HomeManagement } from "./screens/HomeManagement";
import { MemoryHub } from "./screens/MemoryHub";
import { AppMenu } from "./screens/AppMenu";
import { IntegratedPageHeader } from "./screens/IntegratedPageHeader";
import {
  DISABLED_GOOGLE_SERVICE_SETTINGS,
  createBrowserGoogleCalendarTasksApi,
  createLocalGoogleCalendarTasksApi,
  type GoogleCalendarTasksApi,
  type GoogleService,
  type GoogleServiceSettings,
} from "./google-calendar-tasks";
import { applyVisualStyle, type VisualStyle } from "./visual-style";
import {
  createMemoryNotificationPreferenceStore,
  readOsNotificationPermission,
  type NotificationPreferenceStore,
  type OsNotificationPermission,
  type ProactiveExperienceApi,
  type ProactiveOpenResult,
  type ProactiveUiAction,
} from "./proactive-message";
import { ZUNDAMON_MODEL_ID, ZUNDAMON_PORTRAIT } from "./live2d/zundamon-model-manifest";
import type { AvatarAudioSignal } from "./live2d/avatar-contract";
import { readVoiceAudioSignal } from "./voice-audio-signal";
import type { AvatarCapability } from "./live2d/avatar-capability";
import type { AvatarModelManifest, AvatarRendererLoader } from "./live2d/avatar-contract";
import type { AvatarStageProps } from "./live2d/AvatarStage";
import { initialTalkCausalCueState, reduceTalkCausalCue } from "./talk-causal-cue";

function FailedAvatarStage({ fallback, onFallbackError }: AvatarStageProps) {
  return <figure className="live2d-avatar-stage" data-state="failed">
    <img className="live2d-avatar-fallback" src={fallback.src} alt={fallback.alt} onError={onFallbackError} />
    <figcaption className="live2d-avatar-status">静止画で表示しています</figcaption>
  </figure>;
}

export function createLazyAvatarStage(loadStage: () => Promise<Pick<typeof import("./live2d/AvatarStage"), "AvatarStage">> = () => import("./live2d/AvatarStage")) {
  return lazy(async () => {
    try {
      const { AvatarStage } = await loadStage();
      return { default: AvatarStage };
    } catch {
      return { default: FailedAvatarStage };
    }
  });
}

const LazyAvatarStage = createLazyAvatarStage();
const LazyVrmStage = lazy(() => import('./vrm/VrmStage').then(module=>({default:module.VrmStage})));

export type { RealtimeClientFactory } from "./api";

export type AppProps = {
  wallpaperScope?: string;
  characterCloud?: VrmCloud;
  codexApi?: CodexApi;
  bgmApi?: BgmApi;
  localPreview?: boolean;
  createAvatarSpeechPlayer?: () => AvatarSpeechPlayer;
  memoryApi?: MemoryApi;
  realtimeClient?: RealtimeClientFactory;
  chatStore?: LocalStateStore;
  chatStorePersistent?: boolean;
  profileApi?: ProfileApi;
  chatApi?: ChatApi;
  transcriptionApi?: TranscriptionApi;
  now?: () => string;
  nextId?: () => string;
  splashDurationMs?: number;
  requirePersistBeforeChat?: boolean;
  onSignOut?: () => Promise<void> | void;
  onUpdatePassword?: (password: string) => Promise<void>;
  migrationApi?: MigrationApi;
  memorySyncStore?: MemorySyncPendingStore;
  automaticMemoryEnabled?: boolean;
  automaticChatMemoryMode?: "disabled" | "hosted_authoritative_snapshot";
  photoApi?: PhotoApi;
  photoAnalysisEnabled?: boolean;
  photoPreparation?: (file: File) => Promise<PreparedPhoto>;
  integratedUiEnabled?: boolean;
  yuiPortrait?: YuiPortrait;
  googleCalendarTasksApi?: GoogleCalendarTasksApi;
  gmailApi?: GmailApi;
  writesApi?:WritesApi;
  aiConnectionApi?:AIConnectionApi;
  voiceStatus?:()=>Promise<VoiceSettings>;
  selectVoiceProvider?:(provider:VoiceSettings["provider"],speed?:number)=>Promise<VoiceSettings>;
  driveApi?: DriveApi;
  lifeServicesApi?: LifeServicesApi;
  dashboardProgressApi?: DashboardProgressApi;
  visualStylePreferenceApi?: VisualStylePreferenceApi;
  proactiveMessagingEnabled?: boolean;
  proactiveApi?: ProactiveExperienceApi;
  notificationPreferenceStore?: NotificationPreferenceStore;
  osNotificationPermission?: () => OsNotificationPermission;
  live2dReadAudioSignal?: () => AvatarAudioSignal;
  live2dAvatarEnabled?: boolean;
  live2dModel?: AvatarModelManifest;
  live2dRendererLoader?: AvatarRendererLoader;
  live2dCapability?: AvatarCapability;
  causalCueEnabled?: boolean;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HostedAppProps = {
  vrmStorageConfig?: { url: string; key: string };
  authClient: AuthClient;
  apiBaseUrl: string;
  fetchImpl?: FetchLike;
  realtimeClient?: RealtimeClientFactory;
  cacheStore?: LocalStateStore;
  splashDurationMs?: number;
  now?: () => string;
  nextId?: () => string;
  integratedUiEnabled?: boolean;
  yuiPortrait?: YuiPortrait;
  photoAnalysisEnabled?: boolean;
  prismEchoEnabled?: boolean;
  live2dAvatarEnabled?: boolean;
  live2dModel?: AvatarModelManifest;
  live2dReadAudioSignal?: () => AvatarAudioSignal;
};

type View = "chat" | "session" | "memories";
type PhotoPreviewState = {
  url: string;
  byteSize: number;
  status: "confirming" | "sending" | "retryable";
  clientMessageId?: string;
  saveOnly?: boolean;
};
const currentTime = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const disabledGoogleCalendarTasksApi = createLocalGoogleCalendarTasksApi();
const disabledNotificationPreferenceStore = createMemoryNotificationPreferenceStore(false);

function synchronizeGoogleHomeModel(
  current: typeof EMPTY_HOME_MANAGEMENT_MODEL,
  settings: GoogleServiceSettings,
) {
  return (["calendar", "tasks"] as const).reduce((next, service) => {
    const status = settings[service];
    const connected = status.state === "connected";
    const connectedModel = setHomeServiceConnection(next, service, connected);
    const withState = {
      ...connectedModel,
      services: connectedModel.services.map((candidate) => candidate.id === service
        ? { ...candidate, connectionState: status.state }
        : candidate),
    };
    return connected && status.homeVisible
      ? setHomeServiceHomeVisible(withState, service, true)
      : withState;
  }, current);
}

function normalizeRealtimeError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const error = new Error("Realtime start failed");
  if (cause instanceof DOMException) error.name = cause.name;
  return error;
}

function timelineTime(item: TimelineItem): number {
  return Date.parse(item.type === "call" ? item.startedAt : item.createdAt);
}

function orderedTimeline(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((left, right) => timelineTime(left) - timelineTime(right));
}

export function App({
  wallpaperScope = "local",
  characterCloud,
  codexApi,
  bgmApi,
  localPreview = false,
  memoryApi = browserMemoryApi,
  realtimeClient = createBrowserRealtimeClient,
  chatStore,
  chatStorePersistent = true,
  profileApi = browserProfileApi,
  chatApi = browserChatApi,
  transcriptionApi = browserTranscriptionApi,
  now = currentTime,
  nextId = newId,
  splashDurationMs = 1_000,
  requirePersistBeforeChat = false,
  onSignOut,
  onUpdatePassword,
  migrationApi,
  memorySyncStore,
  automaticMemoryEnabled = true,
  automaticChatMemoryMode = "disabled",
  photoApi,
  photoAnalysisEnabled = false,
  photoPreparation = (file) => preparePhoto(file, browserPhotoPreparationDeps()),
  integratedUiEnabled = INTEGRATED_UI_DEFAULT_ENABLED,
  yuiPortrait = DEFAULT_YUI_PORTRAIT,
  googleCalendarTasksApi = disabledGoogleCalendarTasksApi,
  driveApi,
  gmailApi,
  writesApi,
  aiConnectionApi,
  voiceStatus,
  selectVoiceProvider,
  lifeServicesApi,
  dashboardProgressApi,
  visualStylePreferenceApi,
  proactiveMessagingEnabled = false,
  proactiveApi,
  notificationPreferenceStore = disabledNotificationPreferenceStore,
  osNotificationPermission = readOsNotificationPermission,
  live2dAvatarEnabled = false,
  createAvatarSpeechPlayer,
  live2dReadAudioSignal = readVoiceAudioSignal,
  live2dModel,
  live2dRendererLoader,
  live2dCapability,
  causalCueEnabled = false,
}: AppProps) {
  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(ZUNDAMON_CHARACTER.colors)) root.style.setProperty(`--character-${name}`, value);
    document.title = PRODUCT_NAME;
  }, []);
  const launchEnabledRef = useRef(splashDurationMs !== 0);
  const [launchDismissed, setLaunchDismissed] = useState(() => !launchEnabledRef.current);
  const [view, setView] = useState<View>("chat");
  const [primaryView, setPrimaryView] = useState<IntegratedUiView>("talk");
  const [pendingNavFocus, setPendingNavFocus] = useState<IntegratedUiView | null>(null);
  const [avatarVoiceOn, setAvatarVoiceOn] = useState(true);
  const [waitingForSpeech, setWaitingForSpeech] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [spokenStageText, setSpokenStageText] = useState<string | undefined>();
  const speechDisplayGeneration = useRef(0);
  const [avatarVoiceError, setAvatarVoiceError] = useState<string | null>(null);
  const avatarSpeechRef = useRef<ReturnType<typeof createAvatarSpeech> | null>(null);
  if (!avatarSpeechRef.current) avatarSpeechRef.current = createAvatarSpeech(createAvatarSpeechPlayer ?? (() => createBrowserSpeechPlayer(fetch, {playbackOnly:true})), (error) => setAvatarVoiceError(speechFailureMessage(error)), () => setAvatarVoiceError(null));
  useEffect(() => () => avatarSpeechRef.current?.disable(), []);
  const [homeManagementView, setHomeManagementView] = useState<HomeManagementView | null>(null);
  const [homeManagementModel, setHomeManagementModel] = useState(EMPTY_HOME_MANAGEMENT_MODEL);
  const [dashboardProgress, setDashboardProgress] = useState<DashboardProgress | undefined>();
  const [lifeSettingsSection,setLifeSettingsSection] = useState<"google"|"home"|"ai"|"voice"|null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [persistenceWarning, setPersistenceWarning] = useState<boolean | string>(false);
  const [persistenceRetrying, setPersistenceRetrying] = useState(false);
  const persistenceRetryRef = useRef(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupHydrationFailed, setSetupHydrationFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryHubOpen,setMemoryHubOpen] = useState(false);
  const [settingsDetail,setSettingsDetail] = useState<"style"|"about"|null>(null);
  const visualStyle: VisualStyle = "yui";
  const wallpaperController = useWallpaper(wallpaperScope);
  const codexTask = useCodexTask(codexApi, wallpaperScope);
  const characterController = useCharacterPreference(wallpaperScope, characterCloud);
  const [chatSearchRequestId, setChatSearchRequestId] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [returnHomeRequestId, setReturnHomeRequestId] = useState(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [, setChatVersion] = useState(0);
  const chatControllerRef = useRef<ChatController | null>(null);
  const chatStoreRef = useRef<LocalStateStore | null>(null);
  const draftRef = useRef("");
  const chatGenerationRef = useRef(0);
  const causalCueEnabledRef = useRef(causalCueEnabled);
  causalCueEnabledRef.current = causalCueEnabled;
  const [talkCausalCueState, dispatchTalkCausalCue] = useReducer(reduceTalkCausalCue, 0, initialTalkCausalCueState);
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [ending, setEnding] = useState(false);
  const [callPreparing, setCallPreparing] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callCards, setCallCards] = useState<CallCard[]>([]);
  const [dictationState, setDictationState] = useState<DictationState>("idle");
  const bgm = useBgm(bgmApi, wallpaperScope, callPreparing || view === 'session' || dictationState !== 'idle');
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [dictationDraft, setDictationDraft] = useState<{ id: number; text: string } | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [proactiveAction, setProactiveAction] = useState<{
    candidateId: string;
    messageId: string;
    source: "time" | "one_time_reminder" | "calendar_tasks";
    state: "ready" | "processing" | "dismissed" | "deferred" | "unneeded" | "cancelled";
    failed: boolean;
  } | null>(null);
  const proactiveOpenPromiseRef = useRef<Promise<{ notificationEnabled: boolean; result: ProactiveOpenResult | null }> | null>(null);
  const proactiveActionInFlightRef = useRef<string | null>(null);

  useEffect(() => {
    applyVisualStyle(visualStyle);
  }, [visualStyle]);

  const clientRef = useRef<RealtimeClient | null>(null);
  const activeCallStartRef = useRef<CallStartAttempt | null>(null);
  const callStartGenerationRef = useRef(0);
  const connectedCallGenerationRef = useRef(0);
  const endingRef = useRef(false);
  const callCardsRef = useRef<CallCard[]>([]);
  const callCardIdsRef = useRef(new Set<string>());
  const dictationRef = useRef<DictationController | null>(null);
  const dictationCompletionRef = useRef<"draft" | "send">("draft");
  const dictationDraftIdRef = useRef(0);
  const sendTextRef = useRef<(text: string) => void>(() => undefined);
  const memoryQueueRef = useRef<MemorySyncQueue | null>(null);
  const fallbackMemorySyncStoreRef = useRef<MemorySyncPendingStore | null>(null);
  const completedMemorySourcesRef = useRef<Array<{ sourceMessageId: string; sourceOccurredAt: string }>>([]);
  const [memoryRenderVersion, setMemoryRenderVersion] = useState(0);
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<PhotoPreviewState | null>(null);
  const [photoPreparing, setPhotoPreparing] = useState(false);
  const [photoProgress, setPhotoProgress] = useState<PhotoProgressStage | null>(null);
  const [photoError, setPhotoError] = useState<PhotoPresentationError | null>(null);
  const [photoDraftClearRequestId, setPhotoDraftClearRequestId] = useState(0);
  const photoComposerRef = useRef(createPhotoComposer());
  const automaticMemoryEnabledRef = useRef(automaticMemoryEnabled);
  const voiceMemoryEnabledRef = useRef(true);
  const voiceMemoryAbortRef = useRef<AbortController | null>(null);
  if (!fallbackMemorySyncStoreRef.current) fallbackMemorySyncStoreRef.current = createBrowserMemorySyncPendingStore({ key: "zundamon-ai-memory-sync:local" });

  useEffect(() => {
    automaticMemoryEnabledRef.current = automaticMemoryEnabled;
  }, [automaticMemoryEnabled]);

  useEffect(() => () => {
    const composer = photoComposerRef.current;
    if (composer.state === "preparing" || composer.state === "preview") composer.cancel();
  }, []);

  useEffect(() => {
    let active = true;
    void googleCalendarTasksApi.getSettings().then((settings) => {
      if (!active) return;
      setHomeManagementModel((current) => synchronizeGoogleHomeModel(current, settings));
    }, () => {
      if (!active) return;
      setHomeManagementModel((current) => synchronizeGoogleHomeModel(current, DISABLED_GOOGLE_SERVICE_SETTINGS));
    });
    return () => { active = false; };
  }, [googleCalendarTasksApi]);

  useEffect(() => {
    if (!integratedUiEnabled || !dashboardProgressApi || lifeServicesApi) {
      setDashboardProgress(undefined);
      return;
    }
    let active = true;
    void dashboardProgressApi.get().then((progress) => {
      if (active) setDashboardProgress(progress);
    }, () => {
      if (active) setDashboardProgress({ connection: "unavailable", updates: [] });
    });
    return () => { active = false; };
  }, [dashboardProgressApi, integratedUiEnabled, lifeServicesApi]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    const Recorder = globalThis.MediaRecorder;
    if (!mediaDevices || !Recorder) return;
    let active = true;
    const dictation = createDictationController({
      mediaDevices,
      MediaRecorder: Recorder,
      transcriptionApi,
      clock: window,
      onTranscript: (text) => {
        if (dictationCompletionRef.current === "send") {
          sendTextRef.current(text);
          return;
        }
        draftRef.current = text;
        dictationDraftIdRef.current += 1;
        setDictationDraft({ id: dictationDraftIdRef.current, text });
      },
      onState: (next) => {
        if (!active) return;
        setDictationState(next);
        if (next === "recording") setDictationError(null);
      },
      onError: (cause) => {
        if (active) setDictationError(microphoneFailureMessage(cause, "dictation"));
      },
    });
    dictationRef.current = dictation;
    return () => {
      active = false;
      dictation.abort();
      if (dictationRef.current === dictation) dictationRef.current = null;
    };
  }, [transcriptionApi]);

  useEffect(() => {
    let active = true;
    const generation = chatGenerationRef.current + 1;
    chatGenerationRef.current = generation;
    ++speechDisplayGeneration.current;
    avatarSpeechRef.current?.cancel();
    setGenerating(false);
    setWaitingForSpeech(false);
    setSpokenStageText(undefined);
    dispatchTalkCausalCue({ type: "reset", generation });
    setHydrating(true);
    setPersistenceWarning(false);
    setSetupHydrationFailed(false);
    let controller: ChatController | undefined;
    let memoryQueue: MemorySyncQueue | undefined;
    const warnPersistence = (error?: unknown) => {
      const message = chatStore?.getPersistenceWarning?.() ?? (error instanceof Error && error.message === "別の画面で会話が更新されました"
        ? error.message
        : true);
      if (active && chatGenerationRef.current === generation) setPersistenceWarning(message);
    };
    const setup = async () => {
      const browserState = chatStore ? { store: chatStore, persistent: chatStorePersistent } : await createBrowserLocalStateStore();
      if (!active) return;
      if (!browserState.persistent) warnPersistence();
      const resilientStore: LocalStateStore = inheritAuthoritativeRevisionCoordinator(browserState.store, {
        load: async () => {
          try {
            const snapshot = await browserState.store.load();
            if (active) setPersistenceWarning(browserState.store.getPersistenceWarning?.() ?? !browserState.persistent);
            draftRef.current = snapshot.draft;
            const cards = snapshot.timeline.filter((item): item is CallCard => item.type === "call");
            callCardsRef.current = cards;
            callCardIdsRef.current = new Set(cards.map((item) => item.id));
            if (active) setCallCards(cards);
            return snapshot;
          } catch (error) {
            warnPersistence(error);
            if (requirePersistBeforeChat) throw error;
            return createMemoryLocalStateStore().load();
          }
        },
        save: async (snapshot) => {
          const calls = new Map<string, CallCard>();
          for (const item of [...snapshot.timeline, ...callCardsRef.current]) if (item.type === "call") calls.set(item.id, item);
          const timeline = orderedTimeline([...snapshot.timeline.filter((item) => item.type !== "call"), ...calls.values()]);
          try {
            await browserState.store.save({ ...snapshot, draft: draftRef.current, timeline });
            if (active && chatGenerationRef.current === generation) setPersistenceWarning(browserState.store.getPersistenceWarning?.() ?? !browserState.persistent);
          } catch (error) {
            warnPersistence(error);
            throw error;
          }
        },
        getPersistenceWarning: () => browserState.store.getPersistenceWarning?.() ?? null,
      });
      const authoritativeRevisionCoordinator = getAuthoritativeRevisionCoordinator(resilientStore);
      controller = createChatController({
        store: resilientStore,
        profileApi,
        chatApi: codexApi ? withCodex(chatApi, codexApi, job => { if (active) codexTask.onJob(job); }, message => { if (active) codexTask.setError(message); }) : chatApi,
        photoApi,
        authoritativeRevisionCoordinator: authoritativeRevisionCoordinator ?? undefined,
        now,
        nextId,
        requirePersistBeforeChat,
        onStateChange: () => {
          if (active && chatGenerationRef.current === generation) setChatVersion(version => version + 1);
        },
        onCausalCueObservation: (observation) => {
          if (causalCueEnabledRef.current) dispatchTalkCausalCue({ ...observation, generation });
        },
      });
      const pendingStore = memorySyncStore ?? fallbackMemorySyncStoreRef.current!;
      const persistedMemorySettings = typeof memoryApi.getSettings === "function"
        ? await memoryApi.getSettings().catch(() => null)
        : null;
      automaticMemoryEnabledRef.current = automaticMemoryEnabled && (persistedMemorySettings?.memoryEnabled ?? true);
      voiceMemoryEnabledRef.current = automaticMemoryEnabled && (persistedMemorySettings?.memoryEnabled ?? true);
      memoryQueue = automaticChatMemoryMode === "hosted_authoritative_snapshot" ? createMemorySyncQueue({
        process: async (input, signal) => memoryApi.process
          ? memoryApi.process(input, signal)
          : { sourceMessageId: input.sourceMessageId, state: "failed", appliedCount: 0 },
        loadPending: () => pendingStore.load(),
        savePending: (pending) => pendingStore.save(pending),
        automaticMemoryEnabled: () => automaticMemoryEnabledRef.current,
        now,
      }) : undefined;
      chatStoreRef.current = resilientStore;
      chatControllerRef.current = controller;
      memoryQueueRef.current = memoryQueue ?? null;
      await controller.hydrate();
      await memoryQueue?.hydrate();
      if (proactiveMessagingEnabled && proactiveApi && controller.state.profile) {
        if (!proactiveOpenPromiseRef.current) {
          proactiveOpenPromiseRef.current = (async () => {
            const notificationEnabled = await notificationPreferenceStore.load().catch(() => false);
            const result = notificationEnabled
              ? await proactiveApi.open({ openedAt: now(), notificationsEnabled: true }).catch(() => ({ status: "failure" as const, code: "unavailable" }))
              : null;
            return { notificationEnabled, result };
          })();
        }
        const { notificationEnabled, result } = await proactiveOpenPromiseRef.current;
        if (active) setNotificationsEnabled(notificationEnabled);
        if (active && result?.status === "candidate") {
            const messageId = await controller.appendProactiveCandidate({
              candidateId: result.candidate.id,
              text: result.candidate.text,
              createdAt: result.candidate.createdAt,
            });
            if (active) setProactiveAction({ candidateId: result.candidate.id, messageId, source: result.candidate.source, state: "ready", failed: false });
        }
      }
      if (active) { setChatVersion((version) => version + 1); setHydrating(false); }
    };
    void setup().catch((error) => {
      if (active) {
        warnPersistence(error);
        setSetupHydrationFailed(true);
        setSetupError("設定を読み込めませんでした。再読み込みしてもう一度お試しください。");
        setHydrating(false);
      }
    });
    return () => {
      active = false;
      controller?.dispose();
      memoryQueue?.cancel();
      if (chatControllerRef.current === controller) chatControllerRef.current = null;
      if (memoryQueueRef.current === memoryQueue) memoryQueueRef.current = null;
      chatStoreRef.current = null;
    };
  }, [codexApi, automaticChatMemoryMode, automaticMemoryEnabled, chatApi, chatStore, chatStorePersistent, memoryApi, memorySyncStore, nextId, notificationPreferenceStore, now, photoApi, proactiveApi, proactiveMessagingEnabled, profileApi, requirePersistBeforeChat]);

  useEffect(() => {
    if (!causalCueEnabled) {
      dispatchTalkCausalCue({ type: "clear", generation: chatGenerationRef.current });
    }
  }, [causalCueEnabled]);

  useEffect(() => {
    const cue = talkCausalCueState.cue;
    if (cue?.phase !== "delivered") return;
    const dismiss = () => dispatchTalkCausalCue({
      type: "dismiss-delivered",
      generation: talkCausalCueState.generation,
      requestId: cue.requestId,
    });
    if (view !== "chat" || primaryView !== "talk" || visualStyle !== "yui" || callPreparing || dictationState !== "idle") {
      dismiss();
      return;
    }
    const timer = window.setTimeout(dismiss, 1_800);
    return () => window.clearTimeout(timer);
  }, [callPreparing, dictationState, primaryView, talkCausalCueState.cue, talkCausalCueState.generation, view, visualStyle]);

  useEffect(() => {
    const queue = memoryQueueRef.current;
    const controller = chatControllerRef.current;
    if (!queue || !controller || hydrating || completedMemorySourcesRef.current.length === 0) return;
    const completed = completedMemorySourcesRef.current.splice(0);
    for (const source of completed) {
      void queue.enqueue({
        ...source,
      }).catch(() => undefined);
    }
  }, [hydrating, memoryRenderVersion]);

  useEffect(() => {
    if (view === "session" && state.phase === "ended") {
      const client = clientRef.current;
      const generation = connectedCallGenerationRef.current;
      const usageContext = client?.usageContext?.() ?? undefined;
      const memoryBatch = client?.consumeMemoryBatch?.() ?? null;
      if (usageContext) {
        const card: CallCard = { id: `call:${usageContext.sessionId}`, type: "call", startedAt: usageContext.startedAt, endedAt: usageContext.endedAt };
        if (!callCardIdsRef.current.has(card.id)) {
          callCardIdsRef.current.add(card.id);
          callCardsRef.current = [...callCardsRef.current, card];
          setCallCards(callCardsRef.current);
          const controller = chatControllerRef.current;
          if (controller) {
            void controller.flush().catch(() => setPersistenceWarning(chatStoreRef.current?.getPersistenceWarning?.() ?? true));
          }
        }
      }
      clientRef.current = null;
      connectedCallGenerationRef.current = 0;
      endingRef.current = false;
      setEnding(false);
      setCallPreparing(false);
      setCallError(null);
      dispatch({ type: "reset" });
      setView("chat");

      if (memoryBatch && voiceMemoryEnabledRef.current && memoryApi.process) {
        const controller = new AbortController();
        voiceMemoryAbortRef.current?.abort();
        voiceMemoryAbortRef.current = controller;
        void createVoiceMemorySourceId(memoryBatch.sessionId).then((sourceMessageId) => {
          if (controller.signal.aborted || callStartGenerationRef.current !== generation || !voiceMemoryEnabledRef.current) return;
          return memoryApi.process?.({
            sourceMessageId,
            sourceOccurredAt: memoryBatch.sourceOccurredAt,
            sourceOrigin: "voice",
            explicitMemoryTargetTurnIndexes: memoryBatch.explicitMemoryTargetTurnIndexes,
            turns: memoryBatch.turns.map(({ role, text }) => ({
              role,
              text,
              provenance: role === "user" ? "authoritative_source" : "context",
            })),
          }, controller.signal);
        }).catch(() => undefined).finally(() => {
          if (voiceMemoryAbortRef.current === controller) voiceMemoryAbortRef.current = null;
        });
      }
    }
  }, [memoryApi, state.phase, view]);

  useEffect(
    () => () => {
      callStartGenerationRef.current += 1;
      const attempt = activeCallStartRef.current;
      activeCallStartRef.current = null;
      if (attempt) finishCallStart(attempt, "failed");
      const client = clientRef.current;
      clientRef.current = null;
      connectedCallGenerationRef.current = 0;
      voiceMemoryAbortRef.current?.abort();
      voiceMemoryAbortRef.current = null;
      client?.cancelMemory?.();
      client?.stop();
    },
    [],
  );

  const failCallStart = (
    generation: number,
    cause: unknown,
    source?: RealtimeClient,
  ) => {
    if (callStartGenerationRef.current !== generation) return;
    const attempt = activeCallStartRef.current;
    if (source && (!attempt || attempt.client !== source || attempt.generation !== generation)) return;
    activeCallStartRef.current = null;
    if (attempt) finishCallStart(attempt, "failed");
    dispatch({ type: "failed", error: normalizeRealtimeError(cause) });
    setCallPreparing(false);
    setCallError(microphoneFailureMessage(cause, "call"));
    setView("chat");
  };

  const handleSessionAction = (
    action: Parameters<typeof dispatch>[0],
    source: RealtimeClient,
    generation: number,
  ) => {
    const attempt = activeCallStartRef.current;
    const isActiveAttempt = attempt?.generation === generation && attempt.client === source;
    const isConnectedClient = connectedCallGenerationRef.current === generation && clientRef.current === source;
    if (action.type === "connected") {
      if (!isActiveAttempt || !attempt) return;
      activeCallStartRef.current = null;
      finishCallStart(attempt, "connected");
      clientRef.current = source;
      connectedCallGenerationRef.current = generation;
      dispatch(action);
      setCallPreparing(false);
      setCallError(null);
      setView("session");
      return;
    }
    if (action.type === "failed") {
      if (isActiveAttempt) {
        failCallStart(generation, action.error, source);
      } else if (isConnectedClient) {
        clientRef.current = null;
        connectedCallGenerationRef.current = 0;
        source.cancelMemory?.();
        source.stop();
        dispatch(action);
        setCallPreparing(false);
        setCallError(microphoneFailureMessage(action.error, "call"));
        setView("chat");
      }
      return;
    }
    if (!isConnectedClient) return;
    if (action.type === "transcript") {
      const id = action.id ?? `voice:${generation}:${crypto.randomUUID()}`;
      void chatControllerRef.current?.appendVoiceTurn({id, ...action.turn, createdAt: action.occurredAt ?? new Date().toISOString()})
        .catch(() => setPersistenceWarning(chatStoreRef.current?.getPersistenceWarning?.() ?? true));
    }
    dispatch(action);
  };

  const startSession = async () => {
    if (localPreview) return;
    if (activeCallStartRef.current || clientRef.current) {
      return;
    }

    bgm.pause();
    // Suspend speech for the call without changing the chosen chat layout.
    avatarSpeechRef.current?.disable();
    dictationRef.current?.abort();
    voiceMemoryAbortRef.current?.abort();
    voiceMemoryAbortRef.current = null;
    dispatch({ type: "reset" });
    setEnding(false);
    endingRef.current = false;
    setCallPreparing(true);
    setCallError(null);

    const generation = callStartGenerationRef.current + 1;
    callStartGenerationRef.current = generation;
    let source: RealtimeClient | undefined;
    try {
      const client = realtimeClient((action) => {
        if (source) handleSessionAction(action, source, generation);
      });
      source = client;
      const attempt = createCallStartAttempt(generation, client, (timedOutGeneration) => {
        const timeout = new Error("Realtime start timed out");
        timeout.name = "TimeoutError";
        failCallStart(timedOutGeneration, timeout, client);
      });
      activeCallStartRef.current = attempt;
      await client.start();
    } catch (cause) {
      failCallStart(generation, normalizeRealtimeError(cause), source);
    }
  };

  const endSession = () => {
    if (endingRef.current) {
      return;
    }
    endingRef.current = true;
    setEnding(true);
    clientRef.current?.stop();
  };

  const refreshChat = (source: ChatController) => {
    void Promise.resolve().then(() => {
      if (chatControllerRef.current === source) setChatVersion((version) => version + 1);
    });
  };

  const saveInitialProfile = (input: { displayName: string; addressingStyle: "san" | "none" }) => {
    const controller = chatControllerRef.current;
    if (!controller || setupSaving) return;
    setSetupSaving(true);
    setSetupError(null);
    void controller.saveProfile(input).then(() => {
      if (chatControllerRef.current === controller) {
        setSetupSaving(false);
        setChatVersion((version) => version + 1);
      }
    }).catch(() => {
      if (chatControllerRef.current === controller) {
        setSetupSaving(false);
        setSetupError("設定を保存できませんでした。もう一度お試しください。");
      }
    });
  };

  const saveProfileSettings = (input: { displayName: string; addressingStyle: "san" | "none"; occupation?: string; region?: string }) => {
    const controller = chatControllerRef.current;
    if (!controller || settingsSaving) return;
    setSettingsSaving(true);
    setSettingsError(null);
    void controller.updateProfile(input).then(() => {
      if (localPreview) saveLocalProfileDetails({occupation: input.occupation ?? "", region: input.region ?? ""});
      if (chatControllerRef.current === controller) {
        setSettingsSaving(false);
        setSettingsOpen(false);
        setChatVersion((version) => version + 1);
      }
    }).catch(() => {
      if (chatControllerRef.current === controller) {
        setSettingsSaving(false);
        setSettingsError("設定を保存できませんでした。もう一度お試しください。");
      }
    });
  };

  const setGoogleHomeVisible = async (service: GoogleService, visible: boolean) => {
    const status = await googleCalendarTasksApi.setHomeVisible(service, visible);
    setHomeManagementModel((current) => {
      const connected = status.state === "connected";
      const next = setHomeServiceConnection(current, service, connected);
      return connected && status.homeVisible
        ? setHomeServiceHomeVisible(next, service, true)
        : next;
    });
  };

  const stopGoogleService = async (service: GoogleService) => {
    await googleCalendarTasksApi.stopService(service);
    setHomeManagementModel((current) => {
      const disconnected = setHomeServiceConnection(current, service, false);
      return {
        ...disconnected,
        services: disconnected.services.map((candidate) => candidate.id === service
          ? { ...candidate, connectionState: "disconnected" as const }
          : candidate),
      };
    });
  };

  const startGoogleService = async (service: GoogleService) => {
    const authorizationUrl = await googleCalendarTasksApi.beginConnection(service);
    window.location.assign(authorizationUrl);
  };

  const previewGoogleService = async (service: GoogleService, signal?: AbortSignal, sourceId?: string) => sourceId ? googleCalendarTasksApi.preview(service, signal, sourceId) : googleCalendarTasksApi.preview(service, signal);

  const signOut = () => {
    if (!onSignOut || signingOut) return;
    setSigningOut(true);
    setSettingsError(null);
    dictationRef.current?.abort();
    voiceMemoryAbortRef.current?.abort();
    voiceMemoryAbortRef.current = null;
    clientRef.current?.cancelMemory?.();
    clientRef.current?.stop();
    memoryQueueRef.current?.cancel();
    void Promise.resolve().then(onSignOut).catch(() => {
      setSigningOut(false);
      setSettingsError("ログアウトできませんでした。もう一度お試しください。");
    });
  };

  const closeMenusToHome = () => {
    setReturnHomeRequestId(id => id + 1);
    setMenuOpen(false);
    setSettingsOpen(false);
    setSettingsDetail(null);
    setMemoryHubOpen(false);
    setLifeSettingsSection(null);
    setHomeManagementView(null);
    setSourceMessageId(null);
    setPrimaryView("talk");
    setView("chat");
    if (lifeSettingsSection === "voice" && avatarVoiceOn) avatarSpeechRef.current?.enable();
  };
  const withLaunch = (content: ReactNode) => <MenuHomeContext.Provider value={closeMenusToHome}>
    {content}
    {!launchDismissed ? <Splash ready={!hydrating} onDismiss={() => setLaunchDismissed(true)} /> : null}
  </MenuHomeContext.Provider>;

  if (hydrating) {
    return withLaunch(null);
  }

  const controller = chatControllerRef.current;
  if (!controller || !controller.state.profile) {
    return withLaunch(<Setup saving={setupSaving} blocked={setupHydrationFailed} error={setupError} onSave={saveInitialProfile} />);
  }

  const notificationSettings = proactiveMessagingEnabled ? {
    enabled: notificationsEnabled,
    osPermission: osNotificationPermission(),
    onChange: async (enabled: boolean) => {
      try {
        await notificationPreferenceStore.save(enabled);
        setNotificationsEnabled(enabled);
      } catch {
        setSettingsError("通知設定を保存できませんでした。もう一度お試しください。");
      }
    },
  } : undefined;

  const navigation = integratedUiEnabled && !lifeServicesApi ? <IntegratedNavigation
    current={primaryView}
    focusCurrent={pendingNavFocus === primaryView}
    onNavigate={(next, cause) => {
      setPrimaryView(next);
      setPendingNavFocus(cause === "keyboard" ? next : null);
    }}
    onCurrentFocused={() => setPendingNavFocus(null)}
  /> : undefined;
  const navigateIntegrated = (direction: "previous" | "next") => {
    setPrimaryView((current) => moveIntegratedUiView(current, direction === "next" ? 1 : -1));
    setPendingNavFocus(null);
  };
  const integratedPageHeader = integratedUiEnabled ? <IntegratedPageHeader
    onOpenMenu={() => { setSourceMessageId(null); setSettingsError(null); setMenuOpen(true); }}
    onCall={startSession}
    callPreparing={callPreparing}
    callDisabled={localPreview || hydrating || !controller}
  /> : undefined;
  const latestAvatarReply = [...(controller?.state.snapshot.timeline ?? [])].reverse().find((item): item is Extract<ChatMessage, { role: "assistant" }> => item.type === "message" && item.role === "assistant");
  const firstAvatarReply = latestAvatarReply?.replyGroupId
    ? controller?.state.snapshot.timeline.find((item): item is ChatMessage => item.type === "message" && item.role === "assistant" && item.replyGroupId === latestAvatarReply.replyGroupId)
    : latestAvatarReply;
  const avatarExpression = conversationExpression(firstAvatarReply?.text ?? "");
  const avatarPreparing = view !== "session" && ((avatarVoiceOn && waitingForSpeech)
    || (controller?.state.snapshot.timeline.some(item => item.type === "message" && item.role === "user" && item.delivery === "sending") ?? false));
  const selectedVrm = characterController.preference.mode === "vrm" ? characterController.preference.model : undefined;
  const avatarStageProps = {
    enabled: true,
    preparing: avatarPreparing,
    expression: avatarExpression,
    expressionKey: latestAvatarReply?.replyGroupId ?? latestAvatarReply?.id,
    interactive: view !== "session",
    visible: view === "session" || (!menuOpen && !settingsOpen),
    fallback: ZUNDAMON_PORTRAIT,
    readAudioSignal: live2dReadAudioSignal,
  };
  const avatarLoading = <figure className="live2d-avatar-stage"><AvatarLoading /></figure>;
  const selectedAvatar = <aside className="talk-avatar" aria-label="ずんだもんの姿">
    {!characterController.ready && !selectedVrm ? avatarLoading : selectedVrm || (live2dAvatarEnabled && live2dModel?.id === ZUNDAMON_MODEL_ID) ?
      <Suspense fallback={selectedVrm ? avatarLoading : <figure className="live2d-avatar-stage"><img className="live2d-avatar-fallback" src={ZUNDAMON_PORTRAIT.src} alt={ZUNDAMON_PORTRAIT.alt} /></figure>}>
        {selectedVrm
          ? <LazyVrmStage {...avatarStageProps} model={selectedVrm} />
          : <LazyAvatarStage {...avatarStageProps} manifest={live2dModel} loadRenderer={live2dRendererLoader} capability={live2dCapability} />}
      </Suspense>
    : <div className="zundamon-character-stage">
      <img src="/characters/zundamon/sakamoto-ahiru.png" alt="キャラクター（素材未設定時は代替画像）" />
    </div>}
  </aside>;
  const returnToMenu = () => {
    setMemoryHubOpen(false);
    setLifeSettingsSection(null);
    setSettingsOpen(false);
    setSettingsDetail(null);
    setMenuOpen(true);
  };
  const integratedOverlay = integratedUiEnabled && controller.state.profile ? <>
    {menuOpen ? <AppMenu
      bgm={bgm}
      characterController={characterController}
      motionGallery={live2dAvatarEnabled && live2dModel?.id === ZUNDAMON_MODEL_ID ? {manifest:live2dModel,loadRenderer:live2dRendererLoader,capability:live2dCapability} : undefined}
      onClose={() => setMenuOpen(false)}
      onOpenVoiceSettings={voiceStatus?()=>{avatarSpeechRef.current?.disable();setMenuOpen(false);setLifeSettingsSection("voice");}:undefined}
      onOpenAISettings={aiConnectionApi?()=>{setMenuOpen(false);setLifeSettingsSection("ai");}:undefined}
      onOpenSettings={() => { setMenuOpen(false); setSettingsOpen(true); }}
      onOpenConnections={() => { setMenuOpen(false); if(lifeServicesApi)setLifeSettingsSection("google");else setHomeManagementView("connections"); }}
      onOpenLocation={lifeServicesApi ? () => {setMenuOpen(false);setLifeSettingsSection("home");} : undefined}
      personalMenu={lifeServicesApi ? {memory:()=>{setMenuOpen(false);setMemoryHubOpen(true);},style:()=>{setMenuOpen(false);setSettingsDetail("style");setSettingsOpen(true);},about:()=>{setMenuOpen(false);setSettingsDetail("about");setSettingsOpen(true);},signOut:onSignOut?()=>{setMenuOpen(false);signOut();}:undefined}:undefined}
      onOpenHomeEdit={() => { setMenuOpen(false); setHomeManagementView("home"); }}
    /> : null}
    {settingsOpen ? <ProfileSettings wallpaperController={wallpaperController} personalDetails={localPreview ? readLocalProfileDetails() : { occupation: controller.state.profile?.occupation ?? "", region: controller.state.profile?.region ?? "" }} initialPage={settingsDetail??"main"} profile={controller.state.profile} saving={settingsSaving || signingOut} error={settingsError} onSave={saveProfileSettings} onClose={() => { if (!settingsSaving && !signingOut) returnToMenu(); }} onOpenMemories={() => { setSettingsOpen(false); setView("memories"); }} onSignOut={onSignOut ? signOut : undefined} onUpdatePassword={onUpdatePassword} integratedSheet notificationSettings={notificationSettings} /> : null}
  </> : null;

  if (view === "memories") {
    return withLaunch(<SavedMemories
      memoryApi={memoryApi}
      onClose={() => { setView("chat"); if(lifeServicesApi)setMemoryHubOpen(true);else setSettingsOpen(true); }}
      onOpenSource={(messageId) => {
        const hasSource = chatControllerRef.current?.state.snapshot.timeline.some((item) => item.type === "message" && item.id === messageId) ?? false;
        if (!hasSource) return false;
        setMemoryHubOpen(false);
        setSourceMessageId(messageId);
        setSettingsOpen(false);
        setPrimaryView("talk");
        setView("chat");
        return true;
      }}
      onMemoryChanged={() => setMemoryRenderVersion((version) => version + 1)}
      onSettingsChanged={(settings) => {
        automaticMemoryEnabledRef.current = automaticMemoryEnabled && settings.memoryEnabled;
        voiceMemoryEnabledRef.current = automaticMemoryEnabled && settings.memoryEnabled;
      }}
      now={() => new Date(now())}
    />);
  }

  if (view === "chat") {
    const chatState = controller?.state ?? initialChatState;
    const displayedChatState = {
      ...chatState,
      snapshot: {
        ...chatState.snapshot,
        draft: draftRef.current,
        timeline: orderedTimeline([...chatState.snapshot.timeline.filter((item) => item.type !== "call"), ...callCards]),
      },
    };
    const scheduleMemoryAfterReply = (source: ChatController, sourceMessageId: string) => {
      const message = source.state.snapshot.timeline.find((item): item is ChatMessage => (
        item.type === "message"
        && item.id === sourceMessageId
        && item.role === "user"
        && item.delivery === "sent"
      ));
      const hasReply = source.state.snapshot.timeline.some((item) => (
        item.type === "message"
        && item.role === "assistant"
        && item.replyGroupId === `${sourceMessageId}:assistant`
      ));
      if (!message || !hasReply || shouldExcludeAutomaticMemorySource(source.state.snapshot, sourceMessageId)) return;
      if (automaticChatMemoryMode === "hosted_authoritative_snapshot") completedMemorySourcesRef.current.push({ sourceMessageId, sourceOccurredAt: message.createdAt });
      setMemoryRenderVersion((version) => version + 1);
    };
    const sendText = (text: string, retryMessageId?: string) => {
      if (!text.trim() && !retryMessageId) return;
      const source = chatControllerRef.current;
      if (!source) return;
      codexTask.dismiss();
      if (!localPreview && avatarVoiceOn) avatarSpeechRef.current?.enable();
      const speakReply = !localPreview && avatarVoiceOn ? avatarSpeechRef.current?.begin() : undefined;
      const speechGeneration = ++speechDisplayGeneration.current;
      setGenerating(true);
      setWaitingForSpeech(Boolean(speakReply));
      setSpokenStageText(speakReply ? "" : undefined);
      const revealSpeech = () => {if (speechDisplayGeneration.current === speechGeneration) setWaitingForSpeech(false);};
      const request = retryMessageId ? source.retryChat(retryMessageId).then(() => retryMessageId) : source.send(text);
      refreshChat(source);
      void request.then((sourceMessageId) => {
        if (speechDisplayGeneration.current !== speechGeneration) return;
        if (chatControllerRef.current === source) {
          setChatVersion((version) => version + 1);
          scheduleMemoryAfterReply(source, sourceMessageId);
          if (!sourceMessageId || !speakReply) { revealSpeech(); setGenerating(false); }
          if (sourceMessageId && speakReply) {
            const reply = source.state.snapshot.timeline.filter((item): item is ChatMessage => item.type === "message" && item.role === "assistant" && item.replyGroupId === `${sourceMessageId}:assistant`).map(item => item.text).join("\n");
            void speakReply(reply, chunk => {
              if (speechDisplayGeneration.current !== speechGeneration) return;
              setSpokenStageText(previous => previous ? `${previous}\n\n${chunk}` : chunk);
              revealSpeech();
            }).finally(() => {
              if (speechDisplayGeneration.current !== speechGeneration) return;
              setGenerating(false);
              // Also reveal the full reply if playback was cancelled or failed.
              setSpokenStageText(undefined);
              revealSpeech();
            });
          }
        }
      }, () => {
        if (speechDisplayGeneration.current !== speechGeneration) return;
        setGenerating(false);
        revealSpeech();
        if (chatControllerRef.current === source) setChatVersion((version) => version + 1);
      });
    };
    const runProactiveAction = (action: ProactiveUiAction) => {
      const current = proactiveAction;
      if (!current || current.state === "processing" || !proactiveApi || proactiveActionInFlightRef.current !== null) return;
      proactiveActionInFlightRef.current = current.candidateId;
      setProactiveAction({ ...current, state: "processing", failed: false });
      void proactiveApi.act({ candidateId: current.candidateId, action }).then((result) => {
        if (result.status !== "updated" || result.candidateId !== current.candidateId) {
          setProactiveAction((latest) => latest?.candidateId === current.candidateId ? { ...latest, state: "ready", failed: true } : latest);
          return;
        }
        setProactiveAction((latest) => latest?.candidateId === current.candidateId ? { ...latest, state: result.state, failed: false } : latest);
      }, () => {
        setProactiveAction((latest) => latest?.candidateId === current.candidateId ? { ...latest, state: "ready", failed: true } : latest);
      }).finally(() => {
        if (proactiveActionInFlightRef.current === current.candidateId) proactiveActionInFlightRef.current = null;
      });
    };
    sendTextRef.current = sendText;
    const stopDictation = (completion: "draft" | "send") => {
      const dictation = dictationRef.current;
      if (!dictation) {
        setDictationError("このブラウザでは音声入力を使えません。");
        return;
      }
      if (dictation.state === "recording") {
        dictationCompletionRef.current = completion;
        void dictation.stop();
        return;
      }
    };
    const toggleDictation = () => {
      if (localPreview) return;
      const dictation = dictationRef.current;
      if (!dictation) {
        setDictationError("このブラウザでは音声入力を使えません。");
        return;
      }
      if (dictation.state === "recording") {
        stopDictation("draft");
        return;
      }
      const current = chatControllerRef.current;
      const hasPending = current?.state.snapshot.timeline.some((item) => item.type === "message" && item.role === "user" && item.delivery === "sending") ?? false;
      if (draftRef.current.trim() || hasPending || callPreparing || clientRef.current) return;
      bgm.pause();
      // Release the playback-only iOS audio session before requesting the microphone.
      // The next text send recreates the speech player within the user gesture.
      avatarSpeechRef.current?.disable();
      dictationCompletionRef.current = "draft";
      setDictationError(null);
      void dictation.start();
    };
    if (settingsOpen && chatState.profile && !integratedUiEnabled) {
      return withLaunch(<ProfileSettings wallpaperController={wallpaperController} personalDetails={localPreview ? readLocalProfileDetails() : { occupation: chatState.profile?.occupation ?? "", region: chatState.profile?.region ?? "" }} profile={chatState.profile} saving={settingsSaving || signingOut} error={settingsError} onSave={saveProfileSettings} onClose={() => { if (!settingsSaving && !signingOut) setSettingsOpen(false); }} onOpenMemories={() => { setSettingsOpen(false); setView("memories"); }} onOpenChatSearch={integratedUiEnabled ? () => { setSettingsOpen(false); setPrimaryView("talk"); setChatSearchRequestId((current) => current + 1); } : undefined} onSignOut={onSignOut ? signOut : undefined} onUpdatePassword={onUpdatePassword} notificationSettings={notificationSettings} />);
    }
    let menuPage: ReactNode = null;
    if(memoryHubOpen && lifeServicesApi && chatState.profile) menuPage = (<MemoryHub profile={chatState.profile} api={lifeServicesApi} memoryApi={memoryApi} googleApi={googleCalendarTasksApi} onClose={returnToMenu} onOpenMemories={()=>{setMemoryHubOpen(false);setView("memories");}} onSaveProfile={async input=>{await controller.updateProfile({...input,addressingStyle:chatState.profile!.addressingStyle});if(localPreview)saveLocalProfileDetails({occupation:input.occupation,region:input.region});setChatVersion(version=>version+1);}} onSaveName={async name=>{await controller.updateProfile({displayName:name,addressingStyle:chatState.profile!.addressingStyle});setChatVersion(version=>version+1);}} onMemoryEnabled={enabled=>{automaticMemoryEnabledRef.current=automaticMemoryEnabled&&enabled;voiceMemoryEnabledRef.current=automaticMemoryEnabled&&enabled;}}/>);
    else if(lifeSettingsSection === "voice" && voiceStatus && selectVoiceProvider && createAvatarSpeechPlayer)menuPage = (<VoiceConnection status={voiceStatus} select={selectVoiceProvider} createPlayer={createAvatarSpeechPlayer} onClose={()=>{if(avatarVoiceOn)avatarSpeechRef.current?.enable();returnToMenu();}}/>);
    else if(lifeSettingsSection === "ai" && aiConnectionApi)menuPage = (<AIConnection api={aiConnectionApi} codexApi={codexApi} onClose={returnToMenu}/>);
    else if(lifeSettingsSection === "google") menuPage = (<GoogleConnections gmailApi={gmailApi} driveApi={driveApi} api={googleCalendarTasksApi} onClose={returnToMenu}/>);
    else if(lifeSettingsSection && lifeSettingsSection!=="ai" && lifeSettingsSection!=="voice" && lifeServicesApi) menuPage = (<LifeSettings api={lifeServicesApi} googleApi={googleCalendarTasksApi} onClose={returnToMenu} initialSection={lifeSettingsSection}/>);
    if (integratedUiEnabled && homeManagementView && !lifeServicesApi) {
      const toggleHome = (id: HomeServiceId) => {
        const service = homeManagementModel.services.find((candidate) => candidate.id === id);
        if (!service || !service.connected || !service.homeSupported) return;
        if (id === "calendar" || id === "tasks") {
          void setGoogleHomeVisible(id, !service.homeVisible).catch(() => undefined);
          return;
        }
        setHomeManagementModel((current) => setHomeServiceHomeVisible(current, id, !service.homeVisible));
      };
      const toggleWidget = (id: HomeWidget["id"]) => toggleHome(id);
      return withLaunch(<HomeManagement
        view={homeManagementView}
        model={homeManagementModel}
        onClose={() => setHomeManagementView(null)}
        onChangeView={setHomeManagementView}
        onToggleHome={toggleHome}
        onToggleWidget={toggleWidget}
        onMoveWidget={(id, direction) => setHomeManagementModel((current) => moveHomeWidget(current, id, direction))}
        onDisconnect={(id) => {
          if (id === "calendar" || id === "tasks") {
            return stopGoogleService(id);
          }
          setHomeManagementModel((current) => setHomeServiceConnection(current, id, false));
        }}
        onConnect={startGoogleService}
        onSaveWeatherLocation={(location) => {
          setHomeManagementModel((current) => setHomeWeatherLocation(current, location));
          setHomeManagementView("home");
        }}
      />);
    }
    if (integratedUiEnabled && primaryView === "home" && !lifeServicesApi) {
      return withLaunch(<><Home header={integratedPageHeader} navigation={navigation} model={toHomeViewModel(homeManagementModel)} portrait={yuiPortrait} dashboardProgress={dashboardProgress} visualStyle={visualStyle} onNavigate={navigateIntegrated} onOpenHomeManagement={setHomeManagementView} onPreviewGoogleService={previewGoogleService} onListGoogleSources={googleCalendarTasksApi.sources} googleSourceChoices={googleCalendarTasksApi.sourceChoices} onStartConversation={(draft) => { draftRef.current = draft; setPrimaryView("talk"); }} />{integratedOverlay}</>);
    }
    if (integratedUiEnabled && primaryView === "news" && !lifeServicesApi) {
      return withLaunch(<><News header={integratedPageHeader} navigation={navigation} model={EMPTY_NEWS_VIEW_MODEL} onNavigate={navigateIntegrated} onStartConversation={(draft) => { draftRef.current = draft; setPrimaryView("talk"); }} />{integratedOverlay}</>);
    }
    return withLaunch(<>
      <Chat
      bgm={bgmApi ? bgm : undefined}
      taskStatus={<CodexTask job={codexTask.visibleJob} onDismiss={codexTask.dismiss} api={codexApi} error={codexTask.error} onError={codexTask.setError} onJob={codexTask.onJob} onResult={() => sendText('Codexの結果を見せて')} busy={generating || hydrating} />}
      localPreview={localPreview}
      hydrating={hydrating || !controller}
      persistenceWarning={persistenceWarning}
      persistenceRetrying={persistenceRetrying}
      onRetryPersistence={!hydrating && controller ? () => {
        if (persistenceRetryRef.current) return;
        persistenceRetryRef.current=true;setPersistenceRetrying(true);
        void controller.flush().catch(() => {
          if(chatControllerRef.current===controller)setPersistenceWarning(chatStoreRef.current?.getPersistenceWarning?.() ?? true);
        }).finally(() => {persistenceRetryRef.current=false;setPersistenceRetrying(false);});
      } : undefined}
      state={displayedChatState}
      delayedGreetingReplyGroupId={displayedChatState.delayedGreetingReplyGroupId}
      onGreetingRevealed={(replyGroupId) => {
        if (chatControllerRef.current !== controller) return;
        controller.markProfileGreetingRevealed(replyGroupId);
        refreshChat(controller);
      }}
      conversationGeneration={chatGenerationRef.current}
      causalCueEnabled={causalCueEnabled}
      causalCue={talkCausalCueState.generation === chatGenerationRef.current ? talkCausalCueState.cue : null}
      visualStyle={visualStyle}
      sourceMessageId={sourceMessageId}
      clearDraftRequestId={photoDraftClearRequestId}
      returnHomeRequestId={returnHomeRequestId}
      openSearchRequestId={chatSearchRequestId}
      onSearchRequestHandled={() => setChatSearchRequestId(0)}
      avatar={selectedAvatar}
      waitingForSpeech={avatarVoiceOn && waitingForSpeech}
      spokenStageText={avatarVoiceOn ? spokenStageText : undefined}
      menuExpanded={menuOpen || settingsOpen}
      avatarControls={<div className="avatar-conversation-controls">
        <button type="button" aria-label={`音声${avatarVoiceOn ? "ON" : "OFF"}`} title={avatarVoiceOn ? "音声をOFFにする" : "音声をONにする"} aria-pressed={avatarVoiceOn} onClick={() => {
          setAvatarVoiceError(null);
          if (avatarVoiceOn) avatarSpeechRef.current?.disable();
          else if (!localPreview) avatarSpeechRef.current?.enable();
          setAvatarVoiceOn(!avatarVoiceOn);
        }}>{avatarVoiceOn ? <SpeakerHigh aria-hidden="true" size={23} /> : <SpeakerSlash aria-hidden="true" size={23} />}</button>
        {localPreview && avatarVoiceOn ? <span className="avatar-voice-unavailable" role="status">音声はまだ未接続です</span> : null}
        {avatarVoiceError ? <span role="status">{avatarVoiceError}</span> : null}
      </div>}
      integratedChrome={integratedUiEnabled}
      suppressComposerAutofocus={pendingNavFocus === "talk"}
      renderLifeCard={lifeServicesApi ? (card,messageId) => <LifeCardView writesApi={writesApi} gmailApi={gmailApi} card={card} driveApi={driveApi} api={lifeServicesApi} onCardChange={async next => {await controller.updateLifeCard(messageId,next);if(chatControllerRef.current===controller)refreshChat(controller);}}/> : undefined}
        onOpenSettings={() => { setSourceMessageId(null); setSettingsError(null); if (integratedUiEnabled) setMenuOpen(true); else setSettingsOpen(true); }}
      onAuthenticationRequired={onSignOut ? signOut : undefined}
      onCall={startSession}
      proactiveAction={proactiveAction ? {
        messageId: proactiveAction.messageId,
        state: proactiveAction.state,
        failed: proactiveAction.failed,
        canCancel: proactiveAction.source === "one_time_reminder",
        onAction: runProactiveAction,
      } : null}
      callPreparing={callPreparing}
      callDisabled={localPreview || hydrating || !controller}
      dictationState={dictationState}
      dictationDraft={dictationDraft}
      dictationError={dictationError}
      dictationDisabled={callPreparing || clientRef.current !== null}
      onStartDictation={toggleDictation}
      onSendDictation={() => stopDictation("send")}
      callError={callError}
      photoInputEnabled={photoAnalysisEnabled && Boolean(photoApi) && Boolean(controller) && photoPreview === null}
      photoInputBusy={photoPreparing}
      loadPhotoContent={photoAnalysisEnabled && photoApi ? photoApi.fetchContent : undefined}
      onDeletePhoto={photoApi ? (photoId) => {
        return controller.deletePhoto(photoId).then(() => {
          if (chatControllerRef.current !== controller) throw new Error("photo_delete_unconfirmed");
          const removed = !controller.state.snapshot.timeline.some((item) => item.type === "photo" && item.photoId === photoId);
          if (!removed) throw new Error("photo_delete_unconfirmed");
          refreshChat(controller);
        });
      } : undefined}
      onPhotoSelected={(file) => {
        if (!photoAnalysisEnabled || !photoApi || !controller || photoPreview) return;
        const composer = photoComposerRef.current;
        setPhotoError(null);
        setPhotoProgress(null);
        setPhotoPreparing(true);
        composer.beginPreparing();
        void photoPreparation(file).then((prepared) => {
          if (chatControllerRef.current !== controller || !photoAnalysisEnabled) { prepared.dispose(); setPhotoPreparing(false); return; }
          composer.showPreview(prepared);
          setPhotoPreparing(false);
          setPhotoPreview({ url: prepared.previewUrl, byteSize: prepared.byteSize, status: "confirming" });
        }, (error) => {
          composer.cancel();
          setPhotoPreparing(false);
          setPhotoError(classifyPhotoPreparationError(error));
        });
      }}
      photoStatusMessage={photoPreparing ? "写真を準備しています" : photoProgress ? photoProgressMessage(photoProgress) : null}
      photoErrorMessage={photoError ? photoPresentationMessage(photoError) : null}
      photoPreview={photoPreview ? { url: photoPreview.url, byteSize: photoPreview.byteSize, sending: photoPreview.status === "sending", retryable: photoPreview.status === "retryable", saveOnly: photoPreview.saveOnly } : null}
      onSendPhoto={() => {
        if (!photoAnalysisEnabled || !photoApi || !controller || !photoPreview || photoPreview.status === "sending") return;
        const pending = photoPreview;
        const retryId = pending.status === "retryable" ? pending.clientMessageId : undefined;
        let saveOnly = pending.saveOnly === true;
        const onProgress = (stage: PhotoProgressStage) => {
          if (chatControllerRef.current !== controller) return;
          setPhotoProgress(stage);
          if (stage === "commit_retryable") saveOnly = true;
          const presentationError = photoProgressError(stage);
          if (presentationError) setPhotoError(presentationError);
        };
        setPhotoError(null);
        setPhotoPreview({ ...pending, status: "sending" });
        const request: Promise<string> = retryId
          ? controller.retryPhoto(retryId, onProgress).then(() => retryId)
          : Promise.resolve().then(() => controller.sendPhoto(photoComposerRef.current.transfer(), draftRef.current, onProgress));
        void request.then((clientMessageId) => {
          if (chatControllerRef.current !== controller) return;
          const delivery = controller.photoDelivery(clientMessageId);
          if (delivery === "sent") {
            setPhotoProgress(null);
            photoComposerRef.current.finish();
            setPhotoPreview(null);
            setPhotoDraftClearRequestId((current) => current + 1);
          } else if (delivery === "retryable") {
            setPhotoProgress(null);
            setPhotoError(saveOnly ? "photo_save_unconfirmed" : "photo_send_failed");
            photoComposerRef.current.markRetryable();
            setPhotoPreview({ ...pending, status: "retryable", clientMessageId, saveOnly });
          } else {
            setPhotoProgress(null);
            setPhotoError("photo_result_unknown");
            photoComposerRef.current.terminal();
            setPhotoPreview(null);
          }
          refreshChat(controller);
        }, () => {
          if (chatControllerRef.current !== controller) return;
          setPhotoProgress(null);
          setPhotoError("photo_send_failed");
          photoComposerRef.current.terminal();
          setPhotoPreview(null);
          refreshChat(controller);
        });
      }}
      onCancelPhoto={() => {
        const pending = photoPreview;
        photoComposerRef.current.cancel();
        setPhotoError(null);
        setPhotoProgress(null);
        setPhotoPreview(null);
        if (!controller || pending?.status !== "retryable" || !pending.clientMessageId) return;
        void controller.cancelPhoto(pending.clientMessageId).then(() => refreshChat(controller));
      }}
      onDraftChange={(draft) => {
        draftRef.current = draft;
        const current = chatControllerRef.current;
        if (current) void current.updateDraft(draft).catch(() => undefined);
      }}
      generating={generating}
      onStopGeneration={() => {
        ++speechDisplayGeneration.current;
        avatarSpeechRef.current?.cancel();
        chatControllerRef.current?.stopGeneration();
        setGenerating(false);
        setWaitingForSpeech(false);
        setSpokenStageText(stageDialogue(chatControllerRef.current?.state.snapshot.timeline ?? []));
        if (chatControllerRef.current) refreshChat(chatControllerRef.current);
      }}
      onSend={sendText}
      onRetry={(messageId) => sendText("", messageId)}
      />

      {integratedOverlay}
      {menuPage}
    </>);
  }

  return withLaunch(<Session ending={ending} onEnd={endSession} state={state} onMute={() => clientRef.current?.setMuted?.(state.microphoneEnabled)} onInterrupt={() => clientRef.current?.interrupt?.()} />);
}

export function HostedApp({
  vrmStorageConfig,
  authClient,
  apiBaseUrl,
  fetchImpl,
  realtimeClient: suppliedRealtimeClient,
  cacheStore: suppliedCacheStore,
  splashDurationMs,
  now = currentTime,
  nextId = newId,
  integratedUiEnabled = INTEGRATED_UI_DEFAULT_ENABLED,
  yuiPortrait,
  photoAnalysisEnabled = false,
  prismEchoEnabled = false,
  live2dAvatarEnabled = false,
  live2dModel,
  live2dReadAudioSignal = readVoiceAudioSignal,
}: HostedAppProps) {
  const [session, setSession] = useState<AuthSession | null | undefined>(undefined);
  const [cacheStore, setCacheStore] = useState<LocalStateStore | null>(suppliedCacheStore ?? null);
  const hostedLaunchEnabledRef = useRef(splashDurationMs !== 0);
  const [launchDismissed, setLaunchDismissed] = useState(() => !hostedLaunchEnabledRef.current);

  useEffect(() => {
    let active = true;
    let sessionChanges = 0;
    const unsubscribe = authClient.onSessionChange((next) => {
      sessionChanges += 1;
      if (active) setSession(next);
    });
    const initialChanges = sessionChanges;
    void authClient.getSession().then((initial) => {
      if (active && sessionChanges === initialChanges) setSession(initial);
    }, () => {
      if (active && sessionChanges === initialChanges) setSession(null);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [authClient]);

  useEffect(() => {
    if (suppliedCacheStore) {
      setCacheStore(suppliedCacheStore);
      return;
    }
    let active = true;
    void createBrowserLocalStateStore().then((browserState) => {
      if (active) setCacheStore(browserState.store);
    });
    return () => { active = false; };
  }, [suppliedCacheStore]);

  const signOutSession = useCallback(async () => {
    await authClient.signOut();
    setSession(null);
  }, [authClient]);

  const expireSession = useCallback(() => {
    void authClient.signOut().catch(() => undefined).finally(() => setSession(null));
  }, [authClient]);

  const dependencies = useMemo(() => {
    if (!session || !cacheStore) return null;
    const authorizedFetch = createAuthorizedFetch({
      apiBaseUrl,
      getSession: () => authClient.getSession(),
      fetchImpl,
      onAuthExpired: expireSession,
    });
    const sameOriginAuthorizedFetch = createAuthorizedFetch({
      apiBaseUrl: "",
      getSession: () => authClient.getSession(),
      fetchImpl,
      onAuthExpired: expireSession,
    });
    return {
      characterCloud: vrmStorageConfig ? createVrmCloud({...vrmStorageConfig, ownerId: session.userId, getSession: () => authClient.getSession(), fetchImpl}) : undefined,
      createAvatarSpeechPlayer: () => createBrowserSpeechPlayer(authorizedFetch, {playbackOnly:true}),
      memoryApi: createMemoryApi(authorizedFetch),
      dashboardProgressApi: createDashboardProgressApi(authorizedFetch),
      visualStylePreferenceApi: createVisualStylePreferenceApi(sameOriginAuthorizedFetch),
      photoApi: createPhotoApi(authorizedFetch),
      realtimeClient: suppliedRealtimeClient
        ?? (((dispatch) => createRealtimeClient({ dispatch, fetch: authorizedFetch })) as RealtimeClientFactory),
      chatStore: createCloudLocalStateStore({
        remote: createRemoteStateApi(authorizedFetch),
        cache: cacheStore,
        now,
      }),
      profileApi: createProfileApi(authorizedFetch),
      chatApi: createChatApi(authorizedFetch),
      codexApi: createCodexApi(authorizedFetch),
      bgmApi: createBgmApi(authorizedFetch),
      googleCalendarTasksApi: createBrowserGoogleCalendarTasksApi(authorizedFetch, session.userId),
      gmailApi:createGmailApi(authorizedFetch),
      writesApi:createWritesApi(authorizedFetch),
      aiConnectionApi:createAIConnectionApi(authorizedFetch),
      selectVoiceProvider:async(provider:VoiceSettings["provider"],speed?:number)=>{const response=await authorizedFetch("/api/voice-connection",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider,...(speed===undefined?{}:{speed})})});if(!response.ok)throw Error("voice_settings_failed");return await response.json() as VoiceSettings;},
      voiceStatus:async()=>{const response=await authorizedFetch("/api/voice-connection",{cache:"no-store"});if(!response.ok)throw Error("voice_status_failed");return await response.json() as VoiceSettings;},
      driveApi:createDriveApi(authorizedFetch),
      lifeServicesApi: createLifeServicesApi(authorizedFetch),
      transcriptionApi: createTranscriptionApi(authorizedFetch),
      migrationApi: createMigrationApi(authorizedFetch),
      memorySyncStore: createBrowserMemorySyncPendingStore({ key: `zundamon-ai-memory-sync:${session.userId}` }),
    };
  }, [vrmStorageConfig, apiBaseUrl, authClient, cacheStore, expireSession, fetchImpl, now, session?.userId, suppliedRealtimeClient]);

  const withLaunch = (content: ReactNode) => <>
    {content}
    {!launchDismissed ? <Splash ready={session !== undefined && Boolean(cacheStore)} onDismiss={() => setLaunchDismissed(true)} /> : null}
  </>;

  if (session === undefined || !cacheStore) return withLaunch(null);
  if (!session) return withLaunch(<Login authClient={authClient} onAuthenticated={setSession} />);
  if (!dependencies) return withLaunch(null);

  return withLaunch(<App
    key={session.userId}
    wallpaperScope={session.userId}
    characterCloud={dependencies.characterCloud}
    createAvatarSpeechPlayer={dependencies.createAvatarSpeechPlayer}
    memoryApi={dependencies.memoryApi}
    dashboardProgressApi={dependencies.dashboardProgressApi}
    visualStylePreferenceApi={dependencies.visualStylePreferenceApi}
    photoApi={dependencies.photoApi}
    photoAnalysisEnabled={photoAnalysisEnabled}
    causalCueEnabled={prismEchoEnabled}
    live2dAvatarEnabled={live2dAvatarEnabled}
    live2dModel={live2dModel}
    live2dReadAudioSignal={live2dReadAudioSignal}
    automaticChatMemoryMode="hosted_authoritative_snapshot"
    realtimeClient={dependencies.realtimeClient}
    chatStore={dependencies.chatStore}
    profileApi={dependencies.profileApi}
    chatApi={dependencies.chatApi}
    codexApi={dependencies.codexApi}
    bgmApi={dependencies.bgmApi}
    googleCalendarTasksApi={dependencies.googleCalendarTasksApi}
    gmailApi={dependencies.gmailApi}
    writesApi={dependencies.writesApi}
    aiConnectionApi={dependencies.aiConnectionApi}
    voiceStatus={dependencies.voiceStatus}
    selectVoiceProvider={dependencies.selectVoiceProvider}
    driveApi={dependencies.driveApi}
    lifeServicesApi={dependencies.lifeServicesApi}
    transcriptionApi={dependencies.transcriptionApi}
    migrationApi={dependencies.migrationApi}
    memorySyncStore={dependencies.memorySyncStore}
    now={now}
    nextId={nextId}
    splashDurationMs={0}
    integratedUiEnabled={integratedUiEnabled}
    yuiPortrait={yuiPortrait}
    requirePersistBeforeChat
    onSignOut={signOutSession}
    onUpdatePassword={authClient.signInWithGoogle ? undefined : (password) => authClient.updatePassword(password)}
  />);
}
