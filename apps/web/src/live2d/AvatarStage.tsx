import { AvatarLoading } from "../components/AvatarLoading";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvatarAudioSignal,
  AvatarExpression,
  AvatarModelManifest,
  AvatarRenderer,
  AvatarRendererLoader,
  AvatarPreview,
} from "./avatar-contract";
import { readBrowserAvatarCapability, type AvatarCapability } from "./avatar-capability";
import { useAvatarInteraction } from "./avatar-interaction";
import { createAvatarSignalAdapter } from "./avatar-signal";

type AnimationClock = {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
};

const browserAnimationClock: AnimationClock = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (id) => window.cancelAnimationFrame(id),
};

const defaultAudioSignal: AvatarAudioSignal = { speechState: "silent", volume: 0 };

const lazyVerifiedRenderer: AvatarRendererLoader = async (canvas, manifest, signal) => {
  const { loadVerifiedAvatarRenderer } = await import("./avatar-loader");
  return loadVerifiedAvatarRenderer({ canvas, manifest, signal });
};

function disposeRenderer(renderer: AvatarRenderer | null): void {
  try {
    renderer?.dispose();
  } catch {
    // A broken optional renderer must never take down the static YUI surface.
  }
}

export type AvatarStageProps = {
  /** A local renderer shares playback signals, gestures and lifecycle with Live2D. */
  rendererSource?: { load: (canvas: HTMLCanvasElement, signal: AbortSignal) => Promise<AvatarRenderer> };
  className?: string;
  fallbackNotice?: string;
  loadingNotice?: string;
  preview?: AvatarPreview;
  onPreviewFinished?: () => void;
  onStateChange?: (state: "static" | "loading" | "ready" | "failed") => void;
  enabled: boolean;
  interactive?: boolean;
  interactionMode?: "zoom" | "orbit";
  expression?: AvatarExpression;
  expressionKey?: string;
  preparing?: boolean;
  visible?: boolean;
  /** Read-only playback levels; never requests microphone permission. */
  readAudioSignal?: () => AvatarAudioSignal;
  manifest?: AvatarModelManifest;
  fallback: { readonly src: string; readonly alt: string };
  audioSignal?: AvatarAudioSignal;
  capability?: AvatarCapability;
  loadRenderer?: AvatarRendererLoader;
  animationClock?: AnimationClock;
  onFallbackError?: () => void;
};

