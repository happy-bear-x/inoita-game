import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BATCH_SIZE, LEGACY_BATCH_SIZE, pixelRenderOptions } from '../src/application/render-options.ts';

test('pixel render options keep the shipped renderer by default', () => {
  assert.deepEqual(pixelRenderOptions(''), {
    pixelArt: true, smoothPixelArt: false, roundPixels: true,
    autoMobileTextures: false, batchSize: DEFAULT_BATCH_SIZE,
  });
});

test('pixel render options expose URL switches for device A/B', () => {
  const smooth = pixelRenderOptions('?smooth-pixel');
  assert.equal(smooth.pixelArt, false);
  assert.equal(smooth.smoothPixelArt, true);
  assert.equal(smooth.roundPixels, false);

  const legacy = pixelRenderOptions('?single-texture&batch=4096');
  assert.equal(legacy.autoMobileTextures, true);
  assert.equal(legacy.batchSize, LEGACY_BATCH_SIZE);

  // 只认旧容量这个精确值，避免 URL 里的手误把批容量改成一个更奇怪的数。
  assert.equal(pixelRenderOptions('?batch=123').batchSize, DEFAULT_BATCH_SIZE);
});
