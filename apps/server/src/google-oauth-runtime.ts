import { googleConnectionBinding } from './google-assistant-connection-binding.js';
import { acceptedGoogleAssistantScopes, acceptedGoogleConnectionScopes } from './google-assistant-oauth.js';
import { createHash, createPublicKey, verify } from "node:crypto";
import type { GoogleCalendarTasksAccessTokenProvider } from "./google-calendar-tasks-provider.js";
import { GoogleCalendarTasksDiagnosticError } from "./google-calendar-tasks-diagnostics.js";
import { acceptedGoogleReadScopes, type GoogleService } from "./google-calendar-tasks.js";
import type { GoogleCalendarTasksOAuthRepository, GoogleOAuthExchange, GoogleOAuthTokenResult } from "./google-oauth.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const MAX_JWKS_RESPONSE_BYTES = 64 * 1024;

type JsonResponse = { status: number; readJson(maximumBytes: number): Promise<unknown> };
type Http = { post(input: { url: string; body: URLSearchParams; signal: AbortSignal }): Promise<JsonResponse>; get(input: { url: string; signal: AbortSignal }): Promise<JsonResponse> };

export function createGoogleOAuthRuntime(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  repository: GoogleCalendarTasksOAuthRepository;
  http?: Http;
  now?: () => Date;
}): { exchange: GoogleOAuthExchange; tokens: GoogleCalendarTasksAccessTokenProvider } {
  const http = input.http ?? fetchHttp();
  const now = input.now ?? (() => new Date());
  const exchange: GoogleOAuthExchange = {
    async exchange(value) {
      const payload = await postToken(http, new URLSearchParams({
        code: value.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: value.codeVerifier.toString("utf8"),
        grant_type: "authorization_code",
      }), value.signal);
      const token = parseInitialToken(payload);
      const claims = await verifyGoogleIdToken(http, token.idToken, {
        nonceDigest: value.expectedNonceDigest,
        audience: value.expectedAudience,
        issuer: value.expectedIssuer,
        signal: value.signal,
        now,
      });
      if (!acceptedGoogleAssistantScopes(token.scopes, value.service, value.purpose ?? "read")) throw new Error("Google OAuth exchange unavailable");
      return { googleSubject: claims.subject, grantedScopes: token.scopes, refreshToken: Buffer.from(token.refreshToken, "utf8") };
    },
  };
  const tokens: GoogleCalendarTasksAccessTokenProvider = {
    async getAccessToken({ owner, service, signal, expectedConnectionBinding, requireWrite }) {
      if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
      let connection: Awaited<ReturnType<GoogleCalendarTasksOAuthRepository["getConnectionForOwner"]>>;
      try {
        connection = await input.repository.getConnectionForOwner({ ownerId: owner.userId, service });
      } catch {
        if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
        throw new GoogleCalendarTasksDiagnosticError("credential");
      }
      if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
      if (!connection || !acceptedGoogleConnectionScopes(connection.grantedScopes, service)) {
        throw new GoogleCalendarTasksDiagnosticError("credential");
      }
      const binding = googleConnectionBinding(connection);
      if (expectedConnectionBinding !== undefined && expectedConnectionBinding !== binding || requireWrite && !acceptedGoogleAssistantScopes(connection.grantedScopes, service, "write")) throw new GoogleCalendarTasksDiagnosticError("credential");
      try {
        const payload = await postToken(http, new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          refresh_token: connection.refreshToken.toString("utf8"),
          grant_type: "refresh_token",
        }), signal);
        const refreshed = parseRefreshToken(payload);
        if (refreshed.scopes && !acceptedGoogleConnectionScopes(refreshed.scopes, service) || refreshed.scopes && !connection.grantedScopes.every(scope => refreshed.scopes!.includes(scope))) throw new Error("invalid scope");
        if (expectedConnectionBinding !== undefined || requireWrite) {
          const current = await input.repository.getConnectionForOwner({ ownerId: owner.userId, service });
          if (!current || googleConnectionBinding(current) !== binding) throw new Error("Connection changed during refresh");
        }
        return refreshed.accessToken;
      } catch {
        if (signal.aborted) throw new GoogleCalendarTasksDiagnosticError("unknown");
        throw new GoogleCalendarTasksDiagnosticError("refresh");
      }
    },
  };
  return { exchange, tokens };
}

/** Server-only GET transport. A missing length uses -1 and remains bounded by readBoundedJson. */
export function createGoogleCalendarTasksFetchTransport(): { get(input: { url: string; method: "GET"; redirect: "error"; headers: Readonly<Record<string, string>>; signal: AbortSignal }): Promise<{ status: number; contentLength: number; json(maximumBytes: number): Promise<unknown> }> } {
  return {
    async get(input) {
      const response = await fetch(input.url, { method: input.method, redirect: input.redirect, headers: input.headers, signal: input.signal });
      const declared = response.headers.get("content-length");
      return {
        status: response.status,
        contentLength: declared === null ? -1 : Number(declared),
        json: (maximumBytes) => readBoundedJson(response, maximumBytes),
      };
    },
  };
}

async function postToken(http: Http, body: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  const response = await http.post({ url: TOKEN_ENDPOINT, body, signal });
  if (signal.aborted || response.status < 200 || response.status >= 300) throw new Error("Google OAuth exchange unavailable");
  return await response.readJson(MAX_TOKEN_RESPONSE_BYTES);
}

