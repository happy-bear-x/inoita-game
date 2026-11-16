import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillUnitSequence} from '../src/domain/skill-unit-sequence.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['dark-strike'],units=skill.action!.combatUnits!;
const buff=units.find(unit=>unit.effect==='buff')!;
assert.equal(buff.effect,'buff');if(buff.effect!=='buff')throw new Error('Dark Strike buff missing');
const ranks=buff.ranks;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();

test('all dark strike ranks use one layer, the native buff age and ordered independent loop effects',()=>{
  const expected=[210,230,260,300,310,320,330,340];
  for(const [index,rank]of ranks.entries()){
    assert.equal(rank.effect.durationMs,4560);assert.equal(rank.effect.maxStacks,1);
    assert.deepEqual(rank.effect.simulationFrames,{lastActiveFrame:75});
    assert.deepEqual(rank.effect.modifiers,[{attribute:'skillDamageBonus',operation:{kind:'add',amount:expected[index]}}]);
    assert.deepEqual(rank.effect.loopEffects,[{effect:'soul-sword-magic',firstFrameAge:1},{effect:'soul-sword',firstFrameAge:1}]);
    const conditions=new CombatConditions();conditions.applyBuff('actor','dark-strike',rank.strength,rank.effect);
    assert.deepEqual(conditions.buffLoopFrames('actor'),[]);
    conditions.update(60);assert.deepEqual(conditions.buffLoopFrames('actor').map(frame=>frame.frameAge),[1,1]);
    conditions.update(75*60);assert.equal(conditions.hasBuff('actor','dark-strike'),true);
    assert.deepEqual(conditions.buffLoopFrames('actor').map(frame=>frame.frameAge),[76,76]);
    conditions.update(60);assert.deepEqual(conditions.buffLoopFrames('actor'),[]);
  }
});

test('rejected weaker refresh preserves loop age and source, accepted refresh restarts both layers',()=>{
  const conditions=new CombatConditions();conditions.applyBuff('actor','dark-strike',ranks[7].strength,ranks[7].effect,'strong');
  conditions.update(420);assert.equal(conditions.buffLoopFrames('actor')[0].frameAge,7);
  assert.equal(conditions.applyBuff('actor','dark-strike',ranks[0].strength,ranks[0].effect,'weak'),false);
  assert.equal(conditions.buffLoopFrames('actor')[0].frameAge,7);assert.equal(conditions.snapshot('actor')[0].sourceId,'strong');
  assert.equal(conditions.applyBuff('actor','dark-strike',ranks[7].strength,ranks[7].effect,'new'),true);
  assert.deepEqual(conditions.buffLoopFrames('actor'),[]);conditions.update(60);
  assert.equal(conditions.buffLoopFrames('actor')[0].frameAge,1);assert.equal(conditions.snapshot('actor')[0].sourceId,'new');
  const resumed=new CombatConditions();resumed.restoreState(conditions.captureState());
  assert.deepEqual(resumed.buffLoopFrames('actor'),conditions.buffLoopFrames('actor'));
});

function fixture(){
  const fighter:PhysicalFighter={level:1,physicalAttack:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const target={...fighter},conditions=new CombatConditions(),hits:PhysicalHit[]=[];
  const member={level:1,panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}},player:{health:100,maxHealth:100,mana:100,maxMana:100}};
  const host=Object.setPrototypeOf({hero:member,conditions,arena:[{key:'enemy',definition:{}}],pendingDefeats:new Set(),fallen:new Set(),
    roster:{isPresent:()=>true},
    memberOf:(id:string)=>id==='actor'?member:undefined,partyFighter:()=>fighter,enemyFighter:()=>target,
    // 背后渗透这一次读取不在这些朴素宿主的能力范围内：明确当作没学。
    actorAttribute:(function(this:unknown,...args:unknown[]){
      const [,key]=args as [string,string];
      return key==='rearPenetrationRate'?0:Reflect.get(WorldCombat.prototype,'actorAttribute').apply(this,args);
    } as unknown as (id:string,key:string)=>number),
    actorAttributes:()=>({physicalAttack:100,magicAttack:0,maxHealth:100,physicalDamageRate:0,magicDamageRate:0,
      stealthDamageRate:0,primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}}),
    combatant:()=>({position:{x:0,y:0}}),resolveHitReactions:()=>{},settleHit:(_event:unknown,hit:PhysicalHit)=>hits.push(hit),
    dropMana:()=>{},applyStateConsequences:()=>{},syncCombatResourceLimits:()=>{},
  },WorldCombat.prototype);
  const unit=(cueIndex:number,targetId:string,usesSkillDamageBuff=true)=>Reflect.get(WorldCombat.prototype,'skillUnit').call(host,
    {casterId:'actor',targetId,cueIndex,skill:{...skill,level:1,action:{...skill.action,usesSkillDamageBuff}}});
  return {fighter,target,conditions,hits,unit};
}

test('skill bonus survives misses and ordinary attacks, is consumed by a non-miss zero hit, and only boosts the first area hit',t=>{
  t.mock.method(Math,'random',()=>0.1);
  const f=fixture(),apply=()=>f.conditions.applyBuff('actor','dark-strike',ranks[0].strength,ranks[0].effect);
  apply();f.unit(0,'enemy',false);assert.equal(f.conditions.hasBuff('actor','dark-strike'),true);
  f.fighter.hitBase=0;f.fighter.hitBonus=0;f.target.evasionBonus=750;
  f.unit(0,'enemy');assert.equal(f.hits.at(-1)!.kind,'miss');assert.equal(f.conditions.hasBuff('actor','dark-strike'),true);
  f.fighter.hitBase=100;f.fighter.hitBonus=1000;f.target.evasionBonus=0;f.target.physicalResistance=1000;
  f.unit(0,'enemy');assert.equal(f.hits.at(-1)!.damage,0);assert.equal(f.conditions.hasBuff('actor','dark-strike'),false);
  f.target.physicalResistance=0;apply();f.unit(0,'enemy');f.unit(0,'enemy');
  assert.deepEqual(f.hits.slice(-2).map(hit=>hit.damage),[254,210]);
});

test('an enemy failed hit does not block the final self buff in the same ordered action',t=>{
  t.mock.method(Math,'random',()=>0.1);
  const f=fixture();f.fighter.hitBase=0;f.fighter.hitBonus=0;f.target.evasionBonus=750;
  const results=resolveSkillUnitSequence(units,{targets:index=>[index===2?'actor':'enemy'],unit:f.unit});
  assert.deepEqual(results.map(result=>result.outcome),['failure','skipped','success']);
  assert.equal(f.conditions.hasBuff('actor','dark-strike'),true);
});
