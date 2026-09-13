import type { MemoryCandidate, MemoryRecord } from "../../../packages/domain/src/index.js";
import type { MemoryRepository } from "../src/db.js";
import type { RequestUser } from "../src/request-user.js";

export function confirmTestMemory(
  repository: MemoryRepository,
  user: RequestUser,
  candidate: MemoryCandidate,
): Promise<MemoryRecord> {
  return repository.create(user, {
    kind: candidate.kind === "ongoing" ? "routine" : candidate.kind,
    scope: "shared",
    content: candidate.content,
    origin: "explicit",
    sensitivity: "normal",
    importance: candidate.importance,
    sourceMessageId: null,
    sourceOccurredAt: null,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    pinned: true,
    supersedesId: null,
  });
}
