import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseDrops, type DropCatalog } from '../src/domain/drops.ts';
import { blockedNormalAcquisitionIds, reservedAcquisitionIds } from '../src/domain/items.ts';
import { parseItemCatalog, parseShops, validateStoryItems } from '../src/application/content-validation.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { Storefront } from '../src/domain/shop.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = parseItemCatalog(read('items'));
const storyEquipment = new Set(items.storyEquipment ?? []);
const blocked = blockedNormalAcquisitionIds(items);
const reserved = reservedAcquisitionIds(items);
const campaign = read<Campaign>('campaign');
const stats = read<CharacterStatsCatalog>('character-stats');
const shops = parseShops(read('shops'));
const rawDrops = read<DropCatalog>('drops');

test('story equipment covers every locked item and stays out of the paid reserved channel', () => {
  const locked = Object.entries(items.items)
    .filter(([, item]) => item.equipment?.locked === true)
    .map(([id]) => id)
    .sort();
  assert.equal(storyEquipment.size, 26);
  assert.deepEqual([...storyEquipment].sort(), locked);
  for (const id of storyEquipment) {
    assert.ok(blocked.has(id), `${id} 必须被普通获取拦住`);
    assert.ok(!reserved.has(id), `${id} 不能进入保留掉落通道`);
  }
});

test('normal drops never select story equipment', () => {
  const drops = parseDrops(rawDrops, items, Object.keys(rawDrops.enemies));
  for (const kind of ['weapon', 'armor', 'special', 'unique', 'epic'] as const)
    assert.ok(drops.equipment[kind].every(choice => !blocked.has(choice.item)), `${kind} 池里有剧情装备`);
  for (const pool of Object.values(drops.pools)) for (const choices of Object.values(pool))
    for (const choice of choices ?? []) {
      if (choice.item) assert.ok(!blocked.has(choice.item), `池子物品 ${choice.item}`);
      for (const tier of choice.tiers ?? []) if (tier.item) assert.ok(!blocked.has(tier.item), `池子档位 ${tier.item}`);
    }
  for (const rule of Object.values(drops.enemies))
    assert.ok(rule.fixed.every(choice => !blocked.has(choice.item)), '敌人固定奖励');
  for (const rule of Object.values(drops.chests))
    if (rule) assert.ok(rule.fixed.every(choice => !blocked.has(choice.item)), '宝箱固定奖励');
});

test('shops never offer story equipment', () => {
  for (const shopId of Object.keys(shops.shops)) {
    const session = new Session(campaign, undefined, undefined, items);
    const store = new Storefront(shops, items, stats, session, shopId, 'shadow-camp', () => 0.1);
    const check = (): void => assert.ok(store.offers.every(offer => !blocked.has(offer.instance.item)), `${shopId} 出售了剧情装备`);
    check();
    for (const category of store.shop.categories) { store.selectCategory(category); check(); }
  }
});

test('quest rewards and ground drops refuse story equipment while story equip commands still pass', () => {
  validateStoryItems(campaign, items);

  const reward = structuredClone(campaign);
  reward.quests.find(quest => quest.id === 'grafton-mission')!.rewards!.items.push({ item: 'the-promised-sword', quantity: 1 });
  assert.throws(() => validateStoryItems(reward, items), /不可正常获取/);

  const drop = structuredClone(campaign);
  const script = Object.values(drop.scripts).find(value => value.nodes.length > 0)!;
  script.nodes[0]!.commands.push({ type: 'item-drop', item: 'the-promised-sword', quantity: 1, x: 0, y: 0 } as never);
  assert.throws(() => validateStoryItems(drop, items), /剧情不能掉落/);
});

test('item catalog rejects a story equipment list that drifts from the locked set', () => {
  const missing = structuredClone(items);
  missing.storyEquipment = (missing.storyEquipment ?? []).filter(id => id !== 'disguise-mask');
  assert.throws(() => parseItemCatalog(missing), /剧情装备清单/);

  const wrong = structuredClone(items);
  wrong.storyEquipment = [...(wrong.storyEquipment ?? []), 'healing-potion-s'];
  assert.throws(() => parseItemCatalog(wrong), /剧情装备必须是锁定装备/);
});
