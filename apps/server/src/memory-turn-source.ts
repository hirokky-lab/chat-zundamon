import { isReferentialExternalMemoryRequest, type TranscriptTurn } from "../../../packages/domain/src/index.js";
import type { ChatStateRepository } from "./chat-state-routes.js";
import type { RequestUser } from "./request-user.js";

export type AutomaticMemoryTurn = TranscriptTurn & { provenance: "context" | "authoritative_source" };
export type AutomaticMemorySourceResult = AutomaticMemoryTurn[] | "not_found" | "not_eligible";

function previousUserMessageIndex(timeline: readonly { type: string; role?: string }[], before: number): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item?.type === "message" && item.role === "user") return index;
  }
  return -1;
}

export class AuthoritativeMemoryTurnSource {
  constructor(private readonly repository: Pick<ChatStateRepository, "get">) {}

  async load(user: RequestUser, input: { sourceMessageId: string; sourceOccurredAt: string }): Promise<AutomaticMemorySourceResult> {
    const snapshot = await this.repository.get(user);
    if (!snapshot) return "not_found";
    const sourceIndex = snapshot.timeline.findIndex((item) => item.id === input.sourceMessageId);
    if (sourceIndex < 0) return "not_found";
    const source = snapshot.timeline[sourceIndex];
    if (!source || source.type !== "message" || source.role !== "user" || source.delivery !== "sent"
      || source.createdAt !== input.sourceOccurredAt || source.flow === "profile") return "not_eligible";
    const replyGroupId = `${source.id}:assistant`;
    const groupedReplies = snapshot.timeline.flatMap((item, index) => item.type === "message" && item.role === "assistant"
      && item.replyGroupId === replyGroupId ? [{ item, index }] : []);
    const nextUserIndex = snapshot.timeline.findIndex((item, index) => index > sourceIndex && (item.type === "photo" || (item.type === "message" && item.role === "user")));
    if (groupedReplies.length < 1 || groupedReplies.some(({ item, index }) => item.delivery !== "sent" || item.origin === "photo_analysis"
      || index <= sourceIndex || (nextUserIndex >= 0 && index >= nextUserIndex))) return "not_eligible";
    const replyIndexes = groupedReplies.map(({ index }) => index);
    const replies = replyIndexes.map((index) => snapshot.timeline[index] as Extract<typeof snapshot.timeline[number], { type: "message"; role: "assistant" }>);
    if (replies.some((reply, index) => reply.sequence !== index) || replies.some((reply) => Boolean(reply.search) || reply.flow === "external_context")) return "not_eligible";
    const previousUserIndex = previousUserMessageIndex(snapshot.timeline, sourceIndex);
    const followsExternalContext = previousUserIndex >= 0 && snapshot.timeline.some((item, index) => (
      index > previousUserIndex && index < sourceIndex && item.type === "message" && item.role === "assistant"
      && item.delivery === "sent" && item.replyGroupId === `${snapshot.timeline[previousUserIndex]!.id}:assistant`
      && item.flow === "external_context"
    ));
    if (followsExternalContext && isReferentialExternalMemoryRequest(source.text)) return "not_eligible";
    const endIndex = Math.max(...replyIndexes);
    const searchSourceIds = new Set(snapshot.timeline.flatMap((item) => item.type === "message" && item.role === "assistant" && item.search && item.replyGroupId
      ? [item.replyGroupId.replace(/:assistant$/u, "")] : []));
    const externalSourceIds = new Set(snapshot.timeline.flatMap((item) => item.type === "message" && item.role === "assistant" && item.flow === "external_context" && item.replyGroupId
      ? [item.replyGroupId.replace(/:assistant$/u, "")] : []));
    for (const [index, item] of snapshot.timeline.entries()) {
      if (item.type !== "message" || item.role !== "user" || !isReferentialExternalMemoryRequest(item.text)) continue;
      const previousIndex = previousUserMessageIndex(snapshot.timeline, index);
      if (previousIndex >= 0 && externalSourceIds.has(snapshot.timeline[previousIndex]!.id)) externalSourceIds.add(item.id);
    }
    const eligible = snapshot.timeline.slice(0, endIndex + 1).filter((item): item is Extract<typeof item, { type: "message" }> => (
      item.type === "message" && item.delivery === "sent" && item.flow !== "profile"
      && (!("origin" in item) || item.origin !== "photo_analysis")
      && (item.role === "user"
        ? !searchSourceIds.has(item.id) && !externalSourceIds.has(item.id)
        : !item.replyGroupId || (!searchSourceIds.has(item.replyGroupId.replace(/:assistant$/u, "")) && !externalSourceIds.has(item.replyGroupId.replace(/:assistant$/u, ""))))
    ));
    return eligible.slice(-12).map((item) => ({
      role: item.role,
      text: item.text,
      provenance: item.id === source.id ? "authoritative_source" : "context",
    }));
  }
}
