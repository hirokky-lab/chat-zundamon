// Local preparation only. Download archives from the official URLs documented
// in the handoff before running; this script never publishes or fetches material.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { prepareMotionGallery } from './prepare-motion-gallery.mjs';
const root = resolve(import.meta.dirname, '../..');
const local = resolve(root, '.superpowers/zundamon');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, hash] of [['model.zip', '25a3bcd91a81798f81f559a086acd407d6eff5525996ce328ff4708ea23c7797'], ['sdk.zip', '67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0']]) {
  if (digest(await readFile(resolve(local, name))) !== hash) throw new Error(`Official archive changed: ${name}`);
}
execFileSync('unzip', ['-o', '-q', resolve(local, 'model.zip'), 'runtime/*', 'ReadMe.txt', '-d', resolve(local, 'model')]);
execFileSync('unzip', ['-o', '-q', resolve(local, 'sdk.zip'), '*/Framework/*', '*/Core/*', '*/LICENSE.md', '*/NOTICE.md', '-d', resolve(local, 'sdk')]);
const sdk = resolve(local, 'sdk/CubismSdkForWeb-5-r.5');
const typeConfig = resolve(local, 'bridge-tsconfig.json');
await writeFile(typeConfig, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], noEmit: true, useDefineForClassFields: false, skipLibCheck: true, strictNullChecks: false, types: [], baseUrl: root, paths: { '@cubism/*': [resolve(sdk, 'Framework/src/*')] } }, files: [resolve(root, 'scripts/live2d/zundamon-bridge.ts'), resolve(sdk, 'Core/live2dcubismcore.d.ts')] }, null, 2));
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', typeConfig], { stdio: 'inherit' });
const output = resolve(root, 'apps/web/public/live2d');
await mkdir(resolve(output, 'vendor'), { recursive: true });
await mkdir(resolve(output, 'zundamon'), { recursive: true });
await prepareMotionGallery(root, resolve(local, 'model/runtime'), output);
for (const name of ['zundamon.model3.json', 'zundamon.moc3', 'zundamon.physics3.json', 'zundamon.2048/texture_00.png']) {
  const destination = resolve(output, 'zundamon', name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(local, 'model/runtime', name), destination);
}
await copyFile(resolve(sdk, 'Core/live2dcubismcore.min.js'), resolve(output, 'vendor/live2dcubismcore.min.js'));
await copyFile(resolve(local, 'model/ReadMe.txt'), resolve(output, 'zundamon/ReadMe.txt'));
for (const [source, target] of [['LICENSE.md', 'SDK-LICENSE.md'], ['Framework/LICENSE.md', 'Framework-LICENSE.md'], ['Core/LICENSE.md', 'Core-LICENSE.md'], ['Core/RedistributableFiles.txt', 'RedistributableFiles.txt']]) {
  await copyFile(resolve(sdk, source), resolve(output, 'vendor', target));
}
const webRequire = createRequire(resolve(root, 'apps/web/package.json'));
const { build } = createRequire(webRequire.resolve('vite'))('esbuild');
const shaderFiles = await readdir(resolve(sdk, 'Framework/Shaders/WebGL'));
const shaders = Object.fromEntries(await Promise.all(shaderFiles.filter(name => /\.(vert|frag)$/.test(name)).map(async name => [name, await readFile(resolve(sdk, 'Framework/Shaders/WebGL', name), 'utf8')])));
const inlineShaders = { name: 'verified-inline-cubism-shaders', setup(build) {
  build.onLoad({ filter: /cubismshader_webgl\.ts$/ }, async ({ path }) => {
    const original = await readFile(path, 'utf8');
    const needle = 'const response = await fetch(url);\n    return await response.text();';
    if (original.split(needle).length !== 2) throw new Error('SDK shader loader changed');
    const replacement = `const shaders: Record<string, string> = ${JSON.stringify(shaders)}; const source = shaders[url.split('/').pop()!]; if (!source) throw new Error('avatar_shader_rejected'); return source;`;
    return { contents: original.replace(needle, replacement), loader: 'ts' };
  });
} };
const bridge = resolve(output, 'vendor/yui-zundamon-bridge.js');
await build({ entryPoints: [resolve(root, 'scripts/live2d/zundamon-bridge.ts')], outfile: bridge, tsconfig: typeConfig, banner: { js: '/*! Cubism Web Framework: Copyright(c) Live2D Inc. All rights reserved. Live2D Open Software License: https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html . Modified for YUI: shader source loading is inlined from the pinned SDK archive. */' }, plugins: [inlineShaders], bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'inline', alias: { '@cubism': resolve(sdk, 'Framework/src') } });
const sha256 = digest(await readFile(bridge));
await writeFile(resolve(output, 'zundamon/local-bridge.json'), JSON.stringify({ sha256 }));
await writeFile(resolve(local, 'runtime.env'), `VITE_YUI_LIVE2D_AVATAR_ENABLED=true\nVITE_YUI_LIVE2D_MODEL=zundamon\nVITE_YUI_LIVE2D_BRIDGE_SHA256=${sha256}\n`);
console.log(JSON.stringify({ bridgeSha256: sha256, bridgeBytes: (await readFile(bridge)).length, status: 'local-only; poster.png required separately' }));
