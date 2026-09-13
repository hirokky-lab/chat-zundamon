import { createHash } from "node:crypto";
import type { CostFeature, CostGuard, CostReservation } from "./cost-guard.js";
import type { RequestUser } from "./request-user.js";

export const EXTERNAL_TOOL_FEATURES = [
  "web_search",
  "youtube_search",
  "calendar_read",
  "tasks_read",
  "one_time_reminder",
  "photo_analysis",
  "work_assist",
  "avatar",
] as const;

export type ExternalToolFeature = typeof EXTERNAL_TOOL_FEATURES[number];
export type ExternalToolFlags = Record<ExternalToolFeature, boolean>;
export type ExternalCostArea = Extract<
  CostFeature,
  "search" | "calendar" | "notification" | "image" | "work" | "avatar" | "storage"
>;

export const ALL_EXTERNAL_TOOLS_OFF: ExternalToolFlags = Object.freeze({
  web_search: false,
  youtube_search: false,
  calendar_read: false,
  tasks_read: false,
  one_time_reminder: false,
  photo_analysis: false,
  work_assist: false,
  avatar: false,
});

export const EXTERNAL_TOOL_COST_AREA: Record<ExternalToolFeature, ExternalCostArea> = {
  web_search: "search",
  youtube_search: "search",
  calendar_read: "calendar",
  tasks_read: "calendar",
  one_time_reminder: "notification",
  photo_analysis: "image",
  work_assist: "work",
  avatar: "avatar",
};

const EXTERNAL_TOOL_ALLOWED_COST_AREAS: Record<ExternalToolFeature, readonly ExternalCostArea[]> = {
  web_search: ["search"],
  youtube_search: ["search"],
  calendar_read: ["calendar"],
  tasks_read: ["calendar"],
  one_time_reminder: ["notification", "storage"],
  photo_analysis: ["image", "storage"],
  work_assist: ["work"],
  avatar: ["avatar"],
};

export type ExternalToolContext = {
  conversationId: string;
  channel: "chat" | "voice";
  personaId: "yui";
  memoryScope: "shared";
};

export type ExternalToolOutcome = "success" | "failure" | "cancel" | "timeout";

export type ExternalToolTelemetryEvent = {
  featureArea: "external_tool";
  feature: ExternalToolFeature;
  costArea: ExternalCostArea;
  idempotencyKey: `sha256:${string}`;
  outcome: ExternalToolOutcome;
  attempt: number;
  retry: boolean;
  latencyMs: number;
  charged: boolean;
  actualUsd: number;
  quotaUnits: number;
};

export type ExternalToolTelemetry = {
  record(event: ExternalToolTelemetryEvent): void | Promise<void>;
};

export type ExternalToolConfirmationVerifier = {
  verify(input: {
    user: RequestUser;
    requestId: string;
    feature: ExternalToolFeature;
    token: string;
  }): boolean | Promise<boolean>;
};

export type ExternalToolExecution<Value> = {
  value: Value;
  actualUsd: number;
  quotaUnits: number;
};

export type ExternalToolRequest<Input, Value> = {
  user: RequestUser;
  requestId: string;
  attempt: number;
  feature: ExternalToolFeature;
  operation: "read" | "external_change";
  costArea?: ExternalCostArea;
  /** Optional stricter reservation for one bounded request. */
  maximumUsd?: number;
  context: ExternalToolContext;
  input: Input;
  confirmationToken?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  execute(input: {
    input: Input;
    context: ExternalToolContext;
    signal: AbortSignal;
  }): Promise<ExternalToolExecution<Value>>;
};

export type ExternalToolResult<Value> =
  | { status: "disabled" }
  | { status: "confirmation_required" }
  | { status: "success"; value: Value }
  | { status: "failure" }
  | { status: "cancelled" }
  | { status: "timeout" };

export type ExternalToolBoundary = {
  flags(): ExternalToolFlags;
  run<Input, Value>(request: ExternalToolRequest<Input, Value>): Promise<ExternalToolResult<Value>>;
};

type BoundaryOptions = {
  flags: ExternalToolFlags;
  costGuard: CostGuard;
  maximumUsdByArea: Record<ExternalCostArea, number>;
  confirmationVerifier?: ExternalToolConfirmationVerifier;
  telemetry?: ExternalToolTelemetry;
  now?: () => Date;
};

class BoundaryAbortError extends Error {
  constructor(readonly kind: "cancel" | "timeout") {
    super(kind);
  }
}

