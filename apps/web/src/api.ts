import { parseLifeCard } from '@yui/domain';
import {
  createRealtimeClient,
  type RealtimeClient,
} from "./realtime-client";
import { CHAT_CONTEXT_TURN_LIMIT, containsForbiddenSecret, parseMemoryRecord, parseProfile, parseRemoteChatSnapshot, parseWebSearchMetadata } from "@yui/domain";
import type {
  AddressingStyle,
  ChatReply,
  Memory,
  Profile,
  TimelineItem,
  RemoteChatSnapshot,
} from "@yui/domain";
import type { SessionAction } from "./session-reducer";
import type { AutomaticMemoryTurn, MemoryProcessingReceipt, MemorySyncInput } from "./memory-sync";
import { parseVisualStylePreference, type VisualStyle, type VisualStylePreference } from "./visual-style";
export type { GoogleCalendarTasksApi } from "./google-calendar-tasks";
import { createPhotoContentLoader, type PhotoContentHandle } from "./photo-content";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type RealtimeClientFactory = (
  dispatch: (action: SessionAction) => void,
) => RealtimeClient;

export const createBrowserRealtimeClient: RealtimeClientFactory = (dispatch) =>
  createRealtimeClient({ dispatch });

export type MemoryApi = {
  process?(input: Required<Pick<MemorySyncInput, "sourceMessageId" | "sourceOccurredAt">> | {
    sourceMessageId: string;
    sourceOccurredAt: string;
    turns: AutomaticMemoryTurn[];
    sourceOrigin: "voice";
    explicitMemoryTargetTurnIndexes: number[];
  }, signal?: AbortSignal): Promise<MemoryProcessingReceipt>;
  list(): Promise<Memory[]>;
  update(id: string, patch: { content?: string; pinned?: boolean }): Promise<Memory>;
  keep(id: string): Promise<Memory>;
  forget(id: string, blockRelearning: boolean): Promise<void>;
  listTombstones(): Promise<MemoryTombstoneSummary[]>;
  releaseTombstone(id: string): Promise<void>;
  getSettings(): Promise<MemorySettings>;
  updateSettings(settings: { memoryEnabled: boolean }): Promise<MemorySettings>;
};

export type MemoryTombstoneSummary = { id: string; memoryId: string | null; createdAt: string };
export type MemorySettings = { memoryEnabled: boolean; updatedAt: string | null };

export type ChatRequest = {
  kind: "opening" | "reply";
  clientMessageId: string;
  timeline: TimelineItem[];
};

export type { ChatReply } from "@yui/domain";

export type ProfileApi = {
  get(): Promise<Profile | null>;
  save(input: { displayName: string; addressingStyle: AddressingStyle; occupation?: string; region?: string }): Promise<Profile>;
};

export type DashboardProgress = {
  connection: "unconnected" | "available" | "unavailable";
  updates: DashboardProjectionItem[];
};

export type DashboardProjectionItem = {
  project: string;
  requestId: string;
  shortTitle: string;
  status: "working" | "review_required" | "on_hold" | "continuation_required" | "completed";
  currentPhase: "autonomous_execution" | "owner_action_required" | "system_interrupted" | "completed";
  needsOwnerAction: boolean;
  updatedAt: string;
  nextSafeAction: string;
};

export type DashboardProgressApi = { get(signal?: AbortSignal): Promise<DashboardProgress> };
export type VisualStylePreferenceApi = {
  get(signal?: AbortSignal): Promise<VisualStylePreference | null>;
  save(style: VisualStyle, expectedRevision: number, signal?: AbortSignal): Promise<VisualStylePreference | null>;
};

export type WorkAssistMode = "organize" | "task_suggestions" | "draft";
export type WorkAssistRequest = {
  requestId: string;
  conversationId: string;
  mode: WorkAssistMode;
  text: string;
  confirmationToken?: string;
};
export type WorkAssistResult = {
  summary: string;
  tasks: string[];
  draft: string | null;
  workplacePolicy: "unknown";
};
export type WorkAssistOutcome =
  | { status: "success"; result: WorkAssistResult }
  | { status: "confirmation_required" | "sensitive_input_blocked" | "unavailable" };
