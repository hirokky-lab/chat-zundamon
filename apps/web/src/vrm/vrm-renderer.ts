import {
  AmbientLight,
  Box3,
  DirectionalLight,
  LoadingManager,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import type {
  AvatarExpression,
  AvatarRenderer,
} from "../live2d/avatar-contract";
import { inspectVrm } from "./vrm-file";
import { setVrmRestPose } from "./vrm-pose";
import { createVrmMotion } from "./vrm-motion";

const expressions: Partial<Record<AvatarExpression, string>> = {
  smile: "happy",
  greeting: "happy",
  agree: "happy",
  sad: "sad",
  afraid: "sad",
  angry: "angry",
  surprise: "surprised",
  shy: "relaxed",
  thinking: "relaxed",
};
const presets = ["happy", "sad", "angry", "surprised", "relaxed"];

export async function loadVrmRenderer(
  canvas: HTMLCanvasElement,
  data: ArrayBuffer,
  signal: AbortSignal,
): Promise<AvatarRenderer> {
  inspectVrm(data);
  signal.throwIfAborted();
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    // Embedded textures produce object URLs inside GLTFLoader. No remote fetches.
    if (url.startsWith("blob:") || url.startsWith("data:")) return url;
    throw Error("External VRM resource rejected");
  });
  const loader = new GLTFLoader(manager);
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(data, "");
  const vrm: VRM | undefined = gltf.userData.vrm;
  if (!vrm || signal.aborted) {
    VRMUtils.deepDispose(gltf.scene);
    signal.throwIfAborted();
    throw Error("Missing VRM");
  }
  let renderer: WebGLRenderer | undefined;
  const scene = new Scene();
  scene.add(vrm.scene);
  try {
    VRMUtils.rotateVRM0(vrm);
    const bones = vrm.humanoid;
    setVrmRestPose(vrm);
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(vrm.scene),
      size = bounds.getSize(new Vector3()),
      center = bounds.getCenter(new Vector3());
    if (!Number.isFinite(size.y) || size.y < 0.1 || size.y > 100)
      throw Error("Invalid model bounds");
    // Center the whole model; viewport width never introduces a sideways offset.
    vrm.scene.position.x -= center.x;
    const camera = new PerspectiveCamera(30, 1, 0.01, 1000);
    const ambient = new AmbientLight(0xffffff, 1.4),
      key = new DirectionalLight(0xffffff, 2.2);
    key.target.position.set(0, center.y, 0);
    scene.add(ambient, key, key.target);
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setClearColor(0, 0);
    const activeRenderer = renderer;
    let distance = 1, yaw = 0, pitch = 0;
    const updateCamera = () => {
      camera.position.set(
        -distance * Math.sin(yaw) * Math.cos(pitch),
        center.y + distance * Math.sin(pitch),
        distance * Math.cos(yaw) * Math.cos(pitch),
      );
      camera.lookAt(0, center.y, 0);
      // A soft front light follows the viewing direction, including after orbiting.
      key.position.copy(camera.position);
      key.position.y += size.y * .4;
    };
    let previous = 0,
      disposed = false;
    const motion = createVrmMotion();
    const direction = vrm.meta?.metaVersion === "0" ? -1 : 1;
    const leftArm = bones.getNormalizedBoneNode("leftUpperArm"), rightArm = bones.getNormalizedBoneNode("rightUpperArm");
    const leftElbow = bones.getNormalizedBoneNode("leftLowerArm"), rightElbow = bones.getNormalizedBoneNode("rightLowerArm"), rightHand = bones.getNormalizedBoneNode("rightHand");
    const spine = bones.getNormalizedBoneNode("spine"),
      head = bones.getNormalizedBoneNode("head");
    return {
      setOrientation(nextYaw, nextPitch) {
        if (disposed || (yaw === nextYaw && pitch === nextPitch)) return;
        yaw = nextYaw;
        pitch = nextPitch;
        updateCamera();
      },
      resize(width, height, dpr) {
        if (disposed) return;
        activeRenderer.setPixelRatio(Math.min(dpr, 1.5));
        activeRenderer.setSize(width, height, false);
        camera.aspect = width / height;
        const fitHeight = size.y * 1.12,
          fitWidth = size.x * 1.12;
        distance =
          Math.max(fitHeight, fitWidth / camera.aspect) /
          (2 * Math.tan(Math.PI / 12));
        updateCamera();
        camera.updateProjectionMatrix();
      },
      setInput(input) {
        if (disposed) return;
        const delta = previous
          ? Math.min(0.1, Math.max(0, (input.elapsedMs - previous) / 1000))
          : 0;
        previous = input.elapsedMs;
        const { pose, finished } = motion.frame(input);
        const blend = Math.min(1, delta * 12);
        const approach = (current: number, target: number) => current + (target-current)*blend;
        if (spine) { spine.rotation.z = approach(spine.rotation.z, pose.spineZ*direction); spine.rotation.x = approach(spine.rotation.x, pose.spineX*direction); }
        if (head) {
          head.rotation.x = approach(head.rotation.x, pose.headX*direction);
          head.rotation.y = approach(head.rotation.y, pose.headY);
          head.rotation.z = approach(head.rotation.z, pose.headZ*direction);
        }
        for (const [bone, angle] of [[leftArm,pose.leftArm],[rightArm,pose.rightArm],[leftElbow,pose.leftElbow],[rightElbow,pose.rightElbow],[rightHand,pose.rightHand]] as const) {
          if (bone) bone.rotation.z = approach(bone.rotation.z, angle*direction);
        }
        const expression = expressions[input.expression ?? "neutral"];
        for (const name of presets) {
          const current = vrm.expressionManager?.getValue(name) ?? 0;
          vrm.expressionManager?.setValue(
            name,
            current +
              ((name === expression ? 0.6 : 0) - current) *
                Math.min(1, delta * 8),
          );
        }
        vrm.expressionManager?.setValue(
          "blink",
          Math.max(pose.eyeClose, 1 - (input.eyeOpenLeft + input.eyeOpenRight) / 2),
        );
        vrm.expressionManager?.setValue(
          "aa",
          input.speechState === "speaking" ? input.mouthOpen : 0,
        );
        vrm.update(delta);
        activeRenderer.render(scene, camera);
        return { finished };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        VRMUtils.deepDispose(scene);
        activeRenderer.dispose();
      },
    };
  } catch (error) {
    VRMUtils.deepDispose(scene);
    renderer?.dispose();
    throw error;
  }
}
