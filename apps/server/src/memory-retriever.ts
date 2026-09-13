import { isMemoryAvailable } from "../../../packages/domain/src/index.js";
import type {
  MemoryKind,
  MemoryRecord,
  MemoryScope,
} from "../../../packages/domain/src/index.js";
import type { MemoryRepository } from "./db.js";
import type { RequestUser } from "./request-user.js";

export const MAX_RECALLED_MEMORIES = 8;

export type MemoryQuery = {
  text: string;
  now: string;
  scope: MemoryScope;
  relatedNames: string[];
};

export interface MemoryRetriever {
  retrieve(user: RequestUser, query: MemoryQuery): Promise<MemoryRecord[]>;
}

export class MemoryRetrievalError extends Error {
  constructor() {
    super("Memory retrieval unavailable");
    this.name = "MemoryRetrievalError";
  }
}

const broadTokens = new Set([
  "あれ", "いつ", "これ", "こと", "さっき", "した", "して", "しよう",
  "そう", "たい", "だけ", "です", "どう", "なに", "はい", "ます", "もの",
  "了解", "今日", "今度", "予定", "元気", "好き", "最近", "時間", "昨日", "明日", "話",
]);

const workWords = ["仕事", "職場", "会社", "案件", "顧客", "契約", "会議", "締切", "面接"];

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });

