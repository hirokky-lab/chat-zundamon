import { parseLifeCard, type LifeCard } from './life-card.js';
import { formatAddressedName, type AddressingStyle, type Profile } from "./profile.js";
import type { MemoryAction, MemoryCandidateProposal } from "./memory.js";

export const CHAT_CONTEXT_TURN_LIMIT = 30;
export const CHAT_DICTATION_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_DICTATION_MAX_MS = 60_000;

export type ChatDictationMimeType = "audio/webm" | "audio/mp4";

type ChatMessageBase = {
  id: string;
  type: "message";
  text: string;
  createdAt: string;
  delivery: "sending" | "sent" | "failed";
  /** Profile setup and external context are never extractable conversation turns. */
  flow?: "conversation" | "profile" | "external_context";
};

export type ChatMessage =
  | (ChatMessageBase & { role: "user" })
  | (ChatMessageBase & {
    role: "assistant";
    replyGroupId?: string;
    sequence?: 0 | 1 | 2;
    search?: WebSearchMetadata;
  lifeCard?: LifeCard;
  } & (
    | { origin?: never; sourcePhotoMessageId?: never }
    | { origin: "photo_analysis"; sourcePhotoMessageId: string }
  ));

export type PhotoMessage = {
  id: string;
  type: "photo";
  role: "user";
  photoId: string;
  caption: string;
  origin: "photo";
  createdAt: string;
  delivery: "sending" | "sent" | "failed";
};

export type WebSearchMetadata =
  | {
      status: "completed";
      searchedAt: string;
      sources: Array<{ title: string; url: string }>;
      evidence: WebSearchEvidence;
    }
  | {
      status: "failed";
      searchedAt: string;
      sources: [];
    };

export type WebSearchEvidence = {
  facts: Array<{ text: string; sourceUrl: string }>;
  inference: string | null;
  suggestion: string | null;
};

export interface ChatReplyBubble {
  id: string;
  text: string;
  createdAt: string;
  sequence: 0 | 1 | 2;
  flow?: "external_context";
}

export interface ChatReply {
  replyGroupId: string;
  bubbles: ChatReplyBubble[];
  profile?: Profile;
  search?: WebSearchMetadata;
  lifeCard?: LifeCard;
}

export interface ChatProfileProposal {
  displayName: string | null;
  addressingStyle: AddressingStyle | null;
}

export interface ParsedChatResponse {
  reply: ChatReply;
  profileUpdate: ChatProfileProposal | null;
  memoryAction: MemoryAction | null;
}

const controlCharacter = /[\p{Cc}\p{Cf}]/u;
const japaneseCharacter = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const CHAT_REPLY_MAX_BUBBLES = 3;
const CHAT_REPLY_MAX_BUBBLE_LENGTH = 400;
const CHAT_REPLY_MAX_TOTAL_LENGTH = 800;
const explicitWebSearchIntents = [
  /(?:検索|ググ)(?:して|してください|してほしい|してくれる|をお願い)[。！？!?]?$/u,
  /(?:調べて|調査して)(?:ください|ほしい|くれる|もらえる|お願い)?[。！？!?]?$/u,
  /(?:ウェブ|web|ネット|オンライン)(?:で|を)?.{0,16}(?:検索|調べ|確認|見て)(?:して|してください|て|ください|ほしい|お願い)?[。！？!?]?$/iu,
  /(?:最新|いま|今|現在|今日|ニュース).{0,16}(?:検索|調べ|確認)(?:して|してください|て|ください|ほしい|お願い)?[。！？!?]?$/u,
  /\b(?:search the web|look (?:it |this )?up|check online)\b/iu,
] as const;

export type WebSearchAdmission = {
  query: string;
  reason: "explicit" | "freshness" | "source_request";
  highStakes: boolean;
};

