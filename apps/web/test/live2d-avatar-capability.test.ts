import { describe, expect, it } from "vitest";
import { assessAvatarCapability } from "../src/live2d/avatar-capability";

const supported = {
  enabled: true,
  reducedMotion: false,
  coarsePointer: false,
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  webgl2: true,
};

describe("Live2D avatar capability admission", () => {
  it("admits only an explicitly enabled supported device", () => {
    expect(assessAvatarCapability(supported)).toEqual({ mode: "animate" });
  });

  it.each([
    ["disabled", { enabled: false }],
    ["reduced-motion", { reducedMotion: true }],
    ["low-performance", { hardwareConcurrency: 2 }],
    ["low-performance", { deviceMemoryGb: 2 }],
    ["unsupported", { webgl2: false }],
  ] as const)("fails closed as %s", (reason, override) => {
    expect(assessAvatarCapability({ ...supported, ...override })).toEqual({ mode: "fallback", reason });
  });

  it("admits Safari with coarse pointer and undisclosed memory", () => {
    expect(assessAvatarCapability({
      ...supported,
      coarsePointer: true,
      hardwareConcurrency: 4,
      deviceMemoryGb: undefined,
    })).toEqual({ mode: "animate" });
  });
});
