import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { blockedNormalAcquisitionIds, type ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import { parseDrops } from '../src/domain/drops.ts';
import { Storefront } from '../src/domain/shop.ts';
import { Session } from '../src/domain/session.ts';
import { parseShops } from '../src/application/content-validation.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats'),companions=read<CompanionCatalog>('companions');
const campaign=read<Campaign>('campaign'),battle=read<BattleCatalog>('battle');
const sealed=['sealed-skillbook-black-knight','sealed-skillbook-assassin','sealed-skillbook-warlock','sealed-skillbook-priest','sealed-skillbook-ranger','sealed-skillbook-warrior'];

function fixture(highLevel=false){
  const hero=new BattleCharacter('dark-knight',stats,items);
  if(highLevel)hero.addExperience(Number.MAX_SAFE_INTEGER);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions);
  const recruit=(item='mercenary-emblem-black-knight')=>{session.bag.add(item);return session.party!.recruit(session.bag.entries.find(entry=>entry.item===item)!.id,()=>0).member;};
  const open=(item=sealed[0]!,skill?:string)=>{
    session.bag.add(item);
    const entry=session.bag.entries.find(entry=>entry.item===item)!;
    const candidates=items.classSkills[items.items[item].use!.classId!]!.filter(id=>!session.party!.hasSharedSkill(id));
    const value=skill?(candidates.indexOf(skill)+0.5)/candidates.length:0;
    return session.bag.use(entry.id,undefined,undefined,()=>value);
  };
  return {session,recruit,open};
}

test('each sealed class book directly unlocks permanent knowledge without a mercenary or a new item',()=>{
  const {session,open,recruit}=fixture();
  for(const id of sealed){
    const result=open(id),classId=items.items[id].use!.classId!;
    assert.deepEqual(result.rewards,[]);
    assert.equal(result.classId,classId);
    assert.ok(result.skill&&items.classSkills[classId]!.includes(result.skill));
    assert.equal(session.party!.hasSharedSkill(result.skill!),true);
    assert.match(result.message,/已永久解锁/);
    assert.equal(session.bag.count(id),0);
  }
  for(const skill of items.classSkills['dark-knight']!.slice(1))open(sealed[0],skill);
  const member=recruit();
  for(const id of items.classSkills[member.classId]!){
    assert.equal(member.skills.available(id),true);
    assert.equal(member.skills.skillLevels()[id],0,'未来佣兵获得资格，技能仍从0级培养');
  }
  assert.equal(session.bag.entries.some(entry=>entry.skill),false);
});

test('opening books skips shared knowledge and a complete collection preserves the extra sealed book',()=>{
  const {session,open}=fixture(),skills=items.classSkills['dark-knight']!;
  for(const expected of skills)assert.equal(open().skill,expected);
  session.bag.add(sealed[0]!);
  const extra=session.bag.entries.find(entry=>entry.item===sealed[0])!,before=session.captureState();
  assert.throws(()=>session.bag.use(extra.id,undefined,undefined,()=>0),/本职业技能已全部解锁/);
  assert.deepEqual(session.captureState(),before);
  assert.equal(new Set(session.party!.captureState().sharedUnlockedSkills).size,skills.length);
});

test('shared unlocks reach every owned same-class mercenary, preserve trained skills and leave other classes alone',()=>{
  const {session,recruit,open}=fixture(true),first=recruit(),second=recruit(),other=recruit('mercenary-emblem-assassin');
  session.party!.deployFirstAvailable(second.id);session.party!.reserve(second.id);
  const missing=items.classSkills[first.classId]!.find(id=>!first.skills.available(id))!;
  first.skills.learn('dark-strike');
  const trained=first.skills.skillLevels()['dark-strike'],points=first.skills.points(),otherBefore=other.captureState();
  open(sealed[0],missing);
  for(const member of [first,second]){
    assert.equal(member.skills.available(missing),true);
    assert.equal(member.skills.skillLevels()[missing],0);
  }
  open(sealed[0],'dark-strike');
  assert.equal(first.skills.skillLevels()['dark-strike'],trained);
  assert.equal(first.skills.points(),points);
  assert.deepEqual(other.captureState(),otherBefore);
  assert.equal(session.skills.level(missing),0,'主角技能培养独立');
  const future=recruit();assert.equal(future.skills.available(missing),true);assert.equal(future.skills.level(missing),0);
});