const searchExclusions = /(?:パスワード|password|api(?:[ _-]?key|キー)|トークン|token|認証|otp|秘密|住所|電話番号|メール(?:アドレス)?|連絡先|郵便番号|口座|自宅|生年月日|マイナンバー|添付|画像|写真|ファイル|記憶|覚えて(?:いる|た)?(?:内容)?|友(?:人|達|だち)|同僚|家族|妻|夫|配偶者|上司|彼(?:女)?|第三者|(?:私|わたし|僕|ぼく|俺|おれ|自分|うち|我が家)(?:の|は|が)|(?:勤務先|職場|勤め先|仕事先)|(?:[A-ZＡ-Ｚ][A-Za-zＡ-Ｚａ-ｚ0-9０-９]*|[\p{Script=Han}]{1,6})社(?:で)?(?:働|勤)|(?:働|勤)いて(?:い|いま|ま|る)|[\p{Script=Han}]{2,4}(?:さん|氏|先生|君|ちゃん)|https?:\/\/|www\.|個人的な相談|疲れた|静かに|ここまで|終わり|眠い|どうだった|最近どう|元気)/iu;
const referentialSearchTopic = /^(?:これ|それ|あれ|この(?:こと|内容)?|その(?:こと|内容)?|あの(?:こと|内容)?)(?:を|の|について)?$/u;
const personalSearchContext = /(?:(?:私|わたし|僕|ぼく|俺|おれ|自分)自身|(?:私|わたし|僕|ぼく|俺|おれ|自分|うち|我が家)(?:の|は|が|を|に|と|も)|(?:勤務先|職場|勤め先|仕事先)|勤め(?:る|て|てい|ます)|働(?:く|いて|いてい|き)|\b(?:i|me|my|mine|myself|we|us|our|ours|employer|work(?:ing)?\s+at|friend|colleague|family|wife|husband|spouse|boss|manager)\b)/iu;
const embeddedSearchContext = /[。.!?！？]\s*\S/u;
const freshnessIntent = /(?:最新|いま|今|現在|今日|ニュース|速報|株価|為替|天気|価格|相場)/u;
const sourceIntent = /(?:出典|根拠|ソース|引用|公式(?:発表|資料)?)/u;
const officialSourceCheckIntent = /公式情報から.{1,100}(?:確認|調べ|検索)(?:して|してください|て|ください|ほしい|お願い)?[。！？!?]?$/u;
const currentInformationQuestion = /(?:[？?]|誰|いつ|どこ|いくら|何|教えて|知りたい|について)/u;
const searchDirectiveAtEnd = /(?:を)?(?:検索|ググ|調べ|調査|確認|探して|見て)(?:して|してください|してほしい|してくれる|をお願い|ください|ほしい|くれる|もらえる|お願い|て)?[。！？!?]?$/u;
const highStakesIntent = /(?:医療|病気|薬|診断|法律|法的|訴訟|税(?:金)?|投資|株(?:価)?|金融|ローン|保険)/u;
const WEB_SEARCH_QUERY_MAX_LENGTH = 120;

const referentialExternalMemoryRequest = /^(?:これ|それ|あれ|この(?:内容|予定|タスク)?|その(?:内容|予定|タスク)?|あの(?:内容|予定|タスク)?)(?:を)?(?:覚えて|記憶して|保存して)(?:おいて|ください|ほしい)?[。！？!?]?$/u;

export function isReferentialExternalMemoryRequest(value: string): boolean {
  return referentialExternalMemoryRequest.test(value.trim());
}

/**
 * Returns the single, scrubbed search topic that may cross the external-search
 * boundary. A missing classification is intentionally not a search request.
 */
export function prepareWebSearch(text: string): WebSearchAdmission | null {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > WEB_SEARCH_QUERY_MAX_LENGTH || searchExclusions.test(normalized) || personalSearchContext.test(normalized) || embeddedSearchContext.test(normalized)) return null;

  const explicit = explicitWebSearchIntents.some((pattern) => pattern.test(normalized));
  const sourceRequested = (sourceIntent.test(normalized) && currentInformationQuestion.test(normalized))
    || officialSourceCheckIntent.test(normalized);
  const freshnessRequested = freshnessIntent.test(normalized) && currentInformationQuestion.test(normalized);
  if (!explicit && !sourceRequested && !freshnessRequested) return null;

  const query = normalized
    .replace(/^(?:ウェブ|web|ネット|オンライン)(?:で|を)?\s*/iu, "")
    .replace(/\b(?:search the web for|look (?:it |this )?up|check online)\b/iu, "")
    .replace(searchDirectiveAtEnd, "")
    .replace(/[。！？!?]+$/u, "")
    .trim();
  if (!query || query.length > WEB_SEARCH_QUERY_MAX_LENGTH || searchExclusions.test(query) || personalSearchContext.test(query) || referentialSearchTopic.test(query)) return null;

  return {
    query,
    reason: explicit ? "explicit" : sourceRequested ? "source_request" : "freshness",
    highStakes: highStakesIntent.test(query),
  };
}