export type WorkAssistApi = {
  assist(input: WorkAssistRequest, signal?: AbortSignal): Promise<WorkAssistOutcome>;
};

function safeWorkAssistText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) && !containsForbiddenSecret(value);
}

function parseWorkAssistOutcome(value: unknown, status: number): WorkAssistOutcome | null {
  if (!isRecord(value)) return null;
  if (status === 409 && hasExactKeys(value, ["status"]) && value.status === "confirmation_required") return { status: "confirmation_required" };
  if (status === 400 && hasExactKeys(value, ["status"]) && value.status === "sensitive_input_blocked") return { status: "sensitive_input_blocked" };
  if (status === 503 && hasExactKeys(value, ["status"]) && value.status === "unavailable") return { status: "unavailable" };
  if (status !== 200 || !hasExactKeys(value, ["status", "result"]) || value.status !== "success" || !isRecord(value.result)
    || !hasExactKeys(value.result, ["summary", "tasks", "draft", "workplacePolicy"])
    || !safeWorkAssistText(value.result.summary, 1_000)
    || !Array.isArray(value.result.tasks) || value.result.tasks.length > 8
    || !value.result.tasks.every((task) => safeWorkAssistText(task, 240))
    || (value.result.draft !== null && !safeWorkAssistText(value.result.draft, 4_000))
    || value.result.workplacePolicy !== "unknown") return null;
  return { status: "success", result: value.result as WorkAssistResult };
}

export function createWorkAssistApi(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): WorkAssistApi {
  return {
    async assist(input, signal) {
      try {
        const body: WorkAssistRequest = {
          requestId: input.requestId,
          conversationId: input.conversationId,
          mode: input.mode,
          text: input.text,
          ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {}),
        };
        const response = await fetchImpl("/api/work-assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
        return parseWorkAssistOutcome(await response.json(), response.status) ?? { status: "unavailable" };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}

export function createVisualStylePreferenceApi(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): VisualStylePreferenceApi {
  const parse = (value: unknown): VisualStylePreference | null => {
    if (!isRecord(value) || !hasExactKeys(value, ["preference"])) return null;
    return value.preference === null ? null : parseVisualStylePreference(value.preference);
  };
  return {
    async get(signal) {
      try {
        const response = await fetchImpl("/api/visual-style-preference", { ...(signal ? { signal } : {}) });
        return response.ok ? parse(await response.json()) : null;
      } catch { return null; }
    },
    async save(style, expectedRevision, signal) {
      try {
        const response = await fetchImpl("/api/visual-style-preference", {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style, expectedRevision }), ...(signal ? { signal } : {}),
        });
        return response.ok ? parse(await response.json()) : null;
      } catch { return null; }
    },
  };
}

const dashboardStatuses = new Set<DashboardProjectionItem["status"]>(["working", "review_required", "on_hold", "continuation_required", "completed"]);
const dashboardPhases = new Set<DashboardProjectionItem["currentPhase"]>(["autonomous_execution", "owner_action_required", "system_interrupted", "completed"]);
const dashboardProjects = new Set(["yui"]);
const dashboardStatusPhases = new Set(["working:autonomous_execution", "review_required:owner_action_required", "on_hold:autonomous_execution", "continuation_required:system_interrupted", "completed:completed"]);
const dashboardSafeActions = new Set(["確認して判断する", "作業を継続する", "再開を待つ", "完了を記録する", "受信箱の継続判定を待つ"]);

const dashboardProgressClientTimeoutMs = 5_000;

export function createDashboardProgressApi(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  options: { timeoutMs?: number } = {},
): DashboardProgressApi {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs!
    : dashboardProgressClientTimeoutMs;
  return {
    async get(signal) {
      if (signal?.aborted) return { connection: "unavailable", updates: [] };
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let resolveCancellation: ((value: DashboardProgress) => void) | undefined;
      const unavailable = (): DashboardProgress => ({ connection: "unavailable", updates: [] });
      const abortForCaller = () => {
        controller.abort();
        resolveCancellation?.(unavailable());
      };
      signal?.addEventListener("abort", abortForCaller, { once: true });
      try {
        const request = (async (): Promise<DashboardProgress> => {
          const response = await fetchImpl("/api/dashboard/progress", { signal: controller.signal });
          if (!response.ok) return unavailable();
          const value = await response.json();
          return parseDashboardProgress(value) ?? unavailable();
        })();
        const deadline = new Promise<DashboardProgress>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve(unavailable());
          }, timeoutMs);
        });
        const cancellation = new Promise<DashboardProgress>((resolve) => { resolveCancellation = resolve; });
        return await Promise.race([request, deadline, cancellation]);
      } catch {
        return unavailable();
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        signal?.removeEventListener("abort", abortForCaller);
      }
    },
  };
}

