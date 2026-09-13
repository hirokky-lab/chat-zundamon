import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAvatarInteraction } from '../src/live2d/avatar-interaction';

function setup(mode: 'zoom' | 'orbit' = 'orbit') {
  const element = document.createElement('div');
  Object.defineProperties(element, { clientWidth: { value: 400 }, clientHeight: { value: 800 } });
  element.setPointerCapture = vi.fn();
  const stage = { current: element };
  const hook = renderHook(() => useAvatarInteraction(stage, true, mode));
  const pointer = (type: string, x: number, y: number, id = 1, shiftKey = false) => act(() => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, shiftKey, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    element.dispatchEvent(event);
  });
  return { ...hook, element, pointer };
}

it('orbits without translating, bounds vertical rotation and stops after pointer release', () => {
  const { result, pointer, unmount } = setup();
  pointer('pointerdown', 100, 100);
  pointer('pointermove', 200, 10000);
  expect(result.current.orbit.yaw).toBeCloseTo(.8);
  expect(result.current.orbit.pitch).toBe(.65);
  expect(result.current.view).toEqual({ scale: 1 });
  pointer('pointerup', 200, 10000);
  pointer('pointermove', 250, 100);
  expect(result.current.orbit.yaw).toBeCloseTo(.8);
  unmount();
});

it('rotates on shift drag instead of moving, and pinch zoom never changes orientation', () => {
  const { result, pointer, element, unmount } = setup();
  pointer('pointerdown', 100, 100);
  pointer('pointermove', 120, 110, 1, true);
  expect(result.current.view).toEqual({scale:1});
  expect(result.current.orbit.yaw).toBeCloseTo(.16);
  const orientation=result.current.orbit;
  pointer('pointerdown', 220, 110, 2);
  pointer('pointermove', 320, 110, 2);
  expect(result.current.view).toEqual({scale:2});
  expect(result.current.orbit).toEqual(orientation);
  act(() => element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true })));
  expect(result.current.view.scale).toBeLessThan(2);
  unmount();
});

it('ignores Live2D one-finger drag but permits pinch and wheel zoom at a fixed position', () => {
  const { result, pointer, element, unmount } = setup('zoom');
  pointer('pointerdown', 100, 100);
  pointer('pointermove', 125, 150);
  expect(result.current.view).toEqual({scale:1});
  expect(result.current.orbit).toEqual({yaw:0,pitch:0});
  pointer('pointerdown', 225, 150, 2);
  pointer('pointermove', 275, 150, 2);
  expect(result.current.view).toEqual({scale:1.5});
  // Move the entire two-finger gesture: only its separation affects zoom.
  pointer('pointermove', 145, 180);
  pointer('pointermove', 295, 180, 2);
  expect(result.current.view.scale).toBeCloseTo(1.5);
  expect(result.current.orbit).toEqual({yaw:0,pitch:0});
  pointer('pointercancel',145,180);
  pointer('pointercancel',295,180,2);
  pointer('pointermove',400,400);
  expect(result.current.view.scale).toBeCloseTo(1.5);
  act(() => element.dispatchEvent(new WheelEvent('wheel', { deltaY:-100, cancelable:true })));
  expect(result.current.view.scale).toBeGreaterThan(1.5);
  unmount();
});
