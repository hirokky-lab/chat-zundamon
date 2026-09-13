import type { TtsStatus } from "../../../packages/domain/src/index.js";

export type TtsProvider = {
  status(signal?: AbortSignal): Promise<TtsStatus>;
  synthesize(
    input: { text: string; requestId: string },
    signal?: AbortSignal,
  ): Promise<{ audio: Uint8Array; contentType: "audio/wav" }>;
};

export class TtsProviderError extends Error {
  constructor(
    readonly kind: "unavailable" | "voice-not-found" | "timeout" | "upstream" | "cancelled",
  ) {
    super(`TTS provider ${kind}`);
    this.name = "TtsProviderError";
  }
}
