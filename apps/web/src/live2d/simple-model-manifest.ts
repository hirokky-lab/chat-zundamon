import type { AvatarModelManifest } from "./avatar-contract";

export const SIMPLE_MODEL_NOTICE = "本作品のキャラクターには株式会社Live2Dの著作物であるサンプルデータが株式会社Live2Dの定める規約に従って用いられています。本作品は制作者の完全な自己の裁量で制作されています。";

export function createSimpleModelManifest(bridgeSha256: string | undefined): AvatarModelManifest | undefined {
  if (!bridgeSha256 || !/^[a-f0-9]{64}$/.test(bridgeSha256)) return undefined;
  return {
    id: "live2d-official-simple-2026-05-28",
    sdkVersion: "5-r.5",
    bridge: {
      path: "yui-cubism-bridge.js",
      url: "/live2d/vendor/yui-cubism-bridge.js",
      sha256: bridgeSha256,
      maxBytes: 1_048_576,
    },
    assets: [
      { path: "Core/live2dcubismcore.min.js", url: "/live2d/vendor/live2dcubismcore.min.js", sha256: "8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47", maxBytes: 228_042 },
      { path: "simple.model3.json", url: "/live2d/simple/simple.model3.json", sha256: "a96791fa4c813e51d85840643e67add7b58382b17a35fb95a83c4a5a353c6cba", maxBytes: 499 },
      { path: "simple.moc3", url: "/live2d/simple/simple.moc3", sha256: "f710118fccd40ffdb2893dfd9866173f5c4002dc89798d345a890c127dba0ba1", maxBytes: 22_080 },
      { path: "simple.1024/texture_00.png", url: "/live2d/simple/simple.1024/texture_00.png", sha256: "fe16a1630cfec79fdb6fe1fbe4d5f112ad9ae425adfee5954b205a1f1ce15987", maxBytes: 215_379 },
      { path: "simple.cdi3.json", url: "/live2d/simple/simple.cdi3.json", sha256: "ccba459205b4c34de5518c3f9e661d54f9ea9ad6f5feef3dddf4f59c3fea03c4", maxBytes: 2_916 },
      { path: "motion/Scene.motion3.json", url: "/live2d/simple/motion/Scene.motion3.json", sha256: "54168f8a90dbd0b0e6291b526a2c2b07bc86c8734c6dbf27153a52f30fe1765e", maxBytes: 1_178 },
    ],
    notice: SIMPLE_MODEL_NOTICE,
    provisional: true,
  };
}
