import { useEffect, useRef, type TransitionEvent } from "react";

const normalFadeDurationMs = 240;
const reducedFadeDurationMs = 80;

export function Splash({ ready, onDismiss }: { ready: boolean; onDismiss?: () => void }) {
  const dismissedRef = useRef(false);
  const dismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    onDismiss?.();
  };

  useEffect(() => {
    if (!ready) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(dismiss, reduced ? reducedFadeDurationMs : normalFadeDurationMs);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const onTransitionEnd = (event: TransitionEvent<HTMLElement>) => {
    if (event.target === event.currentTarget && event.propertyName === "opacity") dismiss();
  };

  return <main className={`splash-screen${ready ? " is-ready" : ""}`} aria-label={ready ? undefined : "Chatずんだもん 起動画面"} aria-hidden={ready || undefined} data-testid="launch-screen" onTransitionEnd={onTransitionEnd}>
  </main>;
}
