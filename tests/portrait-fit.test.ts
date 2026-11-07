import test from 'node:test';
import assert from 'node:assert/strict';
import { portraitFit } from '../src/ui/portrait-fit.ts';

const near = (actual: number, expected: number, epsilon = 1e-5): void => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

test('portraitFit keeps the source aspect inside the target box', () => {
  const cases = [
    { source: { width: 252, height: 271 }, box: { width: 252, height: 271 } },
    { source: { width: 127, height: 114 }, box: { width: 252, height: 271 } },
    { source: { width: 86, height: 96 }, box: { width: 78, height: 81 } },
    { source: { width: 234, height: 243 }, box: { width: 72.8, height: 75.21 } },
    { source: { width: 78, height: 81 }, box: { width: 63.87, height: 66.81 } },
  ];
  for (const { source, box } of cases) {
    const fit = portraitFit(source, box);
    near(fit.cropWidth / fit.cropHeight, box.width / box.height);
    assert.ok(fit.cropWidth <= source.width + 1e-6);
    assert.ok(fit.cropHeight <= source.height + 1e-6);
  }
});

test('portraitFit fills the box and keeps the chosen side', () => {
  const fit = portraitFit({ width: 127, height: 114 }, { width: 252, height: 271 });
  near(fit.scale, 271 / 114);
  near(fit.cropWidth * fit.scale, 252);
  near(fit.cropHeight * fit.scale, 271);
  near(fit.cropX, (127 - fit.cropWidth) / 2);

  const top = portraitFit({ width: 86, height: 96 }, { width: 78, height: 81 }, .5, .2);
  const bottom = portraitFit({ width: 86, height: 96 }, { width: 78, height: 81 }, .5, .8);
  assert.ok(top.cropY < bottom.cropY, 'anchorY 越大越偏向保留图片底部');
});

test('portraitFit tolerates zero sizes and clamps anchors', () => {
  const empty = portraitFit({ width: 0, height: 0 }, { width: 0, height: 0 }, -1, 2);
  assert.equal(empty.scale, 1);
  assert.equal(empty.cropX, 0);
  assert.equal(empty.cropY, 0);

  const edge = portraitFit({ width: 100, height: 100 }, { width: 50, height: 50 }, -5, 5);
  assert.equal(edge.cropX, 0);
  assert.equal(edge.cropY, 0);
});
