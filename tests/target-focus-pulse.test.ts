import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceFocusPulse,
  FOCUS_PULSE_FRAME_MS,
  FOCUS_PULSE_FRAMES,
  focusRingScale,
} from '../src/rendering/target-focus-pulse.ts';

test('换目标后的红圈按原版 80%..130% 缩放', () => {
  assert.equal(FOCUS_PULSE_FRAMES, 17);
  assert.equal(focusRingScale(17), 1.3);
  assert.equal(focusRingScale(16), 1.2);
  assert.equal(focusRingScale(12), 0.8);
  assert.equal(focusRingScale(1), 0.9);
  assert.equal(focusRingScale(0), 1);
});

test('脉冲按原版 30fps 的真实耗时推进，不随渲染刷新率变快', () => {
  assert.equal(advanceFocusPulse(17, FOCUS_PULSE_FRAME_MS), 16);
  assert.equal(advanceFocusPulse(17, FOCUS_PULSE_FRAME_MS / 2), 16.5);
  assert.equal(advanceFocusPulse(17, 0), 17);
  assert.equal(advanceFocusPulse(17, -10), 17);
  assert.equal(advanceFocusPulse(0.2, 1000), 0);
  assert.equal(advanceFocusPulse(0, 1000), 0);
});
