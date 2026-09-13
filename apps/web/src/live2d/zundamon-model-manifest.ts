import type { AvatarModelManifest } from './avatar-contract';
import { MOTION_GALLERY_ASSET } from './motion-gallery-catalog';

export const ZUNDAMON_MODEL_ID = 'live2d-official-zundamon-2026-08-25';
export const ZUNDAMON_PORTRAIT = { src: '/live2d/zundamon/poster.png', alt: 'ずんだもん' };
export const ZUNDAMON_NOTICE = 'キャラクター：東北ずん子・ずんだもんプロジェクト／イラスト：坂本アヒル／モデリング：Live2D Inc.／Live2D Cubism SDK使用。非公式の本人用試作です。';

export function createZundamonModelManifest(bridgeSha256: string | undefined): AvatarModelManifest | undefined {
  if (!bridgeSha256 || !/^[a-f0-9]{64}$/.test(bridgeSha256)) return undefined;
  return {
    id: ZUNDAMON_MODEL_ID,
    sdkVersion: '5-r.5',
    bridge: { path: 'yui-zundamon-bridge.js', url: '/live2d/vendor/yui-zundamon-bridge.js', sha256: bridgeSha256, maxBytes: 1_048_576 },
    assets: [
      MOTION_GALLERY_ASSET,
      { path: 'Core/live2dcubismcore.min.js', url: '/live2d/vendor/live2dcubismcore.min.js', sha256: '8741f739779b5d5210872bd3d7d99f0f1e56e6c87409e7d26d6bb4b80aa1ef47', maxBytes: 228_042 },
      { path: 'zundamon.model3.json', url: '/live2d/zundamon/zundamon.model3.json', sha256: '8158325400bbe402e4e7f1400865fabc175892f17e7a8cb95727f99c201b7635', maxBytes: 4513 },
      { path: 'zundamon.moc3', url: '/live2d/zundamon/zundamon.moc3', sha256: '9f177a5d90d36138b86e17a9f437c4600362af227c07d99a7a2f65c774a774b2', maxBytes: 1892032 },
      { path: 'zundamon.2048/texture_00.png', url: '/live2d/zundamon/zundamon.2048/texture_00.png', sha256: 'f153264cd740bb08c0c06bc16892ddc92ccc3a8247f26175dc0040bb0f0b4d07', maxBytes: 2195500 },
      { path: 'zundamon.physics3.json', url: '/live2d/zundamon/zundamon.physics3.json', sha256: '4875fd369f3fd2a8a6e58e31b17dcc19442ec4e36a6988494017f5cad3eaf925', maxBytes: 17448 },
    ],
    notice: ZUNDAMON_NOTICE,
    provisional: true,
  };
}