export function shouldUseWebSearch(text: string): boolean {
  return prepareWebSearch(text) !== null;
}

function cleanBubbleText(text: string): string {
  if (text.endsWith("。")) return text.slice(0, -1);
  if (
    text.endsWith(".") &&
    !text.endsWith("...") &&
    !/(?:https?:\/\/|www\.)\S+$/u.test(text) &&
    !/^`[^`]*`$/u.test(text)
  ) {
    return text.slice(0, -1);
  }
  return text;
}

export function normalizeConversationalBubbles(texts: string[]): string[] {
  if (texts.length !== 1 || texts[0].length <= 72) return texts;

  const [text] = texts;
  if (/^(?:https?:\/\/|www\.)\S+$/u.test(text) || /^`[^`]*`$/u.test(text)) return texts;

  const boundaries = [...text.matchAll(/[。！？!?]/gu)]
    .map((match) => (match.index ?? 0) + match[0].length);
  let threeWayBoundaries: [number, number] | null = null;
  let smallestImbalance = Number.POSITIVE_INFINITY;
  for (const firstBoundary of boundaries) {
    for (const secondBoundary of boundaries) {
      if (secondBoundary <= firstBoundary) continue;

      const segmentLengths = [
        firstBoundary,
        secondBoundary - firstBoundary,
        text.length - secondBoundary,
      ];
      if (segmentLengths.some((length) => length < 24)) continue;

      const imbalance = Math.max(...segmentLengths) - Math.min(...segmentLengths);
      if (imbalance < smallestImbalance) {
        threeWayBoundaries = [firstBoundary, secondBoundary];
        smallestImbalance = imbalance;
      }
    }
  }
  if (threeWayBoundaries) {
    const [firstBoundary, secondBoundary] = threeWayBoundaries;
    return [
      cleanBubbleText(text.slice(0, firstBoundary)),
      cleanBubbleText(text.slice(firstBoundary, secondBoundary)),
      cleanBubbleText(text.slice(secondBoundary)),
    ];
  }

  const midpoint = text.length / 2;
  const twoWayBoundaries = boundaries
    .filter((boundary) => boundary >= 24 && text.length - boundary >= 24);
  const boundary = twoWayBoundaries.reduce<number | null>((nearest, candidate) => {
    if (nearest === null || Math.abs(candidate - midpoint) < Math.abs(nearest - midpoint)) {
      return candidate;
    }
    return nearest;
  }, null);

  if (boundary === null) return texts;
  return [cleanBubbleText(text.slice(0, boundary)), cleanBubbleText(text.slice(boundary))];
}

function validateBubbleTexts(bubbles: unknown): string[] {
  if (!Array.isArray(bubbles) || bubbles.length < 1 || bubbles.length > CHAT_REPLY_MAX_BUBBLES) {
    throw new Error("Chat replies must contain one to three bubbles.");
  }
  if (bubbles.some((bubble) => typeof bubble !== "string")) {
    throw new Error("Chat reply bubbles must be strings.");
  }

  const texts = bubbles.map(cleanBubbleText);
  if (texts.some((text) => !text.trim() || controlCharacter.test(text) || text.length > CHAT_REPLY_MAX_BUBBLE_LENGTH)) {
    throw new Error("Chat reply bubbles must contain safe text up to 400 characters.");
  }
  if (texts.reduce((total, text) => total + text.length, 0) > CHAT_REPLY_MAX_TOTAL_LENGTH) {
    throw new Error("Chat reply text must not exceed 800 characters.");
  }
  return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const memoryKinds = new Set(["preference", "person", "routine", "work", "event", "schedule", "shared"]);
const memoryScopes = new Set(["daily", "work", "shared"]);
const importanceValues = new Set([1, 2, 3, 4, 5]);
const actionTypes = new Set(["add", "replace", "mark_past", "mark_uncertain", "forget"]);
const memoryId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isTimestampOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(new Date(value).getTime()));
}

