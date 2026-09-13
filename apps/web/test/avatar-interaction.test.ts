import { expect, it } from 'vitest';
import { boundAvatarScale } from '../src/live2d/avatar-interaction';
it('keeps the character recoverable at extreme zoom levels', () => {
  expect(boundAvatarScale(8)).toBe(2);
  expect(boundAvatarScale(.01)).toBe(.65);
});
