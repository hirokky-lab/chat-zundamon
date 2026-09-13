import { avatarProjection } from "../../apps/web/src/live2d/avatar-projection";
import { createAvatarBodyMotion } from "../../apps/web/src/live2d/avatar-body-motion";
import { createConversationMotion } from "../../apps/web/src/live2d/conversation-motion";
// YUI-owned adapter. Cubism code is supplied separately by the official SDK.
import type { CubismUserModel as UserModel } from '@cubism/model/cubismusermodel';
import type { AvatarFrameInput, AvatarModelManifest, AvatarRenderer } from '../../apps/web/src/live2d/avatar-contract';

const coreKey = '__yuiVerifiedCubismCore' as const;
type CoreHost = typeof globalThis & { [coreKey]?: Promise<void> };
function loadCore(bytes: Uint8Array): Promise<void> {
  const host = globalThis as CoreHost;
  return host[coreKey] ??= new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'text/javascript' }));
    const script = document.createElement('script');
    const done = (error?: Error) => {
      clearTimeout(timer); script.remove(); URL.revokeObjectURL(url);
      if (error) { delete host[coreKey]; reject(error); } else resolve();
    };
    const timer = setTimeout(() => done(new Error('avatar_core_failed')), 5000);
    script.onload = () => done();
    script.onerror = () => done(new Error('avatar_core_failed'));
    script.src = url;
    document.head.append(script);
  });
}

type RendererContext = { canvas: HTMLCanvasElement; manifest: AvatarModelManifest; assets: ReadonlyMap<string, Uint8Array> };
let previousRelease = Promise.resolve();
export async function createAvatarRenderer(context: RendererContext): Promise<AvatarRenderer> {
  // The SDK has shared static state. A cancelled initialization must finish and
  // dispose before the next model touches it; the loader disposes late results.
  const previous = previousRelease;
  let release!: () => void;
  previousRelease = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const renderer = await createRenderer(context);
    return { ...renderer, dispose() { try { renderer.dispose(); } finally { release(); } } };
  } catch (error) { release(); throw error; }
}

