import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseDrops, type DropCatalog } from '../src/domain/drops.ts';
import { reservedAcquisitionIds } from '../src/domain/items.ts';
import { parseItemCatalog, parseShops, validateStoryItems } from '../src/application/content-validation.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { Storefront } from '../src/domain/shop.ts';
import { EquipmentCrafting, parseCrafting } from '../src/domain/crafting.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = parseItemCatalog(read('items'));
const reserved = new Set(items.reservedItems ?? []);
const blocked = reservedAcquisitionIds(items);
const campaign = read<Campaign>('campaign');
const stats = read<CharacterStatsCatalog>('character-stats');
const shops = parseShops(read('shops'));
const rawDrops = read<DropCatalog>('drops');
const craftingCatalog = parseCrafting(read('crafting'));

test('paid item list covers the documented 215 items and their containers', () => {
  assert.equal(reserved.size, 215);
  assert.equal(blocked.size, 230);
  assert.ok(blocked.has('durandal'));
  assert.ok(blocked.has('sword-of-truth'));
  for (const id of ['sealed-weapon-chest', 'sealed-armor-chest', 'sealed-necklace-chest'])
    assert.ok(blocked.has(id), id);
  const recipeBooks = Object.entries(items.items).filter(([, item]) => item.use?.kind === 'recipe').map(([id]) => id);
  assert.equal(recipeBooks.length, 12);
  for (const id of recipeBooks) assert.ok(blocked.has(id), id);
});

test('random drops never select a reserved item', () => {
  const drops = parseDrops(rawDrops, items, Object.keys(rawDrops.enemies));
  for (const kind of ['weapon', 'armor', 'special', 'unique', 'epic'] as const)
    assert.ok(drops.equipment[kind].every(choice => !blocked.has(choice.item)), `${kind} pool contains reserved item`);
  for (const pool of Object.values(drops.pools)) for (const choices of Object.values(pool))
    for (const choice of choices ?? []) {
      if (choice.item) assert.ok(!blocked.has(choice.item), `pool item ${choice.item}`);
      for (const tier of choice.tiers ?? []) if (tier.item) assert.ok(!blocked.has(tier.item), `pool tier ${tier.item}`);
    }
  for (const rule of Object.values(drops.enemies))
    assert.ok(rule.fixed.every(choice => !blocked.has(choice.item)), 'enemy fixed reward');
  for (const rule of Object.values(drops.chests))
    if (rule) assert.ok(rule.fixed.every(choice => !blocked.has(choice.item)), 'chest fixed reward');
});

test('shops never offer a reserved item', () => {
  for (const shopId of Object.keys(shops.shops)) {
    const session = new Session(campaign, undefined, undefined, items);
    const store = new Storefront(shops, items, stats, session, shopId, 'shadow-camp', () => 0.1);
    const check = () => assert.ok(store.offers.every(offer => !blocked.has(offer.instance.item)), `${shopId} offered a reserved item`);
    check();
    for (const category of store.shop.categories) { store.selectCategory(category); check(); }
  }
});

test('unlearned book recipes stay hidden; learned ones become craftable; always-available reserved recipes stay hidden', () => {
  const session = new Session(campaign, undefined, undefined, items);
  const crafting = new EquipmentCrafting(session, craftingCatalog);
  const reservedRecipes = Object.entries(items.recipes).filter(([, recipe]) => blocked.has(recipe.result));
  assert.equal(reservedRecipes.length, 55);
  const available = new Set(crafting.availableRecipes().map(entry => entry.id));
  for (const [id] of reservedRecipes) {
    assert.ok(!available.has(id), `${id} is visible before learning`);
    assert.equal(crafting.recipe(id), undefined, `${id} is readable before learning`);
    assert.throws(() => crafting.recipeQuote(id), /无法进行合成/, `${id} is craftable before learning`);
  }
  const state = session.bag.captureState();
  state.recipes = reservedRecipes.filter(([, recipe]) => recipe.book).map(([id]) => id);
  session.bag.restoreState(state);
  const learned = new Set(crafting.availableRecipes().map(entry => entry.id));
  for (const [id, recipe] of reservedRecipes) {
    if (recipe.book) {
      assert.ok(learned.has(id), `${id} stays hidden after learning`);
      assert.ok(crafting.recipe(id), `${id} is unreadable after learning`);
    } else {
      assert.ok(!learned.has(id), `${id} is visible without a recipe book`);
      assert.equal(crafting.recipe(id), undefined, `${id} is readable without a recipe book`);
      assert.throws(() => crafting.recipeQuote(id), /无法进行合成/, `${id} is craftable without a recipe book`);
    }
  }
});

test('quest rewards cannot grant reserved items or their containers', () => {
  validateStoryItems(campaign, items);
  const direct = structuredClone(campaign);
  direct.quests.find(quest => quest.id === 'grafton-mission')!.rewards!.items.push({ item: 'supreme-elixir', quantity: 1 });
  assert.throws(() => validateStoryItems(direct, items), /保留道具/);
  const container = structuredClone(campaign);
  container.quests.find(quest => quest.id === 'grafton-mission')!.rewards!.items.push({ item: 'sealed-weapon-chest', quantity: 1 });
  assert.throws(() => validateStoryItems(container, items), /保留道具/);
});
