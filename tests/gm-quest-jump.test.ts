import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { createGmActions, type GmStoryJumpPort, type GmStoryJumpSnapshot } from '../src/debug/gm-actions.ts';

async function waitFor(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('等待条件超时');
}

function harness(options: { travelThrows?: boolean; holdPlay?: boolean; playThrows?: boolean; holdSettled?: boolean } = {}) {
  const h = playthrough();
  const calls: string[] = [];
  let releasePlay: (() => void) | undefined;
  let releaseSettled: (() => void) | undefined;
  const snapshot = (): GmStoryJumpSnapshot => ({ session: h.session.captureState(), world: {} });
  const port: GmStoryJumpPort = {
    ready: () => true,
    capture: () => { calls.push('capture'); return snapshot(); },
    begin: () => { calls.push('begin'); h.director.holdTriggers(); },
    releaseTriggers: () => { calls.push('releaseTriggers'); h.director.releaseTriggers(); },
    closeMenu: () => calls.push('closeMenu'),
    travel: async () => {
      calls.push('travel');
      if (options.travelThrows) throw new Error('传送失败');
    },
    play: async () => {
      calls.push('play');
      if (options.holdPlay) await new Promise<void>(resolve => { releasePlay = resolve; });
      if (options.playThrows) throw new Error('剧情播放失败');
      return true;
    },
    settled: options.holdSettled
      ? async () => { await new Promise<void>(resolve => { releaseSettled = resolve; }); }
      : undefined,
    restore: async before => {
      calls.push('restore');
      h.session.restoreState(before.session);
    },
    checkpoint: () => { calls.push('checkpoint'); },
    finish: () => { calls.push('finish'); h.director.releaseTriggers(); },
    dispose: () => { calls.push('dispose'); h.director.releaseTriggers(); },
  };
  const gm = createGmActions({ session: h.session, campaign: h.session.campaign, director: h.director, storyJump: port,
    requestAutoSave: () => calls.push('autoSave') });
  return { h, gm, calls, release: () => releasePlay?.(), releaseSettled: () => releaseSettled?.(), hasSettled: () => !!releaseSettled };
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

test('a jump applies the plan, plays the accept scene and settles as normal progress', async () => {
  const { h, gm, calls } = harness();
  try {
    const result = await gm.startStoryJump('quest-11');
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'available');
    assert.deepEqual(calls.slice(0, 5), ['capture', 'begin', 'travel', 'releaseTriggers', 'play']);
    assert.deepEqual(calls.slice(5), ['finish', 'checkpoint', 'autoSave'],
      '接取剧情播完后直接交接，不留在调试态');
    assert.equal(calls.includes('restore'), false);
  } finally { h.director.dispose(); }
});

test('a setup failure restores the captured state and does not touch auto-save', async () => {
  const { h, gm, calls } = harness({ travelThrows: true });
  try {
    const result = await gm.startStoryJump('quest-11');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /传送失败/);
    assert.equal(h.session.status('quest-11'), 'locked');
    assert.equal(h.session.status('quest-10'), 'available');
    assert.ok(calls.includes('restore'));
    assert.ok(calls.includes('finish'));
    assert.equal(calls.includes('play'), false);
    assert.equal(calls.includes('checkpoint'), false);
    assert.equal(calls.includes('autoSave'), false);
    assert.equal(h.director.allowsAutomaticEvent(
      h.session.campaign.events.find(event => event.id === 'event-1')!), true,
      '启动失败也要清掉设置阶段的临时过滤器');
  } finally { h.director.dispose(); }
});

test('a story error after the jump starts keeps the jumped progress but reports failure', async () => {
  const { h, gm, calls } = harness({ playThrows: true });
  try {
    const result = await gm.startStoryJump('quest-11');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /接取剧情播放失败/);
    assert.equal(calls.includes('restore'), false, '接取剧情开演后不再回滚');
    assert.ok(calls.includes('finish'));
    assert.ok(calls.includes('autoSave'));
  } finally { h.director.dispose(); }
});

test('the handoff waits until the accept story really finishes', async () => {
  const { h, gm, calls, releaseSettled, hasSettled } = harness({ holdSettled: true });
  try {
    const jump = gm.startStoryJump('quest-11');
    await waitFor(() => hasSettled());
    assert.equal(calls.includes('finish'), false, '战斗等待期间不能先交接');
    assert.equal(calls.includes('autoSave'), false);
    releaseSettled();
    const result = await jump;
    assert.equal(result.ok, true, result.reason);
    assert.ok(calls.includes('finish'));
    assert.ok(calls.includes('autoSave'));
  } finally { h.director.dispose(); }
});

test('a second jump is rejected while the accept story is still running', async () => {
  const { h, gm, calls, release } = harness({ holdPlay: true });
  try {
    const first = gm.startStoryJump('quest-11');
    await waitFor(() => calls.includes('play'));
    const second = await gm.startStoryJump('quest-18');
    assert.equal(second.ok, false);
    assert.match(second.reason ?? '', /正在执行剧情跳转/);
    release();
    const done = await first;
    assert.equal(done.ok, true, done.reason);
  } finally { h.director.dispose(); }
});

test('starting a talk quest enters ready, seeds the delivery NPC, and completes by talking', async () => {
  const { h, gm } = harness();
  try {
    const result = await gm.startStoryJump('quest-4');
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.session.status('quest-4'), 'ready');
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-40'), true);
    await h.talk('npc-40');
    assert.equal(h.session.status('quest-4'), 'completed');
  } finally { h.director.dispose(); }
});

test('a jump leaves automatic events to the formal director', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startStoryJump('quest-4')).ok, true);
    const event1 = h.session.campaign.events.find(event => event.id === 'event-1')!;
    assert.equal(h.director.allowsAutomaticEvent(event1), true);
    assert.equal(h.director.runtime.eventStatus('event-0'), 'completed');
    assert.equal(await h.director.enterRegion('event-1', 'shadow-camp'), true);
    assert.notEqual(h.director.runtime.eventStatus('event-1'), 'idle');
  } finally { h.director.dispose(); }
});

test('a jump from quest-10 follows the formal chain to quest-12', async () => {
  const { h, gm } = harness();
  try {
    assert.equal((await gm.startStoryJump('quest-10', 'ready')).ok, true);
    assert.equal(h.session.status('quest-10'), 'ready');

    assert.equal(h.session.complete('quest-10'), true);
    await h.idle();
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'available');

    assert.equal(h.session.accept('quest-11'), true);
    await h.idle();
    for (let index = 0; index < 5; index++)
      h.session.recordQuestFact('defeat', 'enemy-wild-wolf-1', 'gm-story-jump-test');
    await h.idle();
    assert.equal(h.session.status('quest-11'), 'ready');

    assert.equal(h.session.complete('quest-11'), true);
    for (let index = 0; index < 50 && h.director.runtime.eventStatus('event-15') !== 'completed'; index++)
      await h.idle();

    assert.equal(h.director.runtime.eventStatus('event-15'), 'completed');
    assert.equal(h.session.status('quest-12'), 'ready');
  } finally { h.director.dispose(); }
});