async function createRenderer({ canvas, manifest, assets }: RendererContext): Promise<AvatarRenderer> {
  if (manifest.id !== 'live2d-official-zundamon-2026-08-25') throw new Error('avatar_model_rejected');
  const bytes = (path: string) => {
    const value = assets.get(path);
    if (!value) throw new Error('avatar_asset_rejected');
    return value;
  };
  await loadCore(bytes('Core/live2dcubismcore.min.js'));
  // Cubism 5 enums access Core during module initialization. Defer Framework
  // evaluation until verified Core has finished loading.
  const { CubismFramework } = await import('@cubism/live2dcubismframework');
  const { CubismUserModel } = await import('@cubism/model/cubismusermodel');
  const { CubismShaderManager_WebGL } = await import('@cubism/rendering/cubismshader_webgl');
  const { CubismMatrix44 } = await import('@cubism/math/cubismmatrix44');
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, powerPreference: 'low-power', premultipliedAlpha: true });
  if (!gl) throw new Error('avatar_webgl_unavailable');
  // No log callback: re-registering Core callbacks exhausts its fixed WASM
  // function table on reopen. Default Framework logging is already disabled.
  let avatar: UserModel | null = null;
  let texture: WebGLTexture | null = null;
  let gallery: ReturnType<typeof import('./motion-gallery-player').createMotionGalleryPlayer> | undefined;
  let disposed = false;
  let previewMode = false;
  let horizontalOverscan = 1;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { gallery?.dispose(); avatar?.release(); } finally {
      avatar = null;
      if (texture) gl.deleteTexture(texture);
      texture = null;
      try { CubismFramework.dispose(); CubismFramework.cleanUp(); } finally {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.width = 0; canvas.height = 0;
      }
    }
  };
  try {
    CubismFramework.startUp();
    CubismFramework.initialize(16 * 1024 * 1024);
    avatar = new CubismUserModel();
    avatar.loadModel(bytes('zundamon.moc3').slice().buffer, true);
    if (!avatar.getModel()) throw new Error('avatar_model_rejected');
    // Conversation and gallery share verified authored data. No path inside
    // model3.json can trigger network I/O; conversation cues use an allowlist.
    if (assets.has('motion-gallery.json')) {
      const { createMotionGalleryPlayer } = await import('./motion-gallery-player');
      gallery = createMotionGalleryPlayer(avatar, bytes('motion-gallery.json'));
    }
    const physics = bytes('zundamon.physics3.json');
    avatar.loadPhysics(physics.slice().buffer, physics.byteLength);
    avatar.createRenderer(1, 1);
    const renderer = avatar.getRenderer();
    renderer.startUp(gl);
    renderer.setIsPremultipliedAlpha(true);
    // Pinned 5-r.5 SDK contract. Sources are inlined at build time, never fetched.
    const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
    shader.generateShaders();
    const shaderDeadline = performance.now() + 5000;
    while (!shader._isShaderLoaded) {
      if (!shader._isShaderLoading || performance.now() > shaderDeadline) throw new Error('avatar_shader_failed');
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    const bitmap = await createImageBitmap(new Blob([bytes('zundamon.2048/texture_00.png').slice().buffer], { type: 'image/png' }), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
    try {
      if (bitmap.width > 2048 || bitmap.height > 2048) throw new Error('avatar_texture_rejected');
      texture = gl.createTexture();
      if (!texture) throw new Error('avatar_texture_rejected');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      renderer.bindTexture(0, texture);
    } finally { bitmap.close(); }
    const model = avatar.getModel();
    model.update();
    // Runtime coordinates depend on the exported canvas origin. Fit actual
    // visible drawable bounds once so the same full figure survives any aspect.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < model.getDrawableCount(); i++) {
      if (model.getDrawableOpacity(i) <= 0) continue;
      const vertices = model.getDrawableVertices(i);
      for (let j = 0; j < vertices.length; j += 2) {
        minX = Math.min(minX, vertices[j]); maxX = Math.max(maxX, vertices[j]);
        minY = Math.min(minY, vertices[j + 1]); maxY = Math.max(maxY, vertices[j + 1]);
      }
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) throw new Error('avatar_bounds_rejected');
    const id = (name: string) => CubismFramework.getIdManager().getId(name);
    const parameters = Object.fromEntries(['ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthOpenY', 'ParamAngleZ', 'ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamBreath', 'ParamBodyAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ2', 'ParamBodyAngleX2', 'ParamBodyAngleY2', 'ParamArmLowerL', 'ParamArmJawL', 'ParamArmLowerR', 'ParamArmMiddleR', 'ParamArmL', 'ParamArmR', 'ParamHandR', 'ParamArmUpperL', 'ParamArmUpperR', 'ParamBrowLY', 'ParamBrowRY'].map(name => [name, id(name)]));
    const draw = () => {
      if (gl.isContextLost()) throw new Error('avatar_context_lost');
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const matrix = new CubismMatrix44();

      // Leave extra head/foot room for authored gestures in the gallery.
      const fit = previewMode ? 1.62 : 1.86;
      const {scale, aspect} = avatarProjection(canvas.width, canvas.height, maxX - minX, maxY - minY, fit, horizontalOverscan);
      matrix.scale(scale * aspect, scale);
      matrix.translate(-(minX + maxX) / 2 * scale * aspect, -(minY + maxY) / 2 * scale);
      renderer.setMvpMatrix(matrix);
      renderer.setRenderState(null!, [0, 0, canvas.width, canvas.height]);
      renderer.drawModel();
    };
    const bodyMotion = createAvatarBodyMotion();
    const conversationMotion = createConversationMotion();
    // These parameters select separate arm drawings, not interpolated joints.
    const armGroups = [
      ['ParamArmLowerL', 'ParamArmJawL', 'ParamArmUpperL', 'ParamArmMiddleL', 'ParamArmWaistL', 'ParamArmMouthL'],
      ['ParamArmLowerR', 'ParamArmMiddleR', 'ParamArmUpperR', 'ParamArmWaistR', 'ParamArmMouthR', 'ParamArmChopR'],
    ];
    const solidArms = () => {
      const crossed = model.getParameterValueById(id('ParamArmCross')) > .5;
      model.setParameterValueById(id('ParamArmCross'), Number(crossed));
      for (const group of armGroups) {
        const selected = group.reduce((best, name) => model.getParameterValueById(id(name)) > model.getParameterValueById(id(best)) ? name : best);
        for (const name of group) model.setParameterValueById(id(name), Number(!crossed && name === selected));
      }
    };
    let speakingWeight = 0, preparingWeight = 0, smileWeight = 0;
    return {
      setInput(input: AvatarFrameInput) {
        if (disposed) return;
        previewMode = Boolean(input.preview);
        if (input.preview) {
          if (!gallery) throw new Error('avatar_asset_rejected');
          const result = gallery.frame(input);
          model.update(); draw();
          return result;
        }
        const set = (name: string, value: number) => model.setParameterValueById(parameters[name], value);
        // Start from defaults so authored cheeks, tears and pose selectors cannot
        // persist after the reaction ends. Procedural idle remains the base layer.
        for (let index = 0; index < model.getParameterCount(); index++) {
          model.setParameterValueByIndex(index, model.getParameterDefaultValue(index));
        }
        set('ParamEyeLOpen', input.eyeOpenLeft); set('ParamEyeROpen', input.eyeOpenRight);
        set('ParamMouthOpenY', input.mouthOpen);
        speakingWeight += ((input.speechState === 'speaking' ? 1 : 0) - speakingWeight) * .08;
        preparingWeight += ((input.speechState === 'preparing' ? 1 : 0) - preparingWeight) * .06;
        smileWeight += ((input.expression === 'smile' ? .65 : 0) - smileWeight) * .06;
        set('ParamEyeLSmile', smileWeight); set('ParamEyeRSmile', smileWeight); set('ParamMouthForm', smileWeight);
        const t = input.elapsedMs / 1000;
        set('ParamAngleZ', (input.idle - .5) * 6 + preparingWeight * 7 + speakingWeight * Math.sin(t * 1.4) * 2);
        set('ParamAngleY', speakingWeight * Math.sin(t * 3) * 4 + preparingWeight * 3);
        set('ParamAngleX', Math.sin(t * .5) * 3);
        set('ParamEyeBallX', Math.sin(t * .5) * .12);
        set('ParamEyeBallY', preparingWeight * .2);
        set('ParamBreath', input.idle);
        for (const [name, value] of Object.entries(bodyMotion(input))) set(name, value);
        const cue = conversationMotion.frame(input);
        if (gallery && cue) {
          const result = gallery.frame({ ...input, preview: cue }, false);
          // Authored mouth poses must not override the actual voice amplitude.
          if (input.speechState === 'speaking') set('ParamMouthOpenY', input.mouthOpen);
          solidArms();
          if (result.finished) conversationMotion.finish();
        }
        model.update(); draw();
      },
      resize(width, height, dpr) {
        horizontalOverscan = Number.parseFloat(getComputedStyle(canvas).getPropertyValue("--live2d-horizontal-overscan")) === 2 ? 2 : 1;
        if (disposed) return;
        canvas.width = Math.max(1, Math.round(width * Math.min(dpr, 1.5)));
        canvas.height = Math.max(1, Math.round(height * Math.min(dpr, 1.5)));
        model.update(); draw();
      },
      dispose,
    };
  } catch { dispose(); throw new Error('avatar_renderer_failed'); }
}
