import assert from 'node:assert/strict';
import test from 'node:test';
import { measureRefreshRate, mergeRefreshRate, resolveFrameLimit } from '../src/application/frame-pacing.ts';

test('resolveFrameLimit 把够得着屏幕的选项交给 vsync，低一档仍按数值限帧', () => {
  assert.equal(resolveFrameLimit(60, 60), 0);
  assert.equal(resolveFrameLimit(60, 59.5), 0);
  assert.equal(resolveFrameLimit(120, 60), 0);
  assert.equal(resolveFrameLimit(120, 120), 0);
  assert.equal(resolveFrameLimit(30, 30), 0);
  assert.equal(resolveFrameLimit(30, 60), 30);
  assert.equal(resolveFrameLimit(60, 90), 60);
  assert.equal(resolveFrameLimit(60, 120), 60);
});

test('mergeRefreshRate 只采纳样本足够且更高的测量', () => {
  assert.equal(mergeRefreshRate(60, 120, 24), 120);
  assert.equal(mergeRefreshRate(120, 60, 24), 120);
  assert.equal(mergeRefreshRate(60, 120, 2), 60);
});

test('measureRefreshRate 取 rAF 间隔的中位数', async () => {
  const measure = (interval: number): Promise<number> => {
    let clock = 0;
    return measureRefreshRate(callback => { clock += interval; callback(clock); });
  };
  assert.equal(await measure(1000 / 60), 60);
  assert.equal(await measure(1000 / 120), 120);
});

test('measureRefreshRate 采样不足时按 60Hz 处理', async () => {
  assert.equal(await measureRefreshRate(() => {}), 60);
});
