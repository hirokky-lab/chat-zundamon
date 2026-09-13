/** Fit against the visible viewport, independently of extra raster space for gestures. */
export function avatarProjection(width: number, height: number, spanX: number, spanY: number, fit: number, horizontalOverscan = 1) {
  const aspect = height / width;
  return { aspect, scale: Math.min(fit / spanY, fit / (spanX * aspect * horizontalOverscan)) };
}
