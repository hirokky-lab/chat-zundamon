import { googleAssistantScopes, acceptedGoogleAssistantScopes, type GoogleOAuthPurpose } from './google-assistant-oauth.js';
import { createCipheriv, createDecipheriv, createHash, randomUUID, randomBytes as secureRandomBytes } from "node:crypto";
import {
  googleReadScopes, acceptedGoogleReadScopes,
  type GoogleService,
} from "./google-calendar-tasks.js";
import type { RequestUser } from "./request-user.js";

const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const ATTEMPT_TTL_MS = 5 * 60 * 1000;

export type GoogleOAuthTokenResult = {
  googleSubject: string;
  grantedScopes: readonly string[];
  refreshToken: Buffer;
};

/**
 * The production adapter owns the OAuth code exchange and ID-token validation.
 * This contract deliberately returns only validated claims and never persists
 * authorization codes, state, or raw provider responses.
 */
export type GoogleOAuthExchange = {
  exchange(input: {
    code: string;
    service: GoogleService;
    purpose?: GoogleOAuthPurpose;
    codeVerifier: Buffer;
    expectedNonceDigest: string;
    expectedIssuer: "https://accounts.google.com";
    expectedAudience: string;
    signal: AbortSignal;
  }): Promise<GoogleOAuthTokenResult>;
};

type OAuthAttempt = {
  connectionGeneration?: string;
  purpose?: GoogleOAuthPurpose;
  ownerId: string;
  service: GoogleService;
  stateHash: string;
  nonceHash: string;
  codeVerifier: Buffer;
  expiresAt: string;
  consumed: boolean;
};

type OAuthConnection = {
  generation?: string;
  expectedGeneration?: string;
  ownerId: string;
  service: GoogleService;
  googleSubject: string;
  grantedScopes: readonly string[];
  refreshToken: Buffer;
};

export type GoogleCalendarTasksOAuthRepository = {
  createAttempt(attempt: OAuthAttempt): Promise<void>;
  consumeAttemptByStateHashForOwner(stateHash: string, ownerId: string): Promise<OAuthAttempt | null>;
  saveConnection(connection: OAuthConnection): Promise<void>;
  getConnectionForOwner(input: { ownerId: string; service: GoogleService }): Promise<OAuthConnection | null>;
  clearConnection(input: { ownerId: string; service: GoogleService }): Promise<void>;
};

export type GoogleOAuthSnapshot = {
  attempts: Array<{
    ownerId: string;
    service: GoogleService;
    stateHash: string;
    nonceHash: string;
    expiresAt: string;
    consumed: boolean;
  }>;
  connections: Array<{
    ownerId: string;
    service: GoogleService;
    googleSubject: string;
    grantedScopes: readonly string[];
  }>;
};

export function makeInMemoryGoogleCalendarTasksOAuthRepository(): GoogleCalendarTasksOAuthRepository & {
  snapshot(): GoogleOAuthSnapshot;
} {
  const attempts: OAuthAttempt[] = [];
  const connections: OAuthConnection[] = [];
  const generations = new Map<string,string>();
  const generation = (ownerId: string, service: GoogleService) => { const key = ownerId+":"+service; if (!generations.has(key)) generations.set(key,randomUUID()); return generations.get(key)!; };

  return {
    async createAttempt(attempt) {
      attempts.push({ ...attempt, connectionGeneration: generation(attempt.ownerId,attempt.service), codeVerifier: Buffer.from(attempt.codeVerifier) });
    },
    async consumeAttemptByStateHashForOwner(stateHash, ownerId) {
      const attempt = attempts.find((candidate) => candidate.stateHash === stateHash && candidate.ownerId === ownerId && !candidate.consumed);
      if (!attempt) return null;
      attempt.consumed = true;
      return { ...attempt, codeVerifier: Buffer.from(attempt.codeVerifier) };
    },
    async saveConnection(connection) {
      if (connection.expectedGeneration !== undefined && connection.expectedGeneration !== generation(connection.ownerId,connection.service)) throw new Error("Stale OAuth generation");
      const nextGeneration = randomUUID();
      generations.set(connection.ownerId+":"+connection.service,nextGeneration);
      const old = connections.findIndex(c => c.ownerId === connection.ownerId && c.service === connection.service);
      if (old >= 0) connections.splice(old,1);
      connections.push({
        ...connection,
        generation: nextGeneration,
        grantedScopes: [...connection.grantedScopes],
        refreshToken: Buffer.from(connection.refreshToken),
      });
    },
    async getConnectionForOwner({ ownerId, service }) {
      const connection = connections.find((candidate) => candidate.ownerId === ownerId && candidate.service === service);
      return connection ? {
        ...connection,
        grantedScopes: [...connection.grantedScopes],
        refreshToken: Buffer.from(connection.refreshToken),
      } : null;
    },
    async clearConnection(input) {
      generations.set(input.ownerId+":"+input.service,randomUUID());
      for (const attempt of attempts) if (attempt.ownerId === input.ownerId && attempt.service === input.service) attempt.consumed = true;
      const index = connections.findIndex((connection) => connection.ownerId === input.ownerId && connection.service === input.service);
      if (index >= 0) connections.splice(index, 1);
    },
    snapshot() {
      return {
        attempts: attempts.map(({ codeVerifier: _codeVerifier, ...attempt }) => ({ ...attempt })),
        connections: connections.map(({ refreshToken: _refreshToken, ...connection }) => ({
          ...connection,
          grantedScopes: [...connection.grantedScopes],
        })),
      };
    },
  };
}

