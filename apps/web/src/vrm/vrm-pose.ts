import type { VRM } from "@pixiv/three-vrm";

export const VRM_REST_ARM_ANGLE = 1.2;

export function setVrmRestPose(vrm: Pick<VRM, "humanoid" | "meta">): void {
  // rotateVRM0 turns the scene, but its normalized rig keeps the original axes.
  const direction = vrm.meta?.metaVersion === "0" ? -1 : 1;
  const left = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
  const right = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
  if (left) left.rotation.z = -VRM_REST_ARM_ANGLE * direction;
  if (right) right.rotation.z = VRM_REST_ARM_ANGLE * direction;
}
