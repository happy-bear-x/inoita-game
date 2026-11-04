import assert from 'node:assert/strict';
import test from 'node:test';
import { StoryApp } from '../src/app.ts';
import type { GameUI } from '../src/ui/game-ui.ts';
import type { AssetLease } from '../src/application/assets.ts';

function trackedLease(released: string[], name: string): AssetLease {
  return { release: () => { released.push(name); } };
}

test('map asset history keeps only the two most recent leases', () => {
  const app = new StoryApp({} as GameUI);
  const released: string[] = [];
  app.retainMapAssets(trackedLease(released, 'first'));
  app.retainMapAssets(trackedLease(released, 'second'));
  app.retainMapAssets(trackedLease(released, 'third'));
  assert.deepEqual(released, ['first']);
});

test('clearMapHistory releases every retained lease and can run twice', () => {
  const app = new StoryApp({} as GameUI);
  const released: string[] = [];
  app.retainMapAssets(trackedLease(released, 'first'));
  app.retainMapAssets(trackedLease(released, 'second'));
  app.clearMapHistory();
  assert.deepEqual(released, ['first', 'second']);
  app.clearMapHistory();
  assert.deepEqual(released, ['first', 'second'], '重复清理不重复释放');
});

test('map prefetch keeps its own slot and leaves the two history maps intact', () => {
  const app = new StoryApp({} as GameUI);
  const released: string[] = [];
  app.retainMapAssets(trackedLease(released, 'first'));
  app.retainMapAssets(trackedLease(released, 'second'));
  app.retainMapPrefetch(trackedLease(released, 'prefetch'));
  assert.deepEqual(released, []);
  app.retainMapAssets(trackedLease(released, 'third'));
  assert.deepEqual(released, ['first']);
});
