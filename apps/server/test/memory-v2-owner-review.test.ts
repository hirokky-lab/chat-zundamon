import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "../src/db.js";
import { createMemoryRetriever } from "../src/memory-retriever.js";
import { LOCAL_USER } from "../src/request-user.js";

const candidate = {
  kind: "preference" as const,
  scope: "daily" as const,
  content: "私は偏頭痛がある",
  origin: "extracted" as const,
  sensitivity: "sensitive" as const,
  importance: 3 as const,
  sourceMessageId: "owner-review-source",
  sourceOccurredAt: "2026-08-20T00:00:00.000Z",
  validFrom: null,
  validUntil: null,
  expiresAt: null,
  pinned: false,
  supersedesId: null,
};

describe("memory-v2 owner review boundary", () => {
  it("keeps an extracted sensitive candidate out of recall until the owner keeps it once", async () => {
    const repository = createMemoryRepository(":memory:");
    const pending = await repository.create(LOCAL_USER, candidate);

    expect(pending).toMatchObject({ reviewState: "needs_review", ownerReviewedAt: null });
    await expect(repository.listForRecall(LOCAL_USER)).resolves.toEqual([]);
    const retriever = createMemoryRetriever({ repository });
    await expect(retriever.retrieve(LOCAL_USER, {
      text: "偏頭痛について", now: "2026-08-20T01:00:00.000Z", scope: "daily", relatedNames: [],
    })).resolves.toEqual([]);

    const first = await repository.keep(LOCAL_USER, pending.id);
    const second = await repository.keep(LOCAL_USER, pending.id);
    expect(first).toMatchObject({ id: pending.id, reviewState: "eligible", ownerReviewedAt: expect.any(String) });
    expect(second.ownerReviewedAt).toBe(first.ownerReviewedAt);
    await expect(repository.listForRecall(LOCAL_USER)).resolves.toEqual([expect.objectContaining({ id: pending.id })]);
  });

  it("does not let a different owner confirm the pending candidate", async () => {
    const repository = createMemoryRepository(":memory:");
    const pending = await repository.create(LOCAL_USER, candidate);
    const otherOwner = { userId: "00000000-0000-0000-0000-000000000002", email: "other@yui.invalid", accessToken: "other-local" };

    await expect(repository.keep(otherOwner, pending.id)).rejects.toThrow();
    await expect(repository.listForRecall(LOCAL_USER)).resolves.toEqual([]);
    await expect(repository.listForRecall(otherOwner)).resolves.toEqual([]);
  });
});
