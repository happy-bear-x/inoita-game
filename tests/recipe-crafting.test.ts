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

test('learned book recipes appear and stay craftable even when the result is reserved',()=>{
  const {hero,crafting}=fixture();
  let ids=crafting.availableRecipes().map(entry=>entry.id);
  assert.ok(ids.includes('mix-healing-potion-s'));assert.ok(ids.includes('mix-chaos-jewel'));
  assert.ok(!ids.includes('craft-angurvadel'),'未学会的配方书配方不显示');
  const state=hero.bag.captureState();state.recipes=[...state.recipes,'craft-angurvadel'];hero.bag.restoreState(state);
  ids=crafting.availableRecipes().map(entry=>entry.id);
  assert.ok(ids.includes('craft-angurvadel'),'学会后进入合成列表');
  assert.ok(crafting.recipe('craft-angurvadel'),'学会后可读取配方');
  for(const id of ['mix-life-potion-xl','mix-elixir','mix-supreme-elixir']){
    assert.ok(ids.includes(id),'原版常备配方可以直接合成保留道具');
    assert.ok(crafting.recipe(id),'原版常备配方可以直接读取');
  }
});

test('native standing recipe crafts a reserved potion with normal materials',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['mix-supreme-elixir'];
  for(const material of recipe.materials)bag.add(material.item,material.quantity);
  const money=session.money;
  crafting.recipeCommit(crafting.recipeQuote('mix-supreme-elixir'));
  assert.equal(bag.count('supreme-elixir'),1,'卓越灵药正常进入背包');
  for(const material of recipe.materials)assert.equal(bag.count(material.item),0,'材料按配方扣除');
  assert.equal(session.money,money-recipe.cost,'合成费正常扣除');
});

test('unlearned book recipe rejects and never charges',()=>{
  const {session,crafting}=fixture();
  const money=session.money;
  assert.throws(()=>crafting.recipeQuote('craft-angurvadel'),notice('craft-recipe'));
  assert.equal(session.money,money);
});

test('learned book recipe crafts the reserved item and consumes materials and money',()=>{
  const {hero,session,crafting}=fixture(),bag=hero.bag,recipe=items.recipes['craft-angurvadel'];
  const state=bag.captureState();state.recipes=[...state.recipes,'craft-angurvadel'];bag.restoreState(state);
  for(const material of recipe.materials)bag.add(material.item,material.quantity);
  const money=session.money;
  crafting.recipeCommit(crafting.recipeQuote('craft-angurvadel'));
  assert.equal(bag.count('angurvadel'),1);
  assert.equal(session.money,money-recipe.cost);
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
