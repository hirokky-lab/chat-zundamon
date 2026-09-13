import { describe, expect, it } from "vitest";
import { Object3D, Vector3 } from "three";
import type { VRM } from "@pixiv/three-vrm";
import { setVrmRestPose } from "../src/vrm/vrm-pose";

describe("VRM resting arms", () => {
  it.each(["0", "1"] as const)("lowers both hands in VRM %s coordinates", (metaVersion) => {
    const bones: Record<string, Object3D> = {};
    for (const [side, sign] of [["left", 1], ["right", -1]] as const) {
      const arm = new Object3D();
      const hand = new Object3D();
      hand.position.x = sign * (metaVersion === "0" ? -1 : 1) * 0.3;
      arm.add(hand);
      bones[`${side}UpperArm`] = arm;
      bones[`${side}Hand`] = hand;
    }
    setVrmRestPose({
      meta: { metaVersion },
      humanoid: { getNormalizedBoneNode: (name: string) => bones[name] },
    } as Pick<VRM, "meta" | "humanoid">);
    for (const side of ["left", "right"]) {
      const hand = bones[`${side}Hand`].getWorldPosition(new Vector3());
      const shoulder = bones[`${side}UpperArm`].getWorldPosition(new Vector3());
      expect(hand.y).toBeLessThan(shoulder.y - 0.2);
    }
  });
});
