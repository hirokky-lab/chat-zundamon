export type YuiConversationMode = "text" | "voice";

export type YuiCapability =
  | "text-chat"
  | "confirmed-memory"
  | "voice-call"
  | "local-tts"
  | "realtime-audio";

export type YuiContext = {
  now: string;
  timeZone: string | null;
  mode: YuiConversationMode;
  capabilities: YuiCapability[];
  userName: string;
  memories: string[];
  memoryActionTargets?: Array<{ id: string; content: string }>;
  recentTurns?: TranscriptTurn[];
};

export function parseTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("ja-JP", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return null;
  }
}

export type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
};
