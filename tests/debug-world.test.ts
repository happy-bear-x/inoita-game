import assert from 'node:assert/strict';
import test from 'node:test';
import { persistentDebugWorld, prepareDebugWorld } from '../src/application/debug-world.ts';
import type { StoryWorldViewSnapshot } from '../src/scenes/world-scene.ts';
import type { StoryContext } from '../src/application/ports.ts';

const appearance = { id: 'outfit-previous-process', name: 'Hero', description: '', portrait: null, clips: {} };
function snapshot(): StoryWorldViewSnapshot {
  return { location: { map: 'map', x: 3, y: 4, facing: 'south' }, generatedEntities: [], scene: { map: 'map', actors: [
    { id: 'player', actor: 'hero', memberId: 'player', x: 3, y: 4, facing: 'south', visible: true, appearance },
  ] } };
}
const content = { world: { maps: [{ id: 'map' }], actors: {} }, session: {}, battleCatalog: {} } as unknown as Pick<StoryContext, 'world' | 'session' | 'battleCatalog'>;

test('persistent world discards previous-process party textures without changing the live snapshot', () => {
  const before = snapshot(), persisted = persistentDebugWorld(before);
  assert.equal(persisted.scene!.actors[0].appearance, undefined);
  assert.equal(before.scene!.actors[0].appearance?.id, 'outfit-previous-process');
  assert.deepEqual(prepareDebugWorld(before, content), persisted);
});

test('invalid persistent positions are rejected before the current world is changed', () => {
  const value = snapshot(); value.location.x = NaN;
  assert.throws(() => prepareDebugWorld(value, content), /地图或位置无效/);
  const mismatch = snapshot(); mismatch.scene!.actors[0].x = 99;
  assert.throws(() => prepareDebugWorld(mismatch, content), /位置不一致/);
});
