import { describe, expect, it } from "vitest";
import { isLive2dAvatarEnabled } from "../src/live2d/avatar-feature";
import { createSimpleModelManifest } from "../src/live2d/simple-model-manifest";

describe("Live2D avatar feature flag", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true "])("keeps %s off", (value) => {
    expect(isLive2dAvatarEnabled(value)).toBe(false);
  });

  it("accepts only the exact true value", () => {
    expect(isLive2dAvatarEnabled("true")).toBe(true);
  });

  it("requires an exact bridge hash before exposing the official Simple model manifest", () => {
    expect(createSimpleModelManifest(undefined)).toBeUndefined();
    expect(createSimpleModelManifest("A".repeat(64))).toBeUndefined();
    expect(createSimpleModelManifest("a".repeat(63))).toBeUndefined();
    expect(createSimpleModelManifest("a".repeat(64))).toMatchObject({
      id: "live2d-official-simple-2026-05-28",
      sdkVersion: "5-r.5",
      provisional: true,
    });
  });
});
