export type AvatarExpression = "neutral" | "smile" | "surprise" | "thinking" | "angry" | "shy" | "sad" | "afraid" | "greeting" | "agree" | "disagree";

export type AvatarSpeechState = "silent" | "preparing" | "speaking";

/** Explicit, local-only controls for the motion gallery. Absent in conversations. */
export type AvatarPreview = {
  motion?: string;
  expression?: string;
  pose?: string;
  requestId: number;
  loop: boolean;
};
export type AvatarPreviewStatus = { finished: boolean };

export type AvatarAudioSignal = {
  readonly speechState: AvatarSpeechState;
  readonly volume: number;
};

export type AvatarFrameInput = AvatarAudioSignal & {
  readonly preview?: AvatarPreview;
  readonly expression?: AvatarExpression;
  readonly expressionKey?: string;
  readonly elapsedMs: number;
  readonly idle: number;
  readonly eyeOpenLeft: number;
  readonly eyeOpenRight: number;
  readonly mouthOpen: number;
};

export type AvatarAsset = {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly maxBytes: number;
};

export type AvatarModelManifest = {
  readonly id: string;
  readonly sdkVersion: string;
  readonly bridge: AvatarAsset;
  readonly assets: readonly AvatarAsset[];
  readonly notice: string;
  readonly provisional: boolean;
};

export type AvatarRenderer = {
  setOrientation?(yaw: number, pitch: number): void;
  setInput(input: AvatarFrameInput): void | AvatarPreviewStatus;
  resize(width: number, height: number, devicePixelRatio: number): void;
  dispose(): void;
};

export type AvatarRendererLoader = (
  canvas: HTMLCanvasElement,
  manifest: AvatarModelManifest,
  signal: AbortSignal,
) => Promise<AvatarRenderer>;
