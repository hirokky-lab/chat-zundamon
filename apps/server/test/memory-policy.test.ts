import { describe, expect, it, vi } from "vitest";
import type { MemoryCandidateProposal, MemoryCandidateV2, MemoryRecord, MemoryWriteTrust } from "../../../packages/domain/src/memory.js";
import {
  applyMemoryAction,
  classifySensitivity,
  containsForbiddenSecret,
  defaultExpiry,
  isTombstoneContentMatch,
  validateMemoryAction,
} from "../src/memory-policy.js";
import { memoryActionSchema } from "../src/memory-schema.js";

const occurredAt = "2026-08-11T00:00:00.000Z";

function proposal(overrides: Partial<MemoryCandidateProposal> = {}): MemoryCandidateProposal {
  return {
    kind: "event",
    scope: "daily",
    content: "友達と昼食を食べた",
    importance: 2,
    sourceOccurredAt: null,
    validFrom: null,
    validUntil: null,
    retention: "light",
    ...overrides,
  };
}

const automaticTrust: MemoryWriteTrust = {
  origin: "extracted",
  pinned: false,
  sourceMessageId: "message-1",
  sourceOccurredAt: occurredAt,
  scheduleOccurredAt: occurredAt,
  serverNow: occurredAt,
};

function candidate(overrides: Partial<MemoryCandidateV2> = {}): MemoryCandidateV2 {
  return {
    ...proposal(),
    origin: "extracted",
    sensitivity: "normal",
    sourceMessageId: "message-1",
    expiresAt: null,
    pinned: false,
    supersedesId: null,
    ...overrides,
  };
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    ...candidate(),
    normalizedContent: "友達と昼食を食べた",
    status: "active",
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...overrides,
  };
}