export function createExternalToolBoundary(options: BoundaryOptions): ExternalToolBoundary {
  const flags = Object.freeze({ ...options.flags });
  const now = options.now ?? (() => new Date());

  return {
    flags: () => ({ ...flags }),
    async run<Input, Value>(request: ExternalToolRequest<Input, Value>): Promise<ExternalToolResult<Value>> {
      if (!flags[request.feature]) return { status: "disabled" };
      if (!isValidRequest(request)) return { status: "failure" };
      const costArea = request.costArea ?? EXTERNAL_TOOL_COST_AREA[request.feature];
      if (!EXTERNAL_TOOL_ALLOWED_COST_AREAS[request.feature].includes(costArea)) {
        return { status: "failure" };
      }
      const maximumUsd = request.maximumUsd ?? options.maximumUsdByArea[costArea];
      if (!Number.isFinite(maximumUsd) || maximumUsd <= 0 || maximumUsd > options.maximumUsdByArea[costArea]) {
        return { status: "failure" };
      }
      if (request.operation === "external_change") {
        if (!request.confirmationToken || !options.confirmationVerifier) {
          return { status: "confirmation_required" };
        }
        const confirmed = await verifyConfirmation(
          options.confirmationVerifier,
          request,
          request.confirmationToken,
        );
        if (!confirmed) return { status: "confirmation_required" };
      }

      const startedAt = now();
      const idempotencyKey = hashKey(
        request.user.userId,
        request.requestId,
        request.feature,
        costArea,
        request.attempt,
      );
      let reservation: CostReservation | undefined;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let cancelled = false;
      let removeAbortListener: () => void = () => undefined;

      const record = (
        outcome: ExternalToolOutcome,
        actualUsd = 0,
        quotaUnits = 0,
      ): void => {
        const event: ExternalToolTelemetryEvent = {
          featureArea: "external_tool",
          feature: request.feature,
          costArea,
          idempotencyKey,
          outcome,
          attempt: request.attempt,
          retry: request.attempt > 1,
          latencyMs: Math.max(0, now().getTime() - startedAt.getTime()),
          charged: reservation !== undefined,
          actualUsd,
          quotaUnits,
        };
        try {
          void Promise.resolve(options.telemetry?.record(event)).catch(() => undefined);
        } catch {
          // Optional, content-free telemetry must never block the conversation.
        }
      };

      try {
        if (request.signal?.aborted) throw new BoundaryAbortError("cancel");
        const abortPromise = new Promise<never>((_resolve, reject) => {
          const abort = (kind: "cancel" | "timeout") => {
            controller.abort();
            reject(new BoundaryAbortError(kind));
          };
          const externalAbort = () => {
            cancelled = true;
            abort("cancel");
          };
          request.signal?.addEventListener("abort", externalAbort, { once: true });
          removeAbortListener = () => request.signal?.removeEventListener("abort", externalAbort);
          timeout = setTimeout(() => {
            timedOut = true;
            abort("timeout");
          }, request.timeoutMs);
        });
        const reservationPromise = options.costGuard.reserve({
          user: request.user,
          requestId: `external:${costArea}:${idempotencyKey}:${request.attempt}`,
          feature: costArea,
          maximumUsd,
        });
        void reservationPromise.then((lateReservation) => {
          if (reservation === undefined && (timedOut || cancelled)) {
            void Promise.resolve().then(() => lateReservation.hold()).catch(() => undefined);
          }
        }).catch(() => undefined);
        reservation = await Promise.race([reservationPromise, abortPromise]);
        const execution = await Promise.race([
          request.execute({ input: request.input, context: request.context, signal: controller.signal }),
          abortPromise,
        ]);
        if (!isValidExecution(execution, maximumUsd)) {
          throw new Error("invalid external tool accounting");
        }
        await Promise.race([
          Promise.resolve().then(() => reservation?.settle(execution.actualUsd)),
          abortPromise,
        ]);
        record("success", execution.actualUsd, execution.quotaUnits);
        return { status: "success", value: execution.value };
      } catch (error) {
        void Promise.resolve().then(() => reservation?.hold()).catch(() => undefined);
        const outcome = error instanceof BoundaryAbortError
          ? error.kind
          : timedOut
            ? "timeout"
            : cancelled || request.signal?.aborted
              ? "cancel"
              : "failure";
        record(outcome);
        if (outcome === "timeout") return { status: "timeout" };
        if (outcome === "cancel") return { status: "cancelled" };
        return { status: "failure" };
      } finally {
        if (timeout) clearTimeout(timeout);
        removeAbortListener();
      }
    },
  };
}

async function verifyConfirmation<Input, Value>(
  verifier: ExternalToolConfirmationVerifier,
  request: ExternalToolRequest<Input, Value>,
  token: string,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => verifier.verify({
        user: request.user,
        requestId: request.requestId,
        feature: request.feature,
        token,
      })).catch(() => false),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), request.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function hashKey(
  userId: string,
  requestId: string,
  feature: ExternalToolFeature,
  costArea: ExternalCostArea,
  attempt: number,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`${userId}:${requestId}:${feature}:${costArea}:${attempt}`).digest("hex")}`;
}

function isValidRequest<Input, Value>(request: ExternalToolRequest<Input, Value>): boolean {
  return request.requestId.length > 0
    && request.requestId.length <= 128
    && Number.isInteger(request.attempt)
    && request.attempt > 0
    && Number.isInteger(request.timeoutMs)
    && request.timeoutMs > 0
    && request.context.conversationId.length > 0
    && request.context.conversationId.length <= 128
    && (request.context.channel === "chat" || request.context.channel === "voice")
    && request.context.personaId === "yui"
    && request.context.memoryScope === "shared";
}

function isValidExecution<Value>(
  execution: ExternalToolExecution<Value>,
  maximumUsd: number,
): boolean {
  return Number.isFinite(execution.actualUsd)
    && execution.actualUsd >= 0
    && execution.actualUsd <= maximumUsd
    && Number.isInteger(execution.quotaUnits)
    && execution.quotaUnits >= 0;
}
