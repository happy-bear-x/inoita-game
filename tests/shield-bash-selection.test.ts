import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,EnemyPlayableSkill} from '../src/domain/battle.ts';
import {CombatController,type Combatant,type CombatPort} from '../src/domain/combat.ts';
import {EnemyController,type EnemyPort} from '../src/domain/enemy-ai.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import {hasOffhandShield} from '../src/domain/wardrobe.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill:EnemyPlayableSkill={id:'shield-bash',name:'盾牌强击',action:catalog.skills['shield-bash'].action!,level:1,manaCost:10,
  clips:{north:'skill-shield-bash-north',south:'skill-shield-bash-south',east:'skill-shield-bash-east',west:'skill-shield-bash-west'}};
const items={items:{shield:{kind:'shield'},blade:{kind:'long-sword'}}} as unknown as ItemCatalog;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();

function setup(selected=skill){
  const caster:Combatant={id:'caster',team:'party',position:{x:0,y:0},bounds:{x:-8,y:-8,width:16,height:16}};
  const enemy:Combatant={...caster,id:'enemy',team:'enemy',position:{x:40,y:0}};
  let allowed=false,checks=0,spent=0,moves=0,plays=0,stops=0,rolls=0;
  const port:EnemyPort={cooldowns:new CombatCooldownStore(()=>0).forActor(caster.id),actor:id=>[caster,enemy].find(actor=>actor.id===id),candidates:()=>[caster,enemy],facing:()=> 'east',
    canSelectSkill:()=>{checks++;return allowed;},canStand:()=>true,relocate:()=>{},home:()=>({x:0,y:0}),
    navigationBounds:()=>({x:-100,y:-100,width:1000,height:1000}),followPath:()=>{},
    moveToward:()=>{moves++;},stop:()=>{stops++;},play:()=>{plays++;return ()=>{};},frame:()=>{},clearEffects:()=>{},
    canSpendMana:()=>true,spendMana:cost=>{spent+=cost;return true;}};
  const combat=new CombatController(caster.id,null,port);
  const ai=new EnemyController(caster.id,{aggression:'active',awarenessRangeUnits:30,moveSpeedPxPerSecond:100,canMove:true,canTurn:true},
    null,port,[selected],()=>{rolls++;return 0;},combat);
  return {caster,enemy,port,combat,ai,allow:(value=true)=>{allowed=value;},counts:()=>({checks,spent,moves,plays,stops,rolls})};
}

test('shield bash exports its selection requirement and all eight independently timed stun ranks',()=>{
  assert.equal(skill.action.requiredOffhand,'shield');
  const stun=skill.action.combatUnits![1];assert.equal(stun.effect,'state');
  if(stun.effect!=='state')throw new Error('Shield Bash stun missing');
  assert.equal(stun.state,'stun');
  assert.deepEqual(stun.ranks.map(rank=>rank.chanceThreshold),Array(8).fill(1000));
  assert.deepEqual(stun.ranks.map(rank=>rank.stateDurationProfile?.normal.lastActiveFrame),[19,30,39,49,54,60,64,69]);
});

test('actual offhand kind takes priority, while an empty slot uses the original default costume shield',()=>{
  for(const fallback of [false,true])assert.equal(hasOffhandShield(items,{'off-hand':'shield'},fallback),true);
  for(const fallback of [false,true])assert.equal(hasOffhandShield(items,{'off-hand':'blade'},fallback),false);
  assert.equal(hasOffhandShield(items,{},true),true);assert.equal(hasOffhandShield(items,{},false),false);
  assert.equal(hasOffhandShield(items,{'off-hand':'missing'},true),false);
});

test('world selection checks each member equipment and default appearance, including old stance overrides',()=>{
  const hero={},ally={definition:{defaultShield:true}},equipment:Record<string,Record<string,string>>={caster:{},ally:{}};
  const host={hero:{...hero,bag:{equipmentFor:(id:string)=>id,equipmentItems:(id:string)=>equipment[id]}},
    app:{battleCatalog:catalog,items,wardrobe:{defaultShield:false}},memberOf:(id:string)=>id==='caster'?host.hero:id==='ally'?ally:undefined};
  const select=Reflect.get(WorldCombat.prototype,'canSelectSkill');
  const legacy={...skill,action:{...skill.action,requiredOffhand:undefined}};
  assert.equal(select.call(host,'caster',legacy),false);assert.equal(select.call(host,'ally',legacy),true);
  equipment.caster={'off-hand':'shield'};equipment.ally={'off-hand':'blade'};
  assert.equal(select.call(host,'caster',legacy),true);assert.equal(select.call(host,'ally',legacy),false);
  assert.equal(select.call(host,'missing',skill),false);
  assert.equal(select.call(host,'caster',{id:'dark-strike',action:catalog.skills['dark-strike'].action}),true);
});

