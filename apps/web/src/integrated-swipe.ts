import { useRef, type PointerEventHandler } from "react";
import type { IntegratedSwipeDirection } from "./integrated-ui";

type Gesture = { pointerId: number; startX: number; startY: number } | null;
const HORIZONTAL_THRESHOLD = 56;

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, textarea, select, summary, a, img, [contenteditable='true']"));
}

export function useIntegratedSwipe(onSwipe?: (direction: IntegratedSwipeDirection) => void): {
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
} {
  const gesture = useRef<Gesture>(null);
  const cancelled = useRef(false);

  const reset = () => { gesture.current = null; cancelled.current = false; };

  return {
    onPointerDown: (event) => {
      if (gesture.current && gesture.current.pointerId !== event.pointerId) {
        reset();
        return;
      }
      // JSDOM does not populate isPrimary, while real secondary pointers are false.
      if (!onSwipe || event.isPrimary === false || isInteractiveTarget(event.target)) return;
      gesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
      cancelled.current = false;
    },
    onPointerMove: (event) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientY - current.startY) > Math.abs(event.clientX - current.startX)) cancelled.current = true;
    },
    onPointerUp: (event) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const horizontal = event.clientX - current.startX;
      const vertical = event.clientY - current.startY;
      const shouldNavigate = !cancelled.current
        && Math.abs(horizontal) >= HORIZONTAL_THRESHOLD
        && Math.abs(horizontal) > Math.abs(vertical);
      reset();
      if (shouldNavigate) onSwipe?.(horizontal < 0 ? "next" : "previous");
    },
    onPointerCancel: reset,
  };
}
