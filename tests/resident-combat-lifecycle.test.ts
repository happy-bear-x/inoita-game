import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameUI } from '../src/ui/game-ui.ts';
import { StoryApp } from '../src/app.ts';

test('releaseResidentCombat releases once and clears the session stamp', () => {
  const app = new StoryApp({} as GameUI);
  let released = 0;
  app.residentCombatAssets = { release: () => { released++; } };
  app.residentCombatClassId = 'warlock';
  app.residentCombatReady = true;
  app.releaseResidentCombat();
  assert.equal(released, 1);
  assert.equal(app.residentCombatAssets, undefined);
  assert.equal(app.residentCombatClassId, undefined);
  assert.equal(app.residentCombatReady, false);
  app.releaseResidentCombat();
  assert.equal(released, 1, '重复释放必须是幂等的');
});

test('session release clears old gameplay owners and ignores a delayed callback for a replaced session', () => {
  const app = new StoryApp({} as GameUI);
  const old = {} as StoryApp['session'], current = {} as StoryApp['session'];
  let disposed = 0, poolDestroyed = 0, cacheCleared = 0;
  app.session = current;
  app.director = { dispose() { disposed++; } } as StoryApp['director'];
  app.outfits = { destroy() { poolDestroyed++; } } as NonNullable<StoryApp['outfits']>;
  app.content.clearSessionCaches = () => { cacheCleared++; };
  assert.equal(app.releaseSession(old), false);
  assert.equal(app.session, current);
  assert.deepEqual([disposed, poolDestroyed, cacheCleared], [0, 0, 0]);
  assert.equal(app.releaseSession(current), true);
  assert.equal(app.session, undefined);
  assert.equal(app.director, undefined);
  assert.equal(app.outfits, undefined);
  assert.equal(app.checkpoint.available, false);
  assert.deepEqual([disposed, poolDestroyed, cacheCleared], [1, 1, 1]);
  assert.equal(app.releaseSession(current), false);
});