function meaningfulTokens(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return [...wordSegmenter.segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((token) => [...token].length >= 2 && !broadTokens.has(token));
}

type RelevanceEvidence = {
  exactTopicalTokens: string[];
  substringTopicalMatches: number;
};

const sensitiveTopicAnchors = new Set([
  "健康", "病気", "病院", "治療", "通院", "偏頭痛", "頭痛", "持病", "服薬", "診断", "薬",
  "金銭", "年収", "収入", "借金", "ローン", "返済",
  "家族", "恋愛", "彼氏", "彼女", "恋人", "失恋", "悩み", "不安", "うつ", "ストレス",
]);

const standaloneAmbiguousReplies = new Set([
  "うん", "そう", "はい", "了解", "了解しました", "わかりました",
  "お願い", "なるほど", "たしかに", "確かに", "大丈夫", "元気",
  "最近どう", "どうしよう", "今日は",
]);

const standaloneReplySuffixes = [
  "でした", "ました", "ですね", "ですよ", "だね", "だよ", "です", "ます", "ね", "よ",
];
const MAX_STANDALONE_REPLY_LENGTH = 32;
const MAX_STANDALONE_SUFFIX_STRIPS = 32;

function isStandaloneAmbiguousReply(text: string): boolean {
  const compact = normalizeText(text).replace(/\s/gu, "");
  if ([...compact].length > MAX_STANDALONE_REPLY_LENGTH) return false;
  let candidate = compact;
  for (let count = 0; count < MAX_STANDALONE_SUFFIX_STRIPS; count += 1) {
    if (standaloneAmbiguousReplies.has(candidate)) return true;
    const suffix = standaloneReplySuffixes.find((value) => candidate.endsWith(value));
    if (!suffix || candidate.length === suffix.length) return false;
    candidate = candidate.slice(0, -suffix.length);
  }
  return standaloneAmbiguousReplies.has(candidate);
}

function isConservativeSubstring(left: string, right: string): boolean {
  const leftLength = [...left].length;
  const rightLength = [...right].length;
  const shorter = leftLength <= rightLength ? left : right;
  const longer = leftLength <= rightLength ? right : left;
  const shorterLength = Math.min(leftLength, rightLength);
  const longerLength = Math.max(leftLength, rightLength);
  return shorterLength >= 4 &&
    shorterLength / longerLength >= 0.65 &&
    (longer.startsWith(shorter) || longer.endsWith(shorter));
}

function matchingEvidence(
  queryTokens: readonly string[],
  recordTokens: readonly string[],
  relatedNames: readonly string[],
): RelevanceEvidence {
  const exactTopicalTokens: string[] = [];
  let substringTopicalMatches = 0;
  for (const queryToken of new Set(queryTokens)) {
    const compactToken = queryToken.replace(/\s/gu, "");
    if (relatedNames.some((name) => name.replace(/\s/gu, "") === compactToken)) continue;
    if (recordTokens.includes(queryToken)) {
      exactTopicalTokens.push(queryToken);
      continue;
    }
    if (recordTokens.some((candidate) => isConservativeSubstring(queryToken, candidate))) {
      substringTopicalMatches += 1;
    }
  }
  return { exactTopicalTokens, substringTopicalMatches };
}

function inferredKinds(query: MemoryQuery, normalizedText: string): Set<MemoryKind> {
  const kinds = new Set<MemoryKind>();
  if (/(好き|嫌い|好み)/u.test(normalizedText)) kinds.add("preference");
  if (/(毎日|いつも|習慣|日課|ルーティン)/u.test(normalizedText)) kinds.add("routine");
  if (workWords.some((word) => normalizedText.includes(word))) kinds.add("work");
  if (/(予定|予約|何時|いつ|締切|会議)/u.test(normalizedText)) kinds.add("schedule");
  if (/(思い出|一緒に|共有)/u.test(normalizedText)) kinds.add("shared");
  if (query.relatedNames.length > 0) kinds.add("person");
  return kinds;
}

function scopeCompatible(queryScope: MemoryScope, recordScope: MemoryScope): boolean {
  return recordScope === "shared" || recordScope === queryScope;
}

function ageScore(updatedAt: string, nowMs: number): number {
  const age = Math.max(0, nowMs - new Date(updatedAt).getTime());
  const day = 24 * 60 * 60 * 1_000;
  if (age <= day) return 10;
  if (age <= 7 * day) return 6;
  if (age <= 30 * day) return 3;
  return 0;
}

function scheduleScore(record: MemoryRecord, nowMs: number): number {
  if (record.kind !== "schedule") return 0;
  const timestamps = [record.validFrom, record.validUntil, record.sourceOccurredAt]
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (timestamps.length === 0) return 0;
  const distance = Math.min(...timestamps.map((timestamp) => Math.abs(timestamp - nowMs)));
  const day = 24 * 60 * 60 * 1_000;
  if (distance <= day) return 12;
  if (distance <= 7 * day) return 6;
  if (distance <= 30 * day) return 2;
  return 0;
}

function matchingRelatedNames(record: MemoryRecord, names: readonly string[]): number {
  const content = normalizeText(record.content).replace(/\s/gu, "");
  return names.filter((name) => {
    const normalized = normalizeText(name).replace(/\s/gu, "");
    return [...normalized].length >= 2 && content.includes(normalized);
  }).length;
}

export function rankMemories(query: MemoryQuery, records: readonly MemoryRecord[]): MemoryRecord[] {
  const nowDate = new Date(query.now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) return [];
  if (isStandaloneAmbiguousReply(query.text)) return [];
  const queryTokens = meaningfulTokens(query.text);
  const relatedNames = query.relatedNames
    .map(normalizeText)
    .filter((name) => [...name.replace(/\s/gu, "")].length >= 2);
  if (queryTokens.length === 0 && relatedNames.length === 0) return [];

  const normalizedQuery = normalizeText(query.text);
  const kinds = inferredKinds(query, normalizedQuery);
  return records
    .filter((record) => isMemoryAvailable(record, nowDate))
    .filter((record) => scopeCompatible(query.scope, record.scope))
    .map((record) => {
      const recordTokens = meaningfulTokens(record.content);
      const inferredPersonName = record.kind === "person" ? recordTokens.at(0) : undefined;
      const nameEvidence = inferredPersonName ? [...relatedNames, inferredPersonName] : relatedNames;
      const evidence = matchingEvidence(queryTokens, recordTokens, nameEvidence);
      const inferredNameMatch = inferredPersonName && queryTokens.includes(inferredPersonName) ? 1 : 0;
      const nameMatches = Math.max(matchingRelatedNames(record, relatedNames), inferredNameMatch);
      if (evidence.exactTopicalTokens.length === 0 && evidence.substringTopicalMatches === 0 && nameMatches === 0) return null;
      if (
        record.sensitivity === "sensitive" &&
        !evidence.exactTopicalTokens.some((token) => sensitiveTopicAnchors.has(token))
      ) return null;

      const secondaryScore =
        (kinds.has(record.kind) ? 16 : 0) +
        (record.scope === query.scope ? 8 : 4) +
        ageScore(record.updatedAt, nowMs) +
        scheduleScore(record, nowMs) +
        record.importance;
      return { record, ...evidence, nameMatches, secondaryScore };
    })
    .filter((entry): entry is {
      record: MemoryRecord;
      exactTopicalTokens: string[];
      substringTopicalMatches: number;
      nameMatches: number;
      secondaryScore: number;
    } => entry !== null)
    .sort((left, right) =>
      right.exactTopicalTokens.length - left.exactTopicalTokens.length ||
      right.nameMatches - left.nameMatches ||
      right.substringTopicalMatches - left.substringTopicalMatches ||
      right.secondaryScore - left.secondaryScore ||
      left.record.id.localeCompare(right.record.id, "en"))
    .slice(0, MAX_RECALLED_MEMORIES)
    .map(({ record }) => record);
}

export function createMemoryRetriever(options: {
  repository: Pick<MemoryRepository, "listForRecall">;
  recallEnabled?: (user: RequestUser) => boolean | Promise<boolean>;
}): MemoryRetriever {
  return {
    async retrieve(user, query) {
      if (!(await (options.recallEnabled?.(user) ?? true))) return [];
      if (!query.text.trim() && query.relatedNames.length === 0) return [];
      try {
        return rankMemories(query, await options.repository.listForRecall(user));
      } catch {
        throw new MemoryRetrievalError();
      }
    },
  };
}

export function inferMemoryScope(text: string): MemoryScope {
  const normalized = normalizeText(text);
  return workWords.some((word) => normalized.includes(word)) ? "work" : "daily";
}

export function extractRelatedNames(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const segments = [...wordSegmenter.segment(normalized)].filter((segment) => segment.isWordLike);
  const honorifics = new Set(["さん", "くん", "ちゃん", "氏"]);
  const names: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const honorific = segments[index]!;
    const candidate = segments[index - 1]!;
    if (!honorifics.has(honorific.segment)) continue;
    if (candidate.index + candidate.segment.length !== honorific.index) continue;
    if (!/^(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,8}|[A-Za-z]{2,20})$/u.test(candidate.segment)) continue;
    names.push(candidate.segment);
  }
  return [...new Set(names)].slice(0, 4);
}