function parseDashboardProgress(value: unknown): DashboardProgress | null {
  if (!isRecord(value) || !hasExactKeys(value, ["connection", "updates"])
    || (value.connection !== "unconnected" && value.connection !== "available" && value.connection !== "unavailable")
    || !Array.isArray(value.updates) || value.updates.length > 24) return null;
  const updates = value.updates.map(parseDashboardProjectionItem);
  if (updates.some((item) => item === null) || (value.connection !== "available" && updates.length !== 0)) return null;
  return { connection: value.connection, updates: updates as DashboardProjectionItem[] };
}

function parseDashboardProjectionItem(value: unknown): DashboardProjectionItem | null {
  const keys = ["project", "requestId", "shortTitle", "status", "currentPhase", "needsOwnerAction", "updatedAt", "nextSafeAction"];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || typeof value.project !== "string" || !dashboardProjects.has(value.project)
    || typeof value.requestId !== "string" || !/^[A-Z][A-Z0-9-]{2,100}$/u.test(value.requestId)
    || !safeDashboardText(value.shortTitle, 120) || typeof value.status !== "string" || !dashboardStatuses.has(value.status as DashboardProjectionItem["status"])
    || typeof value.currentPhase !== "string" || !dashboardPhases.has(value.currentPhase as DashboardProjectionItem["currentPhase"])
    || !dashboardStatusPhases.has(`${value.status}:${value.currentPhase}`)
    || typeof value.needsOwnerAction !== "boolean" || value.needsOwnerAction !== (value.status === "review_required")
    || !isCanonicalDashboardTimestamp(value.updatedAt) || typeof value.nextSafeAction !== "string" || !dashboardSafeActions.has(value.nextSafeAction)) return null;
  return value as DashboardProjectionItem;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function safeDashboardText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) && !/[\\/]/u.test(value) && !/(?:sk-[A-Za-z0-9_-]{10,}|gh[opusr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}|https?:\/\/|file:\/\/|(?:^|[\s(])(?:\/|~\/))/iu.test(value);
}

function isCanonicalDashboardTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export type ChatApi = {
  respond(input: ChatRequest, signal?: AbortSignal): Promise<ChatReply>;
};

export type PhotoAnalysisResult = {
  photo: { id: string; messageId: string; createdAt: string };
  reply: { replyGroupId: string; bubbles: Array<{ id: string; text: string; createdAt: string; sequence: 0 | 1 | 2; delivery: "sent"; origin: "photo_analysis"; sourcePhotoMessageId: string }> };
};

export type PhotoApi = {
  analyze(input: { clientMessageId: string; caption: string; blob: Blob }, signal?: AbortSignal): Promise<PhotoAnalysisResult>;
  commit(input: { photoId: string; expectedRevision: number; snapshot: RemoteChatSnapshot }): Promise<RemoteChatSnapshot>;
  delete(input: { photoId: string; expectedRevision: number }): Promise<RemoteChatSnapshot>;
  fetchContent(photoId: string, signal: AbortSignal): Promise<PhotoContentHandle>;
};

