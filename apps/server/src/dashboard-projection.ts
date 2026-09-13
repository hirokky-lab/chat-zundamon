import type { FastifyInstance } from "fastify";

const ownerLocalProjectionUrl = "http://127.0.0.1:4310/api/projection/yui/v1";
const projectionSchemaVersion = "codex-work-dashboard.yui-projection.v1";
const maximumProjectionAgeMs = 15 * 60 * 1000;
const projectionRequestTimeoutMs = 2_000;
const projects = new Set(["yui"]);
const statuses = new Set(["working", "review_required", "on_hold", "continuation_required", "completed"]);
const phases = new Set(["autonomous_execution", "owner_action_required", "system_interrupted", "completed"]);
const statusPhases = new Set(["working:autonomous_execution", "review_required:owner_action_required", "on_hold:autonomous_execution", "continuation_required:system_interrupted", "completed:completed"]);
const safeActions = new Set(["確認して判断する", "作業を継続する", "再開を待つ", "完了を記録する", "受信箱の継続判定を待つ"]);
const itemKeys = ["project", "requestId", "shortTitle", "status", "currentPhase", "needsOwnerAction", "updatedAt", "nextSafeAction"] as const;
const envelopeKeys = ["schemaVersion", "generation", "generatedAt", "records"] as const;

export type DashboardProjectionItem = {
  project: "yui";
  requestId: string;
  shortTitle: string;
  status: "working" | "review_required" | "on_hold" | "continuation_required" | "completed";
  currentPhase: "autonomous_execution" | "owner_action_required" | "system_interrupted" | "completed";
  needsOwnerAction: boolean;
  updatedAt: string;
  nextSafeAction: "確認して判断する" | "作業を継続する" | "再開を待つ" | "完了を記録する" | "受信箱の継続判定を待つ";
};

export type DashboardProjectionGatewayResult =
  | { kind: "success"; body: unknown }
  | { kind: "authentication_mismatch" }
  | { kind: "unavailable" };

/** The only runtime adapter is a fixed localhost GET; callers cannot provide a URL or file path. */
export type DashboardProjectionGateway = { get(signal?: AbortSignal): Promise<DashboardProjectionGatewayResult> };
export type DashboardProjection = { connection: "unconnected" | "available" | "unavailable"; updates: DashboardProjectionItem[] };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createOwnerLocalDashboardProjectionGateway(options: { token: string; fetchImpl?: FetchLike }): DashboardProjectionGateway {
  return {
    async get(signal) {
      try {
        const response = await (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(ownerLocalProjectionUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          ...(signal ? { signal } : {}),
        });
        if (response.status === 401) return { kind: "authentication_mismatch" };
        if (!response.ok) return { kind: "unavailable" };
        return { kind: "success", body: await response.json() };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}

export class DashboardProjectionService {
  private latestGeneration = 0;
  private readonly minimumGeneration: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: { gateway?: DashboardProjectionGateway; minimumGeneration?: number; timeoutMs?: number; now?: () => Date } = {}) {
    this.minimumGeneration = Number.isSafeInteger(options.minimumGeneration) && (options.minimumGeneration ?? 0) >= 1
      ? options.minimumGeneration!
      : 1;
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs!
      : projectionRequestTimeoutMs;
  }

  async load(signal?: AbortSignal): Promise<DashboardProjection> {
    const gateway = this.options.gateway;
    if (!gateway) return { connection: "unconnected", updates: [] };
    const controller = new AbortController();
    const abortForCaller = () => controller.abort();
    signal?.addEventListener("abort", abortForCaller, { once: true });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DashboardProjectionGatewayResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve({ kind: "unavailable" });
      }, this.timeoutMs);
    });
    try {
      const result = await Promise.race([gateway.get(controller.signal), timeout]);
      if (result.kind !== "success") return unavailable();
      const envelope = parseEnvelope(result.body, this.minimumGeneration, this.latestGeneration, this.options.now ?? (() => new Date()));
      if (!envelope) return unavailable();
      this.latestGeneration = envelope.generation;
      return { connection: "available", updates: envelope.records };
    } catch {
      return unavailable();
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", abortForCaller);
    }
  }
}

export function registerDashboardProjectionRoute(app: FastifyInstance, service: DashboardProjectionService): void {
  app.get("/api/dashboard/progress", async (_request, reply) => reply.header("Cache-Control", "no-store").send(await service.load()));
}

function parseEnvelope(value: unknown, minimumGeneration: number, latestGeneration: number, now: () => Date): { generation: number; records: DashboardProjectionItem[] } | null {
  if (!isRecord(value) || !hasExactlyKeys(value, envelopeKeys) || value.schemaVersion !== projectionSchemaVersion
    || !Number.isSafeInteger(value.generation) || typeof value.generation !== "number") return null;
  const generation = value.generation;
  if (generation < minimumGeneration || generation < latestGeneration
    || !isFreshTimestamp(value.generatedAt, now) || !Array.isArray(value.records) || value.records.length > 24) return null;
  const records = value.records.map(parseRecord);
  return records.some((record) => record === null) ? null : { generation, records: records as DashboardProjectionItem[] };
}

function unavailable(): DashboardProjection { return { connection: "unavailable", updates: [] }; }

function parseRecord(value: unknown): DashboardProjectionItem | null {
  if (!isRecord(value) || !hasExactlyKeys(value, itemKeys)
    || typeof value.project !== "string" || typeof value.requestId !== "string" || typeof value.shortTitle !== "string"
    || typeof value.status !== "string" || typeof value.currentPhase !== "string" || typeof value.updatedAt !== "string"
    || typeof value.nextSafeAction !== "string") return null;
  if (!projects.has(value.project) || !isRequestId(value.requestId) || !safeText(value.shortTitle, 120)
    || !statuses.has(value.status) || !phases.has(value.currentPhase) || !statusPhases.has(`${value.status}:${value.currentPhase}`)
    || typeof value.needsOwnerAction !== "boolean" || value.needsOwnerAction !== (value.status === "review_required")
    || !isCanonicalTimestamp(value.updatedAt) || !safeActions.has(value.nextSafeAction)) return null;
  return value as DashboardProjectionItem;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function isRequestId(value: string): boolean { return /^[A-Z][A-Z0-9-]{2,100}$/u.test(value); }
function isCanonicalTimestamp(value: string): boolean { return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function isFreshTimestamp(value: unknown, now: () => Date): boolean {
  if (typeof value !== "string" || !isCanonicalTimestamp(value)) return false;
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) return false;
  const age = current.getTime() - new Date(value).getTime();
  return age >= 0 && age <= maximumProjectionAgeMs;
}
function safeText(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/[\\/]/u.test(value)
    && !/(?:sk-[A-Za-z0-9_-]{10,}|gh[opusr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|Bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}|https?:\/\/|file:\/\/|(?:^|[\s(])(?:\/|~\/))/iu.test(value);
}
