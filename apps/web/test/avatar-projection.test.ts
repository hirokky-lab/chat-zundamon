import { expect, it } from 'vitest';
import { avatarProjection } from '../src/live2d/avatar-projection';
it.each([[390,780],[390,580],[1280,720]])('keeps model size when adding horizontal drawing room at %s x %s', (width,height) => {
  const original=avatarProjection(width,height,1.2,2,1.86);
  const extended=avatarProjection(width*2,height,1.2,2,1.86,2);
  expect(extended.scale).toBeCloseTo(original.scale);
  expect(extended.scale*extended.aspect*width*2).toBeCloseTo(original.scale*original.aspect*width);
});