function parseInitialToken(value: unknown): { idToken: string; refreshToken: string; scopes: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google OAuth exchange unavailable");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  const required = ["access_token", "expires_in", "id_token", "refresh_token", "scope", "token_type"] as const;
  const allowed = new Set<string>([...required, "refresh_token_expires_in"]);
  if (!required.every((key) => keys.includes(key)) || !keys.every((key) => allowed.has(key))) throw new Error("Google OAuth exchange unavailable");
  if (typeof item.access_token !== "string" || item.access_token.length === 0 || typeof item.expires_in !== "number" || !Number.isFinite(item.expires_in)
    || typeof item.id_token !== "string" || typeof item.refresh_token !== "string" || item.refresh_token.length === 0 || item.token_type !== "Bearer" || typeof item.scope !== "string") throw new Error("Google OAuth exchange unavailable");
  if (item.refresh_token_expires_in !== undefined
    && (!Number.isSafeInteger(item.refresh_token_expires_in) || (item.refresh_token_expires_in as number) <= 0)) throw new Error("Google OAuth exchange unavailable");
  return { idToken: item.id_token, refreshToken: item.refresh_token, scopes: splitScopes(item.scope) };
}

function parseRefreshToken(value: unknown): { accessToken: string; scopes?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google access unavailable");
  const item = value as Record<string, unknown>;
  if (!Object.keys(item).every((key) => key === "access_token" || key === "expires_in" || key === "id_token" || key === "refresh_token_expires_in" || key === "scope" || key === "token_type")
    || typeof item.access_token !== "string" || item.access_token.length === 0 || typeof item.expires_in !== "number" || !Number.isFinite(item.expires_in) || item.token_type !== "Bearer"
    || (item.id_token !== undefined && (typeof item.id_token !== "string" || item.id_token.length === 0))
    || (item.refresh_token_expires_in !== undefined && (!Number.isSafeInteger(item.refresh_token_expires_in) || (item.refresh_token_expires_in as number) <= 0))
    || (item.scope !== undefined && typeof item.scope !== "string")) throw new Error("Google access unavailable");
  return { accessToken: item.access_token, ...(typeof item.scope === "string" ? { scopes: splitScopes(item.scope) } : {}) };
}

export async function verifyGoogleIdToken(http: Http, idToken: string, input: { nonceDigest: string; audience: string; issuer: string; signal: AbortSignal; now: () => Date }): Promise<{ subject: string }> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Google OAuth exchange unavailable");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);
  if (!exactObject(header, ["alg", "kid", "typ"]) || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0 || header.typ !== "JWT") throw new Error("Google OAuth exchange unavailable");
  if (!isClaims(claims, input)) throw new Error("Google OAuth exchange unavailable");
  const jwks = await fetchJwks(http, input.signal);
  const jwk = jwks.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && candidate.use === "sig" && candidate.alg === "RS256");
  if (!jwk || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"))) throw new Error("Google OAuth exchange unavailable");
  return { subject: claims.sub };
}

async function fetchJwks(http: Http, signal: AbortSignal): Promise<Record<string, unknown>[]> {
  const response = await http.get({ url: JWKS_ENDPOINT, signal });
  if (signal.aborted || response.status !== 200) throw new Error("Google OAuth exchange unavailable");
  const value = await response.readJson(MAX_JWKS_RESPONSE_BYTES);
  if (!exactObject(value, ["keys"]) || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("Google OAuth exchange unavailable");
  return value.keys as Record<string, unknown>[];
}

function isClaims(value: unknown, input: { nonceDigest: string; audience: string; issuer: string; now: () => Date }): value is { iss: string; aud: string; sub: string; nonce: string; exp: number; iat: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const allowed = new Set(["iss", "aud", "azp", "sub", "nonce", "iat", "exp", "at_hash"]);
  if (Object.keys(claims).some((key) => !allowed.has(key)) || claims.iss !== input.issuer || claims.aud !== input.audience
    || (claims.azp !== undefined && claims.azp !== input.audience) || typeof claims.sub !== "string" || claims.sub.length === 0
    || typeof claims.nonce !== "string" || typeof claims.exp !== "number" || typeof claims.iat !== "number"
    || (claims.at_hash !== undefined && typeof claims.at_hash !== "string")) return false;
  if (`sha256:${createHash("sha256").update(claims.nonce, "utf8").digest("hex")}` !== input.nonceDigest) return false;
  const nowSeconds = Math.floor(input.now().getTime() / 1000);
  return Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.iat) && claims.exp >= nowSeconds - 60 && claims.iat <= nowSeconds + 60;
}

function decodeJson(segment: string): unknown { try { return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")); } catch { throw new Error("Google OAuth exchange unavailable"); } }
function splitScopes(value: string): string[] { const scopes = value.split(" ").filter(Boolean); return [...new Set(scopes)]; }
function hasExactReadScopes(scopes: readonly string[], service: GoogleService): boolean { return acceptedGoogleReadScopes(scopes, service); }
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]); }
function fetchHttp(): Http { return { post: async ({ url, body, signal }) => { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal, redirect: "error" }); return { status: response.status, readJson: (maximum) => readBoundedJson(response, maximum) }; }, get: async ({ url, signal }) => { const response = await fetch(url, { method: "GET", signal, redirect: "error" }); return { status: response.status, readJson: (maximum) => readBoundedJson(response, maximum) }; } }; }

export async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new Error("Google OAuth exchange unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google OAuth exchange unavailable");
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Google OAuth exchange unavailable");
      }
      chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new Error("Google OAuth exchange unavailable");
  } finally {
    reader.releaseLock();
  }
}
