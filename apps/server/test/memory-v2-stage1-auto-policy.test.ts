import { describe, expect, it } from "vitest";
import { preflightAutomaticMemory, selectAutomaticMemoryAction } from "../src/memory-auto-policy.js";
import { automaticMemoryProcessingKey } from "../../../packages/domain/src/automatic-memory-key.js";

const source = "私は朝は紅茶を飲むのが好き";

describe("memory-v2 automatic memory safety boundary", () => {
  it("allows one grounded, low-risk owner preference only", () => {
    const preflight = preflightAutomaticMemory({
      sourceContext: { kind: "internal" },
      turns: [{ role: "user", text: source, provenance: "authoritative_source" }],
    });

    expect(preflight).toMatchObject({ eligible: true, category: "preference" });
    expect(selectAutomaticMemoryAction([
      {
        type: "add",
        candidate: {
          kind: "preference", scope: "daily", content: "朝は紅茶を飲むのが好き", importance: 3,
          sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null,
        },
      },
    ], source, false, "preference")).toMatchObject({ type: "add" });
  });

  it.each([
    ["external", { kind: "external", source: "web_search" } as const, source],
    ["Calendar/Tasks external", { kind: "external", source: "calendar_tasks" } as const, source],
    ["Calendar/Tasks follow-up", { kind: "external_followup", sources: ["calendar_tasks"] } as const, "それを覚えておいて"],
    ["health", { kind: "internal" } as const, "私は偏頭痛の治療で通院している"],
    ["referential follow-up", { kind: "internal" } as const, "それを覚えておいて"],
    ["unknown source", undefined, source],
  ])("fails closed for %s", (_name, sourceContext, text) => {
    expect(preflightAutomaticMemory({
      sourceContext,
      turns: [{ role: "user", text, provenance: "authoritative_source" }],
    })).toMatchObject({ eligible: false });
  });

  it("rejects multiple proposed writes even when each proposal is valid", () => {
    const action = {
      type: "add" as const,
      candidate: {
        kind: "preference" as const, scope: "daily" as const, content: "朝は紅茶を飲むのが好き", importance: 3 as const,
        sourceOccurredAt: null, validFrom: null, validUntil: null, retention: null,
      },
    };
    expect(selectAutomaticMemoryAction([action, action], source, false, "preference")).toBeNull();
  });

  it("derives an opaque owner-scoped key for automatic idempotency", () => {
    const first = automaticMemoryProcessingKey("00000000-0000-0000-0000-000000000001", "message-1");
    const second = automaticMemoryProcessingKey("00000000-0000-0000-0000-000000000002", "message-1");
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("message-1");
    expect(second).not.toBe(first);
  });
});