const PHOTO_COMMIT_TIMEOUT_MS = 20_000;

export function createPhotoApi(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  options: { commitTimeoutMs?: number } = {},
): PhotoApi {
  const content = createPhotoContentLoader(fetchImpl);
  const commitTimeoutMs = options.commitTimeoutMs ?? PHOTO_COMMIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(commitTimeoutMs) || commitTimeoutMs < 1 || commitTimeoutMs > PHOTO_COMMIT_TIMEOUT_MS) {
    throw new Error("invalid_photo_commit_timeout");
  }
  const readSnapshot = async (response: Response): Promise<RemoteChatSnapshot> => {
    if (!response.ok) throw new Error(response.status === 409 ? "photo_conflict" : "photo_unavailable");
    const payload = await response.json() as { snapshot?: unknown };
    return parseRemoteChatSnapshot(payload.snapshot) ?? invalidResponse();
  };
  return {
    async analyze(input, signal) {
      const body = new FormData();
      body.set("clientMessageId", input.clientMessageId);
      body.set("caption", input.caption);
      body.set("photo", new File([input.blob], "photo.jpg", { type: "image/jpeg" }));
      const response = await fetchImpl("/api/photo-responses", { method: "POST", body, ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error(response.status === 409 ? "photo_ambiguous" : "photo_unavailable");
      const value = await response.json() as PhotoAnalysisResult;
      if (!isRecord(value) || !isRecord(value.photo) || !isRecord(value.reply)
        || typeof value.photo.id !== "string" || value.photo.messageId !== input.clientMessageId
        || !isCanonicalTimestamp(value.photo.createdAt) || !Array.isArray(value.reply.bubbles)) invalidResponse();
      return value;
    },
    commit: async (input) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), commitTimeoutMs);
      try {
        return await readSnapshot(await fetchImpl(`/api/photos/${encodeURIComponent(input.photoId)}/commit`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ expectedRevision: input.expectedRevision, snapshot: input.snapshot }),
        }));
      } catch (error) {
        if (controller.signal.aborted) throw new Error("photo_unavailable");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
    delete: async (input) => readSnapshot(await fetchImpl(`/api/photos/${encodeURIComponent(input.photoId)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: input.expectedRevision }),
    })),
    fetchContent: (photoId, signal) => content.load(photoId, signal),
  };
}

export type YuiRequestErrorKind =
  | "interrupted"
  | "authentication"
  | "profile-required"
  | "usage-limit"
  | "upstream"
  | "maintenance"
  | "timeout"
  | "network"
  | "unknown";

export class YuiRequestError extends Error {
  readonly name = "YuiRequestError";

  constructor(readonly kind: YuiRequestErrorKind, readonly status?: number) {
    super("Yui request failed");
  }
}

export type TranscriptionApi = {
  transcribe(blob: Blob, signal: AbortSignal): Promise<string>;
};


export function createMemoryApi(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): MemoryApi {
  return {
    async process(input, signal) {
      const payload = "sourceOrigin" in input
        ? input
        : { sourceMessageId: input.sourceMessageId, sourceOccurredAt: input.sourceOccurredAt };
      const response = await fetchImpl("/api/memory/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(signal ? { signal } : {}),
        body: JSON.stringify(payload),
      });
      const receipt = await readJson<unknown>(response);
      if (
        !isRecord(receipt)
        || receipt.sourceMessageId !== input.sourceMessageId
        || (receipt.state !== "pending" && receipt.state !== "completed" && receipt.state !== "failed")
        || !Number.isInteger(receipt.appliedCount)
        || (receipt.appliedCount as number) < 0
        || (receipt.appliedCount as number) > 3
        || !Object.keys(receipt).every((key) => ["sourceMessageId", "state", "appliedCount"].includes(key))
      ) invalidResponse();
      return receipt as MemoryProcessingReceipt;
    },
    async list() {
      const response = await fetchImpl("/api/memories");
      const payload = await readJson<{ memories: unknown }>(response);
      if (!Array.isArray(payload.memories)) invalidResponse();
      return payload.memories.map((memory) => parseMemoryRecord(memory) ?? invalidResponse());
    },
    async update(id, patch) {
      const response = await fetchImpl(`/api/memories/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await readJson<{ memory: unknown }>(response);
      return parseMemoryRecord(payload.memory) ?? invalidResponse();
    },
    async keep(id) {
      const response = await fetchImpl(`/api/memories/${encodeURIComponent(id)}/keep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await readJson<{ memory: unknown }>(response);
      return parseMemoryRecord(payload.memory) ?? invalidResponse();
    },
    async forget(id, blockRelearning) {
      const response = await fetchImpl(`/api/memories/${encodeURIComponent(id)}/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockRelearning }),
      });
      if (!response.ok) await readJson<never>(response);
    },
    async listTombstones() {
      const payload = await readJson<{ tombstones: unknown }>(await fetchImpl("/api/memory-tombstones"));
      if (!Array.isArray(payload.tombstones)) invalidResponse();
      return payload.tombstones.map((value) => parseTombstoneSummary(value) ?? invalidResponse());
    },
    async releaseTombstone(id) {
      const response = await fetchImpl(`/api/memory-tombstones/${encodeURIComponent(id)}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) await readJson<never>(response);
    },
    async getSettings() {
      const payload = await readJson<{ settings: unknown }>(await fetchImpl("/api/memory-settings"));
      return parseMemorySettings(payload.settings) ?? invalidResponse();
    },
    async updateSettings(settings) {
      const response = await fetchImpl("/api/memory-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await readJson<{ settings: unknown }>(response);
      return parseMemorySettings(payload.settings) ?? invalidResponse();
    },
  };
}

export const browserMemoryApi = createMemoryApi();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function parseTombstoneSummary(value: unknown): MemoryTombstoneSummary | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["id", "memoryId", "createdAt"].includes(key))) return null;
  if (typeof value.id !== "string" || (value.memoryId !== null && typeof value.memoryId !== "string") || !isCanonicalTimestamp(value.createdAt)) return null;
  return value as MemoryTombstoneSummary;
}

function parseMemorySettings(value: unknown): MemorySettings | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => ["memoryEnabled", "updatedAt"].includes(key))) return null;
  if (typeof value.memoryEnabled !== "boolean" || (value.updatedAt !== null && !isCanonicalTimestamp(value.updatedAt))) return null;
  return value as MemorySettings;
}

function parseChatReply(value: unknown, clientMessageId: string): ChatReply | null {
  if (!isRecord(value)) return null;
  if (!Object.keys(value).every((key) => key === "replyGroupId" || key === "bubbles" || key === "profile" || key === "search" || key === "lifeCard")) {
    return null;
  }
  const replyGroupId = `${clientMessageId}:assistant`;
  if (
    value.replyGroupId !== replyGroupId ||
    !Array.isArray(value.bubbles) ||
    value.bubbles.length < 1 ||
    value.bubbles.length > 3
  ) {
    return null;
  }

  const ids = new Set<string>();
  let totalLength = 0;
  for (const [sequence, bubble] of value.bubbles.entries()) {
    if (
      !isRecord(bubble) ||
      !Object.keys(bubble).every((key) => ["id", "text", "createdAt", "sequence", "flow"].includes(key)) ||
      bubble.id !== `${replyGroupId}:${sequence}` ||
      ids.has(bubble.id) ||
      bubble.sequence !== sequence ||
      typeof bubble.text !== "string" ||
      !bubble.text.trim() ||
      bubble.text.length > 400 ||
      !isCanonicalTimestamp(bubble.createdAt) ||
      (bubble.flow !== undefined && bubble.flow !== "external_context")
    ) {
      return null;
    }
    ids.add(bubble.id);
    totalLength += bubble.text.length;
  }
  if (totalLength > 800) return null;
  const profile = Object.hasOwn(value, "profile") ? parseProfile(value.profile) : undefined;
  if (Object.hasOwn(value, "profile") && !profile) return null;
  const search = Object.hasOwn(value, "search") ? parseWebSearchMetadata(value.search) : undefined;
  if (Object.hasOwn(value, "search") && !search) return null;
  const lifeCard = Object.hasOwn(value, "lifeCard") ? parseLifeCard(value.lifeCard) : undefined;
  if (Object.hasOwn(value, "lifeCard") && (!lifeCard || value.bubbles.some(b => !isRecord(b) || b.flow !== "external_context"))) return null;
  const bubbles: ChatReply["bubbles"] = value.bubbles.map((bubble) => {
    const parsed = bubble as Record<string, unknown>;
    return {
      id: parsed.id as string,
      text: parsed.text as string,
      createdAt: parsed.createdAt as string,
      sequence: parsed.sequence as 0 | 1 | 2,
      ...(parsed.flow === "external_context" ? { flow: "external_context" as const } : {}),
    };
  });
  return {
    replyGroupId,
    bubbles,
    ...(profile ? { profile } : {}),
    ...(search ? { search } : {}),
    ...(lifeCard ? { lifeCard } : {}),
  };
}

function invalidResponse(): never {
  throw new Error("Yui response was invalid");
}

export function createProfileApi(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): ProfileApi {
  return {
    async get() {
      const payload = await readJson<{ profile: unknown }>(await fetchImpl("/api/profile"));
      if (payload.profile === null) return null;
      return parseProfile(payload.profile) ?? invalidResponse();
    },
    async save(input) {
      const response = await fetchImpl("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = await readJson<{ profile: unknown }>(response);
      return parseProfile(payload.profile) ?? invalidResponse();
    },
  };
}

export const browserProfileApi = createProfileApi();

export function createChatApi(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  getTimeZone: () => string | undefined = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone,
): ChatApi {
  return {
    async respond(input, signal) {
      const turns = input.timeline
        .filter((item): item is Extract<TimelineItem, { type: "message" }> =>
          item.type === "message" && item.flow !== "profile",
        )
        .slice(-CHAT_CONTEXT_TURN_LIMIT)
        .map(({ role, text }) => ({ role, text }));
      let timeZone: string | undefined;
      try {
        timeZone = getTimeZone();
      } catch {
        // Time-zone detection must not prevent chat delivery.
      }
      let response: Response;
      try {
        response = await fetchImpl("/api/chat/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          ...(signal ? { signal } : {}),
          body: JSON.stringify({
            kind: input.kind,
            clientMessageId: input.clientMessageId,
            turns: input.kind === "opening" ? [] : turns,
            ...(timeZone ? { timeZone } : {}),
          }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new YuiRequestError("network");
      }
      const payload = await readJson<{ reply: unknown }>(response);
      return parseChatReply(payload.reply, input.clientMessageId) ?? invalidResponse();
    },
  };
}

export const browserChatApi = createChatApi();

export function createTranscriptionApi(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): TranscriptionApi {
  return {
    async transcribe(blob, signal) {
      const form = new FormData();
      form.append(
        "audio",
        blob,
        blob.type === "audio/mp4" ? "speech.mp4" : "speech.webm",
      );
      const payload = await readJson<{ text: unknown }>(await fetchImpl("/api/chat/transcriptions", {
        method: "POST",
        body: form,
        signal,
      }));
      if (typeof payload.text !== "string") invalidResponse();
      return payload.text;
    },
  };
}

export const browserTranscriptionApi = createTranscriptionApi();

async function readJson<Payload>(response: Response): Promise<Payload> {
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The status code remains authoritative.
    }
    const kind: YuiRequestErrorKind = response.status === 401
      ? "authentication"
      : response.status === 409
        ? "profile-required"
        : response.status === 429
          ? "usage-limit"
          : response.status === 502
            ? "upstream"
            : response.status === 503
              ? "maintenance"
              : response.status === 504
                ? "timeout"
                : "unknown";
    throw new YuiRequestError(kind, response.status);
  }
  return (await response.json()) as Payload;
}
