import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {CompanionCatalog} from '../src/domain/party.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const campaign=read<Campaign>('campaign'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
const battle=read<BattleCatalog>('battle'),companions=read<CompanionCatalog>('companions');

function fixture(){
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions),party=session.party!;
  const recruit=()=>{
    session.bag.add('mercenary-emblem-priest');
    const member=party.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
    party.deployFirstAvailable(member.id);
    return member;
  };
  const first=recruit(),second=recruit();
  session.cooldowns.forActor('player').start('dark-strike',100);
  session.cooldowns.forActor(first.id).start('heal',80);
  session.cooldowns.forActor(second.id).start('heal',120);
  return {session,party,first,second};
}

test('reserving a member preserves cooldowns while dismissal removes only that member before notifications',()=>{
  const {session,party,first,second}=fixture(),before=session.cooldowns.captureState();
  party.reserve(first.id);
  assert.equal(party.get(first.id),first);
  assert.deepEqual(session.cooldowns.captureState(),before);
  const removedSnapshots:boolean[]=[];
  const unsubscribe=session.subscribe(()=>{
    if(!party.get(first.id))removedSnapshots.push(session.cooldowns.captureState().actors.some(([id])=>id===first.id));
  });
  party.dismiss(first.id);unsubscribe();
  assert.equal(party.get(first.id),undefined);
  assert.deepEqual(session.cooldowns.captureState(),{actors:before.actors.filter(([id])=>id!==first.id)});
  assert.equal(session.cooldowns.forActor(first.id).isReady('heal'),true);
  assert.equal(session.cooldowns.forActor(second.id).isReady('heal'),false);
  assert.equal(session.cooldowns.forActor('player').isReady('dark-strike'),false);
  assert.ok(removedSnapshots.length>0);
  assert.ok(removedSnapshots.every(present=>!present));
});

test('a rejected dismissal keeps the active member and every cooldown record',()=>{
  const {session,party,first}=fixture(),before=session.cooldowns.captureState();
  assert.throws(()=>party.dismiss(first.id),/移出队伍/);
  assert.equal(party.get(first.id),first);
  assert.deepEqual(session.cooldowns.captureState(),before);
});


test('pity survives reserve and rejected dismissal, but twenty dismissed recruits leave no history',()=>{
  const {session,party,first}=fixture();
  session.lootPity.counters('player').equipmentMisses=11;
  session.lootPity.counters(first.id).uniqueMisses=7;
  assert.throws(()=>party.dismiss(first.id),/移出队伍/);
  assert.equal(session.lootPity.counters(first.id).uniqueMisses,7);
  party.reserve(first.id);
  assert.equal(session.lootPity.counters(first.id).uniqueMisses,7);
  party.dismiss(first.id);
  for(let index=0;index<20;index++){
    session.bag.add('mercenary-emblem-priest');
    const member=party.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-priest')!.id,()=>0).member;
    session.lootPity.counters(member.id).equipmentMisses=3;
    party.dismiss(member.id);
  }
  assert.deepEqual(session.lootPity.captureState().members.map(([id])=>id),['player']);
  const saved=JSON.parse(JSON.stringify(session.captureState()));
  saved.lootPity.members.push(['mercenary-retired',{equipmentMisses:3,uniqueMisses:4,epicMisses:5}]);
  const reserve=party.activeIds.find(id=>id!=='player')!;
  party.reserve(reserve);
  const restored=session.captureState();
  restored.lootPity!.members.push([reserve,{equipmentMisses:2,uniqueMisses:3,epicMisses:4}]);
  restored.lootPity!.members.push(...saved.lootPity.members.filter(([id]:[string,unknown])=>id==='mercenary-retired'));
  session.restoreState(JSON.parse(JSON.stringify(restored)));
  assert.equal(session.lootPity.counters('player').equipmentMisses,11);
  assert.equal(session.lootPity.counters(reserve).uniqueMisses,3);
  assert.equal(session.captureState().lootPity!.members.some(([id])=>id==='mercenary-retired'),false);
});