describe("memory policy", () => {
  it.each([
    "パスワードは hunter2",
    "APIキーは sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "認証コードは 123456",
    "パスワードは a$b%c&d",
    "password hunter2",
    "password is hunter2",
    "password was a$b%c&d",
    "password changed to hunter2",
    "password is changed to hunter2",
    "password was reset to a$b%c&d",
    "password was changed as hunter2",
    "パスワードは変更済み に hunter2",
    "password = hunter2",
    "password : a$b%c&d",
    "PIN = 1234",
    "パスワード は hunter2",
    "パスワード、hunter2",
    "パスワードって hunter2",
    "パスワードの値は hunter2",
    "パスワードについては hunter2",
    "パスワード？ hunter2",
    "パスワードの内容は hunter2",
    "パスワード\n（hunter2）",
    "パスワードについては『hunter2』",
    "パスワードとして hunter2",
    "パスワードには hunter2",
    "パスワードは sunshine",
    "ＰＡＳＳＷＯＲＤとして\n『sunshine』",
    "passcode is sunshine",
    "SECRET KEY is sunshine",
    "OTP is sunshine",
    "credit cardについて相談した",
    "API token is sunshine",
    "client secret is sunshine",
    "refresh token is sunshine",
    "verification code is sunshine",
    "session-token is sunshine",
    "bearer token is sunshine",
    "authentication credential is sunshine",
    "bank authentication code is sunshine",
    "seed phrase is apple river moon",
    "recovery phrase is apple river moon",
    "CVV is 123",
    "CVC is 123",
    "card security code is 123",
    "TOTP is 123456",
    "APIトークンは sunshine",
    "シークレットキーは sunshine",
    "アクセストークンは sunshine",
    "リフレッシュトークンは sunshine",
    "検証コードは sunshine",
    "カードセキュリティコードは 123",
    "シードフレーズは apple river moon",
    "復旧フレーズは apple river moon",
    "2FA code is 123456",
    "MFA token is sunshine",
    "2FAコードは123456",
    "MFAトークンは sunshine",
    "バックアップコードは123456",
    "２ｆａ＿ＣＯＤＥ is 123456",
    "mFa/token is sunshine",
    "BACKUP-CODE is 123456",
    "back-up code is 123456",
    "back up code is 123456",
    "confirmation code is 123456",
    "login code is 123456",
    "sign-in code is 123456",
    "sign in code is 123456",
    "authenticator code is 123456",
    "SMS code is 123456",
    "email code is 123456",
    "text message code is 123456",
    "one-time login code is 123456",
    "ＳＭＳ＿ＣＯＤＥ is 123456",
    "確認コードは123456",
    "ログインコードは123456",
    "サインインコードは123456",
    "認証アプリコードは123456",
    "SMSコードは123456",
    "本人確認コードは123456",
    "メール認証コードは123456",
    "ワンタイムコードは123456",
    "『確認コードという言葉』は123456",
    "パスワードは「hunter2」",
    "パスワード：『a$b%c&d』",
    "認証コードが 123456",
    "PINコードを 1234",
    "カード番号は 4111 1111 1111 1111",
    "暗証番号は 1234",
    "sk-abcdefghijklmnopq",
    "QmFzZTY0U2VjcmV0KysvPQ==",
    "cG9ydGFibGUtY3JlZGVudGlhbC0xMjM0NTY3ODkw",
  ])("rejects forbidden secret: %s", (content) => {
    expect(containsForbiddenSecret(content)).toBe(true);
  });

  it.each([
    "password = hunter2",
    "password changed to hunter2",
    "password is changed to hunter2",
    "password was reset to a$b%c&d",
    "password was changed as hunter2",
    "パスワードは変更済み に hunter2",
  ])("returns only a safe reason when rejecting credential content", (content) => {
    const result = validateMemoryAction({
      action: { type: "add", candidate: proposal({ content }) },
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: automaticTrust,
    });

    expect(result).toEqual({ ok: false, reason: "forbidden_secret" });
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it("does not reject general banking or order text", () => {
    expect(containsForbiddenSecret("銀行振込は明日にする")).toBe(false);
    expect(containsForbiddenSecret("注文番号は 1234567890123456")).toBe(false);
  });

  it("does not treat ordinary words or clear substrings as credential labels", () => {
    expect(containsForbiddenSecret("合言葉を考える")).toBe(false);
    expect(containsForbiddenSecret("暗号技術について相談した")).toBe(false);
    expect(containsForbiddenSecret("spinning class に通う")).toBe(false);
    expect(containsForbiddenSecret("pineapple が好き")).toBe(false);
    expect(containsForbiddenSecret("private keyboard を買う")).toBe(false);
    expect(containsForbiddenSecret("passwordless login の記事を読む")).toBe(false);
    expect(containsForbiddenSecret("passcodebook という造語")).toBe(false);
    expect(containsForbiddenSecret("design token を決める")).toBe(false);
    expect(containsForbiddenSecret("source code を読む")).toBe(false);
    expect(containsForbiddenSecret("keyboard を買う")).toBe(false);
    expect(containsForbiddenSecret("tokenization を学ぶ")).toBe(false);
    expect(containsForbiddenSecret("security discussion をする")).toBe(false);
    expect(containsForbiddenSecret("デザイントークンを決める")).toBe(false);
    expect(containsForbiddenSecret("ソースコードを読む")).toBe(false);
    expect(containsForbiddenSecret("キーボードを買う")).toBe(false);
    expect(containsForbiddenSecret("トークン化を学ぶ")).toBe(false);
    expect(containsForbiddenSecret("セキュリティについて議論する")).toBe(false);
    expect(containsForbiddenSecret("backup photos を整理する")).toBe(false);
    expect(containsForbiddenSecret("backup strategy と source code を話す")).toBe(false);
    expect(containsForbiddenSecret("MFAについて相談する")).toBe(false);
    expect(containsForbiddenSecret("2FAを導入するか議論する")).toBe(false);
    expect(containsForbiddenSecret("バックアップについて相談する")).toBe(false);
    expect(containsForbiddenSecret("source code を読む")).toBe(false);
    expect(containsForbiddenSecret("status code を確認する")).toBe(false);
    expect(containsForbiddenSecret("error code を調べる")).toBe(false);
    expect(containsForbiddenSecret("dress code を決める")).toBe(false);
    expect(containsForbiddenSecret("confirmation dialog を設計する")).toBe(false);
    expect(containsForbiddenSecret("login screen を設計する")).toBe(false);
    expect(containsForbiddenSecret("SMSについて議論する")).toBe(false);
    expect(containsForbiddenSecret("code review をする")).toBe(false);
    expect(containsForbiddenSecret("『確認コードという言葉』")).toBe(false);
  });

  it.each([
    "パスワードを変更した",
    "password was forgotten",
    "PINコードについて相談した",
    "APIキー管理アプリを使う",
  ])("intentionally rejects credential-topic memory even when no value is visible: %s", (content) => {
    expect(containsForbiddenSecret(content)).toBe(true);
  });

  it("allows an explicit health fact but marks it sensitive", () => {
    expect(classifySensitivity("偏頭痛がある")).toBe("sensitive");
    expect(containsForbiddenSecret("偏頭痛がある")).toBe(false);
  });

  it.each([
    "糖尿病の治療中", "がんの検査を受ける", "貯金は百万円", "資産を相続した",
    "息子は高校生", "娘と暮らしている", "離婚について相談中",
  ])("classifies representative health, finance, and family facts as sensitive: %s", (content) => {
    expect(classifySensitivity(content)).toBe("sensitive");
  });

  it.each(["毎日がんばっている", "貯金箱を買った"])('does not overmatch representative ordinary text: %s', (content) => {
    expect(classifySensitivity(content)).toBe("normal");
  });

  it("uses the short retention period for light events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(occurredAt));
    expect(defaultExpiry(proposal({ sourceOccurredAt: null, retention: "light" }), automaticTrust)).toBe("2026-08-14T00:00:00.000Z");
    vi.useRealTimers();
  });

  it("retains dated events for 30 days and schedules for seven days after their date", () => {
    expect(defaultExpiry(proposal({ sourceOccurredAt: null, retention: "recent" }), automaticTrust)).toBe("2026-09-10T00:00:00.000Z");
    expect(defaultExpiry(proposal({ kind: "schedule", sourceOccurredAt: null, retention: null }), automaticTrust)).toBe("2026-08-18T00:00:00.000Z");
  });

  it("uses a past trusted schedule occurrence plus seven days", () => {
    expect(defaultExpiry(
      proposal({ kind: "schedule", sourceOccurredAt: "2036-08-11T00:00:00.000Z", retention: null }),
      { ...automaticTrust, scheduleOccurredAt: "2026-08-01T00:00:00.000Z" },
    )).toBe("2026-08-08T00:00:00.000Z");
  });

  it("keeps pinned and explicit memories indefinitely", () => {
    expect(defaultExpiry(proposal({ sourceOccurredAt: occurredAt, retention: "recent" }), { ...automaticTrust, pinned: true })).toBeNull();
    expect(defaultExpiry(proposal({ sourceOccurredAt: occurredAt, retention: "recent" }), { ...automaticTrust, origin: "explicit" })).toBeNull();
  });

  it("does not allow automatic candidates to forge explicit or pinned indefinite retention", () => {
    const result = validateMemoryAction({
      action: {
        type: "add",
        candidate: {
          ...proposal({ sourceOccurredAt: occurredAt, retention: "light" }),
          origin: "explicit",
          pinned: true,
          expiresAt: null,
        } as never,
      },
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: automaticTrust,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      candidate: expect.objectContaining({ origin: "extracted", pinned: false, expiresAt: "2026-08-14T00:00:00.000Z" }),
    }));
  });

  it("makes replacement targets past and marks ambiguous targets uncertain", async () => {
    const current = record();
    const conflicting = record({ id: "10000000-0000-4000-8000-000000000002" });
    const records = [current, conflicting];
    const statuses: Array<[string, string]> = [];
    const repository = {
      list: async () => records,
      replace: async (_user: unknown, id: string, next: MemoryCandidateV2) => {
        current.status = "past";
        return record({ ...next, id: "10000000-0000-4000-8000-000000000003", status: "active" });
      },
      setStatus: async (_user: unknown, id: string, status: MemoryRecord["status"]) => {
        const target = records.find((item) => item.id === id)!;
        target.status = status;
        statuses.push([id, status]);
        return target;
      },
      create: async () => record(),
      update: async () => record(),
      forget: async () => undefined,
      listActiveTombstones: async () => [],
      releaseTombstone: async () => undefined,
      getProcessing: async () => null,
      claimProcessing: async () => "claimed" as const,
      applyPreparedAction: async (_user: unknown, _sourceMessageId: string, action: { type: string; targetMemoryId?: string; targetMemoryIds?: string[] }) => {
        if (action.type === "replace" || action.type === "mark_past") current.status = "past";
        if (action.type === "mark_uncertain") {
          for (const id of action.targetMemoryIds ?? []) {
            const target = records.find((item) => item.id === id)!;
            target.status = "uncertain";
            statuses.push([id, "uncertain"]);
          }
        }
        return "applied" as const;
      },
      setProcessing: async () => undefined,
    };

    await expect(applyMemoryAction({
      user: { userId: "owner", email: "owner@example.com", accessToken: "token" },
      sourceMessageId: "message-2",
      action: { type: "replace", targetMemoryId: current.id, candidate: proposal({ content: "友達と夕食を食べた" }) },
      repository,
      allowedTargetIds: [current.id],
      trust: automaticTrust,
    })).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(current.status).toBe("past");

    await expect(applyMemoryAction({
      user: { userId: "owner", email: "owner@example.com", accessToken: "token" },
      sourceMessageId: "message-3",
      action: { type: "mark_uncertain", targetMemoryIds: [conflicting.id] },
      repository,
      allowedTargetIds: [conflicting.id],
      trust: automaticTrust,
    })).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(statuses).toContainEqual([conflicting.id, "uncertain"]);
  });

  it("does not allow an expired target to be made active again", () => {
    expect(validateMemoryAction({
      action: { type: "mark_uncertain", targetMemoryIds: ["10000000-0000-4000-8000-000000000001"] },
      records: [record({ status: "expired" })],
      tombstones: [],
      allowedTargetIds: ["10000000-0000-4000-8000-000000000001"],
      trust: automaticTrust,
    })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("blocks an automatic exact tombstone match but ignores a released tombstone", () => {
    const action = { type: "add" as const, candidate: proposal({ content: " 友達と、昼食を食べた。 " }) };
    expect(validateMemoryAction({
      action,
      records: [],
      tombstones: [{ normalizedFingerprint: "友達と昼食を食べた", releasedAt: null }],
      allowedTargetIds: [],
      trust: automaticTrust,
    })).toEqual({ ok: false, reason: "tombstoned" });
    expect(validateMemoryAction({
      action,
      records: [],
      tombstones: [{ normalizedFingerprint: "友達と昼食を食べた", releasedAt: occurredAt }],
      allowedTargetIds: [],
      trust: automaticTrust,
    })).toEqual(expect.objectContaining({ ok: true }));
  });

  it("asks for relearning confirmation instead of overriding a tombstone for an explicit remember request", () => {
    expect(validateMemoryAction({
      action: { type: "add", candidate: proposal() },
      records: [],
      tombstones: [{ normalizedFingerprint: "友達と昼食を食べた", releasedAt: null }],
      allowedTargetIds: [],
      trust: { ...automaticTrust, origin: "explicit" },
    })).toEqual({ ok: false, reason: "requires_relearning_confirmation" });
  });

  it.each([
    "昼食を友達と食べた",
    "友達と昼食を食べてきた",
    "友達と昼ご飯を食べた",
  ])("blocks a Japanese paraphrase of a tombstoned memory: %s", (content) => {
    expect(validateMemoryAction({
      action: { type: "add", candidate: proposal({ content }) },
      records: [],
      tombstones: [{ normalizedFingerprint: "友達と昼食を食べた", releasedAt: null }],
      allowedTargetIds: [],
      trust: automaticTrust,
    })).toEqual({ ok: false, reason: "tombstoned" });
  });

  it("does not block an unrelated near-match and allows a released paraphrase", () => {
    const action = { type: "add" as const, candidate: proposal({ content: "同僚と夕食を食べた" }) };
    expect(validateMemoryAction({ action, records: [], tombstones: [{ normalizedFingerprint: "友達と昼食を食べた", releasedAt: null }], allowedTargetIds: [], trust: automaticTrust })).toEqual(expect.objectContaining({ ok: true }));
    expect(validateMemoryAction({ action: { type: "add", candidate: proposal({ content: "昼食を友達と食べた" }) }, records: [], tombstones: [{ normalizedFingerprint: "友達と昼食を食べた", releasedAt: occurredAt }], allowedTargetIds: [], trust: automaticTrust })).toEqual(expect.objectContaining({ ok: true }));
  });

  it("does not treat a different explicit subject as the same tombstoned fact", () => {
    expect(isTombstoneContentMatch("妹は猫が好き", "猫が好き")).toBe(false);
  });

  it("accepts only strict v2 actions at the model boundary", () => {
    expect(memoryActionSchema.safeParse({
      type: "forget",
      targetMemoryId: "10000000-0000-4000-8000-000000000001",
      blockRelearning: true,
      extra: true,
    }).success).toBe(false);
  });

  it("rejects duplicate uncertain-memory targets at the model boundary", () => {
    expect(memoryActionSchema.safeParse({
      type: "mark_uncertain",
      targetMemoryIds: ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000001"],
    }).success).toBe(false);
  });

  it("fails closed when a caller bypasses the parser with duplicate uncertain-memory targets", () => {
    const current = record();
    expect(validateMemoryAction({
      action: { type: "mark_uncertain", targetMemoryIds: [current.id, current.id] },
      records: [current],
      tombstones: [],
      allowedTargetIds: [current.id],
      trust: automaticTrust,
    })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("rejects model supplied authority fields at the action boundary", () => {
    expect(memoryActionSchema.safeParse({
      type: "add",
      candidate: {
        ...proposal(),
        origin: "explicit",
        pinned: true,
        expiresAt: null,
      },
    }).success).toBe(false);
  });

  it("accepts a retention-tagged proposal without server authority fields", () => {
    expect(memoryActionSchema.safeParse({
      type: "add",
      candidate: proposal(),
    }).success).toBe(true);
  });

  it("rejects event proposals without a retention category at the model boundary", () => {
    expect(memoryActionSchema.safeParse({
      type: "add",
      candidate: proposal({ retention: null }),
    }).success).toBe(false);
  });

  it("fails closed for an event without retention when a caller bypasses the schema", () => {
    expect(validateMemoryAction({
      action: { type: "add", candidate: proposal({ retention: null }) },
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: automaticTrust,
    })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("uses the trusted occurrence time instead of a model-proposed future timestamp", () => {
    expect(validateMemoryAction({
      action: { type: "add", candidate: proposal({ retention: "recent", sourceOccurredAt: "2036-08-11T00:00:00.000Z" }) },
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: automaticTrust,
    })).toEqual(expect.objectContaining({
      ok: true,
      candidate: expect.objectContaining({
        sourceOccurredAt: occurredAt,
        expiresAt: "2026-09-10T00:00:00.000Z",
      }),
    }));
  });

  it("clamps a future trusted event source to serverNow", () => {
    expect(validateMemoryAction({
      action: { type: "add", candidate: proposal({ retention: "recent" }) },
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: { ...automaticTrust, sourceOccurredAt: "2026-09-11T00:00:00.000Z" },
    })).toEqual(expect.objectContaining({
      ok: true,
      candidate: expect.objectContaining({
        sourceOccurredAt: occurredAt,
        expiresAt: "2026-09-10T00:00:00.000Z",
      }),
    }));
  });

  it("requires a trusted schedule occurrence and rejects extreme anchors", () => {
    const action = { type: "add" as const, candidate: proposal({ kind: "schedule", retention: null }) };
    expect(validateMemoryAction({
      action,
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: { ...automaticTrust, scheduleOccurredAt: null },
    })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(validateMemoryAction({
      action,
      records: [],
      tombstones: [],
      allowedTargetIds: [],
      trust: { ...automaticTrust, scheduleOccurredAt: "1900-01-01T00:00:00.000Z" },
    })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("rejects a known but unpresented target id", () => {
    expect(validateMemoryAction({
      action: { type: "forget", targetMemoryId: "10000000-0000-4000-8000-000000000001", blockRelearning: false },
      records: [record()],
      tombstones: [],
      allowedTargetIds: [],
      trust: automaticTrust,
    })).toEqual({ ok: false, reason: "unknown_target" });
  });

  it("fails closed when a caller bypasses the required tombstone collection", () => {
    expect(validateMemoryAction({
      action: { type: "add", candidate: proposal() },
      records: [],
      allowedTargetIds: [],
      trust: automaticTrust,
    } as never)).toEqual({ ok: false, reason: "invalid_transition" });
  });
});
