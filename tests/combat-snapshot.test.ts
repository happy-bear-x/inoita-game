import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareCombatRestore,type WorldCombatState} from '../src/domain/combat-snapshot.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {combatActor,refreshCombatActors} from '../src/domain/combat-actor-lookup.ts';
import type {EnemyController} from '../src/domain/enemy-ai.ts';
import type {FriendlySummonState} from '../src/domain/friendly-summon-ai.ts';
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
function snapshot():WorldCombatState {
  const conditions=new CombatConditions();conditions.setTemporaryAttribute('player','physicalAttack',50);
  return {roster:{enemies:[{key:'enemy',enemyId:catalog.enemies[0].id,x:10,y:20,health:15,mana:3}],sequence:1,partySize:1},
    conditions:conditions.captureState(),threat:{entries:[{ownerId:'enemy',sourceId:'player',score:20,updatedTick:3}]},
    party:[{id:'player',position:{x:1,y:2},facing:'south',combat:{state:'attacking',targetId:'enemy',cooldowns:{}}}],
    enemies:[{id:'enemy',facing:'north'}],summonGroups:[],focusTargetId:'enemy'};
}
function enemyState():ReturnType<EnemyController['captureState']> {
  return {state:'attacking',targetId:'player',pendingReturn:true,threatCombatActive:true,
    accumulator:30,clock:600,nextPathAt:780,path:[{x:10,y:12}],destination:{x:1,y:2},destinationRange:4,
    progressPosition:{x:10,y:20},lastProgressAt:540,idleElapsed:180,wanderDestination:{x:40,y:20},
    spentOnce:['once-only'],combat:{state:'attacking',targetId:'player',cooldowns:{spell:{remainingMs:300,durationMs:600}}}};
}
function friendlyState():FriendlySummonState {
  return {ownerId:'player',role:'beast',state:'returning',targetId:'enemy',returning:true,
    clock:9000,accumulator:30,nextDecisionAt:9180,nextSearchAt:9180,nextRecallAt:10020,nextFollowSearchAt:9900,targetSince:8400,
    path:[{x:24,y:20}],pathTargetId:'player',pathDestination:{x:1,y:2},followActive:true,
    failedTargets:[{id:'enemy',until:9900,position:{x:10,y:20}}],checkedTargets:[{id:'enemy',until:9600,position:{x:10,y:20}}],
    fallbackTargets:[{id:'enemy',until:9900,position:{x:10,y:20}}],
    farElapsed:5040,stuckElapsed:5040,progressOrigin:{x:30,y:20},followDestination:{x:1,y:2},followUnreachable:true,followSlot:3,
    combat:{state:'attacking',targetId:'enemy',cooldowns:{'monster-hell-scream':{remainingMs:300,durationMs:600}}}};
}
function summonSnapshot():WorldCombatState {
  const state=snapshot();
  state.roster.enemies.push({key:'summon',enemyId:'enemy-beast-companion-1',x:30,y:20,health:7,mana:0,level:10,
    summonedBy:'player',summonedBySkill:'beast-companion',summonedStats:{physicalAttack:39,maxHealth:3520,physicalResistanceBonus:250,magicResistance:120}});
  state.enemies.push({id:'summon',facing:'east',ai:{kind:'friendly-summon',state:friendlyState()},summonRemainingMs:12000,summonTauntChance:40});
  state.summonGroups=[['player',['summon']]];
  return state;
}
test('static restore prepares an isolated copy, retains resources and threat, and clears action attributes',()=>{
  const input=snapshot(),before=structuredClone(input),prepared=prepareCombatRestore(input,catalog,[]);
  assert.deepEqual(input,before);assert.equal(prepared.party[0].combat.state,'idle');
  assert.equal(prepared.party[0].combat.targetId,'enemy');assert.deepEqual(prepared.roster,before.roster);
  assert.deepEqual(prepared.threat,before.threat);assert.deepEqual(prepared.conditions.temporary,[]);
});
test('invalid references, nonfinite data and broken threat are rejected before mutating input',()=>{
  for(const mutate of [(s:WorldCombatState)=>s.enemies[0].id='missing',
    (s:WorldCombatState)=>s.roster.enemies[0].x=NaN,
    (s:WorldCombatState)=>s.threat.entries.push({...s.threat.entries[0]})]){
    const input=snapshot();mutate(input);const before=structuredClone(input);
    assert.throws(()=>prepareCombatRestore(input,catalog,[]));assert.deepEqual(input,before);
  }
});
test('ordinary enemy AI restores idle with no old target or route while retaining paid cooldowns and once-only skills',()=>{
  const input=snapshot();input.enemies[0].ai={kind:'enemy',state:enemyState()};
  const before=structuredClone(input),prepared=prepareCombatRestore(input,catalog,[]);
  assert.deepEqual(input,before);
  const saved=prepared.enemies[0].ai;assert.equal(saved?.kind,'enemy');
  if(saved?.kind!=='enemy')return;
  assert.equal(saved.state.state,'idle');assert.equal(saved.state.targetId,undefined);
  assert.equal(saved.state.combat?.targetId,undefined);assert.equal(saved.state.combat?.state,'idle');
  assert.deepEqual(saved.state.path,[]);assert.equal(saved.state.destination,undefined);
  assert.equal(saved.state.progressPosition,undefined);assert.equal(saved.state.wanderDestination,undefined);
  assert.equal(saved.state.pendingReturn,false);assert.equal(saved.state.threatCombatActive,false);
  assert.deepEqual(saved.state.combat?.cooldowns,before.enemies[0].ai!.state.combat!.cooldowns);
  assert.deepEqual(saved.state.spentOnce,['once-only']);
});
test('AI kinds, complete actor records and finite enemy decision state are validated before restore',()=>{
  const mutations:((state:WorldCombatState)=>void)[]=[
    state=>{Reflect.set(state.enemies[0],'ai',enemyState());},
    state=>{Reflect.set(state.enemies[0],'ai',{kind:'other',state:enemyState()});},
    state=>{state.enemies[0].ai={kind:'enemy',state:{...enemyState(),clock:-1}};},
    state=>{state.enemies=[];},
    state=>{state.enemies.push({...state.enemies[0]});},
    state=>{state.enemies[0].summonRemainingMs=-60;},
  ];
  for(const mutate of mutations){
    const input=snapshot();mutate(input);const before=structuredClone(input);
    assert.throws(()=>prepareCombatRestore(input,catalog,[]));assert.deepEqual(input,before);
  }
});
test('friendly summons restore stationary after JSON round-trip, preserving identity, resources, lifetime and cooldowns',()=>{
  const input=JSON.parse(JSON.stringify(summonSnapshot())) as WorldCombatState,before=structuredClone(input);
  const prepared=prepareCombatRestore(input,catalog,[]),saved=prepared.enemies[1];
  assert.deepEqual(input,before);assert.deepEqual(prepared.roster,before.roster);
  assert.deepEqual(prepared.summonGroups,[['player',['summon']]]);
  assert.equal(saved.facing,'east');assert.equal(saved.summonRemainingMs,12000);assert.equal(saved.summonTauntChance,40);
  assert.equal(saved.ai?.kind,'friendly-summon');if(saved.ai?.kind!=='friendly-summon')return;
  assert.deepEqual(saved.ai.state,{ownerId:'player',role:'beast',state:'idle',returning:false,clock:0,accumulator:0,
    nextDecisionAt:0,nextSearchAt:0,nextRecallAt:0,nextFollowSearchAt:0,targetSince:0,path:[],followActive:false,
    failedTargets:[],checkedTargets:[],fallbackTargets:[],farElapsed:0,stuckElapsed:0,followUnreachable:false,followSlot:0,
    combat:{state:'idle',cooldowns:{'monster-hell-scream':{remainingMs:300,durationMs:600}}}});
});
test('a summon AI kind, owner and role must match its roster identity and active party',()=>{
  const mutations:((state:WorldCombatState)=>void)[]=[
    state=>{state.enemies[1].ai={kind:'enemy',state:enemyState()};},
    state=>{state.enemies[1].ai=undefined;},
    state=>{const ai=state.enemies[1].ai!;if(ai.kind==='friendly-summon')ai.state.ownerId='enemy';},
    state=>{const ai=state.enemies[1].ai!;if(ai.kind==='friendly-summon')ai.state.role='hell-soldier';},
    state=>{state.roster.enemies[1].summonedBy='enemy';state.summonGroups=[['enemy',['summon']]];},
    state=>{state.roster.enemies[1].summonedBy=undefined;state.summonGroups=[];},
    state=>{state.roster.enemies[1].enemyId=catalog.enemies[0].id;},
  ];
  for(const mutate of mutations){
    const input=summonSnapshot();mutate(input);const before=structuredClone(input);
    assert.throws(()=>prepareCombatRestore(input,catalog,[]));assert.deepEqual(input,before);
  }
});
test('an active companion retains ownership of its friendly summon across stationary restore',()=>{
  const input=summonSnapshot();input.roster.partySize=2;
  input.party.push({id:'companion',position:{x:40,y:20},facing:'west',combat:{state:'idle',cooldowns:{}}});
  input.roster.enemies[1].summonedBy='companion';input.summonGroups=[['companion',['summon']]];
  const ai=input.enemies[1].ai!;if(ai.kind!=='friendly-summon')assert.fail('missing friendly state');
  ai.state.ownerId='companion';
  const prepared=prepareCombatRestore(input,catalog,['player','companion']);
  assert.equal(prepared.roster.enemies[1].summonedBy,'companion');
  const restored=prepared.enemies[1].ai!;assert.equal(restored.kind,'friendly-summon');
  if(restored.kind==='friendly-summon')assert.equal(restored.state.ownerId,'companion');
  const absent=structuredClone(input);absent.party.pop();
  const repaired=prepareCombatRestore(absent,catalog,['player','companion']);
  assert.equal(repaired.roster.enemies.some(enemy=>enemy.key==='summon'),false,'主人不在队员记录里时丢掉孤儿召唤');
});

