import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { applyQuestStartPlan, planQuestStart, questFocusEventIds } from '../src/debug/quest-jump.ts';

test('quest-11 starts available from its script-only accept chain', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-11');
    assert.equal(plan.mode, 'available');
    assert.equal(plan.fallback, false);
    assert.equal(plan.accept?.script, 'next:quest-10:quest-11');
    assert.equal(plan.accept?.eventId, undefined);
    assert.equal(plan.acceptAlternatives[0]?.script, 'next:quest-10:quest-11');
    assert.ok(plan.changedQuests.some(change => change.id === 'quest-10' && change.to === 'completed'));
    assert.ok(plan.destination, '任务可接取地点存在');

    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-10'), 'completed');
    assert.equal(h.session.status('quest-11'), 'available');
    assert.equal(h.session.questBook.runningQuestIds.includes('quest-11'), false);
  } finally {
    h.director.dispose();
  }
});

test('quest-262 uses event-283 and clears a previously completed accept event', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-262');
    assert.equal(plan.mode, 'available');
    assert.equal(plan.accept?.eventId, 'event-283');
    assert.ok(plan.conditionPatch.quests.some(entry => entry.id === 'quest-261' && entry.status === 'completed'));

    const runtime = structuredClone(h.session.runtimeState);
    runtime.completedEvents = [...runtime.completedEvents, 'event-283'];
    h.session.runtimeState = runtime;

    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-262'), 'available');
    assert.equal(h.session.runtimeState.completedEvents.includes('event-283'), false);
  } finally {
    h.director.dispose();
  }
});

test('a quest without an accept script stays available at the giver', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-18');
    assert.equal(plan.mode, 'available');
    assert.equal(plan.fallback, false);
    assert.equal(plan.accept, undefined);
    assert.equal(plan.destination?.map, 'training-dungeon-one');
  } finally {
    h.director.dispose();
  }
});

test('an internal quest without an available entry falls back to active', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-13');
    assert.equal(plan.mode, 'active');
    assert.equal(plan.fallback, true);
    assert.ok(plan.warnings.some(warning => warning.includes('内部任务')));
  } finally {
    h.director.dispose();
  }
});

test('an accept event choice condition is patched with the required choice', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-502');
    const choice = plan.conditionPatch.choices.find(entry => entry.choice === 'choice-36');
    assert.ok(choice, 'choice-36 条件应被补进计划');
    assert.equal(choice.value, 'option-0');
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.storyWorld.choice('choice-36'), 'option-0');
  } finally {
    h.director.dispose();
  }
});

test('a ready prerequisite stays ready after the full refresh', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-275');
    assert.equal(plan.accept?.eventId, 'event-301');
    assert.equal(plan.conditionPatch.unsatisfied.length, 0);
    applyQuestStartPlan(h.session, plan);
    assert.equal(h.session.status('quest-274'), 'ready');
    const event = campaign.events.find(entry => entry.id === 'event-301')!;
    assert.equal(h.session.evaluateCondition(event.condition!), true);
  } finally {
    h.director.dispose();
  }
});

test('applying a plan keeps the running pool exactly in sync with active and ready quests', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-11');
    applyQuestStartPlan(h.session, plan);
    const running = new Set(h.session.questBook.runningQuestIds);
    for (const [id, state] of h.session.quests) {
      const shouldRun = state.status === 'active' || state.status === 'ready';
      assert.equal(running.has(id), shouldRun, `${id} 的运行池状态`);
    }
    // 调试状态必须还能被正式的读档校验接受，不能造出一份只有调试层认的现场。
    const sandbox = h.session.createStorySandbox();
    sandbox.restoreState(h.session.captureState());
    assert.equal(sandbox.status('quest-11'), 'available');
  } finally {
    h.director.dispose();
  }
});

test('quest-4 starts ready, seeds its gated delivery NPC, and marks the opening event complete', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-4');
    assert.equal(plan.mode, 'ready');
    assert.equal(plan.fallback, true);
    assert.ok(plan.warnings.some(warning => warning.includes('待交付')));
    assert.equal(plan.destination?.map, 'shadow-camp');
    assert.equal(plan.destination?.x, 264);
    assert.ok(plan.conditionPatch.flags.some(entry =>
      entry.flag === 'quest-npc-located-npc-40' && entry.value === true));

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    assert.equal(h.session.status('quest-3'), 'completed');
    assert.equal(h.session.status('quest-4'), 'ready');
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-40'), true);
    assert.ok(h.session.runtimeState.completedEvents.includes('event-0'));
    assert.equal(h.session.runtimeState.completedEvents.includes('event-1'), false);
    const placement = campaign.placements.find(entry => entry.id === 'quest-npc-located-npc-40')!;
    assert.equal(h.session.evaluateCondition(placement.condition), true);
  } finally {
    h.director.dispose();
  }
});

test('an internal fallback applies through the script accept path', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-13');
    assert.equal(plan.mode, 'active');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();
    assert.equal(h.session.status('quest-13'), 'active');
  } finally {
    h.director.dispose();
  }
});

test('a filtered region stays occupied so the exit can still trigger', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-4');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.setAutomaticEventFilter(() => false);
    h.director.releaseTriggers();

    let regionCalls = 0;
    const enterRegion = h.director.enterRegion.bind(h.director);
    (h.director as unknown as { enterRegion: typeof enterRegion }).enterRegion = (id, map) => {
      regionCalls++;
      return enterRegion(id, map);
    };

    const location = h.session.storyWorld.currentLocation!;
    h.session.movePlayer({ ...location, x: 360, y: 328 });
    h.frame('none');
    h.session.movePlayer({ ...location, x: 392, y: 328 });
    h.frame('all', ['event-1']);
    assert.equal(regionCalls, 1);
    h.session.movePlayer({ ...location, x: 393, y: 328 });
    h.frame('all', ['event-1']);

    assert.equal(h.session.storyWorld.currentLocation?.map, 'shadow-forest-west');
    assert.equal(h.director.runtime.eventStatus('event-1'), 'idle');
  } finally {
    h.director.dispose();
  }
});

test('quest focus only admits events attached to the target quest', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const hunter = campaign.quests.find(quest => quest.id === 'quest-262')!;
    assert.ok(questFocusEventIds(campaign, hunter, 'event-283').has('event-283'));
    const report = campaign.quests.find(quest => quest.id === 'quest-4')!;
    const focus = questFocusEventIds(campaign, report);
    assert.equal(focus.has('event-1'), false);
    assert.equal(focus.has('event-6'), false);
  } finally {
    h.director.dispose();
  }
});
