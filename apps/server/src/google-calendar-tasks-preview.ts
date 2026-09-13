import { parseGoogleSourceListResult, isValidGoogleSourceId, type GoogleSourceListResult, parseGooglePreviewResult, type GooglePreviewResult, type GooglePreviewService } from "@yui/domain";
import type { ExternalToolBoundary, ExternalToolContext } from "./external-tools.js";
import type {
  GoogleCalendarTasksConnectionRepository,
  GoogleCalendarTasksQuotaRepository,
} from "./google-calendar-tasks.js";
import type { GoogleCalendarTasksDiagnosticReason } from "./google-calendar-tasks-diagnostics.js";
import { googleCalendarTasksDiagnostic } from "./google-calendar-tasks-diagnostics.js";
import type { GoogleCalendarTasksPreviewGateway } from "./google-calendar-tasks-preview-provider.js";
import {
  GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
  GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
} from "./google-calendar-tasks-runtime.js";
import type { RequestUser } from "./request-user.js";

export type GoogleCalendarTasksPreviewOutcome =
  | { status: "completed"; value: GooglePreviewResult }
  | { status: "disabled" | "disconnected" | "quota" | "unavailable" };

export type GoogleCalendarTasksSourcesOutcome =
  | { status: "completed"; value: GoogleSourceListResult }
  | { status: "disabled" | "disconnected" | "quota" | "unavailable" };

export type GoogleCalendarTasksPreviewService = {
  preview(input: {
    owner: RequestUser;
    service: GooglePreviewService;
    sourceId?: string;
    requestId: string;
    context: ExternalToolContext;
    signal?: AbortSignal;
    diagnostic?: (reason: GoogleCalendarTasksDiagnosticReason) => void;
  }): Promise<GoogleCalendarTasksPreviewOutcome>;
  sources(input: {
    owner: RequestUser;
    service: GooglePreviewService;
    requestId: string;
    context: ExternalToolContext;
    signal?: AbortSignal;
    diagnostic?: (reason: GoogleCalendarTasksDiagnosticReason) => void;
  }): Promise<GoogleCalendarTasksSourcesOutcome>;
};

export function createGoogleCalendarTasksPreviewService(options: {
  boundary: ExternalToolBoundary;
  connections: Pick<GoogleCalendarTasksConnectionRepository, "status">;
  quota: GoogleCalendarTasksQuotaRepository;
  gateway: GoogleCalendarTasksPreviewGateway;
  now?: () => Date;
}): GoogleCalendarTasksPreviewService {
  const now = options.now ?? (() => new Date());
  return {
    async preview(input) {
      if (input.sourceId !== undefined && !isValidGoogleSourceId(input.sourceId)) return { status: "unavailable" };
      const feature = input.service === "calendar" ? "calendar_read" : "tasks_read";
      if (!options.boundary.flags()[feature]) return { status: "disabled" };
      let failure: "disconnected" | "quota" | "unavailable" = "unavailable";
      let diagnosticReason: GoogleCalendarTasksDiagnosticReason = "unknown";
      const result = await options.boundary.run({
        user: input.owner,
        requestId: input.requestId,
        attempt: 1,
        feature,
        operation: "read",
        costArea: "calendar",
        maximumUsd: GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
        context: input.context,
        input: { service: input.service, request: "preview" },
        timeoutMs: GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
        signal: input.signal,
        execute: async ({ signal }) => {
          const connection = await options.connections.status(input.owner, input.service);
          if (connection.state !== "connected" || connection.service !== input.service) {
            failure = "disconnected";
            throw new Error("Google preview connection unavailable");
          }
          const lease = await options.quota.acquire(input.owner, input.service, now(), input.requestId);
          if (!lease) {
            failure = "quota";
            throw new Error("Google preview quota unavailable");
          }
          await lease.commit();
          let received: GooglePreviewResult;
          try {
            received = await options.gateway.preview({ owner: input.owner, service: input.service, ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }) }, signal);
          } catch (error) {
            diagnosticReason = googleCalendarTasksDiagnostic(error).reason;
            throw error;
          }
          return {
            value: parseGooglePreviewResult(received, input.service),
            actualUsd: 0,
            quotaUnits: 1,
          };
        },
      });
      if (result.status === "disabled") return { status: "disabled" };
      if (result.status === "success") return { status: "completed", value: result.value };
      input.diagnostic?.(diagnosticReason);
      return { status: failure };
    },
    async sources(input) {
      const feature = input.service === "calendar" ? "calendar_read" : "tasks_read";
      if (!options.boundary.flags()[feature]) return { status: "disabled" };
      let failure: "disconnected" | "quota" | "unavailable" = "unavailable";
      let diagnosticReason: GoogleCalendarTasksDiagnosticReason = "unknown";
      const result = await options.boundary.run({
        user: input.owner,
        requestId: input.requestId,
        attempt: 1,
        feature,
        operation: "read",
        costArea: "calendar",
        maximumUsd: GOOGLE_CALENDAR_TASKS_MAXIMUM_USD,
        context: input.context,
        input: { service: input.service, request: "sources" },
        timeoutMs: GOOGLE_CALENDAR_TASKS_DEFAULT_TIMEOUT_MS,
        signal: input.signal,
        execute: async ({ signal }) => {
          const connection = await options.connections.status(input.owner, input.service);
          if (connection.state !== "connected" || connection.service !== input.service) {
            failure = "disconnected";
            throw new Error("Google preview connection unavailable");
          }
          const lease = await options.quota.acquire(input.owner, input.service, now(), input.requestId);
          if (!lease) {
            failure = "quota";
            throw new Error("Google preview quota unavailable");
          }
          await lease.commit();
          let received: GoogleSourceListResult;
          try {
            received = await options.gateway.sources({ owner: input.owner, service: input.service }, signal);
          } catch (error) {
            diagnosticReason = googleCalendarTasksDiagnostic(error).reason;
            throw error;
          }
          return {
            value: parseGoogleSourceListResult(received, input.service),
            actualUsd: 0,
            quotaUnits: 1,
          };
        },
      });
      if (result.status === "disabled") return { status: "disabled" };
      if (result.status === "success") return { status: "completed", value: result.value };
      input.diagnostic?.(diagnosticReason);
      return { status: failure };
    },
  };
}