test('rejected manual selection leaves resources, cooldowns, movement and playback untouched',()=>{
  const run=setup();
  assert.equal(run.combat.requestManualSkill(skill,'enemy'),'unavailable');
  assert.deepEqual(run.counts(),{checks:1,spent:0,moves:0,plays:0,stops:0,rolls:0});
  assert.equal(run.combat.snapshot().state,'idle');assert.deepEqual(run.combat.snapshot().cooldowns,{});
  const unbound=new CombatController('caster',null,{...run.port,canSelectSkill:undefined} as CombatPort);
  assert.equal(unbound.requestManualSkill(skill,'enemy'),'unavailable');
  run.allow();assert.equal(run.combat.requestManualSkill(skill,'enemy'),'started');
  assert.equal(run.counts().spent,10);assert.equal(run.counts().plays,1);
});

test('an accepted skill keeps its selection eligibility while approaching after an equipment change',()=>{
  const run=setup();run.allow();run.enemy.position={x:200,y:0};
  assert.equal(run.combat.requestManualSkill(skill,'enemy'),'started');
  assert.equal(run.combat.snapshot().state,'approaching');assert.equal(run.counts().spent,0);
  run.allow(false);run.enemy.position={x:40,y:0};run.combat.update();
  assert.equal(run.combat.snapshot().state,'attacking');assert.equal(run.counts().checks,1);
  assert.equal(run.counts().spent,10);assert.equal(run.counts().plays,1);
});

test('automatic selection rejects an ineligible skill before it consumes anything',()=>{
  const run=setup();run.ai.update(60);
  assert.equal(run.counts().checks,1);assert.equal(run.counts().rolls,0);assert.equal(run.counts().plays,0);
  assert.deepEqual(run.combat.snapshot().cooldowns,{});
  run.allow();run.ai.update(60);
  assert.equal(run.counts().plays,1);assert.equal(run.counts().spent,10);
  assert.equal(run.counts().rolls,0,'原版选招不掷随机数');
});

test('forced action requests and summon commands keep their separate execution entry',()=>{
  const direct=setup();assert.equal(direct.combat.requestTriggeredAction(skill,'enemy'),'started');assert.equal(direct.counts().checks,0);
  const command=setup();assert.equal(command.ai.command(skill,'enemy',1),true);assert.equal(command.counts().checks,0);
  assert.equal(command.counts().plays,1);assert.equal(command.counts().spent,10);
});


test('Divine Strike shares the shield gate for hero and companion manual and automatic selection',()=>{
  for(const growth of [catalog.skills['divine-strike'],catalog.skills['divine-strike'].companion!]){
    const divine={...skill,id:'divine-strike',action:growth.action!};
    assert.equal(divine.action.requiredOffhand,'shield');
    const run=setup(divine);
    assert.equal(run.combat.requestManualSkill(divine,'enemy'),'unavailable');
    run.ai.update(60);
    assert.equal(run.counts().spent,0);assert.equal(run.counts().rolls,0);assert.equal(run.counts().plays,0);
    assert.deepEqual(run.combat.snapshot().cooldowns,{});
    run.allow();assert.equal(run.combat.requestManualSkill(divine,'enemy'),'started');
    assert.equal(run.counts().spent,10);assert.equal(run.counts().plays,1);
  }
});

test('快捷栏资格与实际起手共用同一盾牌判定',()=>{
  const equipment:Record<string,Record<string,string>>={caster:{}};
  const host={hero:{bag:{equipmentFor:(id:string)=>id,equipmentItems:(id:string)=>equipment[id]}},
    controlledId:'caster',
    app:{battleCatalog:catalog,items,wardrobe:{defaultShield:false}},
    conditions:{canUseSkillShortcuts:()=>true},
    canSelectSkill:Reflect.get(WorldCombat.prototype,'canSelectSkill'),
    memberOf:(id:string)=>id==='caster'?host.hero:undefined};
  const available=Reflect.get(WorldCombat.prototype,'skillSlotAvailable') as (this:typeof host,skillId:string)=>boolean;
  assert.equal(available.call(host,'shield-bash'),false,'空手副手时盾牌强击在快捷栏不可用');
  assert.equal(available.call(host,'divine-strike'),false);
  assert.equal(available.call(host,'dark-strike'),true,'无装备门槛的技能保持可用');
  equipment.caster={'off-hand':'shield'};
  assert.equal(available.call(host,'shield-bash'),true,'装上盾后恢复可用');
  assert.equal(available.call(host,'missing-skill'),false);
});
