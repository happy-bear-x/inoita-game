import assert from 'node:assert/strict';
import test from 'node:test';
import { FOCUS_PULSE_FRAMES, focusRingScale } from '../src/rendering/target-focus-pulse.ts';

test('换目标后的红圈按原版 80%..130% 缩放', () => {
  assert.equal(FOCUS_PULSE_FRAMES, 17);
  assert.equal(focusRingScale(17), 1.3);
  assert.equal(focusRingScale(16), 1.2);
  assert.equal(focusRingScale(12), 0.8);
  assert.equal(focusRingScale(1), 0.9);
  assert.equal(focusRingScale(0), 1);
});
