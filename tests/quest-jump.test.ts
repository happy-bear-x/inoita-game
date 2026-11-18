import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';
import { applyQuestStartPlan, planQuestStart, questFocusEventIds } from '../src/debug/quest-jump.ts';
import { parseDrops } from '../src/domain/drops.ts';
import { prepareSceneVisit } from '../src/domain/scene-visit.ts';
import type { Session } from '../src/domain/session.ts';
import { parseSprings } from '../src/domain/springs.ts';
import { resolveStoryScene } from '../src/domain/story-scene.ts';
import type { StoryStage } from '../src/domain/story-performance.ts';

const contentJson = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const testDrops = parseDrops(contentJson('drops'), headlessContent.items,
  headlessContent.battle.enemies.map(enemy => enemy.id));
const testSprings = parseSprings(contentJson('springs'));

/** 用正式进图与舞台解析流程预演接取演出。 */
function resolveAcceptStage(session: Session, stage: StoryStage) {
  const map = headlessContent.maps.get(stage.map)!;
  const scene = prepareSceneVisit({
    session, campaign: headlessContent.campaign, world: headlessContent.world,
    battleCatalog: headlessContent.battle, drops: testDrops, springs: testSprings,
  }, map, {
    id: 'player', actor: headlessContent.campaign.start.actor,
    x: stage.x, y: stage.y, facing: 'south', visible: true,
  }, () => 0.5);
  return resolveStoryScene(stage, scene);
}

function acceptStages(script: string): StoryStage[] {
  return headlessContent.campaign.scripts[script].nodes
    .flatMap(node => node.presentation)
    .filter((action): action is StoryStage => action.type === 'stage');
}

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

test('a filtered region stays occupied so the exit can still trigger', async () => {
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

    // 同一套占用逻辑也要能在过滤解除后原地补触发，不必先走开再回来。
    h.session.movePlayer({ ...h.session.storyWorld.currentLocation!, x: 600, y: 620 });
    h.frame('all', ['event-2']);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.director.runtime.eventStatus('event-2'), 'idle');
    h.director.setAutomaticEventFilter(undefined);
    h.frame('all', ['event-2']);
    for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.notEqual(h.director.runtime.eventStatus('event-2'), 'idle', '过滤解除后原地补触发');
  } finally {
    h.director.dispose();
  }
});

test('quest-275 grants handover items and lets the prerequisite finish', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-275');
    assert.equal(plan.mode, 'available');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    assert.ok(h.session.bag.count('powder') >= 10, '补足火药');
    assert.ok(h.session.bag.count('firecracker') >= 5, '补足爆竹');
    assert.equal(h.session.status('quest-274'), 'ready');

    h.session.applyStoryCommands([{
      type: 'quest',
      command: { type: 'script-complete', quest: 'quest-274', cycle: h.session.questBook.state('quest-274')?.cycle },
    }]);
    assert.equal(h.session.status('quest-274'), 'completed', '正式完成要盖过调试钉住的 ready');
    h.director.releaseTriggers();
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

    const saint = campaign.quests.find(quest => quest.id === 'quest-35')!;
    const chain = questFocusEventIds(campaign, saint, undefined, new Set(['quest-35']));
    assert.ok(chain.has('event-38'), '条件引用目标任务的触发事件要放行');
    assert.ok(chain.has('event-40'), '完成事件条件里的前置事件也要放行');
    assert.equal(chain.has('event-1'), false);
  } finally {
    h.director.dispose();
  }
});

test('quest-10 replays the original world commands for its accept scene cast', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-10');
    assert.equal(plan.accept?.eventId, 'event-47');
    assert.equal(plan.destination?.map, 'training-dungeon-one');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-59'));
    assert.ok(plan.worldCommands.some(command => command.type === 'flag'
      && command.flag === 'quest-npc-located-npc-59' && command.value === true));
    assert.equal(plan.worldCommands.some(command => command.type === 'quest'), false,
      '世界状态只重放世界命令，不改任务状态');
    assert.equal(plan.warnings.some(warning => warning.includes('找不到对应的剧情命令')), false);

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    assert.equal(h.session.storyWorld.isPlaced('quest-npc-located-npc-59'), true);
    assert.equal(h.session.storyWorld.hasFlag('quest-npc-located-npc-59'), true);
    const placement = campaign.placements.find(entry => entry.id === 'quest-npc-located-npc-59')!;
    assert.equal(h.session.visible(placement), true);
  } finally {
    h.director.dispose();
  }
});

