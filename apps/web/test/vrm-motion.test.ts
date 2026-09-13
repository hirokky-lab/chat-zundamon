import { describe, expect, it } from 'vitest';
import { createVrmMotion, VRM_MOTIONS } from '../src/vrm/vrm-motion';
import type { AvatarFrameInput } from '../src/live2d/avatar-contract';
const frame = (elapsedMs: number, extra: Partial<AvatarFrameInput> = {}): AvatarFrameInput => ({ elapsedMs, idle: 0, eyeOpenLeft: 1, eyeOpenRight: 1, mouthOpen: 0, volume: 0, speechState: 'silent', expression: 'neutral', expressionKey: 'saved', ...extra });
describe('VRM gestures', () => {
  it('does not replay saved replies or continuously repeat a new reply', () => {
    const motion = createVrmMotion();
    motion.frame(frame(0, { expression: 'greeting' }));
    expect(motion.frame(frame(1000, { expression: 'greeting' })).pose.rightArm).toBe(1.2);
    motion.frame(frame(1100, { expression: 'greeting', expressionKey: 'new' }));
    expect(motion.frame(frame(2100, { expression: 'greeting', expressionKey: 'new' })).pose.rightArm).toBeLessThan(0);
    expect(motion.frame(frame(5000, { expression: 'greeting', expressionKey: 'new' })).finished).toBe(true);
    expect(motion.frame(frame(6000, { expression: 'greeting', expressionKey: 'new' })).pose.rightArm).toBe(1.2);
  });
  it.each(VRM_MOTIONS)('returns $label to rest and allows another preview', ({ id }) => {
    const motion = createVrmMotion();
    const preview = { motion: id, requestId: 1, loop: false };
    motion.frame(frame(0, { preview }));
    expect(motion.frame(frame(1000, { preview })).finished).toBe(false);
    const end = motion.frame(frame(6000, { preview }));
    expect(end.finished).toBe(true);
    expect(end.pose.leftArm).toBe(-1.2);
    expect(end.pose.rightArm).toBe(1.2);
    expect(end.pose.eyeClose).toBe(0);
    expect(motion.frame(frame(7000, { preview: { ...preview, requestId: 2 } })).finished).toBe(false);
    expect(motion.frame(frame(13000, { preview: { ...preview, requestId: 2 } })).finished).toBe(true);
  });
  it('releases the thinking pose when preparation ends', () => {
    const motion = createVrmMotion();
    motion.frame(frame(0, { speechState: 'preparing' }));
    expect(motion.frame(frame(1000, { speechState: 'preparing' })).pose.rightElbow).not.toBe(0);
    expect(motion.frame(frame(1100, { speechState: 'speaking' })).pose.rightElbow).toBe(0);
  });
});
