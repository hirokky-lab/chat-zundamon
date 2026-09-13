import { VRM_REST_ARM_ANGLE } from './vrm-pose';
import type { AvatarExpression, AvatarFrameInput } from '../live2d/avatar-contract';

export const VRM_MOTIONS = [
  { id: 'vrm-nod', label: 'うなずく', expression: 'agree' },
  { id: 'vrm-no', label: '首を振る', expression: 'disagree' },
  { id: 'vrm-wave', label: '手を振る', expression: 'greeting' },
  { id: 'vrm-think', label: '考える', expression: 'thinking' },
  { id: 'vrm-joy', label: '喜ぶ', expression: 'smile' },
] as const;
type MotionId = typeof VRM_MOTIONS[number]['id'];
export type VrmPose = {
  headX: number; headY: number; headZ: number; spineX: number; spineZ: number;
  leftArm: number; rightArm: number; leftElbow: number; rightElbow: number;
  rightHand: number; eyeClose: number;
};
const byExpression: Partial<Record<AvatarExpression, MotionId>> = {
  agree: 'vrm-nod', disagree: 'vrm-no', greeting: 'vrm-wave', thinking: 'vrm-think',
  smile: 'vrm-joy', shy: 'vrm-think', sad: 'vrm-think',
};
const durations: Record<MotionId, number> = { 'vrm-nod': 2, 'vrm-no': 2.4, 'vrm-wave': 3.2, 'vrm-think': 4.2, 'vrm-joy': 3 };
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x*x*(3-2*x); };

export function createVrmMotion() {
  let initialized = false, seenKey: string | undefined, previewId: number | undefined;
  let preparing = false, active: MotionId | undefined, started = 0;
  return {
    frame(input: AvatarFrameInput): { pose: VrmPose; finished: boolean } {
      const t = input.elapsedMs / 1000;
      const pose: VrmPose = {
        headX: 0, headY: Math.sin(t*.6)*.025, headZ: Math.sin(t*.7)*.02,
        spineX: Math.sin(t*1.2)*.007, spineZ: Math.sin(t*.9)*.012,
        leftArm: -VRM_REST_ARM_ANGLE, rightArm: VRM_REST_ARM_ANGLE, leftElbow: 0, rightElbow: 0, rightHand: 0, eyeClose: 0,
      };
      let cue: MotionId | undefined;
      if (!initialized) { initialized = true; seenKey = input.expressionKey; }
      if (input.preview) {
        if (previewId !== input.preview.requestId) {
          previewId = input.preview.requestId;
          cue = VRM_MOTIONS.find(m => m.id === input.preview?.motion)?.id;
        }
      } else {
        previewId = undefined;
        const nextPreparing = input.speechState === 'preparing';
        if (nextPreparing && !preparing) cue = 'vrm-think';
        if (!nextPreparing && preparing) active = undefined;
        preparing = nextPreparing;
        if (!preparing && seenKey !== input.expressionKey) {
          seenKey = input.expressionKey;
          active = undefined;
          cue = byExpression[input.expression ?? 'neutral'];
        }
      }
      if (cue) { active = cue; started = t; }
      let finished = false;
      if (active) {
        const duration = durations[active];
        const elapsed = t-started;
        const phase = input.preview?.loop ? elapsed % duration : elapsed;
        const weight = smooth(phase/.45)*smooth((duration-phase)/.55);
        if (phase >= duration) { active = undefined; finished = true; }
        else {
          switch (active) {
            case 'vrm-nod': pose.headX += Math.sin(phase*7)*.16*weight; pose.spineX += .025*weight; break;
            case 'vrm-no': pose.headY += Math.sin(phase*6)*.22*weight; break;
            case 'vrm-wave':
              pose.rightArm -= 1.4*weight; pose.rightElbow = -1.1*weight;
              pose.rightHand = Math.sin(phase*10)*.28*weight; pose.headZ -= .06*weight; break;
            case 'vrm-think':
              pose.rightArm -= .08*weight; pose.rightElbow = -.3*weight;
              pose.headZ += .1*weight; pose.headX += .06*weight; break;
            case 'vrm-joy':
              pose.leftArm += 1.95*weight; pose.rightArm -= 1.95*weight;
              pose.leftElbow = .2*weight; pose.rightElbow = -.2*weight;
              pose.eyeClose = .95*weight; pose.spineX -= .025*weight; break;
          }
        }
      }
      return { pose, finished };
    },
  };
}
