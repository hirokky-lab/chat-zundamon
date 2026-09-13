export type AvatarFallbackReason =
  | "disabled"
  | "reduced-motion"
  | "mobile"
  | "low-performance"
  | "unsupported";

export type AvatarCapabilityInput = {
  readonly enabled: boolean;
  readonly reducedMotion: boolean;
  readonly coarsePointer: boolean;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGb?: number;
  readonly webgl2: boolean;
};

export type AvatarCapability =
  | { readonly mode: "animate" }
  | { readonly mode: "fallback"; readonly reason: AvatarFallbackReason };

export function assessAvatarCapability(input: AvatarCapabilityInput): AvatarCapability {
  if (!input.enabled) return { mode: "fallback", reason: "disabled" };
  if (input.reducedMotion) return { mode: "fallback", reason: "reduced-motion" };
  if (
    (input.hardwareConcurrency !== undefined && input.hardwareConcurrency <= 2) ||
    (input.deviceMemoryGb !== undefined && input.deviceMemoryGb <= 2)
  ) return { mode: "fallback", reason: "low-performance" };
  if (!input.webgl2) return { mode: "fallback", reason: "unsupported" };
  return { mode: "animate" };
}
export function readBrowserAvatarCapability(enabled: boolean): AvatarCapability {
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const hardwareConcurrency = navigator.hardwareConcurrency || undefined;
  const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (!enabled) return { mode: "fallback", reason: "disabled" };
  if (reducedMotion) return { mode: "fallback", reason: "reduced-motion" };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2");
  const webgl2 = context !== null;
  context?.getExtension("WEBGL_lose_context")?.loseContext();
  canvas.width = 0;
  canvas.height = 0;
  return assessAvatarCapability({ enabled, reducedMotion, coarsePointer, hardwareConcurrency, deviceMemoryGb, webgl2 });
}
