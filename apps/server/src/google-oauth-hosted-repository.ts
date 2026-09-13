import { createCipheriv, createDecipheriv, randomBytes as secureRandomBytes } from "node:crypto";
import type { GoogleCalendarTasksOAuthRepository } from "./google-oauth.js";

type RpcClient = { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };

type Encrypted = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

export function createSupabaseGoogleCalendarTasksOAuthRepository(input: {
  /**
   * Returns a service-role RPC client bound to this owner.  The binding is
   * deliberately supplied by the existing allowlisted mutation factory, so
   * callers cannot choose a second owner id in an RPC payload.
   */
  rpcForOwner: (ownerId: string) => RpcClient;
  key: Buffer;
  keyVersion: string;
  randomBytes?: (size: number) => Buffer;
}): GoogleCalendarTasksOAuthRepository {
  assertKey(input.key);
  const randomBytes = input.randomBytes ?? secureRandomBytes;
  const invoke = async (ownerId: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await input.rpcForOwner(ownerId).rpc(name, args);
    if (result.error) throw new Error("Google OAuth repository unavailable");
    return result.data;
  };
  return {
    async createAttempt(attempt) {
      const encrypted = encrypt(input.key, attempt.codeVerifier, randomBytes);
      await invoke(attempt.ownerId, attempt.purpose === "write" ? "create_google_assistant_oauth_attempt" : "create_google_calendar_tasks_oauth_attempt", {
        ...(attempt.purpose === "write" ? { p_purpose: "write" } : {}),
        p_service: attempt.service,
        p_state_digest: attempt.stateHash,
        p_nonce_digest: attempt.nonceHash,
        p_code_verifier_ciphertext: encrypted.ciphertext.toString("base64"),
        p_code_verifier_iv: encrypted.iv.toString("base64"),
        p_code_verifier_tag: encrypted.tag.toString("base64"),
        p_key_version: input.keyVersion,
        p_expires_at: attempt.expiresAt,
      });
    },
    async consumeAttemptByStateHashForOwner(stateHash, ownerId) {
      const value = await invoke(ownerId, "consume_google_calendar_tasks_oauth_attempt", { p_state_digest: stateHash });
      return parseAttempt(value, input.key);
    },
    async saveConnection(connection) {
      const encrypted = encrypt(input.key, connection.refreshToken, randomBytes);
      await invoke(connection.ownerId, connection.expectedGeneration ? "save_google_assistant_oauth_connection" : "save_google_calendar_tasks_oauth_connection", {
        ...(connection.expectedGeneration ? { p_expected_generation: connection.expectedGeneration } : {}),
        p_service: connection.service,
        p_google_subject: connection.googleSubject,
        p_granted_scopes: [...connection.grantedScopes],
        p_refresh_token_ciphertext: encrypted.ciphertext.toString("base64"),
        p_refresh_token_iv: encrypted.iv.toString("base64"),
        p_refresh_token_tag: encrypted.tag.toString("base64"),
        p_key_version: input.keyVersion,
      });
    },
    async getConnectionForOwner({ ownerId, service }) {
      const value = await invoke(ownerId, "get_google_calendar_tasks_oauth_connection", { p_service: service });
      return parseConnection(value, input.key, input.keyVersion, ownerId, service);
    },
    async clearConnection({ ownerId, service }) {
      await invoke(ownerId, "clear_google_calendar_tasks_oauth_connection", { p_service: service });
    },
  };
}

function parseConnection(
  value: unknown,
  key: Buffer,
  keyVersion: string,
  ownerId: string,
  service: "calendar" | "tasks",
): { ownerId: string; service: "calendar" | "tasks"; googleSubject: string; grantedScopes: readonly string[]; refreshToken: Buffer ; generation?: string } | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google OAuth repository unavailable");
  const item = value as Record<string, unknown>;
  const expected = "googleSubject,grantedScopes,keyVersion,refreshTokenCiphertext,refreshTokenIv,refreshTokenTag";
  if (Object.keys(item).filter(key => key !== "generation").sort().join(",") !== expected || typeof item.googleSubject !== "string" || !Array.isArray(item.grantedScopes)
    || item.grantedScopes.some((scope) => typeof scope !== "string") || typeof item.refreshTokenCiphertext !== "string"
    || typeof item.refreshTokenIv !== "string" || typeof item.refreshTokenTag !== "string" || typeof item.keyVersion !== "string"
    || item.keyVersion !== keyVersion) throw new Error("Google OAuth repository unavailable");
  return {
    ...(typeof item.generation === "string" ? { generation: item.generation } : {}),
    ownerId,
    service,
    googleSubject: item.googleSubject,
    grantedScopes: item.grantedScopes,
    refreshToken: decrypt(key, item.refreshTokenCiphertext, item.refreshTokenIv, item.refreshTokenTag),
  };
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("Invalid Google OAuth key");
}

function encrypt(key: Buffer, plaintext: Buffer, randomBytes: (size: number) => Buffer): Encrypted {
  const iv = randomBytes(12);
  if (iv.length !== 12) throw new Error("Invalid Google OAuth IV");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return {
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    iv,
    tag: cipher.getAuthTag(),
  };
}

function decrypt(key: Buffer, ciphertext: string, iv: string, tag: string): Buffer {
  try {
    const decodedCiphertext = Buffer.from(ciphertext, "base64");
    const decodedIv = Buffer.from(iv, "base64");
    const decodedTag = Buffer.from(tag, "base64");
    if (decodedIv.length !== 12 || decodedTag.length !== 16 || decodedCiphertext.length === 0) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, decodedIv);
    decipher.setAuthTag(decodedTag);
    return Buffer.concat([decipher.update(decodedCiphertext), decipher.final()]);
  } catch {
    throw new Error("Google OAuth repository unavailable");
  }
}

function parseAttempt(value: unknown, key: Buffer): Parameters<GoogleCalendarTasksOAuthRepository["createAttempt"]>[0] | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Google OAuth repository unavailable");
  const item = value as Record<string, unknown>;
  if (
    item.ownerId === undefined || (item.service !== "calendar" && item.service !== "tasks")
    || typeof item.stateHash !== "string" || typeof item.nonceHash !== "string" || typeof item.expiresAt !== "string"
    || typeof item.codeVerifierCiphertext !== "string" || typeof item.codeVerifierIv !== "string" || typeof item.codeVerifierTag !== "string"
    || Object.keys(item).filter(key => key !== "purpose" && key !== "connectionGeneration").sort().join(",") !== "codeVerifierCiphertext,codeVerifierIv,codeVerifierTag,expiresAt,nonceHash,ownerId,service,stateHash"
  ) throw new Error("Google OAuth repository unavailable");
  if (item.purpose !== undefined && item.purpose !== "read" && item.purpose !== "write") throw new Error("Google OAuth repository unavailable");
  if (typeof item.ownerId !== "string" || item.ownerId.length === 0 || !Number.isFinite(Date.parse(item.expiresAt))) throw new Error("Google OAuth repository unavailable");
  return {
    ...(typeof item.connectionGeneration === "string" ? { connectionGeneration: item.connectionGeneration } : {}),
    ...(item.purpose === "write" ? { purpose: "write" as const } : {}),
    ownerId: item.ownerId,
    service: item.service,
    stateHash: item.stateHash,
    nonceHash: item.nonceHash,
    codeVerifier: decrypt(key, item.codeVerifierCiphertext, item.codeVerifierIv, item.codeVerifierTag),
    expiresAt: item.expiresAt,
    consumed: true,
  };
}
