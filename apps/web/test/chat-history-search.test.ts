import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@yui/domain";
import { searchChatHistory, selectInitialResult } from "../src/chat-history-search";

const now = "2026-08-09T00:00:00.000Z";

function message(input: {
  id: string;
  role: "user" | "assistant";
  text: string;
  flow?: "conversation" | "profile";
}): TimelineItem {
  return {
    id: input.id,
    type: "message",
    role: input.role,
    text: input.text,
    createdAt: now,
    delivery: "sent",
    flow: input.flow,
  };
}

function callCard(id: string): TimelineItem {
  return { id, type: "call", startedAt: now, endedAt: now };
}

const timeline: TimelineItem[] = [
  message({ id: "profile-1", role: "assistant", text: "大輝さん、はじめまして", flow: "profile" }),
  message({ id: "m1", role: "user", text: "Ｃｏｄｅｘの話" }),
  callCard("call-1"),
  message({ id: "m2", role: "assistant", text: "codex、便利だね" }),
];

describe("chat history search", () => {
  it("normalizes full-width case variants and excludes profile, calls, and blank queries", () => {
    expect(searchChatHistory(timeline, "CODEX").map((result) => result.messageId)).toEqual(["m1", "m2"]);
    expect(searchChatHistory(timeline, "はじめまして")).toEqual([]);
    expect(searchChatHistory(timeline, "   ")).toEqual([]);
  });

  it("keeps identical message text as separate results", () => {
    const duplicates = [
      message({ id: "first", role: "user", text: "また会議しよう" }),
      message({ id: "second", role: "assistant", text: "また会議しよう" }),
    ];

    expect(searchChatHistory(duplicates, "会議")).toEqual([
      { messageId: "first", timelineIndex: 0 },
      { messageId: "second", timelineIndex: 1 },
    ]);
  });

  it("selects the closest result at or before the visible anchor, otherwise the newest result", () => {
    const results = searchChatHistory(timeline, "codex");

    expect(selectInitialResult(results, "m2", timeline)).toBe(1);
    expect(selectInitialResult(results, "call-1", timeline)).toBe(0);
    expect(selectInitialResult(results, "profile-1", timeline)).toBe(1);
    expect(selectInitialResult(results, null, timeline)).toBe(1);
    expect(selectInitialResult([], "m2", timeline)).toBeNull();
  });
});
