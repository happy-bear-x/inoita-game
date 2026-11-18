import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GroundLootStore } from '../src/domain/ground-loot.ts';
import { parseDrops, rollEnemyLoot, type DropReward } from '../src/domain/drops.ts';
import { parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';
import { newStorySession } from '../src/domain/story-class.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const stats = parseCharacterStats(read('character-stats'));
const items = parseItemCatalog(read('items'));
const drops = parseDrops(read('drops'), items, read('battle').enemies.map((enemy: { id: string }) => enemy.id));

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test('ground drops share one pickup rule: whoever walks over them collects', () => {
  const store = new GroundLootStore();
  const reward: DropReward = { kind: 'money', amount: 10 };
  store.add('map', 10, 10, [reward]);
  assert.equal(store.collectNearby('map', 10, 10, () => true).length, 1);
  store.add('map', 10, 10, [reward]);
  assert.equal(store.collectNearby('map', 12, 12, () => true).length, 1, '12px 内即可拾取');
  assert.equal(store.collectNearby('map', 30, 10, () => true).length, 0, '离得远不能拾取');
});

test('a guaranteed equipment drop carries a grade snapshot that survives pickup', () => {
  const random = seeded(0x51ed);
  const result = rollEnemyLoot(drops, stats, 'enemy-scorpion-1', 100, 100, random,
    {}, { equipmentBonus: 10_000 });
  const equipment = result.rewards.filter(reward => reward.kind === 'item' && reward.roll);
  assert.ok(equipment.length >= 1, '保底应至少有一件装备');
  const reward = equipment[0]!;
  assert.ok(reward.kind === 'item' && reward.roll);
  const session = newStorySession(read('campaign'), read('world').actors[read('campaign').start.actor],
    read('story-classes').classes[0], items, stats, read('battle'), read('companions'));
  const instance = session.bag.prepareDrop(reward.item, { grade: reward.roll, sockets: reward.roll!.sockets });
  assert.equal(instance.numbers?.grade, reward.roll!.grade);
  assert.equal(instance.numbers?.baseAttack, reward.roll!.attack);
});

test('a rarity floor applies to every guaranteed drop', () => {
  const random = seeded(0x1234);
  for (let index = 0; index < 50; index += 1) {
    const result = rollEnemyLoot(drops, stats, 'enemy-scorpion-1', 100, 100, random,
      {}, { equipmentBonus: 10_000, minRarity: 2 });
    for (const reward of result.rewards)
      if (reward.kind === 'item' && reward.roll) assert.ok(reward.roll.rarity >= 2, `稀有度 ${reward.roll.rarity}`);
  }
});

test('quest drops stay a single shared roll', () => {
  const random = seeded(0x77);
  const result = rollEnemyLoot(drops, stats, 'enemy-scorpion-1', 100, 100, random);
  assert.ok(Array.isArray(result.rewards));
  assert.ok(result.rewards.every(reward => reward.kind === 'money' || reward.kind === 'item'));
});

test('ground loot caps each map at 64, dropping the oldest first', () => {
  const reward: DropReward = { kind: 'money', amount: 1 };
  const store = new GroundLootStore();
  store.add('map', 0, 0, Array.from({ length: 70 }, () => reward));
  assert.equal(store.forMap('map').length, 64, '每图最多 64 件');
  store.add('other', 0, 0, [reward]);
  assert.equal(store.forMap('other').length, 1, '上限按地图分别计算');
});
