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
import { Bag } from '../src/domain/bag.ts';

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
  const give=structuredClone(campaign);
  Object.values(give.scripts)[0]!.nodes[0]!.commands.push({type:'item-give',item:'disguise-mask',quantity:1});
  assert.throws(()=>validateStoryItems(give,items),/剧情专属装备应直接穿戴/);
});

test('every story equipment item is rejected by bag grants and ground pickups before any inventory changes',()=>{
  const bag=new Bag(()=>{},items,'dark-knight');
  const before=bag.captureState();
  for(const item of storyEquipment){
    assert.throws(()=>bag.add(item),/剧情专属装备不能放入背包/);
    assert.throws(()=>bag.receiveDrop({id:'ground-story',item,quantity:1,enhancement:0,gems:[]}),/剧情专属装备不能放入背包/);
    assert.deepEqual(bag.captureState(),before);
  }
});

test('every worn story item rejects manual removal and replacement for the hero and companions',()=>{
  for(const owner of ['player','story-member'])for(const item of storyEquipment){
    let notifications=0;const bag=new Bag(()=>notifications++,items,'dark-knight'),slot=items.items[item].equipment!.slot;
    const worn=bag.addEquipped(item,slot,owner,'dark-knight');
    const normal=Object.keys(items.items).find(id=>{const rule=items.items[id].equipment;return rule&&!rule.locked&&rule.slot===slot&&rule.classes.includes('dark-knight');})!;
    assert.ok(normal,`存在对应槽位的普通装备：${item}`);bag.add(normal);
    const replacement=bag.entries.find(entry=>entry.item===normal)!,before=bag.captureState(),count=notifications;
    assert.match(bag.unequipProblem(slot,owner)!,/剧情专属装备/);
    assert.throws(()=>bag.planUnequip(slot,owner),/剧情专属装备/);
    assert.throws(()=>bag.unequip(slot,owner),/剧情专属装备/);
    assert.match(bag.equipProblem(replacement.id,slot,owner,'dark-knight')!,/剧情专属装备/);
    assert.throws(()=>bag.equip(replacement.id,slot,owner,'dark-knight'),/剧情专属装备/);
    assert.deepEqual(bag.captureState(),before);assert.equal(notifications,count);
    bag.unequipForStory(slot,owner);
    assert.equal(bag.get(worn),undefined);assert.ok(bag.get(replacement.id));bag.verifyConsistency();
  }
});

test('equipment changes cannot indirectly displace story weapons in either hand',()=>{
  const bag=new Bag(()=>{},items,'warrior');
  bag.addEquipped('dagger','main-hand','player','warrior');
  const off=bag.addEquipped('the-promised-sword','off-hand','player','warrior');
  bag.add('basic-greatsword');const greatsword=bag.entries.find(entry=>entry.item==='basic-greatsword')!;
  const before=bag.captureState();
  assert.throws(()=>bag.unequip('main-hand'),/剧情专属装备/);
  assert.throws(()=>bag.equip(greatsword.id,'main-hand'),/剧情专属装备/);
  assert.deepEqual(bag.captureState(),before);assert.ok(bag.get(off));
  const other=new Bag(()=>{},items,'dark-knight');
  other.addEquipped('dragon-tooth-2','main-hand','player','dark-knight');other.add('basic-shield');
  const shield=other.entries.find(entry=>entry.item==='basic-shield')!,snapshot=other.captureState();
  assert.throws(()=>other.equip(shield.id,'off-hand'),/剧情专属装备/);
  assert.deepEqual(other.captureState(),snapshot);
});

test('bag restoration rejects loose story equipment while preserving the currently worn instance',()=>{
  const bag=new Bag(()=>{},items,'dark-knight'),id=bag.addEquipped('disguise-mask','head','player','dark-knight');
  const invalid=bag.captureState();delete invalid.worn.head;invalid.allCells.push(id);invalid.pouches.armor.push(id);
  assert.throws(()=>bag.restoreState(invalid),/剧情专属装备不能放入背包/);
  assert.equal(bag.equipmentItems().head,'disguise-mask');
});

test('a story companion leaving returns normal equipment but removes scene equipment and its retirement reference',()=>{
  const bag=new Bag(()=>{},items,'dark-knight');
  const mask=bag.addEquipped('disguise-mask','head','story-member','dark-knight');
  const normal=bag.addEquipped('dagger','main-hand','story-member','dark-knight');
  bag.removeOwner('story-member',true,true);
  assert.equal(bag.get(mask),undefined);assert.ok(bag.entries.some(entry=>entry.id===normal));
  const retired=bag.takeRetiredEquipment('story-member')!;
  assert.equal(retired.head,undefined);assert.equal(retired['main-hand'],normal);bag.verifyConsistency();
});

test('item catalog rejects a story equipment list that drifts from the locked set', () => {
  const missing = structuredClone(items);
  missing.storyEquipment = (missing.storyEquipment ?? []).filter(id => id !== 'disguise-mask');
  assert.throws(() => parseItemCatalog(missing), /剧情装备清单/);

  const wrong = structuredClone(items);
  wrong.storyEquipment = [...(wrong.storyEquipment ?? []), 'healing-potion-s'];
  assert.throws(() => parseItemCatalog(wrong), /剧情装备必须是锁定装备/);
});
