import { expect, it } from 'vitest';
import { createAvatarBodyMotion } from '../src/live2d/avatar-body-motion';
import { createAvatarSignalAdapter } from '../src/live2d/avatar-signal';
it('moves the torso and arms even with muted speech, without changing mouth or eyes', () => {
 const motion = createAvatarBodyMotion(), signal = createAvatarSignalAdapter();
 const start = motion(signal.frame(0)), later = motion(signal.frame(2000));
 expect(later.ParamBodyAngleZ).not.toBe(start.ParamBodyAngleZ);
 expect(later.ParamArmL).not.toBe(start.ParamArmL);
 expect(later).not.toHaveProperty('ParamMouthOpenY');
 expect(later).not.toHaveProperty('ParamEyeLOpen');
});
it('switches mutually exclusive arm poses and returns them to rest', () => {
 const motion = createAvatarBodyMotion(), signal = createAvatarSignalAdapter();
 signal.setAudio({speechState:'preparing',volume:0});
 let values = motion(signal.frame(0));
 for(let t=33;t<2000;t+=33) values = motion(signal.frame(t));
 expect(values.ParamArmJawL).toBeGreaterThan(.9);
 expect(values.ParamArmJawL + values.ParamArmLowerL).toBeCloseTo(1);
 signal.setAudio({speechState:'silent',volume:0});
 for(let t=2000;t<6000;t+=33) values = motion(signal.frame(t));
 expect(values.ParamArmJawL).toBeLessThan(.01);
 expect(values.ParamArmLowerR + values.ParamArmMiddleR).toBeCloseTo(1);
});

it('never crossfades arm drawings during any transition', () => {
 const motion = createAvatarBodyMotion(), signal = createAvatarSignalAdapter();
 for (let t=0; t<16000; t+=33) {
  signal.setAudio({speechState:t<2000?'preparing':t<12000?'speaking':'silent',volume:.5});
  const v=motion(signal.frame(t));
  for(const key of ['ParamArmLowerL','ParamArmJawL','ParamArmLowerR','ParamArmMiddleR']) expect([0,1]).toContain(v[key]);
  expect(v.ParamArmLowerL+v.ParamArmJawL).toBe(1);
  expect(v.ParamArmLowerR+v.ParamArmMiddleR).toBe(1);
 }
});

it('animates all visible torso axes while silent', () => {
 const motion=createAvatarBodyMotion(), signal=createAvatarSignalAdapter();
 const samples=Array.from({length:400},(_,i)=>motion(signal.frame(i*33)));
 for(const key of ['ParamBodyAngleX2','ParamBodyAngleY2','ParamBodyAngleZ2']) {
  const values=samples.map(v=>v[key]);
  expect(Math.max(...values)-Math.min(...values)).toBeGreaterThan(1);
 }
 expect(samples.every(v=>v.ParamArmLowerL===1 && v.ParamArmLowerR===1)).toBe(true);
});

it('keeps both upper-arm poses disabled throughout a long idle period', () => {
 const motion=createAvatarBodyMotion(), signal=createAvatarSignalAdapter();
 for(let time=0;time<180000;time+=100) {
  const pose=motion(signal.frame(time));
  expect(pose.ParamArmUpperL).toBe(0);
  expect(pose.ParamArmUpperR).toBe(0);
  expect(pose).not.toHaveProperty('ParamEyeLOpen');
 }
});
