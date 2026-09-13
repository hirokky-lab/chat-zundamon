import { useEffect, useRef, useState, type RefObject } from "react";

export function boundAvatarScale(scale: number) {
  return Math.max(.65, Math.min(2, scale));
}

export function boundAvatarOrbit(yaw: number, pitch: number) {
  return { yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)), pitch: Math.max(-.65, Math.min(.65, pitch)) };
}

export function useAvatarInteraction(stage: RefObject<HTMLElement | null>, enabled: boolean, mode: "zoom" | "orbit" = "zoom") {
  const [orbit, setOrbit] = useState({ yaw: 0, pitch: 0 });
  const orbitRef = useRef(orbit);
  const [view, setView] = useState({ scale: 1 });
  const current = useRef(view);
  current.current = view;
  useEffect(() => {
    const element = stage.current;
    if (!enabled || !element) return;
    const points = new Map<number, { x: number; y: number }>();
    const geometry = () => {
      const values = [...points.values()];
      return { x: values.reduce((n, p) => n + p.x, 0) / values.length, y: values.reduce((n, p) => n + p.y, 0) / values.length,
        distance: values.length === 2 ? Math.hypot(values[1].x-values[0].x, values[1].y-values[0].y) : 0 };
    };
    const update = (scale: number) => {
      current.current = { scale: boundAvatarScale(scale) };
      setView(current.current);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button') || points.size >= 2) return;
      event.preventDefault(); event.stopPropagation();
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      element.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return;
      event.preventDefault(); event.stopPropagation();
      const before = geometry();
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = geometry(), v = current.current;
      if (mode === "orbit" && points.size === 1) {
        orbitRef.current = boundAvatarOrbit(orbitRef.current.yaw + (after.x-before.x) * .008, orbitRef.current.pitch + (after.y-before.y) * .006);
        setOrbit(orbitRef.current);
      } else if (points.size === 2 && before.distance > 0) {
        update(v.scale * after.distance / before.distance);
      }
    };
    const up = (event: PointerEvent) => { points.delete(event.pointerId); };
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const v = current.current;
      update(v.scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .002));
    };
    element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up); element.addEventListener('lostpointercapture', up);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up); element.removeEventListener('lostpointercapture', up);
      element.removeEventListener('wheel', wheel);
    };
  }, [enabled, stage, mode]);
  return { view, orbit };
}
