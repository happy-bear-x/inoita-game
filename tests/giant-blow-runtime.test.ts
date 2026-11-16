import {dispatchFrame} from './support/combat-driver.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,ActionDispatchDefinition,SkillAction} from '../src/domain/battle.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatController,type ActionPlayback,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['giant-blow'],action=skill.action!;
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const base:PhysicalFighter={level:10,physicalAttack:201,magicAttack:303,maxHealth:10000,hitBase:100,hitBonus:1000,
  evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,
  weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const actor=(id:string,x=16,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();

function fixture(targets:Combatant[]=[],rank=1,plan:SkillAction=action){
  const caster=actor('caster',0,0,'party'),actors=new Map([caster,...targets].map(actor=>[actor.id,actor]));
  const stats=new Map(targets.map(actor=>[actor.id,{...base}]));
  const conditions=new CombatConditions(),hits:{event:SkillUnitHit;hit:PhysicalHit}[]=[],order:string[]=[],attempts:SkillUnitHit[]=[],feedback:ActionDispatchDefinition[]=[],prepared:number[]=[];
  const member={level:10,bag:{equipmentFor:()=>({}),get:()=>undefined},panel:{...base,attributes:{...primary}},player:{health:10000,maxHealth:10000,mana:100,maxMana:100}};
  let afterHit:((event:SkillUnitHit)=>void)|undefined;
  const host=Object.setPrototypeOf({hero:member,conditions,pendingDefeats:new Set(),
    arena:targets.map(actor=>({key:actor.id,definition:{}})),
    memberOf:(id:string)=>id==='caster'?member:undefined,partyPassives:()=>[],
    partyFighter:()=>conditions.fighter('caster',member.panel),enemyFighter:(id:string)=>conditions.fighter(id,stats.get(id)!),
    roster:{isPresent:()=>true,enemySnapshot:(id:string)=>stats.get(id)},combatant:(id:string)=>actors.get(id),
    applyStateConsequences:()=>{},resolveHitReactions:()=>{},showHit:()=>{},settleHit:(event:SkillUnitHit,hit:PhysicalHit)=>{hits.push({event,hit});afterHit?.(event);},dropMana:()=>{},
  },WorldCombat.prototype);
  const presenter=Object.setPrototypeOf({pose:()=>{},visualEffect:(cue:{effect:string})=>order.push(`effect:${cue.effect}`),
    visual:(id:string)=>actors.has(id)?{container:{active:true,...actors.get(id)!.position}}:undefined},CombatPresenter.prototype);
  let affordable=true;
  let frame=(_index:number)=>{},spent=0,moves=0,turns=0,playback:ActionPlayback|undefined;
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor('caster'),actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'east',face:()=>{turns++;},
    moveToward:()=>{moves++;},stop:()=>{},canStand:()=>true,relocate:()=>{moves++;},clearEffects:()=>{},
    canSpendMana:()=>affordable,spendMana:cost=>{spent+=cost;return true;},
    play:(value,onFrame)=>{playback=value;frame=onFrame;return ()=>{};},
    frame:(value,index,contact,ready)=>dispatchFrame(presenter,value,index,contact,ready,undefined,(value:ActionDispatchDefinition,work:()=>void)=>{work();feedback.push(value);order.push('feedback');}),
    prepareUnit:event=>{prepared.push(event.cueIndex);return Reflect.get(WorldCombat.prototype,'prepareSkillUnit').call(host,event);},
    unit:hit=>{attempts.push(hit);order.push(`unit:${hit.cueIndex}:${hit.targetId}`);return Reflect.get(WorldCombat.prototype,'skillUnit').call(host,hit);}};
  const combat=new CombatController('caster',null,port);
  return {caster,stats,hits,order,attempts,feedback,combat,conditions,member,actors,host,prepared,
    afterHit:(callback:(event:SkillUnitHit)=>void)=>{afterHit=callback;},
    start:(targetId?:string)=>combat.requestManualSkill({id:skill.id,action:plan,level:rank,manaCost:48},targetId),
    frame:(index:number)=>frame(index),affordable:(value:boolean)=>{affordable=value;},counts:()=>({spent,moves,turns}),playback:()=>playback};
}


test('Giant Blow uses the live current target at impact and retains the first target set after reactions change it',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('locked',16),actor('current',-32),actor('near-current',-60)]);
  assert.equal(run.start('locked'),'started');run.combat.setReactionTarget('current');
  run.afterHit(()=>run.combat.setReactionTarget('locked'));
  run.frame(15);assert.equal(run.attempts.length,0);run.frame(16);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'current'],[0,'near-current'],[1,'current'],[1,'near-current']]);
  assert.equal(run.conditions.hasState('locked','stun'),false);assert.equal(run.conditions.hasState('current','stun'),true);
  assert.deepEqual(run.order.slice(-1),['feedback']);assert.equal(run.counts().spent,48);
});

