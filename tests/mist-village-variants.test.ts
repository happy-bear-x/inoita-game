import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import type { QuestStatus, WorldMap } from '../src/domain/content.ts';
import { evaluateStoryCondition, type StoryConditionContext } from '../src/domain/story-condition.ts';

/**
 * 雾之村的克劳德、莫妮卡、费罗斯各有「地图静态版」和「剧情版」两个实例。
 * 两套实例站在同一格，显隐必须按任务阶段互斥，不能靠踩到某个区域事件才切换。
 */
const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign: Campaign = read('campaign');
const map: WorldMap = read('maps/mist-village-1b503cf0');
const entities = [...map.entities, ...campaign.placements];

function context(quest255: QuestStatus, quest334: QuestStatus, quest335: QuestStatus): StoryConditionContext {
  const statuses: Record<string, QuestStatus> = { 'quest-255': quest255, 'quest-334': quest334, 'quest-335': quest335 };
  return {
    questStatus: id => statuses[id] ?? 'locked',
    eventStatus: () => 'idle',
    choice: () => undefined,
    flag: () => false,
    world: () => undefined
  };
}

function visible(id: string, quest255: QuestStatus, quest334: QuestStatus, quest335: QuestStatus): boolean {
  const entity = entities.find(value => value.id === id);
  assert.ok(entity, `缺少实体 ${id}`);
  return evaluateStoryCondition(entity.condition, context(quest255, quest334, quest335));
}

const staticIds = ['charles-a302dcb7-012', 'claude-654192ed-002', 'felix-a1cb422a-011'];
const storyIds = ['claude-e6e221a8-017', 'felix-3fb0f273-021', 'charles-d7fb0023-022', 'quest-npc-npc-449'];
const monicaStoryIds = ['monica-5a307cb2-018', 'quest-npc-npc-447'];
const monicaStaticId = 'monica-6ffc2d17-009';

test('mist village variants switch visibility by quest phase', () => {
  // 阶段 0：quest-334 还没就绪。只留剧情版，静态版全部隐藏，避免提前叠人。
  for (const id of staticIds) assert.equal(visible(id, 'available', 'locked', 'locked'), false, `${id} 在 quest-334 就绪前应隐藏`);
  assert.equal(visible(monicaStaticId, 'available', 'locked', 'locked'), false, '莫妮卡的静态版在 quest-334 就绪前应隐藏');
  for (const id of storyIds) assert.equal(visible(id, 'available', 'locked', 'locked'), true, `${id} 在 quest-334 就绪前应可见`);
  for (const id of monicaStoryIds) assert.equal(visible(id, 'available', 'locked', 'locked'), true, `${id} 在 quest-334 就绪前应可见`);
  assert.equal(visible('quest-npc-npc-483', 'available', 'locked', 'locked'), false, 'quest-360 的任务版在 quest-334 就绪前应隐藏');

  // 阶段 1：quest-255 已完成、quest-334 还没就绪。仍然只留剧情版。
  for (const id of staticIds) assert.equal(visible(id, 'completed', 'active', 'locked'), false, `${id} 在 quest-334 就绪前应隐藏`);
  for (const id of storyIds) assert.equal(visible(id, 'completed', 'active', 'locked'), true, `${id} 在 quest-334 就绪前应可见`);
  assert.equal(visible('quest-npc-npc-483', 'completed', 'active', 'locked'), false, 'quest-360 的任务版在 quest-334 就绪前应隐藏');

  // 阶段 2：quest-334 就绪。克劳德、查尔斯、费罗斯回到静态版；莫妮卡保留剧情版。
  for (const id of staticIds) assert.equal(visible(id, 'completed', 'ready', 'locked'), true, `${id} 在 quest-334 就绪后应可见`);
  for (const id of storyIds) assert.equal(visible(id, 'completed', 'ready', 'locked'), false, `${id} 在 quest-334 就绪后应隐藏`);
  for (const id of monicaStoryIds) assert.equal(visible(id, 'completed', 'ready', 'locked'), true, `${id} 在 quest-334 就绪后仍保留`);
  assert.equal(visible(monicaStaticId, 'completed', 'ready', 'locked'), false, '莫妮卡的静态版在 quest-334 就绪后应隐藏');
  assert.equal(visible('quest-npc-npc-483', 'completed', 'ready', 'locked'), true, 'quest-360 的任务版在 quest-334 就绪后应可见');

  // quest-335 已接取也代表 event-384 已经切换过，即使调试现场没有写 quest-334 状态。
  assert.equal(visible('claude-654192ed-002', 'completed', 'active', 'active'), true, 'quest-335 接取后静态版应可见');
  assert.equal(visible('claude-e6e221a8-017', 'completed', 'active', 'active'), false, 'quest-335 接取后剧情版应隐藏');
});