test('initial skill tables do not hide uncollected global unlocks',()=>{
  const {session,recruit,open}=fixture(),member=recruit();
  const natural=Object.keys(member.generated.skillCaps)[0]!;
  assert.equal(member.skills.available(natural),true);
  open(sealed[0],natural);
  assert.equal(session.party!.hasSharedSkill(natural),true);
  assert.equal(member.skills.level(natural),0);
});

test('skill resets and dismissing all mercenaries preserve knowledge for future recruits',()=>{
  const {session,recruit,open}=fixture(),member=recruit();
  const missing=items.classSkills[member.classId]!.find(id=>!member.skills.available(id))!;
  open(sealed[0],missing);member.skills.reset();
  assert.equal(member.skills.available(missing),true);
  session.party!.dismiss(member.id);
  assert.equal(session.party!.ownedMembers().length,0);
  const future=recruit();
  assert.equal(future.skills.available(missing),true);assert.equal(future.skills.level(missing),0);
  assert.equal(session.party!.hasSharedSkill(missing),true);
});

test('session snapshots restore shared knowledge and checkpoints restore the sealed book with its knowledge state',()=>{
  const {session,recruit}=fixture(),member=recruit();
  const missing=items.classSkills[member.classId]!.find(id=>!member.skills.available(id))!;
  session.bag.add(sealed[0]!);
  const book=session.bag.entries.find(entry=>entry.item===sealed[0])!,before=session.captureState();
  const skills=items.classSkills[member.classId]!;
  session.bag.use(book.id,undefined,undefined,()=>(skills.indexOf(missing)+0.5)/skills.length);
  const after=session.captureState(),fresh=fixture();fresh.session.restoreState(after);
  assert.equal(fresh.session.party!.hasSharedSkill(missing),true);
  assert.equal(fresh.session.party!.get(member.id)!.skills.available(missing),true);
  assert.equal(fresh.recruit().skills.available(missing),true);
  session.restoreState(before);
  assert.equal(session.party!.hasSharedSkill(missing),false);
  assert.equal(session.party!.get(member.id)!.skills.available(missing),false);
  assert.ok(session.bag.get(book.id));
  session.restoreState(after);assert.equal(session.party!.hasSharedSkill(missing),true);
});

test('invalid randomness and a failed permanent unlock leave the book, knowledge, members and notifications unchanged',()=>{
  const {session,recruit}=fixture();recruit();session.bag.add(sealed[0]!);
  const book=session.bag.entries.find(entry=>entry.item===sealed[0])!,before=session.captureState();
  for(const value of [-0.1,1,NaN,Infinity]){
    assert.throws(()=>session.bag.use(book.id,undefined,undefined,()=>value),/随机结果无效/);
    assert.deepEqual(session.captureState(),before);
  }
  let notifications=0;session.subscribe(()=>notifications++);
  const party=session.party!,unlock=party.unlockSharedSkill.bind(party);
  party.unlockSharedSkill=id=>{unlock(id);throw new Error('登记后失败');};
  assert.throws(()=>session.bag.use(book.id,undefined,undefined,()=>0),/登记后失败/);
  party.unlockSharedSkill=unlock;
  assert.deepEqual(session.captureState(),before);
  assert.equal(notifications,0);
  assert.equal(session.bag.lastResult,undefined);
  session.bag.use(book.id,undefined,undefined,()=>0);assert.equal(notifications,1,'成功只通知一次完整结果');
});