test('orphan summons are dropped instead of failing the whole save load',()=>{
  const input=summonSnapshot();
  input.roster.enemies.push({key:'orphan',enemyId:catalog.enemies[0].id,x:32,y:20,summonedBy:'missing-owner'});
  input.enemies.push({id:'orphan',facing:'south',ai:{kind:'enemy',state:enemyState()},summonRemainingMs:6000});
  input.summonGroups.push(['missing-owner',['orphan']]);
  input.conditions.buffs.push(['orphan',[]]);
  input.conditions.states.push(['orphan',[]]);
  input.conditions.temporary.push(['orphan',[]]);
  input.threat.entries.push({ownerId:'orphan',sourceId:'player',score:10,updatedTick:1});
  const prepared=prepareCombatRestore(input,catalog,[]);
  assert.equal(prepared.roster.enemies.some(enemy=>enemy.key==='orphan'),false);
  assert.equal(prepared.enemies.some(enemy=>enemy.id==='orphan'),false);
  assert.equal(prepared.summonGroups.some(([owner])=>owner==='missing-owner'),false);
  assert.ok(prepared.roster.enemies.some(enemy=>enemy.key==='summon'),'有效召唤继续保留');
});
test('a hostile summon keeps the enemy AI branch and a valid enemy owner',()=>{
  const input=snapshot();
  input.roster.enemies.push({key:'hostile-summon',enemyId:catalog.enemies[0].id,x:32,y:20,summonedBy:'enemy'});
  input.enemies.push({id:'hostile-summon',facing:'south',ai:{kind:'enemy',state:enemyState()},summonRemainingMs:6000});
  input.summonGroups=[['enemy',['hostile-summon']]];
  const prepared=prepareCombatRestore(input,catalog,[]);
  assert.equal(prepared.enemies[1].ai?.kind,'enemy');
  assert.equal(prepared.roster.enemies[1].summonedBy,'enemy');
  assert.equal(prepared.enemies[1].summonRemainingMs,6000);
});
test('summon groups reject missing, duplicated, foreign and cyclic ownership',()=>{
  const mutations:((state:WorldCombatState)=>void)[]=[
    state=>{state.summonGroups=[];},
    state=>{state.summonGroups=[['player',['summon','summon']]];},
    state=>{state.summonGroups=[['player',['summon']],['player',[]]];},
    state=>{state.summonGroups=[['enemy',['summon']]];},
    state=>{state.summonGroups=[['player',['enemy']]];},
    state=>{state.roster.enemies[0].summonedBy='summon';state.roster.enemies[1].summonedBy='enemy';},
  ];
  for(const mutate of mutations){
    const input=summonSnapshot();mutate(input);const before=structuredClone(input);
    assert.throws(()=>prepareCombatRestore(input,catalog,[]));assert.deepEqual(input,before);
  }
});
test('actor queries build once per roster change and retain the original candidate order',()=>{
  const actors=Array.from({length:553},(_,index)=>({id:`enemy-${index}`}));let reads=0;
  const key=(actor:{id:string})=>{reads++;return actor.id;};
  for(let frame=0;frame<100;frame++)for(let index=0;index<553;index++)assert.equal(combatActor(actors,`enemy-${index}`,key),actors[index]);
  assert.equal(reads,553);assert.equal(actors[0].id,'enemy-0');
  actors.splice(0,1,{id:'summon'});refreshCombatActors(actors);
  assert.equal(combatActor(actors,'enemy-0',key),undefined);assert.equal(combatActor(actors,'summon',key),actors[0]);
  assert.equal(reads,1106);
});
