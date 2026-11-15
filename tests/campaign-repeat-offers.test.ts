import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateStoryCondition, type StoryConditionContext } from '../src/domain/story-condition.ts';
import type { QuestStatus } from '../src/domain/content.ts';

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));

/** 首都两名 NPC 和黑暗教团 NPC 的重复任务：接取一次后不再重复弹出。 */
const offers = [
  { event: 'event-595', npc: '拉宾斯', base: 'quest-492', followUp: 'quest-499' },
  { event: 'event-597', npc: '米莉儿', base: 'quest-494', followUp: 'quest-500' },
  { event: 'event-599', npc: '卡茵', base: 'quest-498', followUp: 'quest-502' },
] as const;

function context(base: QuestStatus, followUp: QuestStatus): StoryConditionContext {
  return {
    questStatus: id => {
      for (const offer of offers) {
        if (id === offer.base) return base;
        if (id === offer.followUp) return followUp;
      }
      return 'locked';
    },
    eventStatus: () => 'idle',
    choice: () => undefined,
    flag: () => false,
    world: () => undefined,
  };
}

test('repeat offers fire until the follow-up quest is accepted, then stay closed', () => {
  for (const offer of offers) {
    const event = campaign.events.find((value: { id: string }) => value.id === offer.event);
    assert.ok(event, `${offer.npc} 缺少近身事件 ${offer.event}`);
    assert.equal(evaluateStoryCondition(event.condition, context('completed', 'available')), true,
      `${offer.npc} 的后续任务可接时应弹出一次`);
    for (const status of ['active', 'ready', 'completed'] as const)
      assert.equal(evaluateStoryCondition(event.condition, context('completed', status)), false,
        `${offer.npc} 的后续任务 ${status} 后不应再弹出`);
    assert.equal(evaluateStoryCondition(event.condition, context('active', 'available')), false,
      `${offer.npc} 的前置任务未完成时不应弹出`);
  }
});