test('invalid and duplicate shared skill records are rejected before replacing the current session',()=>{
  const {session}=fixture(),before=session.captureState();
  for(const skills of [['missing-skill'],['dark-strike','dark-strike']]){
    const invalid=structuredClone(before);invalid.party!.sharedUnlockedSkills=skills;
    assert.throws(()=>session.restoreState(invalid),/共享解锁技能记录无效/);
    assert.deepEqual(session.captureState(),before);
  }
});

test('ordinary and sealed skill books can still be sold and discarded',()=>{
  const {session}=fixture(),catalog=parseShops(read('shops'));
  const store=new Storefront(catalog,items,stats,session,'merchandise-dealer-b09d9585','shadow-camp');
  for(const id of ['skillbook',sealed[0]!]){
    session.bag.add(id);const entry=session.bag.entries.find(value=>value.item===id)!;
    assert.ok(store.sellPrice(entry)>0);const before=session.money;store.sell(entry.id,1);assert.ok(session.money>before);
    session.bag.add(id);session.bag.discard(session.bag.entries.find(value=>value.item===id)!.id,1);assert.equal(session.bag.count(id),0);
  }
});

test('mercenary max-all learns every class skill and keeps it at max after level changes',()=>{
  const {recruit}=fixture(),member=recruit();
  const classSkills=battle.classes.find(entry=>entry.id===member.classId)!.skills;
  member.skills.maxAll(battle,member.classId);
  for(const id of classSkills){
    const maximum=battle.skills[id]!.companion?.ranks.length??battle.skills[id]!.ranks.length;
    assert.equal(member.skills.skillLevels()[id],maximum,`${id} 应满级`);
  }
  member.addExperience(Number.MAX_SAFE_INTEGER);
  for(const id of classSkills){
    const maximum=battle.skills[id]!.companion?.ranks.length??battle.skills[id]!.ranks.length;
    assert.equal(member.skills.skillLevels()[id],maximum,`${id} 升级后仍满级`);
  }
});

test('sealed books sold by shops have a positive price and can be bought',()=>{
  const catalog=parseShops(read('shops'));
  const id='test-sealed-shop';
  catalog.shops[id]={name:'测试商人',priceRatePercent:100,fixedStock:['sealed-skillbook-black-knight'],categories:[],stockRules:[]};
  const s=new Session(campaign,undefined,undefined,items);
  const store=new Storefront(catalog,items,stats,s,id,'shadow-camp');
  const offer=store.offers.find(value=>value.instance.item==='sealed-skillbook-black-knight')!;
  assert.ok(offer);
  const price=store.buyPrice(offer.id);
  assert.ok(price>0,'封印技能书必须有正价格');
  s.gainMoney(price);
  store.buy(offer.id,1);
  assert.equal(s.bag.count('sealed-skillbook-black-knight'),1);
});

test('sealed skill books remain in the reserved channel and also enter normal loot and shops',()=>{
  const drops=parseDrops(read('drops'),items,battle.enemies.map(enemy=>enemy.id));
  const blocked=blockedNormalAcquisitionIds(items);
  for(const id of sealed){
    assert.equal(blocked.has(id),false,`${id} 可以正常获取`);
    assert.ok(items.items[id]!.basePrice>0,`${id} 商店价格必须为正`);
    assert.ok(drops.pools.ordinary.misc?.some(choice=>choice.item===id));
    assert.ok(drops.pools.advanced.misc?.some(choice=>choice.item===id));
    assert.equal(read<{reservedDrops:{entries:{item:string;once:boolean}[]}}>('drops').reservedDrops.entries.find(entry=>entry.item===id)?.once,false);
  }
  const shops=read<{profiles:Record<string,{pools:Record<string,{item?:string}[]>}>}>('shops');
  for(const profile of ['black-market','lamp'])
    for(const id of sealed)assert.ok(shops.profiles[profile]!.pools.misc?.some(choice=>choice.item===id));
});
