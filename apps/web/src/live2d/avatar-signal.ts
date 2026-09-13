import type { AvatarAudioSignal, AvatarFrameInput } from "./avatar-contract";

const clamp01 = (value: number): number => Number.isFinite(value)
  ? Math.max(0, Math.min(1, value))
  : 0;

export type AvatarSignalAdapter = {
  setAudio(input: AvatarAudioSignal): void;
  frame(elapsedMs: number): AvatarFrameInput;
};

export function createAvatarSignalAdapter(): AvatarSignalAdapter {
  let audio: AvatarAudioSignal = { speechState: "silent", volume: 0 };

  return {
    setAudio(input) {
      audio = input;
    },
    frame(rawElapsedMs) {
      const elapsedMs = Number.isFinite(rawElapsedMs) ? Math.max(0, rawElapsedMs) : 0;
      const blinkPhase = elapsedMs % 4_000;
      const eyeOpen = blinkPhase >= 3_680 && blinkPhase < 3_840 ? 0 : 1;
      const idle = clamp01(0.5 + Math.sin((elapsedMs / 6_000) * Math.PI * 2) * 0.25);
      const speechState = audio.speechState;
      const volume = speechState === "speaking" ? clamp01(audio.volume) : 0;
      const mouthOpen = speechState === "speaking" ? volume : speechState === "preparing" ? 0.12 : 0;

      return {
        elapsedMs,
        eyeOpenLeft: eyeOpen,
        eyeOpenRight: eyeOpen,
        idle,
        mouthOpen,
        speechState,
        volume,
      };
    },
  };
}
