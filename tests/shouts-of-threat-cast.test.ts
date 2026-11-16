import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatController,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['shouts-of-threat'],action=skill.action!,units=action.combatUnits!;
const damage=units[0],buff=units[1];
if(damage.effect!=='physical'||buff.effect!=='buff')throw new Error('Shouts of Threat units missing');
const event=action.events.find(event=>event.kind==='units')!;
if(event.kind!=='units')throw new Error('Shouts of Threat event missing');
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base:PhysicalFighter={level:10,physicalAttack:201,magicAttack:303,maxHealth:10000,hitBase:100,hitBonus:0,
  evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
  weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const actor=(id:string,x=16,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();

function fixture(targets:Combatant[]=[]){
  const caster=actor('caster',0,0,'party'),actors=new Map([caster,...targets].map(actor=>[actor.id,actor]));
  const stats=new Map(targets.map(actor=>[actor.id,{...base}]));
  const conditions=new CombatConditions(),hits:{event:SkillUnitHit;hit:PhysicalHit}[]=[],taunts:string[]=[],effects:string[]=[],attempts:SkillUnitHit[]=[];
  const member={level:10,panel:{...base,attributes:primary},player:{health:10000,maxHealth:10000,mana:100,maxMana:100}};
  const host=Object.setPrototypeOf({hero:member,conditions,pendingDefeats:new Set(),
    arena:targets.map(actor=>({key:actor.id,definition:{}})),threat:{taunt:(_source:string,target:string)=>taunts.push(target)},
    memberOf:(id:string)=>id==='caster'?member:undefined,partyPassives:()=>[],
    partyFighter:()=>conditions.fighter('caster',member.panel),enemyFighter:(id:string)=>conditions.fighter(id,stats.get(id)!),
    roster:{isPresent:()=>true,enemySnapshot:(id:string)=>stats.get(id)},combatant:(id:string)=>actors.get(id),
    resolveHitReactions:()=>{},settleHit:(event:SkillUnitHit,hit:PhysicalHit)=>hits.push({event,hit}),dropMana:()=>{},
    applyStateConsequences:()=>{},syncCombatResourceLimits:()=>{},
  },WorldCombat.prototype);
  const presenter=Object.setPrototypeOf({pose:()=>{},visualEffect:(cue:{effect:string})=>effects.push(cue.effect),
    visual:(id:string)=>actors.has(id)?{container:{active:true,...actors.get(id)!.position}}:undefined},CombatPresenter.prototype);
  let frame=(_index:number)=>{},spent=0,moves=0;
  const unit=(hit:SkillUnitHit)=>Reflect.get(WorldCombat.prototype,'skillUnit').call(host,hit);
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('caster'),actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'west',
    moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;},
    play:(_playback,onFrame)=>{frame=onFrame;return ()=>{};},
    frame:(playback,index,contact,ready)=>dispatchFrame(presenter,playback,index,contact,ready),
    unit:hit=>{attempts.push(hit);return unit(hit);}};
  const combat=new CombatController('caster',null,port);
  return {host,member,stats,conditions,hits,taunts,effects,attempts,actors,unit,combat,
    start:()=>combat.requestManualSkill({id:skill.id,action,level:1,manaCost:40}),
    fire:()=>frame(event.frame),counts:()=>({spent,moves})};
}

test('roar can be cast in place without targets and still dispatches both effects and pays its cost once',()=>{
  const run=fixture();assert.equal(run.start(),'started');run.fire();run.fire();
  assert.deepEqual(run.counts(),{spent:40,moves:0});assert.deepEqual(run.attempts,[]);
  assert.deepEqual(run.effects,['curse-wind-ring','curse-shockwave']);
  assert.equal(run.combat.snapshot().cooldowns[skill.id].remainingMs,action.cooldownFrames*60);
});

test('the real roar cast searches the caster grid and reuses its first sixteen targets for damage, slow and taunt',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const valid=[actor('axis-in',79),actor('diagonal-in',57,57),...Array.from({length:15},(_,index)=>actor(`enemy-${index}`))];
  const run=fixture([actor('axis-out',80),actor('diagonal-out',58,58),{...actor('hidden'),states:['stealthed']},
    actor('friendly',16,0,'party'),...valid]);
  assert.equal(run.start(),'started');run.fire();const expected=valid.slice(0,16).map(target=>target.id);
  for(let cue=0;cue<3;cue++)assert.deepEqual(run.attempts.filter(hit=>hit.cueIndex===cue).map(hit=>hit.targetId),expected);
  assert.deepEqual(run.taunts,expected);assert.equal(run.conditions.hasBuff(valid.at(-1)!.id,'shouts-of-threat'),false);
  assert.equal(run.conditions.attribute('axis-in','moveSpeed',1000),800);
  assert.equal(run.conditions.attribute('axis-in','attackSpeedRate',1000),800);
});

test('misses and successful zero damage stop only that target slow and taunt units',t=>{
  t.mock.method(Math,'random',()=>0.2);const run=fixture([actor('hit'),actor('miss'),actor('zero')]);
  run.stats.get('miss')!.evasionBonus=750;run.stats.get('zero')!.physicalResistance=1000;
  assert.equal(buff.effect,'buff');const stronger=buff.ranks[7];
  run.conditions.applyBuff('hit','shouts-of-threat',stronger.strength,stronger.effect,'stronger');
  run.start();run.fire();
  assert.deepEqual(run.hits.map(({event,hit})=>[event.targetId,hit.kind,hit.damage]),[['hit','hit',271],['miss','miss',0],['zero','hit',0]]);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'hit'],[0,'miss'],[0,'zero'],[1,'hit'],[2,'hit']]);
  assert.equal(run.conditions.hasBuff('hit','shouts-of-threat'),true);
  assert.equal(run.conditions.snapshot('hit')[0].sourceId,'stronger');
  assert.equal(run.conditions.attribute('hit','attackSpeedRate',1000),580);
  for(const id of ['miss','zero'])assert.equal(run.conditions.hasBuff(id,'shouts-of-threat'),false);
  assert.deepEqual(run.taunts,['hit']);assert.deepEqual(run.effects,['curse-wind-ring','curse-shockwave']);
});
