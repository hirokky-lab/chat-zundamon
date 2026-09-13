import { createHash } from "node:crypto";

const field = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`;

/** Opaque, owner-scoped persistence key. Never expose its inputs. */
export function automaticMemoryProcessingKey(ownerId: string, sourceMessageId: string, policyVersion = "natural-v1"): string {
  return createHash("sha256")
    .update(`${field("yui:auto-memory-processing")}${field(policyVersion)}${field(ownerId)}${field(sourceMessageId)}`, "utf8")
    .digest("hex");
}