function parseMemoryCandidateProposal(value: unknown): MemoryCandidateProposal {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["kind", "scope", "content", "importance", "sourceOccurredAt", "validFrom", "validUntil", "retention"])
    || typeof value.kind !== "string"
    || !memoryKinds.has(value.kind)
    || typeof value.scope !== "string"
    || !memoryScopes.has(value.scope)
    || typeof value.content !== "string"
    || !value.content.trim()
    || value.content.length > 200
    || controlCharacter.test(value.content)
    || typeof value.importance !== "number"
    || !importanceValues.has(value.importance)
    || !isTimestampOrNull(value.sourceOccurredAt)
    || !isTimestampOrNull(value.validFrom)
    || !isTimestampOrNull(value.validUntil)
    || !["light", "recent", null].includes(value.retention as "light" | "recent" | null)
    || (value.kind === "event" && value.retention === null)
  ) throw new Error("Chat memory candidate must be a strict proposal.");

  return value as MemoryCandidateProposal;
}

function parseMemoryAction(value: unknown, allowedTargetIds?: readonly string[]): MemoryAction {
  if (!isRecord(value) || typeof value.type !== "string" || !actionTypes.has(value.type)) {
    throw new Error("Chat memory action must be a strict action.");
  }
  const validateTarget = (targetMemoryId: unknown): string => {
    if (typeof targetMemoryId !== "string" || !memoryId.test(targetMemoryId)) {
      throw new Error("Chat memory action target must be a UUID.");
    }
    if (allowedTargetIds && !allowedTargetIds.includes(targetMemoryId)) {
      throw new Error("Chat memory action target was not presented to the model.");
    }
    return targetMemoryId;
  };

  if (value.type === "add" && hasExactKeys(value, ["type", "candidate"])) {
    return { type: "add", candidate: parseMemoryCandidateProposal(value.candidate) };
  }
  if (value.type === "replace" && hasExactKeys(value, ["type", "targetMemoryId", "candidate"])) {
    return {
      type: "replace",
      targetMemoryId: validateTarget(value.targetMemoryId),
      candidate: parseMemoryCandidateProposal(value.candidate),
    };
  }
  if (value.type === "mark_past" && (hasExactKeys(value, ["type", "targetMemoryId"]) || hasExactKeys(value, ["type", "targetMemoryId", "replacement"]))) {
    return {
      type: "mark_past",
      targetMemoryId: validateTarget(value.targetMemoryId),
      ...(Object.hasOwn(value, "replacement") && value.replacement !== null
        ? { replacement: parseMemoryCandidateProposal(value.replacement) }
        : {}),
    };
  }
  if (value.type === "mark_uncertain" && hasExactKeys(value, ["type", "targetMemoryIds"]) && Array.isArray(value.targetMemoryIds) && value.targetMemoryIds.length >= 1 && value.targetMemoryIds.length <= 3) {
    const targetMemoryIds = value.targetMemoryIds.map(validateTarget);
    if (new Set(targetMemoryIds).size !== targetMemoryIds.length) throw new Error("Chat memory action targets must be unique.");
    return { type: "mark_uncertain", targetMemoryIds };
  }
  if (value.type === "forget" && hasExactKeys(value, ["type", "targetMemoryId", "blockRelearning"]) && typeof value.blockRelearning === "boolean") {
    return { type: "forget", targetMemoryId: validateTarget(value.targetMemoryId), blockRelearning: value.blockRelearning };
  }
  throw new Error("Chat memory action must be a strict action.");
}

function parseStructuredResponse(raw: string, allowedTargetIds?: readonly string[]): {
  texts: string[];
  profileUpdate: ChatProfileProposal | null;
  memoryAction: MemoryAction | null;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !isRecord(parsed) ||
    !Object.hasOwn(parsed, "bubbles") ||
    !Object.hasOwn(parsed, "profileUpdate") ||
    !Object.hasOwn(parsed, "memoryAction")
  ) {
    throw new Error("Chat response JSON must contain bubbles, profileUpdate, and memoryAction.");
  }
  if (!Object.keys(parsed).every((key) => ["bubbles", "profileUpdate", "memoryAction"].includes(key))) {
    throw new Error("Chat response JSON may include only bubbles, profileUpdate, and memoryAction.");
  }

  let profileUpdate: ChatProfileProposal | null;
  if (parsed.profileUpdate === null) {
    profileUpdate = null;
  } else if (
    isRecord(parsed.profileUpdate) &&
    Object.keys(parsed.profileUpdate).length === 2 &&
    Object.hasOwn(parsed.profileUpdate, "displayName") &&
    Object.hasOwn(parsed.profileUpdate, "addressingStyle") &&
    (typeof parsed.profileUpdate.displayName === "string" || parsed.profileUpdate.displayName === null) &&
    (parsed.profileUpdate.addressingStyle === "san" ||
      parsed.profileUpdate.addressingStyle === "none" ||
      parsed.profileUpdate.addressingStyle === null)
  ) {
    profileUpdate = {
      displayName: parsed.profileUpdate.displayName,
      addressingStyle: parsed.profileUpdate.addressingStyle,
    };
  } else {
    throw new Error("Chat profile proposal must be a strict nullable profile update.");
  }

  const memoryAction = parsed.memoryAction === null
    ? null
    : parseMemoryAction(parsed.memoryAction, allowedTargetIds);

  return { texts: validateBubbleTexts(parsed.bubbles), profileUpdate, memoryAction };
}

