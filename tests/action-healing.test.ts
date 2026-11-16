import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {actionHealing} from '../src/domain/action-healing.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import {actionDamageSource} from '../src/domain/combat-damage-source.ts';
import type {NumericCombatUnit} from '../src/domain/battle.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
const hooks=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hooks.deregister();
const attributes={physicalAttack:100,magicAttack:50,maxHealth:1000,physicalDamageRate:0,magicDamageRate:0,
  stealthDamageRate:0,primaryAttributes:{strength:3,dexterity:0,vitality:0,intelligence:4,mentality:0}};
const unit:NumericCombatUnit={effect:'heal',source:'physicalAttack',attributeWeights:{strength:7,dexterity:0,vitality:0,intelligence:6,mentality:0},
  ranks:[{fixedAddition:999,operation:{kind:'multiply-thousandth',ratePerThousand:1500}}]};

test('ordinary healing skips a zero clamped caster rate and never enforces minimum healing',()=>{
  assert.equal(actionHealing(101,1500),151);
  assert.equal(actionHealing(101,0),101);assert.equal(actionHealing(101,-100),101);
  assert.equal(actionHealing(1,1),0);assert.equal(actionHealing(0,1500),0);
  assert.equal(actionHealing(-101,500),-50);
});

test('healing sums weighted stats before truncation and ignores the auxiliary fixed addition',()=>{
  const source=actionDamageSource(attributes);
  assert.equal(actionDamage(unit,1,source),156);
  assert.equal(actionHealing(actionDamage(unit,1,source),333),51);
  assert.equal(actionDamage({...unit,effect:'physical'},1,source),1654);
});

function fixture(rate=333){
  const reads:string[]=[],writes:number[]=[];
  const member=(health:number)=>({level:1,panel:{attributes:attributes.primaryAttributes},player:{health,maxHealth:1000},setHealth(value:number){
    writes.push(value);this.player.health=Math.max(0,Math.min(1000,value));}});
  const source=member(50),target=member(100),enemy={key:'enemy',definition:{}};
  const enemyState={health:100,maxHealth:1000};
  const host={hero:source,arena:[enemy],pendingDefeats:new Set(),fallen:new Set(),hitResolution:new CombatHitResolution(),
    memberOf:(id:string)=>id==='source'?source:id==='target'?target:undefined,
    partyFighter:()=>({}),actorAttributes:()=>attributes,
    prepareSkillUnit:Reflect.get(WorldCombat.prototype,'prepareSkillUnit'),
    isActorPresent:Reflect.get(WorldCombat.prototype,'isActorPresent'),
    unitValueSourceId:Reflect.get(WorldCombat.prototype,'unitValueSourceId'),
    actorAttribute:(id:string,key:string)=>{
      if(key==='physicalAttack')return attributes.physicalAttack;
      reads.push(`${id}:${key}`);return id==='source'?rate:9000;
    },
    conditions:{canReceiveDamage:()=>true},readResourceCapacity:()=>1000,restoreHealth:Reflect.get(WorldCombat.prototype,'restoreHealth'),react:()=>{},
    roster:{isPresent:()=>true,enemySnapshot:()=>enemyState,setEnemyHealth:(_id:string,value:number)=>{writes.push(value);enemyState.health=Math.min(1000,value);}},
  };
  const heal=(targetId='target')=>Reflect.get(WorldCombat.prototype,'skillUnit').call(host,
    {casterId:'source',targetId,cueIndex:0,skill:{id:'healing-test',action:{combatUnits:[unit]}}});
  return {host,source,target,enemyState,reads,writes,heal};
}

test('ordinary healing uses the caster rate for party and enemy recipients, including a full target',()=>{
  for(const targetId of ['target','enemy']){
    const f=fixture();assert.equal(f.heal(targetId),'success');
    assert.equal(targetId==='target'?f.target.player.health:f.enemyState.health,151);
    assert.deepEqual(f.reads,['source:healingPowerRate']);
  }
  const full=fixture(1500);full.target.player.health=1000;
  assert.equal(full.heal(),'success');assert.deepEqual(full.writes,[1000]);assert.equal(full.target.player.health,1000);
  const zero=fixture(0);zero.heal();assert.equal(zero.target.player.health,256);
});

test('ordinary healing rejects zero HP recipients but an active zero HP caster can heal a living ally',()=>{
  for(const targetId of ['target','enemy']){
    const f=fixture();if(targetId==='target')f.target.player.health=0;else f.enemyState.health=0;
    f.host.hitResolution.run(()=>{
      f.host.hitResolution.deferDefeat(targetId,()=>{});
      assert.equal(f.heal(targetId),'success');
    });
    assert.deepEqual(f.writes,[]);assert.deepEqual(f.reads,[]);
  }
  const f=fixture();f.source.player.health=0;
  f.host.hitResolution.run(()=>{
    f.host.hitResolution.deferDefeat('source',()=>{});
    assert.equal(f.heal(),'success');assert.equal(f.target.player.health,151);
  });
  assert.equal(f.source.player.health,0);
});

test('shared actor reads clamp healing power below zero after modifiers for both consumers',()=>{
  let adjustment=-1500;
  const host={memberOf:()=>({level:1,panel:{}}),arena:[],partyPassives:()=>[],
    conditions:{cachedAttribute:()=>undefined,attribute:(_id:string,key:string,base:number)=>{
      assert.equal(key,'healingPowerRate');assert.equal(base,1000);return base+adjustment;
    }}};
  const read=()=>Reflect.get(WorldCombat.prototype,'actorAttribute').call(host,'source','healingPowerRate');
  assert.equal(read(),0);adjustment=100;assert.equal(read(),1100);
});
