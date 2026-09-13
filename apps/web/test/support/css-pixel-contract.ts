// Chromium can expose an exact 44 CSS px layout as one 1/16384 px unit below
// the computed value through getBoundingClientRect(). Keep this tolerance tied
// to that observation quantum; it is not a smaller interaction-size contract.
export const CSS_PIXEL_OBSERVATION_EPSILON = 1 / 16_384;

export function meetsCssPixelMinimum(actual: number, minimum: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(minimum)) return false;
  return actual >= minimum || minimum - actual <= CSS_PIXEL_OBSERVATION_EPSILON;
}
