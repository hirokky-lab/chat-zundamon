import { describe, expect, it } from "vitest";
import { createAvatarSignalAdapter } from "../src/live2d/avatar-signal";

describe("Live2D avatar signal adapter", () => {
  it("keeps silent fixture input closed and deterministic", () => {
    const adapter = createAvatarSignalAdapter();

    expect(adapter.frame(0)).toEqual({
      elapsedMs: 0,
      eyeOpenLeft: 1,
      eyeOpenRight: 1,
      idle: 0.5,
      mouthOpen: 0,
      speechState: "silent",
      volume: 0,
    });
    expect(adapter.frame(0)).toEqual(adapter.frame(0));
  });

  it("normalizes speaking volume and drives mouth input", () => {
    const adapter = createAvatarSignalAdapter();
    adapter.setAudio({ speechState: "speaking", volume: 4 });

    expect(adapter.frame(1_000)).toMatchObject({
      mouthOpen: 1,
      speechState: "speaking",
      volume: 1,
    });

    adapter.setAudio({ speechState: "speaking", volume: -2 });
    expect(adapter.frame(1_000)).toMatchObject({ mouthOpen: 0, volume: 0 });
  });

  it("uses a bounded preparing fixture without pretending real audio is connected", () => {
    const adapter = createAvatarSignalAdapter();
    adapter.setAudio({ speechState: "preparing", volume: 0.9 });

    expect(adapter.frame(500)).toMatchObject({
      mouthOpen: 0.12,
      speechState: "preparing",
      volume: 0,
    });
  });

  it("generates bounded idle and blink inputs", () => {
    const adapter = createAvatarSignalAdapter();

    expect(adapter.frame(2_000).idle).toBeGreaterThan(0.5);
    expect(adapter.frame(3_760)).toMatchObject({ eyeOpenLeft: 0, eyeOpenRight: 0 });
    expect(adapter.frame(4_000)).toMatchObject({ eyeOpenLeft: 1, eyeOpenRight: 1 });
    expect(adapter.frame(20_000).idle).toBeGreaterThanOrEqual(0);
    expect(adapter.frame(20_000).idle).toBeLessThanOrEqual(1);
  });
});