test('quest-10 accept scene shows Lehman with the real stage pipeline', () => {
  const h = playthrough();
  try {
    const plan = planQuestStart(h.session.campaign, h.session, 'quest-10');
    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    const stage = acceptStages('event-47')[0]!;
    const resolved = resolveAcceptStage(h.session, stage);
    const lehman = resolved.scene.actors.find(actor => actor.worldEntityId === 'quest-npc-located-npc-59');
    assert.ok(lehman);
    assert.equal(lehman.visible, true);
    assert.deepEqual([lehman.x, lehman.y], [200, 408]);
    assert.equal(resolved.cast.find(member => member.id === 'story-lehman-90989efd')?.visible, true);
  } finally {
    h.director.dispose();
  }
});

test('quest-153 replay follows the accept stage map instead of the destination', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-153');
    assert.equal(plan.accept?.eventId, 'event-44');
    assert.equal(plan.destination?.map, 'kamuran-wilderness-d37060c8');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-246'));
    // npc-82 没有 worldEntityId，只能按舞台地图匹配；只补目的地会漏掉它。
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-82'));

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();

    const stage = acceptStages('event-44').find(value =>
      value.cast.some(member => member.worldEntityId === 'quest-npc-located-npc-246'))!;
    assert.equal(stage.map, 'leap-gate-district-1da2f793');
    const resolved = resolveAcceptStage(h.session, stage);
    const lehman = resolved.scene.actors.find(actor => actor.worldEntityId === 'quest-npc-located-npc-246');
    assert.ok(lehman);
    assert.equal(lehman.visible, true);
  } finally {
    h.director.dispose();
  }
});

test('a world entity placed on another map is replayed before the accept scene', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    h.session.storyWorld.apply({ kind: 'place', entity: {
      id: 'quest-npc-located-npc-59', map: 'inside-arnen-castle01-8b6ce276',
      actor: 'story-lehman-90989efd', characterId: 'npc-59', x: 200, y: 376, visible: true } });
    h.session.applyStoryCommands([{ type: 'flag', flag: 'quest-npc-located-npc-59', value: true }]);

    const plan = planQuestStart(campaign, h.session, 'quest-10');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-59'
      && command.command.entity.map === 'training-dungeon-one'));

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();
    assert.equal(h.session.storyWorld.entity('quest-npc-located-npc-59')?.map, 'training-dungeon-one');
  } finally {
    h.director.dispose();
  }
});

test('a placement from a later story event is not replayed into an earlier jump', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    const plan = planQuestStart(campaign, h.session, 'quest-317');
    assert.ok(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-located-npc-445'
      && command.command.entity.map === 'eternal-snowy-forest-3-d519c1d9'));
    assert.equal(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'remove-character' && command.command.characterId === 'npc-492'), false,
      '不能重放目标之后事件的清场命令');

    h.director.holdTriggers();
    applyQuestStartPlan(h.session, plan);
    h.director.releaseTriggers();
    assert.equal(h.session.storyWorld.entity('quest-npc-located-npc-445')?.map,
      'eternal-snowy-forest-3-d519c1d9');
    assert.equal(h.session.storyWorld.actorVisible('eternal-snowy-valley-f39c6607', 'npc-492'), true);
  } finally {
    h.director.dispose();
  }
});

test('a quest-gated placement that should stay hidden does not warn about a missing source', () => {
  const h = playthrough();
  try {
    const campaign = h.session.campaign;
    h.session.applyStoryCommands([{ type: 'quest', command: { type: 'accept', quest: 'quest-334' } }]);
    assert.equal(h.session.status('quest-334'), 'ready');

    const plan = planQuestStart(campaign, h.session, 'quest-322');
    assert.equal(plan.worldCommands.some(command => command.type === 'world'
      && command.command.kind === 'place' && command.command.entity.id === 'quest-npc-npc-449'), false);
    assert.equal(plan.warnings.some(warning => warning.includes('quest-npc-npc-449')), false,
      '条件要求隐藏的 NPC 不该报缺来源');
  } finally {
    h.director.dispose();
  }
});


