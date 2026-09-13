import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { RequestUser } from "./request-user.js";

export type SupabaseAuthClient = {
  auth: {
    getUser(accessToken: string): Promise<{
      data: { user: { id: string; email?: string } | null };
      error: unknown;
    }>;
  };
};

export type AuthVerifier = {
  verify(accessToken: string): Promise<RequestUser | null>;
};

export function createSupabaseAuthVerifier(
  client: SupabaseAuthClient,
  allowedEmail: string,
): AuthVerifier {
  const normalizedAllowedEmail = allowedEmail.trim().toLowerCase();
  return {
    async verify(accessToken) {
      try {
        const { data, error } = await client.auth.getUser(accessToken);
        const email = data.user?.email?.trim().toLowerCase();
        if (error || !data.user || !email || email !== normalizedAllowedEmail) return null;
        return { userId: data.user.id, email, accessToken };
      } catch {
        return null;
      }
    },
  };
}

export function registerAuthentication(
  app: FastifyInstance,
  options: { verifier: AuthVerifier; allowedOrigin: string },
): void {
  void app.register(cors, {
    origin: options.allowedOrigin,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Yui-Session-Id", "X-Yui-Time-Zone"],
    exposedHeaders: ["X-Yui-Opening-Context", "X-Yui-Voice-Provider"],
  });

  app.addHook("onRequest", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (
      request.method === "OPTIONS" ||
      (request.method === "GET" && (pathname === "/healthz" || pathname === "/api/healthz")) ||
      (request.method === "GET" && pathname === "/api/browser-config") ||
      (request.method === "GET" && pathname === "/api/google-calendar-tasks/callback") ||
      pathname === "/api/cron/proactive" ||
      pathname === "/api/cron/backup"
    ) return;

    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (!match) return reply.code(401).send({ error: "Unauthorized" });
    const user = await options.verifier.verify(match[1]);
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    request.yuiUser = user;
  });
}
