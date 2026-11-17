import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { createGmActions, type GmStoryDebugPort, type GmStoryDebugSnapshot } from '../src/debug/gm-actions.ts';

function harness(options: { travelThrows?: boolean; playReturns?: boolean; realPlay?: boolean } = {}) {
  const h = playthrough();
  const calls: string[] = [];
  const snapshot = (): GmStoryDebugSnapshot => ({ session: h.session.captureState(), world: {} });
  const port: GmStoryDebugPort = {
    ready: () => true,
    capture: () => { calls.push('capture'); return snapshot(); },
    begin: () => { calls.push('begin'); h.director.holdTriggers(); },
    releaseTriggers: () => { calls.push('releaseTriggers'); h.director.releaseTriggers(); },
    closeMenu: () => calls.push('closeMenu'),
    travel: async () => {
      calls.push('travel');
      if (options.travelThrows) throw new Error('传送失败');
    },
    play: async accept => {
      calls.push('play');
      if (options.realPlay) return accept.eventId
        ? h.director.trigger({ id: accept.eventId, script: accept.script })
        : true;
      return options.playReturns ?? true;
    },
    restore: async before => {
      calls.push('restore');
      h.session.restoreState(before.session);
    },
    checkpoint: () => { calls.push('checkpoint'); },
    finish: () => { calls.push('finish'); h.director.releaseTriggers(); },
    dispose: () => { calls.push('dispose'); h.director.releaseTriggers(); },
  };
  const gm = createGmActions({ session: h.session, campaign: h.session.campaign, director: h.director, storyDebug: port,
    requestAutoSave: () => calls.push('autoSave') });
  return { h, gm, calls };
}

test('the quest catalog and preview expose the ordered full list and a start plan', () => {
  const { h, gm } = harness();
  try {
    const catalog = gm.questCatalog();
    assert.ok(catalog.length > 0);
    assert.equal(catalog.flatMap(group => group.entries).length, 496);
    const preview = gm.previewQuestDebug('quest-11');
    assert.equal(preview.ok, true);
    assert.equal(preview.plan?.accept?.script, 'next:quest-10:quest-11');
  } finally { h.director.dispose(); }
});

test('starting a quest applies the plan, travels, plays the accept scene, and can restore', async () => {
  const { h, gm, calls } = harness();
  try {
    const result = await gm.startQuestDebug('quest-11');
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'available');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(0, 5), ['capture', 'begin', 'travel', 'releaseTriggers', 'play']);
    assert.equal(gm.questDebugState().active, true);
    assert.equal(gm.questDebugState().questId, 'quest-11');

    const restored = await gm.returnFromQuestDebug();
    assert.equal(restored.ok, true, restored.reason);
    assert.equal(gm.questDebugState().active, false);
    assert.equal(h.session.status('quest-11'), 'locked');
    assert.equal(h.session.status('quest-10'), 'available');
    assert.ok(calls.includes('restore'));
    assert.ok(calls.includes('finish'));
  } finally { h.director.dispose(); }
});

test('an event-backed accept scene really starts after the setup hold is released', async () => {
  const { h, gm } = harness({ realPlay: true });
  try {
    const result = await gm.startQuestDebug('quest-262');
    assert.equal(result.ok, true, result.reason);
    for (let index = 0; index < 50; index++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.session.status('quest-262'), 'active');
  } finally { h.director.dispose(); }
});

test('keeping a debug run does not restore the earlier session state', async () => {
  const { h, gm, calls } = harness();
  try {
    assert.equal((await gm.startQuestDebug('quest-11')).ok, true);
    const event1 = h.session.campaign.events.find(event => event.id === 'event-1')!;
    assert.equal(h.director.allowsAutomaticEvent(event1), false);
    let notified = 0;
    const notify = h.director.notify.bind(h.director);
    (h.director as unknown as { notify: typeof notify }).notify = (...args) => {
      notified++;
      return notify(...args);
    };
    const kept = gm.keepQuestDebugProgress();
    assert.equal(kept.ok, true, kept.reason);
    assert.equal(gm.questDebugState().active, false);
    assert.equal(h.session.status('quest-11'), 'available');
    assert.equal(h.director.allowsAutomaticEvent(event1), true);
    assert.ok(calls.includes('checkpoint'), '保留进度后刷新回滚检查点');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(notified, 0, '保留进度不能补派发正式剧情');
    assert.equal(calls.includes('restore'), false);
    assert.ok(calls.includes('finish'));
    assert.ok(calls.includes('autoSave'), '保留进度后补一次自动存档请求');
  } finally { h.director.dispose(); }
});

test('a second debug run is rejected while one is active', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startQuestDebug('quest-11')).ok, true);
    const second = await gm.startQuestDebug('quest-18');
    assert.equal(second.ok, false);
    assert.match(second.reason ?? '', /已有调试任务/);
  } finally { h.director.dispose(); }
});

test('return and keep cannot run concurrently', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startQuestDebug('quest-11')).ok, true);
    const returning = gm.returnFromQuestDebug();
    const secondReturn = gm.returnFromQuestDebug();
    const keepDuringReturn = gm.keepQuestDebugProgress();
    const [first, second] = await Promise.all([returning, secondReturn]);
    assert.equal(first.ok, true, first.reason);
    assert.equal(second.ok, false);
    assert.match(second.reason ?? '', /正在结束/);
    assert.equal(keepDuringReturn.ok, false);
    assert.match(keepDuringReturn.reason ?? '', /正在结束/);
  } finally { h.director.dispose(); }
});

test('a travel failure restores the captured session state and clears forced availability', async () => {
  const { h, gm, calls } = harness({ travelThrows: true });
  try {
    const result = await gm.startQuestDebug('quest-11');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /传送失败/);
    assert.equal(h.session.status('quest-11'), 'locked');
    assert.equal(h.session.status('quest-10'), 'available');
    assert.ok(calls.includes('restore'));
    assert.ok(calls.includes('finish'));
    assert.equal(gm.questDebugState().active, false);
  } finally { h.director.dispose(); }
});

test('starting a talk quest enters ready, seeds the delivery NPC, and completes by talking', async () => {
  const { h, gm } = harness();
  try {
    const result = await gm.startQuestDebug('quest-4');
    assert.equal(result.ok, true, result.reason);
    assert.equal(gm.questDebugState().status, 'ready');
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-40'), true);
    await h.talk('npc-40');
    assert.equal(h.session.status('quest-4'), 'completed');
    assert.equal(gm.questDebugState().completed, true);
  } finally { h.director.dispose(); }
});

test('a debug run suppresses unrelated formal events and clears the filter when it ends', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startQuestDebug('quest-4')).ok, true);
    const event1 = h.session.campaign.events.find(event => event.id === 'event-1')!;
    assert.equal(h.director.allowsAutomaticEvent(event1), false);
    assert.equal(h.director.runtime.eventStatus('event-0'), 'completed');
    assert.equal(await h.director.enterRegion('event-1', 'shadow-camp'), false);
    assert.equal(h.director.runtime.eventStatus('event-1'), 'idle');

    const restored = await gm.returnFromQuestDebug();
    assert.equal(restored.ok, true, restored.reason);
    assert.equal(h.director.allowsAutomaticEvent(event1), true);
  } finally { h.director.dispose(); }
});