test('a lost current target is selected again at impact and published back to the controller',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('lost'),actor('replacement',20)]);assert.equal(run.start('lost'),'started');
  run.actors.delete('lost');run.combat.targetRemoved('lost');run.frame(16);
  assert.equal(run.combat.snapshot().targetId,'replacement');
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'replacement'],[1,'replacement']]);
});

test('an existing out-of-reach current target falls back to caster feet without choosing another center',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const current=actor('current'),run=fixture([current,actor('near-caster',-40),actor('axis-out',48)]);
  assert.equal(run.start('current'),'started');current.position.x=200;run.frame(16);
  assert.equal(run.combat.snapshot().targetId,'current');
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'near-caster'],[1,'near-caster']]);
});

test('an empty replacement search still hits the caster-centered area and runs its feedback',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture([actor('lost'),actor('ring',40)]);assert.equal(run.start('lost'),'started');
  run.actors.delete('lost');run.combat.targetRemoved('lost');run.frame(16);
  assert.equal(run.combat.snapshot().targetId,undefined);
  assert.deepEqual(run.attempts.map(hit=>[hit.cueIndex,hit.targetId]),[[0,'ring'],[1,'ring']]);
  assert.equal(run.feedback.length,1);
});

test('the first sixteen targets keep failed damage slots and only successful damage proceeds to stun',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const targets=Array.from({length:17},(_,index)=>actor(`enemy-${index}`)),run=fixture(targets);
  run.conditions.applyState('enemy-0','damage-immune',10000);
  run.stats.get('enemy-1')!.evasionBase=10000;run.stats.get('enemy-1')!.evasionBonus=750;
  assert.equal(run.start('enemy-2'),'started');run.frame(16);
  assert.deepEqual(run.attempts.filter(hit=>hit.cueIndex===0).map(hit=>hit.targetId),targets.slice(0,16).map(value=>value.id));
  assert.deepEqual(run.attempts.filter(hit=>hit.cueIndex===1).map(hit=>hit.targetId),targets.slice(2,16).map(value=>value.id));
  assert.equal(run.conditions.hasState('enemy-16','stun'),false);
  assert.deepEqual(run.feedback,[{breaksStealth:true,shake:true,vibrationMs:150,sound:'Wa_Titan_Attack'}]);
  run.frame(16);assert.equal(run.feedback.length,1);
});

test('all eight ranks apply normal and target-shortened stun lifetimes through the actual hit host',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const shortened of [false,true])for(const [index,lastFrame] of (shortened?[7,7,15,15,15,15,22,22]:[15,15,30,30,30,30,45,45]).entries()){
    const run=fixture([actor('enemy')],index+1);
    if(shortened)Reflect.set(run.host.arena[0].definition,'stateRules',{durationScale:0.5});
    assert.equal(run.start('enemy'),'started');run.frame(16);
    assert.ok(run.hits[0].hit.damage>0);assert.equal(run.conditions.hasState('enemy','stun'),true);
    run.conditions.update((lastFrame+1)*60);assert.equal(run.conditions.hasState('enemy','stun'),true);
    run.conditions.update(60);assert.equal(run.conditions.hasState('enemy','stun'),false);
  }
});

test('one-handed and two-handed action plans keep their own swing and hit frames with one mana charge',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const wardrobe=JSON.parse(readFileSync(new URL('../public/content/wardrobe.json',import.meta.url),'utf8')) as WardrobeCatalog;
  const single=wardrobe.skillStances.warrior['longsword:empty'].actions['giant-blow']!;
  for(const [plan,swingFrame,hitFrame,effect] of [[single,7,11,'giant-blow-swing'],[action,12,16,'giant-blow']] as const){
    const run=fixture([actor('enemy')],1,plan);assert.equal(run.start('enemy'),'started');
    run.frame(swingFrame-1);assert.deepEqual(run.order,[]);
    run.frame(swingFrame);assert.deepEqual(run.order,[`effect:${effect}`]);
    run.frame(hitFrame-1);assert.equal(run.attempts.length,0);
    run.frame(hitFrame);assert.deepEqual(run.attempts.map(hit=>hit.cueIndex),[0,1]);
    assert.equal(run.feedback.length,1);assert.equal(run.counts().spent,48);
  }
});
