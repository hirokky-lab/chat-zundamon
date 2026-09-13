import { isValidGoogleSourceId } from "@yui/domain";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { GoogleCalendarTasksRepositoryError, type GoogleCalendarTasksConnectionRepository, type GoogleCalendarTasksReadRequest, type GoogleCalendarTasksReadService, type GoogleService } from "./google-calendar-tasks.js";
import type { GoogleOAuthService } from "./google-oauth.js";
import type { GoogleCalendarTasksPreviewService } from "./google-calendar-tasks-preview.js";

const services: readonly GoogleService[] = ["calendar", "tasks"];

/**
 * These routes are registered only after at least one server feature flag is
 * enabled. They intentionally expose only connection state, never provider
 * account values, OAuth values, scopes, or token material.
 */
export function registerGoogleCalendarTasksRoutes(
  app: FastifyInstance,
  options: { connections: GoogleCalendarTasksConnectionRepository; readService: GoogleCalendarTasksReadService; previewService: GoogleCalendarTasksPreviewService; enabled: Readonly<Record<GoogleService, boolean>>; oauth?: GoogleOAuthService },
): void {
  app.post("/api/google-calendar-tasks/:service/connect", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const owner = request.yuiUser;
    const service = parseService((request.params as { service?: unknown }).service);
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    if (!service || !options.enabled[service] || !options.oauth) return reply.code(404).send();
    try {
      const body = request.body;
      if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "purpose" || !["read", "write"].includes(String((body as { purpose?: unknown }).purpose)))) return reply.code(400).send({ error: "Invalid request" });
      const purpose = body ? (body as { purpose: "read" | "write" }).purpose : "read";
      const started = await options.oauth.begin({ owner, service, ...(purpose === "write" ? { purpose } : {}) });
      return { authorizationUrl: started.authorizationUrl };
    } catch {
      return reply.code(409).send({ error: "Google service is unavailable" });
    }
  });
  app.get("/api/google-calendar-tasks/callback", async (request, reply) => {
    const query = request.query;
    if (!options.oauth || !isExactCallbackQuery(query)) return reply.code(404).send();
    let outcome: Awaited<ReturnType<NonNullable<typeof options.oauth>["complete"]>>;
    try {
      outcome = await options.oauth.complete({
        owner: { userId: "", email: "", accessToken: "" },
        code: query.code,
        state: query.state,
        signal: new AbortController().signal,
        isServiceEnabled: (service) => options.enabled[service] === true,
      });
    } catch {
      request.log.warn({ event: "google_oauth_callback_rejected", reason: "adapter_unavailable" }, "Google OAuth callback rejected");
      return reply.redirect("/", 303);
    }
    if (outcome.status === "rejected") {
      request.log.warn({ event: "google_oauth_callback_rejected", reason: outcome.reason ?? "unavailable" }, "Google OAuth callback rejected");
    }
    if (outcome.status === "connected") {
      const owner = { userId: outcome.ownerId, email: "", accessToken: "" };
      try {
        await options.connections.save(owner, { service: outcome.service, googleSubject: outcome.googleSubject });
      } catch {
        request.log.warn({ event: "google_oauth_callback_rejected", reason: "control_unavailable" }, "Google OAuth callback rejected");
        try {
          await options.oauth.discard({ owner, service: outcome.service });
        } catch {
          // The callback must not expose provider or storage failures to the browser.
        }
        return reply.redirect("/", 303);
      }
    }
    return reply.redirect("/", 303);
  });
  app.get("/api/google-calendar-tasks/status", async (request, reply) => {
    const owner = request.yuiUser;
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    try {
      const [calendar, tasks] = await Promise.all(services.map(async (service) => options.enabled[service]
        ? options.connections.status(owner, service)
        : { service, state: "disabled" as const, homeVisible: false }));
      return { calendar, tasks };
    } catch (error) {
      const reason = error instanceof GoogleCalendarTasksRepositoryError ? error.reason : "unavailable";
      request.log.warn({ event: "google_calendar_tasks_status_unavailable", reason }, "Google Calendar/Tasks status unavailable");
      return reply.code(503).send({ error: "Google service status unavailable" });
    }
  });

  app.post("/api/google-calendar-tasks/:service/read", async (request, reply) => {
    const owner = request.yuiUser;
    const service = parseService((request.params as { service?: unknown }).service);
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    if (!service || !options.enabled[service]) return reply.code(404).send();
    const body = parseReadBody(request.body, service);
    if (!body) return reply.code(400).send({ error: "Invalid Google service request" });
    try {
      const outcome = await options.readService.read({
        owner,
        service,
        request: body.request,
        requestId: body.requestId,
        context: { conversationId: body.requestId, channel: "chat", personaId: "yui", memoryScope: "shared" },
        diagnostic: (reason) => request.log.warn(
          { event: "google_calendar_tasks_read_unavailable", service, reason },
          "Google Calendar/Tasks read unavailable",
        ),
      });
      if (outcome.status !== "completed") return reply.code(503).send({ error: "Google service is unavailable" });
      return { status: outcome.status, service: outcome.service, checkedAt: outcome.checkedAt };
    } catch {
      return reply.code(503).send({ error: "Google service is unavailable" });
    }
  });

  app.post("/api/google-calendar-tasks/:service/preview", async (request, reply) => {
    const owner = request.yuiUser;
    const service = parseService((request.params as { service?: unknown }).service);
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    if (!service || !options.enabled[service]) return reply.code(404).send();
    if (!isPreviewBody(request.body)) return reply.code(400).send({ error: "Invalid Google service request" });
    const requestId = `google-preview:${randomUUID()}`;
    try {
      const outcome = await options.previewService.preview({
        owner,
        service,
        ...(isSourceBody(request.body) ? { sourceId: request.body.sourceId } : {}),
        requestId,
        context: { conversationId: requestId, channel: "chat", personaId: "yui", memoryScope: "shared" },
        diagnostic: (reason) => request.log.warn(
          { event: "google_calendar_tasks_preview_unavailable", service, reason },
          "Google Calendar/Tasks preview unavailable",
        ),
      });
      if (outcome.status === "disconnected") return reply.code(409).send({ error: "Google service is disconnected" });
      if (outcome.status === "quota") return reply.code(429).send({ error: "Google service is temporarily unavailable" });
      if (outcome.status !== "completed") return reply.code(503).send({ error: "Google service is unavailable" });
      return outcome.value;
    } catch {
      return reply.code(503).send({ error: "Google service is unavailable" });
    }
  });

  app.post("/api/google-calendar-tasks/:service/sources", async (request, reply) => {
    const owner = request.yuiUser;
    const service = parseService((request.params as { service?: unknown }).service);
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    if (!service || !options.enabled[service]) return reply.code(404).send();
    if (!isEmptyPreviewBody(request.body)) return reply.code(400).send({ error: "Invalid Google service request" });
    const requestId = `google-sources:${randomUUID()}`;
    try {
      const outcome = await options.previewService.sources({
        owner,
        service,
        requestId,
        context: { conversationId: requestId, channel: "chat", personaId: "yui", memoryScope: "shared" },
        diagnostic: (reason) => request.log.warn(
          { event: "google_calendar_tasks_sources_unavailable", service, reason },
          "Google Calendar/Tasks preview unavailable",
        ),
      });
      if (outcome.status === "disconnected") return reply.code(409).send({ error: "Google service is disconnected" });
      if (outcome.status === "quota") return reply.code(429).send({ error: "Google service is temporarily unavailable" });
      if (outcome.status !== "completed") return reply.code(503).send({ error: "Google service is unavailable" });
      return outcome.value;
    } catch {
      return reply.code(503).send({ error: "Google service is unavailable" });
    }
  });

  app.post("/api/google-calendar-tasks/:service/home", async (request, reply) => {
    const owner = request.yuiUser;
    const service = parseService((request.params as { service?: unknown }).service);
    const body = request.body;
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    if (!service || !options.enabled[service]) return reply.code(404).send();
    if (!isExactVisibleBody(body)) return reply.code(400).send({ error: "Invalid Google service request" });
    try {
      await options.connections.setHomeVisible(owner, service, body.visible);
      return await options.connections.status(owner, service);
    } catch {
      return reply.code(409).send({ error: "Google service is unavailable" });
    }
  });

  app.delete("/api/google-calendar-tasks/:service", async (request, reply) => {
    const owner = request.yuiUser;
    const service = parseService((request.params as { service?: unknown }).service);
    if (!owner) return reply.code(401).send({ error: "Authentication required" });
    if (!service || !options.enabled[service]) return reply.code(404).send();
    try {
      if (options.oauth) await options.oauth.discard({ owner, service });
      await options.connections.clear(owner, service);
      return reply.code(204).send();
    } catch {
      return reply.code(409).send({ error: "Google service is unavailable" });
    }
  });
}

