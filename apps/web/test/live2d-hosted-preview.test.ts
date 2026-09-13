import { describe, expect, it } from 'vitest';
import { isHostedZundamonEnabled, shouldIncludeLive2dMaterial } from '../src/live2d/avatar-feature';

const enabled = {
  VITE_YUI_DEPLOYMENT_ENV: 'preview',
  VITE_YUI_LIVE2D_AVATAR_ENABLED: 'true',
  VITE_YUI_LIVE2D_MODEL: 'zundamon',
  VITE_YUI_LIVE2D_BRIDGE_SHA256: 'a'.repeat(64),
};
describe('owner Preview Live2D gate', () => {
  it('requires Preview, exact opt-ins, and a pinned bridge', () => {
    expect(isHostedZundamonEnabled(enabled)).toBe(true);
  });
  it.each([
    { VITE_YUI_DEPLOYMENT_ENV: 'production' },
    { VITE_YUI_DEPLOYMENT_ENV: undefined },
    { VITE_YUI_LIVE2D_AVATAR_ENABLED: 'TRUE' },
    { VITE_YUI_LIVE2D_MODEL: 'simple' },
    { VITE_YUI_LIVE2D_MODEL: undefined },
    { VITE_YUI_LIVE2D_BRIDGE_SHA256: undefined },
    { VITE_YUI_LIVE2D_BRIDGE_SHA256: '../bridge' },
  ])('rejects incomplete or non-Preview settings %j', override => {
    expect(isHostedZundamonEnabled({ ...enabled, ...override })).toBe(false);
  });
  it('includes material only for an explicit local build or an admitted Preview build', () => {
    expect(shouldIncludeLive2dMaterial('production', enabled)).toBe(false);
    expect(shouldIncludeLive2dMaterial('preview-live2d', enabled)).toBe(true);
    expect(shouldIncludeLive2dMaterial('preview-live2d', {})).toBe(false);
    expect(shouldIncludeLive2dMaterial('local-live2d', {})).toBe(true);
    expect(shouldIncludeLive2dMaterial('local-live2d', { ...enabled, VITE_YUI_DEPLOYMENT_ENV: 'production' })).toBe(false);
    expect(shouldIncludeLive2dMaterial('preview-live2d', { ...enabled, VITE_YUI_DEPLOYMENT_ENV: 'production' })).toBe(false);
  });
});
