import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';

const map = headlessContent.maps.get('werewolf-lair-43f5b4c5')!;
const roundTrips = [
  { title: 'normal victory', restore: false, skip: false },
  { title: 'skipped victory scene', restore: false, skip: true },
  { title: 'victory after saving and restoring the active encounter', restore: true, skip: false },
];

for (const route of roundTrips) test(`the werewolf battle unlocks the next quest after ${route.title}`, async () => {
  const entry = playthrough();
  let h = entry;
  try {
    assert.equal(entry.session.accept('quest-46'), true);
    entry.session.applyStoryCommands([{type:'travel',destination:{map:map.id,x:300,y:152,facing:'east'}}]);
    await entry.region('event-60');
    assert.equal(entry.director.runtime.eventStatus('event-60'), 'waiting');

    if (route.restore) {
      h = playthrough(JSON.parse(JSON.stringify(entry.session.captureState())));
      assert.equal(h.director.runtime.eventStatus('event-60'), 'waiting');
    }
    let skipped = false;
    if (route.skip) {
      h.director.onPresentationStarted = () => h.director.skip();
      h.director.onSkipProgress = phase => { if (phase === 'requested') skipped = true; };
    }
    await h.defeat('enemy-head-werewolf-1');
    const roster = new WorldEnemyRoster(h.session, map, [], h.session.hero!.level);
    const [encounter] = roster.completedEncounters();
    assert.ok(encounter);
    const resultId = `result:${encounter.id}:won`;
    assert.equal(await h.director.encounterResult(encounter.id, 'won', resultId), true);
    await h.idle();
    assert.equal(skipped, route.skip);
    assert.equal(h.director.runtime.eventStatus('event-60'), 'completed');
    assert.equal(h.director.runtime.eventStatus('event-61'), 'completed');
    assert.equal(h.session.status('quest-46'), 'completed');
    assert.equal(h.session.status('quest-47'), 'ready');

    const receipts = h.session.captureState().receipts;
    assert.equal(receipts.filter(receipt => receipt.quest === 'quest-46').length, 1);
    assert.equal(await h.director.encounterResult(encounter.id, 'won', resultId), false);
    assert.deepEqual(h.session.captureState().receipts, receipts);
    if (!route.restore && !route.skip) {
      await h.travel('mine-undergrounds-b2-9407459c');
      await h.talk('npc-233');
      assert.equal(h.session.status('quest-71'), 'ready');
      assert.equal(h.session.itemCount('schreiber-s-necklace'), 1);
      await h.travel('dwarf-village-f9a49628');
      await h.talk('npc-237');
      assert.equal(h.session.status('quest-71'), 'completed');
      assert.equal(h.session.itemCount('schreiber-s-necklace'), 0);
    }
  } finally {
    if (h !== entry) h.director.dispose();
    entry.director.dispose();
  }
});
