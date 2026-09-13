import type { MemoryAction } from "../../../packages/domain/src/memory.js";
import { classifySensitivity, containsForbiddenSecret } from "./memory-policy.js";
import { memoryActionSchema } from "./memory-schema.js";

export const AUTOMATIC_MEMORY_POLICY_VERSION = "natural-v1" as const;

export type AutomaticMemoryExternalSource =
  | "web_search" | "weather" | "calendar_tasks" | "drive_gmail" | "photo_analysis" | "attachment";
export type AutomaticMemorySourceContext =
  | { kind: "internal" }
  | { kind: "external"; source: AutomaticMemoryExternalSource }
  | { kind: "external_followup"; sources: AutomaticMemoryExternalSource[] };
export type AutomaticMemoryCategory = "preference" | "person" | "work" | "shared";

const transientOrUnsafe = /(?:明日|今日|昨日|今夜|今週|来週|予定|会議|気分|悲しい|嬉しい|つらい|冗談|もし|仮に|引用|[「『“”]|と(?:書いて|言って)いた|友達|知人|同僚|家族|彼|彼女|たぶん|多分|おそらく|気がする|かもしれない|推測|迷って|好きじゃない|好みではない|ではない|じゃない)/u;
const sensitive = /(?:偏頭痛|頭痛|持病|治療|通院|服薬|診断|病気|年収|収入|借金|ローン|貯金|資産|家族|父|母|兄|姉|弟|妹|息子|娘|夫|妻|彼氏|彼女|恋人|離婚|失恋|悩み|不安|うつ|ストレス|支持政党|政治|宗教|性的|セクシュアリティ)/u;
const ownerLead = /^(?:私|僕|自分)(?:(?:は|も)(?:[、,]\s*)?|の|[、,]\s*)/u;
const preference = /^(?:(?:朝|昼|夜)は)?(?:紅茶|コーヒー|珈琲|緑茶|お茶|読書|本|音楽|映画|散歩|料理|写真|犬|猫|和食|洋食|甘いもの|辛いもの)(?:を(?:飲む|食べる|読む|聴く|見る|する)の)?(?:が|は|を)(?:(?:大|とても|かなり|すごく|本当に|一番|ずっと)\s*)*(?:好き|好み|苦手|好む)(?:です|だ)?$/u;
const profile = /^(?:(?:呼び名|名前)(?:は|を)[\p{L}\p{N}ー・]{1,16}(?:(?:がいい|にして)(?:です)?|です|だ)?|(?:職業|仕事)(?:は|を)(?:エンジニア|デザイナー|編集者|作家|会社員|学生|教員|研究者|公務員|自営業|経営者)(?:です|だ|をしている|をしています)|[^はもが、,。！？；;／/\r\n]{1,12}(?:都|道|府|県|市|区|町|村)(?:在住|出身)(?:です|だ)?)$/u;
const work = /^(?:長期方針(?:は)?|今後(?:は)?|これから(?:は)?)(?:安全|品質|正確さ|プライバシー|継続性|使いやすさ)(?:を|が)(?:最)?(?:優先する|大切にする|方針にする)$/u;
const response = /^(?:返事|回答|説明)(?:は|を)(?:短め|簡潔|箇条書き|詳しく|結論から)(?:が読みやすい|でお願い|にして)?$/u;

function category(value: string, requireOwner = true): AutomaticMemoryCategory | null {
  const hasOwner = ownerLead.test(value);
  const text = value.replace(ownerLead, "").trim().replace(/[。！]$/u, "");
  if (!text || (requireOwner && !hasOwner)) return null;
  if (preference.test(text)) return "preference";
  if (profile.test(text)) return "person";
  if (work.test(text)) return "work";
  if (response.test(text)) return "shared";
  return null;
}

export type AutomaticMemoryPreflight =
  | { eligible: true; authoritativeText: string; category?: AutomaticMemoryCategory }
  | { eligible: false; reason: "external" | "unsafe" | "not_durable" | "invalid_source" };

export function preflightAutomaticMemory(input: {
  turns: Array<{ role: "user" | "assistant"; text: string; provenance: "context" | "authoritative_source" }>;
  sourceContext?: AutomaticMemorySourceContext;
  sourceOrigin?: "voice";
  explicitMemoryTargetTurnIndexes?: number[];
}): AutomaticMemoryPreflight {
  if (input.sourceOrigin !== "voice" && input.sourceContext?.kind !== "internal") return { eligible: false, reason: input.sourceContext ? "external" : "invalid_source" };
  const authoritative = input.turns.filter((turn) => turn.role === "user" && turn.provenance === "authoritative_source");
  const selected = input.sourceOrigin === "voice" && (input.explicitMemoryTargetTurnIndexes?.length ?? 0) > 0
    ? input.explicitMemoryTargetTurnIndexes!.flatMap((index) => input.turns[index] ? [input.turns[index]!] : []) : authoritative;
  if (selected.length !== 1) return { eligible: false, reason: "invalid_source" };
  const text = selected[0]!.text.normalize("NFKC").trim();
  if (!text || containsForbiddenSecret(text) || (input.sourceOrigin !== "voice" && (sensitive.test(text) || transientOrUnsafe.test(text)))) return { eligible: false, reason: "unsafe" };
  if (input.sourceOrigin === "voice" && (input.explicitMemoryTargetTurnIndexes?.length ?? 0) > 0) return { eligible: true, authoritativeText: text };
  const found = category(text);
  return found ? { eligible: true, authoritativeText: text, category: found } : { eligible: false, reason: "not_durable" };
}

export function selectAutomaticMemoryAction(actions: unknown[], authoritativeText?: string, explicit = false, expected?: AutomaticMemoryCategory): MemoryAction | null {
  if (actions.length !== 1) return null;
  const parsed = memoryActionSchema.safeParse(actions[0]);
  if (!parsed.success || parsed.data.type !== "add" || containsForbiddenSecret(parsed.data.candidate.content)) return null;
  const action = parsed.data as MemoryAction & { type: "add" };
  if (!explicit) {
    const candidateCategory = category(action.candidate.content, false);
    if (classifySensitivity(action.candidate.content) !== "normal" || transientOrUnsafe.test(action.candidate.content)
      || sensitive.test(action.candidate.content) || !expected || candidateCategory !== expected || action.candidate.kind !== candidateCategory) return null;
  }
  const canonical = (value: string) => value.normalize("NFKC").replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, "");
  if (authoritativeText && !canonical(authoritativeText).includes(canonical(action.candidate.content))) return null;
  return action;
}
