import assert from 'node:assert/strict';
import test from 'node:test';
import { thumbnailSize } from '../src/ui/phaser/game-thumbnail.ts';

test('存档缩略图等比缩进最大尺寸，不放大也不变形', () => {
  assert.deepEqual(thumbnailSize(1280, 720), { width: 360, height: 203 });
  assert.deepEqual(thumbnailSize(960, 640), { width: 305, height: 203 });
  assert.deepEqual(thumbnailSize(360, 203), { width: 360, height: 203 });
  // 小于上限的图保持原尺寸，避免把小画面放大后变糊。
  assert.deepEqual(thumbnailSize(200, 100), { width: 200, height: 100 });
  // 极端宽窄比例也必须至少留 1 像素。
  assert.deepEqual(thumbnailSize(10000, 10), { width: 360, height: 1 });
  assert.deepEqual(thumbnailSize(0, 100), { width: 0, height: 0 });
  assert.deepEqual(thumbnailSize(Number.NaN, 100), { width: 0, height: 0 });
});