function parseService(value: unknown): GoogleService | null {
  return value === "calendar" || value === "tasks" ? value : null;
}

function parseReadBody(value: unknown, service: GoogleService): { request: GoogleCalendarTasksReadRequest; requestId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "request,requestId"
    || typeof source.requestId !== "string"
    || !/^[A-Za-z0-9:_-]{1,128}$/.test(source.requestId)) return null;
  if (service === "calendar" && (source.request === "availability" || source.request === "event_type")) {
    return { request: source.request, requestId: source.requestId };
  }
  if (service === "tasks" && source.request === "task_summary") return { request: source.request, requestId: source.requestId };
  return null;
}

function isEmptyPreviewBody(value: unknown): boolean {
  return value === undefined
    || (Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
}

function isExactVisibleBody(value: unknown): value is { visible: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return Object.keys(source).length === 1 && source.visible !== undefined && typeof source.visible === "boolean";
}

function isExactCallbackQuery(value: unknown): value is { code: string; state: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const query = value as Record<string, unknown>;
  const allowed = new Set(["code", "state", "scope", "authuser", "prompt", "iss", "path"]);
  if (!Object.keys(query).every((key) => allowed.has(key))) return false;
  if (query.path !== undefined && query.path !== "google-calendar-tasks/callback") return false;
  return typeof query.code === "string" && query.code.length > 0
    && typeof query.state === "string" && query.state.length > 0
    && Object.values(query).every((item) => typeof item === "string" && item.length > 0);
}

function isSourceBody(value: unknown): value is { sourceId: string } {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && "sourceId" in value && isValidGoogleSourceId(value.sourceId);
}
function isPreviewBody(value: unknown): boolean { return isEmptyPreviewBody(value) || isSourceBody(value); }