export function parseChatResponseOutput(
  raw: string,
  replyGroupId: string,
  createdAt: string,
  allowedTargetIds?: readonly string[],
): ParsedChatResponse {
  const structured = parseStructuredResponse(raw, allowedTargetIds);
  const texts = normalizeConversationalBubbles(structured?.texts ?? validateBubbleTexts([raw]));

  return {
    reply: {
      replyGroupId,
      bubbles: texts.map((text, sequence) => ({
        id: `${replyGroupId}:${sequence}`,
        text,
        createdAt,
        sequence: sequence as 0 | 1 | 2,
      })),
    },
    profileUpdate: structured?.profileUpdate ?? null,
    memoryAction: structured?.memoryAction ?? null,
  };
}

export function assertExternalContextOutput(parsed: ParsedChatResponse): ParsedChatResponse {
  if (parsed.profileUpdate !== null || parsed.memoryAction !== null) {
    throw new Error("External context output cannot mutate profile or memory");
  }
  return parsed;
}

export function parseChatReplyOutput(raw: string, replyGroupId: string, createdAt: string): ChatReply {
  return parseChatResponseOutput(raw, replyGroupId, createdAt).reply;
}

export function createProfileGreeting(
  profile: Profile,
  createdAt: string,
  replyGroupId: string,
): ChatMessage[] {
  return [
    {
      id: `${replyGroupId}:0`,
      type: "message",
      role: "assistant",
      text: `${formatAddressedName(profile)}、はじめまして`,
      createdAt,
      delivery: "sent",
      flow: "profile",
      replyGroupId,
      sequence: 0,
    },
    {
      id: `${replyGroupId}:1`,
      type: "message",
      role: "assistant",
      text: "これからよろしくね",
      createdAt,
      delivery: "sent",
      flow: "profile",
      replyGroupId,
      sequence: 1,
    },
  ];
}

export type CallCard = {
  id: string;
  type: "call";
  startedAt: string;
  endedAt: string;
};

export type TimelineItem = ChatMessage | PhotoMessage | CallCard;

export type LocalChatSnapshot = {
  timeline: TimelineItem[];
  draft: string;
  pendingDisplayName: string | null;
  lastOpeningAt: string | null;
  lastConversationAt: string | null;
};

const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const photoUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHOTO_CAPTION_MAX_LENGTH = 400;

function parseIsoTimestamp(input: string): number | null {
  const match = isoTimestamp.exec(input);
  if (!match) return null;

  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;

  const date = new Date(timestamp);
  const [year, month, day, hour, minute, second, millisecond] = match
    .slice(1)
    .map(Number);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }

  return timestamp;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseWebSearchMetadata(value: unknown): WebSearchMetadata | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["status", "searchedAt", "sources", "evidence"]) ||
    !isCanonicalTimestamp(value.searchedAt) ||
    !Array.isArray(value.sources)
  ) return null;
  if (value.status === "failed") {
    return Object.keys(value).length === 3 && value.sources.length === 0
      ? { status: "failed", searchedAt: value.searchedAt, sources: [] }
      : null;
  }
  if (value.status !== "completed" || Object.keys(value).length !== 4 || value.sources.length < 1 || value.sources.length > 5) return null;
  const sources: Array<{ title: string; url: string }> = [];
  const urls = new Set<string>();
  for (const source of value.sources) {
    if (!isRecord(source) || !hasOnlyKeys(source, ["title", "url"]) || Object.keys(source).length !== 2) return null;
    if (typeof source.title !== "string" || !source.title.trim() || source.title.length > 200 || controlCharacter.test(source.title)) return null;
    if (typeof source.url !== "string") return null;
    let url: URL;
    try { url = new URL(source.url); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.toString() !== source.url || urls.has(source.url)) return null;
    urls.add(source.url);
    sources.push({ title: source.title, url: source.url });
  }
  const evidence = parseWebSearchEvidence(value.evidence, urls);
  return evidence ? { status: "completed", searchedAt: value.searchedAt, sources, evidence } : null;
}

