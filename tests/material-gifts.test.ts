import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseItemCatalog } from '../src/application/content-validation.ts';
import { Bag } from '../src/domain/bag.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { parseDrops, rollReservedDrops, type DropCatalog } from '../src/domain/drops.ts';
import type { ItemReward } from '../src/domain/items.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = parseItemCatalog(read('items'));
const rawDrops = read<DropCatalog>('drops');
const drops = parseDrops(rawDrops, items, Object.keys(rawDrops.enemies));
const stats = read<CharacterStatsCatalog>('character-stats');
const gifts: { id: string; minimumLevel: number; bossOnly: boolean; rewards: ItemReward[] }[] = [
  { id: 'chaos-set', minimumLevel: 40, bossOnly: false, rewards: [
    { item: 'magic-branch', quantity: 6 }, { item: 'spell-crystal', quantity: 6 },
    { item: 'mithril', quantity: 18 }, { item: 'chaos-scale', quantity: 3 },
  ] },
  { id: 'bounteous-chaos-set', minimumLevel: 60, bossOnly: true, rewards: [
    { item: 'magic-branch', quantity: 24 }, { item: 'spell-crystal', quantity: 24 },
    { item: 'mithril', quantity: 72 }, { item: 'chaos-scale', quantity: 12 },
    { item: 'jewel-of-catharsis', quantity: 2 },
  ] },
  { id: 'epic-chaos-set', minimumLevel: 70, bossOnly: false, rewards: [
    { item: 'transcendent-flower', quantity: 2 }, { item: 'palpitant-crystal', quantity: 6 },
    { item: 'mithril', quantity: 16 }, { item: 'chaos-scale', quantity: 2 },
  ] },
  { id: 'bounteous-epic-chaos-set', minimumLevel: 90, bossOnly: true, rewards: [
    { item: 'transcendent-flower', quantity: 8 }, { item: 'palpitant-crystal', quantity: 24 },
    { item: 'mithril', quantity: 64 }, { item: 'chaos-scale', quantity: 8 },
    { item: 'jewel-of-catharsis', quantity: 2 },
  ] },
  { id: 'equip-combo-set', minimumLevel: 60, bossOnly: false, rewards: [
    { item: 'mithril', quantity: 4 }, { item: 'leather', quantity: 25 },
    { item: 'magic-cloth', quantity: 25 }, { item: 'bloody-fur', quantity: 25 },
    { item: 'standard-jewel', quantity: 2 }, { item: 'advanced-jewel', quantity: 2 },
    { item: 'supreme-jewel', quantity: 2 },
  ] },
  { id: 'bounteous-equip-combo-set', minimumLevel: 80, bossOnly: true, rewards: [
    { item: 'mithril', quantity: 8 }, { item: 'leather', quantity: 50 },
    { item: 'magic-cloth', quantity: 50 }, { item: 'bloody-fur', quantity: 50 },
    { item: 'standard-jewel', quantity: 2 }, { item: 'advanced-jewel', quantity: 2 },
    { item: 'supreme-jewel', quantity: 6 },
  ] },
];

for (const gift of gifts) {
  test(`${gift.id} consumes one box and grants every described material on each opening`, () => {
    const bag = new Bag(() => {}, items);
    bag.add(gift.id, 2);
    const entry = bag.entries.find(entry => entry.item === gift.id)!;
    for (let opened = 1; opened <= 2; opened++) {
      const result = bag.use(entry.id);
      assert.equal(result.kind, 'pack');
      assert.deepEqual(result.rewards, gift.rewards);
      assert.equal(bag.count(gift.id), 2 - opened);
      for (const reward of gift.rewards) assert.equal(bag.count(reward.item), reward.quantity * opened, reward.item);
      bag.verifyConsistency();
    }
  });

  test(`${gift.id} is a repeatable level-gated drop from the intended enemies`, () => {
    const entry = drops.reservedDrops!.entries.find(entry => entry.item === gift.id)!;
    assert.ok(entry);
    assert.equal(entry.weight, gift.bossOnly ? 25 : 100);
    const catalogue: DropCatalog = { ...drops, reservedDrops: { ...drops.reservedDrops!, entries: [entry] } };
    const roll = (source: 'elite' | 'boss', heroLevel: number, sourceLevel = heroLevel) =>
      rollReservedDrops(catalogue, stats, {
        source, heroLevel, sourceLevel, random: () => 0,
        claimed: new Set([gift.id]), pending: new Set([gift.id]),
      }).rewards;
    assert.deepEqual(roll('boss', gift.minimumLevel - 1, 105), [], 'high-level enemies do not bypass the player level gate');
    assert.deepEqual(roll('boss', gift.minimumLevel), [{ kind: 'item', item: gift.id, quantity: 1 }]);
    assert.deepEqual(roll('elite', gift.minimumLevel), gift.bossOnly ? [] : [{ kind: 'item', item: gift.id, quantity: 1 }]);
    assert.deepEqual(roll('boss', 105), [{ kind: 'item', item: gift.id, quantity: 1 }], 'material boxes remain available at the level cap');
    assert.deepEqual(roll('boss', 105, 71), [{ kind: 'item', item: gift.id, quantity: 1 }], 'late-game players can farm the repeatable level-71 spider queen');
  });
}
