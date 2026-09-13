import { parseProfile, type Profile } from "@yui/domain";
import type { ChatApi, MemoryApi, ProfileApi } from "./api";
import { createBrowserLocalStateStore } from "./local-state";

const unavailable = async (): Promise<never> => { throw new Error("表示確認モードでは接続していません。"); };

/** A separate fixture store: demonstration text must never become real conversation memory. */
export async function createLocalPreviewProps() {
  const { store, persistent } = await createBrowserLocalStateStore({ databaseName: "zundamon-ai-preview" });
  let profile: Profile | null = null;
  try { profile = parseProfile(JSON.parse(localStorage.getItem("zundamon-ai-preview-profile") ?? "null")); } catch { /* Private mode stays session-only. */ }
  const profileApi: ProfileApi = {
    get: async () => profile,
    save: async (input) => {
      profile = { ...input, updatedAt: new Date().toISOString() };
      try { localStorage.setItem("zundamon-ai-preview-profile", JSON.stringify(profile)); } catch { /* Session-only profile. */ }
      return profile;
    },
  };
  const chatApi: ChatApi = {
    async respond(input, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return {
        replyGroupId: `${input.clientMessageId}:assistant`,
        bubbles: [{
          id: `${input.clientMessageId}:assistant:0`, sequence: 0, createdAt: new Date().toISOString(),
          text: input.kind === "opening"
            ? "ずんだもんなのだ。ここでは、会話の表示とトーク履歴を試せるのだ。\n（表示確認用の定型文・AI未接続）"
            : "メッセージの表示を確認したのだ。トーク履歴を開いても、この会話のまま続けられるのだ。\n（表示確認用の定型文・AI未接続）",
        }],
      };
    },
  };
  const memoryApi: MemoryApi = {
    list: async () => [], getSettings: async () => ({ memoryEnabled: false, updatedAt: null }),
    listTombstones: async () => [], update: unavailable, keep: unavailable, forget: unavailable,
    releaseTombstone: unavailable, updateSettings: unavailable,
  };
  return { chatStore: store, chatStorePersistent: persistent, chatApi, profileApi, memoryApi, automaticMemoryEnabled: false };
}