export function AvatarStage({
  rendererSource,
  className = '',
  fallbackNotice = '静止画で表示しています',
  loadingNotice,
  preview,
  onPreviewFinished,
  onStateChange,
  enabled,
  interactive = false,
  interactionMode = "zoom",
  expression = "neutral",
  expressionKey,
  preparing = false,
  visible = true,
  readAudioSignal,
  manifest,
  fallback,
  audioSignal = defaultAudioSignal,
  capability,
  loadRenderer = lazyVerifiedRenderer,
  animationClock = browserAnimationClock,
  onFallbackError,
}: AvatarStageProps) {
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const finishedRef = useRef(onPreviewFinished);
  finishedRef.current = onPreviewFinished;
  const expressionRef = useRef({expression, expressionKey});
  expressionRef.current = {expression, expressionKey};
  const preparingRef = useRef(preparing);
  preparingRef.current = preparing;
  const stageRef = useRef<HTMLElement>(null);
  const { view: placement, orbit } = useAvatarInteraction(stageRef, interactive, interactionMode);
  const orbitRef = useRef(orbit);
  orbitRef.current = orbit;
  const placementStyle = interactive ? { scale: placement.scale } : undefined;
  const [foreground, setForeground] = useState(document.visibilityState !== "hidden");
  const [inViewport, setInViewport] = useState(typeof IntersectionObserver !== "function");
  const [reducedMotion, setReducedMotion] = useState(false);
  const failedRef = useRef(false);
  const readAudioRef = useRef(readAudioSignal);
  readAudioRef.current = readAudioSignal;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const adapterRef = useRef(createAvatarSignalAdapter());
  const [state, setState] = useState<"static" | "loading" | "ready" | "failed">("static");
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  const admission = useMemo(() => capability ?? readBrowserAvatarCapability(enabled), [capability, enabled, reducedMotion]);

  useEffect(() => {
    const visibilityChanged = () => setForeground(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibilityChanged);
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const motionChanged = () => setReducedMotion(media?.matches ?? false);
    motionChanged();
    media?.addEventListener("change", motionChanged);
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => setInViewport(entry.isIntersecting)) : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      media?.removeEventListener("change", motionChanged);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    adapterRef.current.setAudio(audioSignal);
  }, [audioSignal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!enabled || !visible || !foreground || !inViewport || reducedMotion || (!manifest && !rendererSource) || admission.mode !== "animate" || !canvas || failedRef.current) {
      setState(failedRef.current ? "failed" : "static");
      return;
    }

    const controller = new AbortController();
    let active = true;
    let renderer: AvatarRenderer | null = null;
    let frameId: number | null = null;
    let firstTimestamp: number | null = null;
    let lastTimestamp = -Infinity;
    let observer: ResizeObserver | null = null;
    setState("loading");

    const releaseRenderer = () => {
      observer?.disconnect();
      observer = null;
      if (frameId !== null) animationClock.cancel(frameId);
      frameId = null;
      const released = renderer;
      renderer = null;
      disposeRenderer(released);
    };
    const failClosed = () => {
      if (!active) return;
      failedRef.current = true;
      controller.abort();
      releaseRenderer();
      setState("failed");
    };

    const resize = () => {
      if (!renderer) return;
      const width = Math.max(1, canvas.clientWidth || 320);
      const height = Math.max(1, canvas.clientHeight || 320);
      const devicePixelRatio = Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
      renderer.resize(width, height, devicePixelRatio);
    };
    const renderFrame = (timestamp: number) => {
      if (!active || !renderer) return;
      try {
        firstTimestamp ??= timestamp;
        if (timestamp - lastTimestamp >= 1000 / 30 - 0.5) {
          if (readAudioRef.current) adapterRef.current.setAudio(readAudioRef.current());
          const frame = adapterRef.current.frame(timestamp - firstTimestamp);
          renderer.setOrientation?.(orbitRef.current.yaw, orbitRef.current.pitch);
          const result = renderer.setInput({ ...frame, ...(preparingRef.current && frame.speechState !== 'speaking' ? {speechState: 'preparing' as const} : {}), ...expressionRef.current, ...(previewRef.current ? { preview: previewRef.current } : {}) });
          if (result?.finished) finishedRef.current?.();
          lastTimestamp = timestamp;
        }
        frameId = animationClock.request(renderFrame);
      } catch {
        failClosed();
      }
    };

    const contextLost = (event: Event) => { event.preventDefault(); failClosed(); };
    canvas.addEventListener("webglcontextlost", contextLost);
    void Promise.resolve().then(() => rendererSource ? rendererSource.load(canvas, controller.signal) : loadRenderer(canvas, manifest!, controller.signal)).then((loaded) => {
      if (!active || controller.signal.aborted) {
        disposeRenderer(loaded);
        return;
      }
      renderer = loaded;
      try {
        resize();
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(() => {
            try {
              resize();
            } catch {
              failClosed();
            }
          });
          observer.observe(canvas);
        }
        setState("ready");
        frameId = animationClock.request(renderFrame);
      } catch {
        failClosed();
      }
    }, () => {
      failClosed();
    });

    return () => {
      active = false;
      canvas.removeEventListener("webglcontextlost", contextLost);
      controller.abort();
      releaseRenderer();
    };
  }, [admission, animationClock, enabled, visible, foreground, inViewport, reducedMotion, loadRenderer, manifest, rendererSource]);

  const activeSurface = enabled && (manifest || rendererSource) && admission.mode === "animate" && visible && foreground && inViewport && !reducedMotion;
  const ready = state === "ready" && visible && foreground && inViewport && !reducedMotion;
  const showStatus = enabled && ((!manifest && !rendererSource) || admission.mode === "fallback" || reducedMotion || state === "failed");

  const showLoading = !!loadingNotice && !ready && !showStatus;

  return <figure ref={stageRef} className={`live2d-avatar-stage ${className}`} data-state={state} data-interactive={interactive || undefined} data-interaction-mode={interactive ? interactionMode : undefined}>
    <img style={placementStyle} draggable={false} className="live2d-avatar-fallback" src={fallback.src} alt={fallback.alt} hidden={ready || showLoading} onError={onFallbackError} />
    {activeSurface ? <canvas style={placementStyle} ref={canvasRef} className="live2d-avatar-canvas" data-testid="live2d-avatar-canvas" role="img" aria-label={fallback.alt} hidden={!ready} /> : null}
    {showLoading ? <AvatarLoading label={loadingNotice} /> : null}
    {showStatus ? <figcaption className="live2d-avatar-status">{fallbackNotice}</figcaption> : null}
  </figure>;
}
