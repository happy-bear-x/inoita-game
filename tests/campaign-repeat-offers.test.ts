import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateStoryCondition, type StoryCondition, type StoryConditionContext } from '../src/domain/story-condition.ts';
import type { QuestStatus } from '../src/domain/content.ts';

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8'));

interface CampaignQuest {
  id: string;
  availableWhen?: StoryCondition;
}
interface CampaignCommand {
  type: string;
  command?: { type: string; quest: string };
}
interface CampaignScriptNode {
  id: string;
  exit?: { type: string; condition?: StoryCondition };
  commands?: CampaignCommand[];
}

function quest(id: string): CampaignQuest {
  const value = campaign.quests.find((entry: CampaignQuest) => entry.id === id);
  assert.ok(value, `缺少任务 ${id}`);
  return value;
}

function scriptNodes(id: string): CampaignScriptNode[] {
  const value = campaign.scripts[id] as { nodes: CampaignScriptNode[] } | undefined;
  assert.ok(value, `缺少脚本 ${id}`);
  return value.nodes;
}

/** 首都两名 NPC 和黑暗教团 NPC 的重复任务：接取一次后不再重复弹出。 */
const offers = [
  { event: 'event-595', acceptEvent: 'event-596', npc: '拉宾斯', base: 'quest-492', followUp: 'quest-499' },
  { event: 'event-597', acceptEvent: 'event-598', npc: '米莉儿', base: 'quest-494', followUp: 'quest-500' },
  { event: 'event-599', acceptEvent: 'event-600', npc: '卡茵', base: 'quest-498', followUp: 'quest-502' },
] as const;

function context(statuses: Partial<Record<string, QuestStatus>>): StoryConditionContext {
  return {
    questStatus: id => statuses[id] ?? 'locked',
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
    assert.equal(evaluateStoryCondition(event.condition, context({ [offer.base]: 'completed', [offer.followUp]: 'available' })), true,
      `${offer.npc} 的后续任务可接时应弹出一次`);
    for (const status of ['active', 'ready', 'completed'] as const)
      assert.equal(evaluateStoryCondition(event.condition, context({ [offer.base]: 'completed', [offer.followUp]: status })), false,
        `${offer.npc} 的后续任务 ${status} 后不应再弹出`);
    assert.equal(evaluateStoryCondition(event.condition, context({ [offer.base]: 'active', [offer.followUp]: 'available' })), false,
      `${offer.npc} 的前置任务未完成时不应弹出`);
  }
});

test('follow-up quests stay reachable under the real content conditions', () => {
  for (const offer of offers) {
    const followUp = quest(offer.followUp);
    if (offer.followUp === 'quest-502') {
      assert.equal(evaluateStoryCondition(followUp.availableWhen, context({})), false,
        'quest-502 在前置任务 quest-498 未完成时不可接');
      assert.equal(evaluateStoryCondition(followUp.availableWhen, context({ 'quest-498': 'completed' })), true,
        'quest-498 完成后 quest-502 可接');
    } else {
      assert.deepEqual(followUp.availableWhen, { type: 'all', conditions: [] },
        `${offer.followUp} 没有前置条件`);
      assert.equal(evaluateStoryCondition(followUp.availableWhen, context({})), true,
        `${offer.followUp} 应恒为可接`);
    }
  }
});

test('accept scripts take the same follow-up quest their branch checks', () => {
  for (const offer of offers) {
    const nodes = scriptNodes(offer.acceptEvent);
    const branch = nodes.find(node => node.exit?.type === 'branch');
    assert.ok(branch?.exit?.condition, `${offer.acceptEvent} 缺少任务分支`);
    assert.equal(branch.exit.condition.type, 'quest');
    assert.equal((branch.exit.condition as { quest: string }).quest, offer.followUp,
      `${offer.acceptEvent} 的分支应判断 ${offer.followUp}`);
    // "accepted" 覆盖进行中、待交付和已完成；只有可接或未解锁才进入接取分支。
    for (const status of ['active', 'ready', 'completed', 'available', 'locked'] as const) {
      const accepted = status === 'active' || status === 'ready' || status === 'completed';
      assert.equal(evaluateStoryCondition(branch.exit.condition, context({ [offer.followUp]: status })), accepted,
        `${offer.acceptEvent} 在 ${status} 时应${accepted ? '' : '不'}跳过接取`);
    }
    const accepted = nodes.flatMap(node => node.commands ?? [])
      .filter(command => command.type === 'quest' && command.command?.type === 'accept')
      .map(command => command.command!.quest);
    assert.deepEqual(accepted, [offer.followUp], `${offer.acceptEvent} 应接取 ${offer.followUp}`);
  }
});