export type GoogleOAuthService = {
  begin(input: { owner: RequestUser; service: GoogleService; purpose?: GoogleOAuthPurpose }): Promise<{
    authorizationUrl: string;
    state: string;
  }>;
  complete(input: {
    owner: RequestUser;
    code: string;
    state: string;
    signal: AbortSignal;
    isServiceEnabled?: (service: GoogleService) => boolean;
  }): Promise<
    | { status: "connected"; service: GoogleService; googleSubject: string; ownerId: string }
    | { status: "rejected"; reason?: GoogleOAuthRejectionReason }
  >;
  discard(input: { owner: RequestUser; service: GoogleService }): Promise<void>;
};

export type GoogleOAuthRejectionReason =
  | "invalid_request"
  | "invalid_state"
  | "attempt_unavailable"
  | "feature_disabled"
  | "exchange_unavailable"
  | "invalid_result"
  | "repository_unavailable";

export function createGoogleOAuthService(input: {
  repository: GoogleCalendarTasksOAuthRepository;
  exchange: GoogleOAuthExchange;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  clientId?: string;
  redirectUri?: string;
  callbackStateKey?: Buffer;
  isWriteEnabled?: (service: GoogleService) => boolean;
}): GoogleOAuthService {
  const now = input.now ?? (() => new Date());
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const clientId = input.clientId ?? "yui-google-owner-read-r1";
  const redirectUri = input.redirectUri ?? "https://yui.invalid/api/google-calendar-tasks/callback";
  const callbackStateKey = input.callbackStateKey ?? Buffer.alloc(32, 1);

  return {
    async begin({ owner, service, purpose = "read" }) {
      if (purpose !== "read" && purpose !== "write" || purpose === "write" && !input.isWriteEnabled?.(service)) throw new Error("Google write is disabled");
      const state = createCallbackState(owner.userId, callbackStateKey, randomBytes);
      const nonce = randomBytes(32).toString("base64url");
      // PKCE requires an ASCII verifier. Never send an arbitrary binary buffer
      // through UTF-8 conversion to the token endpoint.
      const codeVerifier = Buffer.from(randomBytes(48).toString("base64url"), "ascii");
      const codeChallenge = sha256(codeVerifier).toString("base64url");
      const expiresAt = new Date(now().getTime() + ATTEMPT_TTL_MS).toISOString();

      await input.repository.createAttempt({
        ownerId: owner.userId,
        service,
        ...(purpose === "write" ? { purpose } : {}),
        stateHash: sha256Digest(state),
        nonceHash: sha256Digest(nonce),
        codeVerifier,
        expiresAt,
        consumed: false,
      });

      const authorizationUrl = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", clientId);
      authorizationUrl.searchParams.set("scope", googleAssistantScopes(service, purpose).join(" "));
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("nonce", nonce);
      authorizationUrl.searchParams.set("redirect_uri", redirectUri);
      authorizationUrl.searchParams.set("code_challenge", codeChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      authorizationUrl.searchParams.set("access_type", "offline");
      authorizationUrl.searchParams.set("include_granted_scopes", "false");
      authorizationUrl.searchParams.set("prompt", "consent");

      return { authorizationUrl: authorizationUrl.toString(), state };
    },

    async complete({ owner, code, state, signal, isServiceEnabled }) {
      if (signal.aborted || code.length === 0 || state.length === 0) return { status: "rejected", reason: "invalid_request" };
      const ownerId = parseCallbackStateOwner(state, callbackStateKey);
      if (!ownerId) return { status: "rejected", reason: "invalid_state" };
      let attempt: OAuthAttempt | null;
      try {
        attempt = await input.repository.consumeAttemptByStateHashForOwner(sha256Digest(state), ownerId);
      } catch {
        return { status: "rejected", reason: "attempt_unavailable" };
      }
      if (!attempt || Date.parse(attempt.expiresAt) <= now().getTime()) return { status: "rejected", reason: "attempt_unavailable" };
      // The callback bypasses the normal Bearer route guard, so re-check the
      // service flag after deriving the owner from opaque state and before
      // exchanging or storing a credential. A disabled service consumes the
      // one-time state and fails closed.
      if (isServiceEnabled && !isServiceEnabled(attempt.service)) return { status: "rejected", reason: "feature_disabled" };

      if (attempt.purpose === "write" && !input.isWriteEnabled?.(attempt.service)) return { status: "rejected", reason: "feature_disabled" };
      let result: GoogleOAuthTokenResult;
      try {
        result = await input.exchange.exchange({
          code,
          service: attempt.service,
          ...(attempt.purpose === "write" ? { purpose: attempt.purpose } : {}),
          codeVerifier: attempt.codeVerifier,
          expectedNonceDigest: attempt.nonceHash,
          expectedIssuer: "https://accounts.google.com",
          expectedAudience: clientId,
          signal,
        });
      } catch {
        return { status: "rejected", reason: "exchange_unavailable" };
      }
      if (signal.aborted || !acceptedGoogleAssistantScopes(result.grantedScopes, attempt.service, attempt.purpose ?? "read") || result.googleSubject.length === 0 || result.refreshToken.length === 0) {
        return { status: "rejected", reason: "invalid_result" };
      }
      try {
        if (attempt.purpose === "write") {
          const existing = await input.repository.getConnectionForOwner({ ownerId: attempt.ownerId, service: attempt.service });
          if (existing && existing.googleSubject !== result.googleSubject) return { status: "rejected", reason: "invalid_result" };
        }
        if (!attempt.connectionGeneration) return { status: "rejected", reason: "attempt_unavailable" };
        await input.repository.saveConnection({
          expectedGeneration: attempt.connectionGeneration,
          ownerId: attempt.ownerId,
          service: attempt.service,
          googleSubject: result.googleSubject,
          grantedScopes: googleAssistantScopes(attempt.service, attempt.purpose ?? "read").filter(scope => result.grantedScopes.includes(scope)),
          refreshToken: result.refreshToken,
        });
      } catch {
        return { status: "rejected", reason: "repository_unavailable" };
      }
      return { status: "connected", service: attempt.service, googleSubject: result.googleSubject, ownerId: attempt.ownerId };
    },

    async discard({ owner, service }) {
      await input.repository.clearConnection({ ownerId: owner.userId, service });
    },
  };
}

function createCallbackState(ownerId: string, key: Buffer, randomBytes: (size: number) => Buffer): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(ownerId) || key.length !== 32) throw new Error("Invalid OAuth callback state");
  const iv = randomBytes(12);
  if (iv.length !== 12) throw new Error("Invalid OAuth callback state");
  const cipher = createCipheriv("aes-256-gcm", callbackStateEncryptionKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(ownerId, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url")}`;
}

function parseCallbackStateOwner(state: string, key: Buffer): string | null {
  try {
    if (!state.startsWith("v1.") || state.length > 256 || key.length !== 32) return null;
    const raw = Buffer.from(state.slice(3), "base64url");
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12); const tag = raw.subarray(raw.length - 16); const ciphertext = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", callbackStateEncryptionKey(key), iv); decipher.setAuthTag(tag);
    const ownerId = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(ownerId) ? ownerId : null;
  } catch { return null; }
}

function callbackStateEncryptionKey(key: Buffer): Buffer { return createHash("sha256").update("yui-google-oauth-state-v1").update(key).digest(); }

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function sha256Digest(value: string): string {
  return `sha256:${sha256(Buffer.from(value, "utf8")).toString("hex")}`;
}

function isExactGoogleReadScope(scopes: readonly string[], service: GoogleService): boolean {
  return acceptedGoogleReadScopes(scopes, service);
}
