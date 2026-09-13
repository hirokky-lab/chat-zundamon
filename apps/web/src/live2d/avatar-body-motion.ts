import type { AvatarFrameInput, AvatarExpression } from './avatar-contract';

const ease = (x: number) => { const v = Math.max(0, Math.min(1, x)); return v * v * (3 - 2 * v); };
/** Zundamon's arm selectors swap drawings; only joint parameters interpolate. */
export function createAvatarBodyMotion() {
  let lastTime: number | undefined, lastKey: string | undefined;
  let initialized = false, cue: AvatarExpression = 'neutral', cueStart = -Infinity;
  let speaking = 0, thinking = 0, gesture = 0, smile = 0;
  let wasSpeaking = false, beatStart = -Infinity, lastBeat = -Infinity;
  let jawPose = false, middlePose = false;
  return (input: AvatarFrameInput): Record<string, number> => {
    const time = Math.max(0, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0);
    const dt = lastTime === undefined ? 0 : Math.max(0, Math.min(100, time - lastTime));
    lastTime = time;
    if (!initialized) { initialized = true; lastKey = input.expressionKey; }
    if (input.expressionKey !== lastKey) {
      lastKey = input.expressionKey; cue = input.expression ?? 'neutral'; cueStart = time;
      if(time-lastBeat>2500) { beatStart=time; lastBeat=time; }
    }
    if (time - cueStart > 5000) cue = 'neutral';
    const blend = 1 - Math.exp(-dt / 450);
    speaking += ((input.speechState === 'speaking' ? 1 : 0) - speaking) * blend;
    thinking += ((input.speechState === 'preparing' || cue === 'thinking' ? 1 : 0) - thinking) * blend;
    smile += ((cue === 'smile' ? .65 : 0) - smile) * blend;
    const isSpeaking = input.speechState === 'speaking';
    if(isSpeaking && !wasSpeaking && time-lastBeat>2500) {beatStart=time;lastBeat=time;}
    wasSpeaking=isSpeaking;
    const age=(time-beatStart)/1000;
    const beat=age>=0 && age<1.4 ? Math.sin(age/1.4*Math.PI) : 0;
    const t = time / 1000;
    gesture += ((age>=0 && age<2 && cue!=='thinking' ? 1 : 0) - gesture) * blend;
    jawPose = thinking > (jawPose ? .35 : .65);
    middlePose = gesture > (middlePose ? .35 : .65);
    const jaw = Number(jawPose), middle = Number(middlePose);
    // Each slow weight shift has a quiet interval. The period varies by cycle.
    const cycle = t % 51;
    const local = cycle < 15 ? cycle : cycle < 32 ? cycle - 15 : cycle - 32;
    const envelope = ease(local / 2) * (1 - ease((local - 6) / 2));
    const sway = Math.sin(local * .65) * 3.2 * envelope + beat * 1.3;
    const turn = Math.sin(local * .48) * 4 * envelope;
    const breath = Math.sin(t * 1.05) * .6;
    const nod = beat * 2;
    const surprise = cue === 'surprise' ? Math.sin(Math.min(1, (time - cueStart) / 2200) * Math.PI) : 0;
    const bodyY = breath + nod - surprise * 4 + smile * 2;
    const output: Record<string, number> = {
      ParamAngleY: nod * 1.5 + thinking * 3,
      ParamBodyAngleZ: sway, ParamBodyAngleX: turn, ParamBodyAngleY: bodyY,
      ParamBodyAngleZ2: sway, ParamBodyAngleX2: turn * .8, ParamBodyAngleY2: bodyY,
      ParamArmLowerL: 1 - jaw, ParamArmJawL: jaw, ParamArmUpperL: 0,
      ParamArmLowerR: 1 - middle, ParamArmMiddleR: middle, ParamArmUpperR: 0,
      ParamArmL: Math.sin(local * .65 - .5) * .12 * envelope * (1-thinking),
      ParamArmR: Math.sin(local * .65 + .5) * .12 * envelope + gesture * Math.sin(t*2) * .12,
      ParamHandR: gesture * Math.sin(t * 1.6) * .12,
      ParamEyeLSmile: smile, ParamEyeRSmile: smile, ParamMouthForm: smile,
      ParamBrowLY: surprise * .6, ParamBrowRY: surprise * .6,
    };
    return output;
  };
}
