import { z } from "zod";

const japaneseCharacter = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

export const memoryCandidateSchema = z.object({
  kind: z.enum(["preference", "event", "ongoing", "shared"]),
  content: z
    .string()
    .min(1)
    .max(40)
    .regex(japaneseCharacter, "Memory content must contain Japanese characters"),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
});

export const memoryCandidatesSchema = z.array(memoryCandidateSchema).max(3);

const nullableTimestamp = z.string().datetime({ offset: true }).nullable();
const memoryKindSchema = z.enum(["preference", "person", "routine", "work", "event", "schedule", "shared"]);
const memoryScopeSchema = z.enum(["daily", "work", "shared"]);
const importanceSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

export const memoryCandidateProposalSchema = z.object({
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
  content: z.string().min(1).max(200),
  importance: importanceSchema,
  sourceOccurredAt: nullableTimestamp,
  validFrom: nullableTimestamp,
  validUntil: nullableTimestamp,
  retention: z.enum(["light", "recent"]).nullable(),
}).strict().refine(
  (candidate) => candidate.kind !== "event" || candidate.retention !== null,
  { message: "Event memory proposals require retention" },
);

// Kept as an alias while callers transition to the proposal-oriented name.
export const memoryCandidateV2Schema = memoryCandidateProposalSchema;

const targetMemoryIdSchema = z.string().uuid();

export const memoryActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), candidate: memoryCandidateProposalSchema }).strict(),
  z.object({ type: z.literal("replace"), targetMemoryId: targetMemoryIdSchema, candidate: memoryCandidateProposalSchema }).strict(),
  z.object({ type: z.literal("mark_past"), targetMemoryId: targetMemoryIdSchema, replacement: memoryCandidateProposalSchema.optional() }).strict(),
  z.object({ type: z.literal("mark_uncertain"), targetMemoryIds: z.array(targetMemoryIdSchema).min(1).max(3).refine((ids) => new Set(ids).size === ids.length, "Memory action targets must be unique") }).strict(),
  z.object({ type: z.literal("forget"), targetMemoryId: targetMemoryIdSchema, blockRelearning: z.boolean() }).strict(),
]);
