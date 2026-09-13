import { CubismMotionManager } from '@cubism/motion/cubismmotionmanager';
import type { CubismMotion } from '@cubism/motion/cubismmotion';
import type { CubismUserModel } from '@cubism/model/cubismusermodel';
import { CubismFramework } from '@cubism/live2dcubismframework';
import type { AvatarFrameInput, AvatarPreviewStatus } from '../../apps/web/src/live2d/avatar-contract';

type Expression = { Parameters: Array<{ Id: string; Value: number; Blend?: 'Add' | 'Multiply' | 'Overwrite' }> };
type Pack = { motions: Record<string, unknown>; expressions: Record<string, Expression> };

/** Only receives the hash-verified, locally packed official animation data. Never fetches URLs. */
export function createMotionGalleryPlayer(avatar: CubismUserModel, bytes: Uint8Array) {
  const pack: Pack = JSON.parse(new TextDecoder().decode(bytes));
  const model = avatar.getModel();
  const manager = new CubismMotionManager();
  let requestId = -1, motionId: string | undefined, current: CubismMotion | undefined;
  let lastTime: number | undefined, notified = false;
  const id = (name: string) => CubismFramework.getIdManager().getId(name);
  const apply = (name?: string) => {
    if (!name) return;
    if (!Object.hasOwn(pack.expressions, name)) throw new Error('avatar_asset_rejected');
    for (const parameter of pack.expressions[name].Parameters) {
      const key = id(parameter.Id);
      if (parameter.Blend === 'Multiply') model.multiplyParameterValueById(key, parameter.Value);
      else if (parameter.Blend === 'Overwrite') model.setParameterValueById(key, parameter.Value);
      else model.addParameterValueById(key, parameter.Value);
    }
  };
  return {
    frame(input: AvatarFrameInput, resetParameters = true): AvatarPreviewStatus {
      const selection = input.preview!;
      const delta = lastTime === undefined ? 0 : Math.max(0, Math.min(.1, (input.elapsedMs - lastTime) / 1000));
      lastTime = input.elapsedMs;
      if (selection.requestId !== requestId || selection.motion !== motionId) {
        manager.stopAllMotions(); current = undefined;
        requestId = selection.requestId; motionId = selection.motion; notified = false;
        if (motionId) {
          if (!Object.hasOwn(pack.motions, motionId)) throw new Error('avatar_asset_rejected');
          const data = new TextEncoder().encode(JSON.stringify(pack.motions[motionId]));
          current = avatar.loadMotion(data.buffer, data.byteLength, motionId);
          if (!current) throw new Error('avatar_asset_rejected');
          // SDK requires initialized effect-ID arrays even for authored-only playback.
          current.setEffectIds([], []);
          current.setLoop(selection.loop);
          manager.startMotionPriority(current, true, 3);
        }
      }
      // Clear all previous expressions, selector drawings and motion values every frame.
      if (resetParameters) {
        for (let index = 0; index < model.getParameterCount(); index++) {
          model.setParameterValueByIndex(index, model.getParameterDefaultValue(index));
        }
        model.setParameterValueById(id('ParamEyeLOpen'), input.eyeOpenLeft);
        model.setParameterValueById(id('ParamEyeROpen'), input.eyeOpenRight);
      }
      if (current) current.setLoop(selection.loop);
      manager.updateMotion(model, delta);
      apply(selection.expression);
      apply(selection.pose);
      const finished = Boolean(motionId && !selection.loop && manager.isFinished() && !notified);
      if (finished) { notified = true; current = undefined; }
      return { finished };
    },
    dispose() { manager.stopAllMotions(); manager.release(); },
  };
}
