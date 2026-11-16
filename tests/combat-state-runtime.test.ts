import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {BattleBuffEffect} from '../src/domain/battle.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat,enemyTapRect}=await import('../src/scenes/world-combat.ts');
phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

test('scene applies the actual state source and rejects weak buff refresh without interrupting the target',()=>{
  const conditions=new CombatConditions(),applied:string[][]=[];
  const host={conditions,pendingDefeats:new Set(),hero:{},arena:[],memberOf:()=>true,partyFighter:()=>({}),
    isActorPresent:method('isActorPresent'),
    stateApplicationRequest:(_source:string,_target:string,state:string)=>({state,sourceRelation:'hostile'}),
    applyActorBuff:method('applyActorBuff'),syncCombatResourceLimits:()=>{},applyStateConsequences:(_id:string,states:string[])=>applied.push(states)};
  const state={effect:'state',state:'stun',ranks:[{chanceThreshold:1000,durationMs:2000}]};
  const event={casterId:'enemy',targetId:'ally',cueIndex:0,skill:{id:'test',action:{combatUnits:[state]}}};
  method('skillUnit').call(host,event);
  assert.equal(conditions.snapshot('ally')[0].sourceId,'enemy');assert.deepEqual(applied,[['stun']]);
  const effect:BattleBuffEffect={durationMs:1000,tickMs:0,states:['immobilized'],modifiers:[],periodic:[]};
  conditions.applyBuff('ally','net-shackles',10,effect,'stronger');applied.length=0;
  method('skillUnit').call(host,{...event,skill:{id:'net-shackles',action:{combatUnits:[
    {effect:'buff',buff:'net-shackles',ranks:[{strength:1,chanceThreshold:1000,effect}]}]}}});
  assert.deepEqual(applied,[]);assert.equal(conditions.snapshot('ally').find(entry=>entry.kind==='buff')?.sourceId,'stronger');
});

test('state entry stops the current actor and stealth immediately clears hostile trackers only',()=>{
  const conditions=new CombatConditions(),events:string[]=[];
  const player={id:'player',team:'party'},ally={id:'ally',team:'party'},enemy={id:'enemy',team:'hostile'};
  const layer={alpha:1,setAlpha(alpha:number){this.alpha=alpha;return this;}};
  const visual={layers:[layer],container:{alpha:.8}};
  const host={conditions,partyControllers:new Map([
    ['player',{cancel:()=>events.push('cancel-player')}],['ally',{targetRemoved:()=>events.push('forget-ally')}]]),
    visualOf:()=>visual,movement:{stop:()=>events.push('stop-player')},heroAi:{disable:()=>events.push('disable-player')},
    allies:[],arena:[{key:'enemy',controller:{targetRemoved:(id:string)=>events.push(`forget-enemy:${id}`)}}],
    combatant:()=>player,combatants:()=>[player,ally,enemy],scene:{refreshCombatTarget:()=>{}},focusTargetId:undefined};
  conditions.applyState('player','stealthed',1000,'caster');
  method('applyStateConsequences').call(host,'player',['stealthed']);
  assert.deepEqual(events,['cancel-player','stop-player','disable-player','forget-enemy:player']);
  assert.equal(layer.alpha,.5);assert.equal(visual.container.alpha,.8);
  assert.equal(conditions.canAct('player'),true);assert.equal(conditions.canMove('player'),true);
});

test('scene movement checks distinguish root from disabled actions and failed selection cannot set focus',()=>{
  const conditions=new CombatConditions();conditions.applyState('ally','immobilized',1000);
  const host={conditions,controlledId:'ally',controlledMember:{player:{health:10}},defeated:false};
  assert.equal(method('playerCannotMove').call(host),true);assert.equal(method('playerCannotAct').call(host),false);
  method('selectEnemy').call({pendingDefeats:new Set(),isUnavailableEnemyTarget:()=>false,combat:{selectTarget:()=>false},
    focusTarget:()=>assert.fail('failed selection set focus'),scene:{refreshCombatTarget:()=>assert.fail('failed selection changed HUD')}},'hidden');
});

test('damage immunity returns before damage feedback or health writes without affecting targetability',()=>{
  const conditions=new CombatConditions();conditions.applyState('ally','damage-immune',1000);
  const host={conditions,pendingDefeats:new Set(),showHit:()=>assert.fail('immune damage displayed feedback'),
    memberOf:()=>assert.fail('immune damage reached health mutation')};
  method('settleHit').call(host,{casterId:'enemy',targetId:'ally'},{kind:'hit',damage:100},{});
  assert.equal(conditions.canTarget('ally'),true);
});

test('enemy tap area covers the drawn idle frame instead of the feet collision box',()=>{
  const clip={frameWidth:32,frameHeight:40,originX:.625,originY:.675};
  const actor={collision:{x:-8,y:-8,width:16,height:16},clips:{'idle-south':clip,'idle-north':clip,'idle-east':clip,'idle-west':clip}};
  const rect=enemyTapRect(actor as never);
  assert.deepEqual(rect,{x:-20,y:-27,width:32,height:40});
  assert.ok(rect.x<=actor.collision.x&&rect.y<=actor.collision.y);
  assert.ok(rect.x+rect.width>=actor.collision.x+actor.collision.width);
  assert.ok(rect.y+rect.height>=actor.collision.y+actor.collision.height);
  const facingOnly={...actor,clips:{'idle-south':clip,'idle-east':{...clip,frameWidth:48,originX:.5}}};
  assert.deepEqual(enemyTapRect(facingOnly as never),{x:-24,y:-27,width:48,height:40});
});

test('enemy tap area falls back to the collision box when the catalog has no idle clip',()=>{
  const actor={collision:{x:-8,y:-8,width:16,height:16},clips:{}};
  assert.deepEqual(enemyTapRect(actor as never),{x:-8,y:-8,width:16,height:16});
});
