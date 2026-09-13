import { describe, expect, it, vi } from "vitest";
import { createSupabaseGoogleCalendarTasksOAuthRepository } from "../src/google-oauth-hosted-repository";

const ownerId = "00000000-0000-0000-0000-00000000000a";

describe("hosted Google OAuth repository", () => {
  it("encrypts a verifier before passing it to the server-only attempt RPC", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const repository = createSupabaseGoogleCalendarTasksOAuthRepository({
      rpcForOwner: (requestedOwnerId) => {
        expect(requestedOwnerId).toBe(ownerId);
        return { rpc };
      },
      key: Buffer.alloc(32, 4),
      keyVersion: "r1",
      randomBytes: () => Buffer.alloc(12, 7),
    });

    await repository.createAttempt({
      ownerId,
      service: "calendar",
      stateHash: `sha256:${"a".repeat(64)}`,
      nonceHash: `sha256:${"b".repeat(64)}`,
      codeVerifier: Buffer.from("verifier", "utf8"),
      expiresAt: "2026-08-28T12:00:00.000Z",
      consumed: false,
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("create_google_calendar_tasks_oauth_attempt");
    expect(args).toMatchObject({ p_service: "calendar", p_key_version: "r1" });
    expect(args).not.toHaveProperty("p_owner_id");
    expect(args.p_code_verifier_ciphertext).not.toBe(Buffer.from("verifier", "utf8").toString("base64"));
    expect(args.p_code_verifier_iv).toBe(Buffer.alloc(12, 7).toString("base64"));
  });
});
