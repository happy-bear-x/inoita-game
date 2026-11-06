import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInteraction, type InteractionTarget } from '../src/domain/interaction.ts';

const base: InteractionTarget = {
  chest: false, spring: false,
  objective: false, questSlot: false, shop: false,
};

test('chests and springs win over services and story', () => {
  assert.deepEqual(resolveInteraction({ ...base, chest: true }), { kind: 'chest' });
  assert.deepEqual(resolveInteraction({ ...base, chest: true, spring: true }), { kind: 'chest' },
    '宝箱判定在泉水之前');
  assert.deepEqual(resolveInteraction({ ...base, spring: true, service: 'innkeeper' }), { kind: 'spring' },
    '泉水判定在 NPC 服务之前');
});

test('each service maps to its own action when no quest slot is taken', () => {
  assert.deepEqual(resolveInteraction({ ...base, service: 'fusion-machine' }), { kind: 'crafting' });
  assert.deepEqual(resolveInteraction({ ...base, service: 'soul-healer' }), { kind: 'soul-healer' });
  assert.deepEqual(resolveInteraction({ ...base, service: 'legendary-sword' }), { kind: 'legendary-sword' });
  assert.deepEqual(resolveInteraction({ ...base, service: 'innkeeper' }), { kind: 'innkeeper' });
});

test('a service NPC holding a quest slot plays the story instead of its panel', () => {
  for (const service of ['fusion-machine', 'soul-healer', 'legendary-sword', 'innkeeper'] as const) {
    assert.deepEqual(resolveInteraction({ ...base, service, questSlot: true }), { kind: 'story' },
      `${service} 的任务槽优先于功能面板`);
  }
});

test('shops open only without a quest objective or quest slot, otherwise story wins', () => {
  assert.deepEqual(resolveInteraction({ ...base, shop: true }), { kind: 'shop' });
  assert.deepEqual(resolveInteraction({ ...base, shop: true, objective: true }), { kind: 'story' },
    '带任务目标的实体走剧情');
  assert.deepEqual(resolveInteraction({ ...base, shop: true, questSlot: true }), { kind: 'story' },
    '占用任务槽时走剧情');
  assert.deepEqual(resolveInteraction({ ...base, service: 'innkeeper', shop: true }), { kind: 'innkeeper' },
    'NPC 服务先于商店判定');
});

test('everything else falls back to ordinary story interaction', () => {
  assert.deepEqual(resolveInteraction(base), { kind: 'story' });
  assert.deepEqual(resolveInteraction({ ...base, objective: true }), { kind: 'story' });
  assert.deepEqual(resolveInteraction({ ...base, questSlot: true }), { kind: 'story' });
});
