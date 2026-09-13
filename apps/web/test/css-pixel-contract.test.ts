import { describe, expect, it } from "vitest";
import { meetsCssPixelMinimum } from "./support/css-pixel-contract";

describe("CSS pixel minimum contract", () => {
  it("accepts Chromium's one-layout-unit observation error without lowering the minimum", () => {
    expect(meetsCssPixelMinimum(44, 44)).toBe(true);
    expect(meetsCssPixelMinimum(43.99993896484375, 44)).toBe(true);
  });

  it("rejects values outside the explicit observation epsilon", () => {
    expect(meetsCssPixelMinimum(43.9998779296875, 44)).toBe(false);
    expect(meetsCssPixelMinimum(43, 44)).toBe(false);
    expect(meetsCssPixelMinimum(Number.NaN, 44)).toBe(false);
  });
});