function parseWebSearchEvidence(value: unknown, sourceUrls: Set<string>): WebSearchEvidence | null {
  if (!isRecord(value) || !hasExactKeys(value, ["facts", "inference", "suggestion"]) || !Array.isArray(value.facts)) return null;
  if (value.facts.length < 1 || value.facts.length > 3) return null;
  const facts: WebSearchEvidence["facts"] = [];
  for (const fact of value.facts) {
    if (!isRecord(fact) || !hasExactKeys(fact, ["text", "sourceUrl"]) || typeof fact.text !== "string" || typeof fact.sourceUrl !== "string") return null;
    if (!fact.text.trim() || fact.text.length > 180 || controlCharacter.test(fact.text) || !sourceUrls.has(fact.sourceUrl)) return null;
    facts.push({ text: fact.text, sourceUrl: fact.sourceUrl });
  }
  if (!isSafeWebSearchDerivedText(value.inference) || !isSafeWebSearchDerivedText(value.suggestion)) return null;
  return { facts, inference: value.inference, suggestion: value.suggestion };
}

function isSafeWebSearchDerivedText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= 180 && !controlCharacter.test(value));
}

export function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseIsoTimestamp(value) !== null;
}

export function parseTimelineItem(
  value: unknown,
  options: { strict?: boolean; snapshotVersion?: 1 | 2 | 3 } = {},
): TimelineItem | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (options.strict && value.id.length === 0) return null;

  if (
    options.snapshotVersion === 3 &&
    value.type === "photo" &&
    value.role === "user" &&
    photoUuidV4.test(value.id) &&
    typeof value.photoId === "string" &&
    photoUuidV4.test(value.photoId) &&
    typeof value.caption === "string" &&
    value.caption.length <= PHOTO_CAPTION_MAX_LENGTH &&
    !controlCharacter.test(value.caption) &&
    value.origin === "photo" &&
    isCanonicalTimestamp(value.createdAt) &&
    (value.delivery === "sending" || value.delivery === "sent" || value.delivery === "failed")
  ) {
    if (options.strict && !hasOnlyKeys(value, [
      "id", "type", "role", "photoId", "caption", "origin", "createdAt", "delivery",
    ])) return null;
    return {
      id: value.id,
      type: "photo",
      role: "user",
      photoId: value.photoId,
      caption: value.caption,
      origin: "photo",
      createdAt: value.createdAt,
      delivery: value.delivery,
    };
  }

  if (
    value.type === "message" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    isCanonicalTimestamp(value.createdAt) &&
    (value.delivery === "sending" || value.delivery === "sent" || value.delivery === "failed")
  ) {
    const hasReplyGroupId = Object.hasOwn(value, "replyGroupId");
    const hasSequence = Object.hasOwn(value, "sequence");
    const hasSearch = Object.hasOwn(value, "search");
    const hasLifeCard = Object.hasOwn(value, "lifeCard");
    const hasOrigin = Object.hasOwn(value, "origin");
    const hasSourcePhotoMessageId = Object.hasOwn(value, "sourcePhotoMessageId");
    const hasPhotoLineage = hasOrigin || hasSourcePhotoMessageId;
    const allowedKeys = value.role === "assistant" && (hasReplyGroupId || hasSequence)
      ? ["id", "type", "role", "text", "createdAt", "delivery", "flow", "replyGroupId", "sequence", "search", "lifeCard", "origin", "sourcePhotoMessageId"]
      : ["id", "type", "role", "text", "createdAt", "delivery", "flow"];
    if (options.strict && !hasOnlyKeys(value, allowedKeys)) return null;
    const hasValidFlow = value.flow === "conversation" || value.flow === "profile" || value.flow === "external_context";
    if (options.strict && value.flow !== undefined && !hasValidFlow) return null;

    const flow: ChatMessageBase["flow"] =
      value.flow === "conversation" || value.flow === "profile" || value.flow === "external_context" ? value.flow : undefined;
    const delivery: ChatMessageBase["delivery"] = value.delivery;
    const base: ChatMessageBase = {
      id: value.id,
      type: "message",
      text: value.text,
      createdAt: value.createdAt,
      delivery,
      ...(flow ? { flow } : {}),
    };
    if (value.role === "user") {
      if (hasLifeCard || hasSearch || hasPhotoLineage || (options.strict && (hasReplyGroupId || hasSequence))) return null;
      return { ...base, role: "user" };
    }
    if (
      hasPhotoLineage &&
      (
        options.snapshotVersion !== 3 ||
        value.origin !== "photo_analysis" ||
        typeof value.sourcePhotoMessageId !== "string" ||
        !photoUuidV4.test(value.sourcePhotoMessageId) ||
        !hasOrigin ||
        !hasSourcePhotoMessageId
      )
    ) return null;
    if (!hasReplyGroupId && !hasSequence) return hasLifeCard || hasSearch || hasPhotoLineage ? null : { ...base, role: "assistant" };
    if (
      typeof value.replyGroupId !== "string" ||
      value.replyGroupId.length === 0 ||
      (value.sequence !== 0 && value.sequence !== 1 && value.sequence !== 2) ||
      value.id !== `${value.replyGroupId}:${value.sequence}`
    ) {
      return null;
    }
    const lifeCard = hasLifeCard ? parseLifeCard(value.lifeCard) : undefined;
    if (hasLifeCard && (!lifeCard || flow !== "external_context" || hasPhotoLineage)) return null;
    const search = hasSearch ? parseWebSearchMetadata(value.search) : undefined;
    if (hasSearch && !search) return null;
    const assistantBase = {
      ...base,
      role: "assistant" as const,
      replyGroupId: value.replyGroupId,
      sequence: value.sequence as 0 | 1 | 2,
      ...(search ? { search } : {}),
      ...(lifeCard ? { lifeCard } : {}),
    };
    if (hasPhotoLineage) {
      return {
        ...assistantBase,
        origin: "photo_analysis",
        sourcePhotoMessageId: value.sourcePhotoMessageId as string,
      };
    }
    return assistantBase;
  }

  if (
    value.type === "call" &&
    isCanonicalTimestamp(value.startedAt) &&
    isCanonicalTimestamp(value.endedAt)
  ) {
    if (options.strict && !hasOnlyKeys(value, ["id", "type", "startedAt", "endedAt"])) return null;
    return {
      id: value.id,
      type: "call",
      startedAt: value.startedAt,
      endedAt: value.endedAt,
    };
  }

  return null;
}

