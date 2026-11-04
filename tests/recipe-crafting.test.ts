import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {EquipmentCrafting,CraftingError,parseCrafting} from '../src/domain/crafting.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {Session} from '../src/domain/session.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {Campaign} from '../src/domain/campaign.ts';

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),campaign=read<Campaign>('campaign');
const craftingCatalog=parseCrafting(read('crafting'));
function fixture(){
  const hero=new BattleCharacter('dark-knight',stats,items),session=new Session(campaign,undefined,undefined,items,hero);
  session.gainMoney(100000);
  return {hero,session,crafting:new EquipmentCrafting(session,craftingCatalog)};
}
const notice=(expected:string)=>(error:unknown)=>error instanceof CraftingError&&error.notice===expected;

test('reserved book recipes stay hidden even after learning; potion and jewel recipes remain available',()=>{
  const {hero,crafting}=fixture();
  let ids=crafting.availableRecipes().map(entry=>entry.id);
  assert.ok(ids.includes('mix-healing-potion-s'));assert.ok(ids.includes('mix-chaos-jewel'));
  assert.ok(!ids.includes('craft-angurvadel'));
  const state=hero.bag.captureState();state.recipes=[...state.recipes,'craft-angurvadel'];hero.bag.restoreState(state);
  ids=crafting.availableRecipes().map(entry=>entry.id);
  assert.ok(!ids.includes('craft-angurvadel'),'保留道具的配方不进入合成列表');
  assert.equal(crafting.recipe('craft-angurvadel'),undefined);
});

test('reserved book recipe rejects even after learning and never charges',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag;
  const state=bag.captureState();state.recipes=[...state.recipes,'craft-angurvadel'];bag.restoreState(state);
  const money=session.money;
  assert.throws(()=>crafting.recipeQuote('craft-angurvadel'),notice('craft-recipe'));
  assert.equal(bag.count('angurvadel'),0);assert.equal(session.money,money);
});

test('always-available potion recipe works without learning and consumes lower potions',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['mix-life-potion-m'];
  for(const material of recipe.materials)bag.add(material.item,material.quantity);
  const money=session.money;
  crafting.recipeCommit(crafting.recipeQuote('mix-life-potion-m'));
  assert.equal(bag.count('life-potion-m'),1);
  assert.equal(bag.count('healing-potion-m'),0);assert.equal(bag.count('fruit-of-cause'),0);
  assert.equal(session.money,money-recipe.cost);
});

test('missing materials, missing money and stale quotes leave the bag untouched',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['mix-healing-potion-s'];
  assert.throws(()=>crafting.recipeQuote('mix-healing-potion-s'),notice('craft-materials'));
  bag.add('leaf-of-life',recipe.materials[0].quantity);
  session.spendMoney(session.money);
  assert.throws(()=>crafting.recipeQuote('mix-healing-potion-s'),notice('craft-money'));
  session.gainMoney(10);
  const quote=crafting.recipeQuote('mix-healing-potion-s');
  bag.add('leaf-of-life',1);
  const snapshot=session.captureState();
  assert.throws(()=>crafting.recipeCommit(quote),notice('craft-target'));
  assert.deepEqual(session.captureState(),snapshot);
});

test('a recipe failure after consuming materials rolls the bag and money back without notifying',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['mix-life-potion-m'];
  for(const material of recipe.materials)bag.add(material.item,material.quantity);
  const before=session.captureState();
  let updates=0;session.subscribe(()=>updates++);
  const spend=session.spendMoney;
  session.spendMoney=()=>{throw new Error('注入失败');};
  try{assert.throws(()=>crafting.recipeCommit(crafting.recipeQuote('mix-life-potion-m')),/注入失败/);}
  finally{session.spendMoney=spend;}
  assert.deepEqual(session.captureState(),before,'配方失败后材料和金币完全回滚');
  assert.equal(updates,0,'中间状态不通知界面');
});
