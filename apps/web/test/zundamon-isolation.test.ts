import { describe, expect, it, vi } from "vitest";
import { createIndexedDbLocalStateStore, EMPTY_LOCAL_CHAT } from "../src/local-state";
import { parseHostedBrowserConfig } from "../src/hosted-config";
import { createLocalPreviewProps } from "../src/local-preview";

describe("zundamon isolation", () => {
  it("never reads YUI history or draft from its default database", async () => {
    const original = createIndexedDbLocalStateStore({ databaseName: "yui-local" });
    await original.save({ ...EMPTY_LOCAL_CHAT, draft: "original YUI private draft" });
    expect((await createIndexedDbLocalStateStore().load()).draft).not.toContain("original YUI");
    expect((await original.load()).draft).toBe("original YUI private draft");
  });
  it("ignores inherited browser connection variables", () => {
    expect(parseHostedBrowserConfig({ VITE_SUPABASE_URL: "https://old.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "old", VITE_YUI_API_BASE_URL: "https://old.example" })).toBeNull();
  });
  it("preview replies are labelled, isolated, and make no network request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    try {
      const preview = await createLocalPreviewProps();
      const reply = await preview.chatApi.respond({ kind: "reply", clientMessageId: "fixture", timeline: [] });
      expect(reply.bubbles[0]?.text).toContain("AI未接続");
      const bubble = reply.bubbles[0]!;
      await preview.chatStore.save({ ...EMPTY_LOCAL_CHAT, draft: "still here", timeline: [{ ...bubble, type: "message", role: "assistant", delivery: "sent", replyGroupId: reply.replyGroupId }] });
      expect(await preview.chatStore.load()).toMatchObject({ draft: "still here", timeline: [{ id: bubble.id }] });
      expect(await preview.memoryApi.getSettings()).toMatchObject({ memoryEnabled: false });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});