export function parseLocalChatSnapshot(value: unknown): LocalChatSnapshot | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.timeline) ||
    typeof value.draft !== "string" ||
    (typeof value.pendingDisplayName !== "string" && value.pendingDisplayName !== null) ||
    (value.lastOpeningAt !== null && !isCanonicalTimestamp(value.lastOpeningAt)) ||
    (value.lastConversationAt !== null && !isCanonicalTimestamp(value.lastConversationAt))
  ) {
    return null;
  }

  const timeline = new Map<string, TimelineItem>();
  for (const item of value.timeline) {
    const parsed = parseTimelineItem(item);
    if (!parsed) return null;
    timeline.set(parsed.id, parsed);
  }

  return {
    timeline: [...timeline.values()],
    draft: value.draft,
    pendingDisplayName: null,
    lastOpeningAt: value.lastOpeningAt,
    lastConversationAt: value.lastConversationAt,
  };
}

export function shouldCreateOpening(input: {
  now: string;
  lastOpeningAt: string | null;
  lastConversationAt: string | null;
}): boolean {
  const now = parseIsoTimestamp(input.now);
  if (now === null) return false;
  if (input.lastOpeningAt === null && input.lastConversationAt === null) return true;
  if (input.lastOpeningAt === null || input.lastConversationAt === null) return false;

  const lastOpeningAt = parseIsoTimestamp(input.lastOpeningAt);
  const lastConversationAt = parseIsoTimestamp(input.lastConversationAt);
  if (lastOpeningAt === null || lastConversationAt === null) {
    return false;
  }

  return (
    now - lastOpeningAt >= 6 * 60 * 60 * 1_000 &&
    now - lastConversationAt >= 30 * 60 * 1_000
  );
}
