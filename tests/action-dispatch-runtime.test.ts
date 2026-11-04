import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {ActionDispatchDefinition,BattleCatalog,NumericCombatUnit,ResolvedBasicAttack,SkillAction,SkillEvent} from '../src/domain/battle.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {ActionPlayback,CombatController,CombatPort,SkillUnitHit} from '../src/domain/combat.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {PendingEnemyDefeats} from '../src/domain/combat-outcomes.ts';
import type {Point} from '../src/domain/navigation.ts';
import type {PhysicalFighter} from '../src/domain/physical-hit.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const damage:NumericCombatUnit&{effect:'physical'}={effect:'physical',source:'physicalAttack',attributeWeights:primary,
  ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
const base:PhysicalFighter={level:1,physicalAttack:100,magicAttack:0,maxHealth:10000,
  hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,
  criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
const dispatch=(overrides:Partial<ActionDispatchDefinition>={}):ActionDispatchDefinition=>({
  breaksStealth:true,casterEffects:[{effect:'dispatch-tail',placement:'attached',recipient:'caster'}],
  shake:true,vibrationMs:150,sound:'dispatch-sound',...overrides,
});
function skillAction(definition=dispatch()):SkillAction {
  return {requiresTarget:true,cooldownFrames:0,approachDistanceUnits:4,searchRadiusPx:100,transition:null,
    combatUnits:[damage,{effect:'visual'}],events:[{kind:'units',frame:2,dispatch:definition,cues:[
      {target:'current',targetRangePx:100,targetSelection:'search',effects:[]},
      {target:'self',targetRangePx:0,targetSelection:'search',effects:[]},
    ]}]};
}

function fixture(action=skillAction(),basic?:ResolvedBasicAttack){
  const conditions=new CombatConditions(),resolution=new CombatHitResolution(),order:string[]=[],fallen=new Set<string>();
  const box={x:-4,y:-4,width:8,height:8};
  const visual=(x:number)=>({actor:{collision:box},container:{active:true,x,y:0},
    layers:[{alpha:1,setAlpha(value:number){this.alpha=value;return this;}}]});
  const visuals=new Map([['player',visual(0)],['enemy',visual(16)],['other',visual(24)]]);
  let learnedRank=0;
  const configuration={draft:()=>({levels:{'dark-sense':learnedRank},shortcuts:[]})};
  const member={level:1,classId:'assassin',skills:configuration,panel:{...base,maxMana:100,attributes:{...primary}},player:{health:30,maxHealth:10000,mana:100,maxMana:100},
    bag:{equipmentFor:()=>({}),equipmentItems:()=>({}),get:()=>undefined},
    setCombatResourceCapacity(key:'maxHealth'|'maxMana',value:number){this.player[key]=value;},
    setHealth(value:number){this.player.health=Math.max(0,Math.min(this.player.maxHealth,value));},
    setCombatResourceLimits(health:number,mana:number){this.player.maxHealth=health;this.player.maxMana=mana;},
    spendMana:()=>true};
  const enemyHealth=new Map([['enemy',10000],['other',10000]]);
  const buffApplications:{id:string;sourceId?:string;strength:number;health:number}[]=[];
  const applyBuff=conditions.applyBuff.bind(conditions);
  conditions.applyBuff=(...args)=>{
    const accepted=applyBuff(...args);
    if(accepted&&args[1]==='dark-sense'){
      order.push(`dark-sense:${args[0]}`);
      buffApplications.push({id:args[0],sourceId:args[4],strength:args[2],health:member.player.health});
    }
    return accepted;
  };
  const arrivals:((center?:Point)=>void)[]=[],attempts:SkillUnitHit[]=[],contacts:string[]=[],dispatches:ActionDispatchDefinition[]=[];
  const skill={id:'dispatch-test',action,level:1};
  let frame=(_index:number)=>{},complete=()=>{},playback:ActionPlayback|undefined;
  let react=()=>{},afterUnit:((hit:SkillUnitHit)=>void)=()=>{};
  const removeState=conditions.removeState.bind(conditions);
  conditions.removeState=(id,state)=>{if(state==='stealthed')order.push('remove-stealth');return removeState(id,state);};
  const host=Object.setPrototypeOf({
    playAction:(presenter:{play:(...args:unknown[])=>()=>void},...args:unknown[])=>presenter.play(...args),
    presentActionFrame:(presenter:object,...args:Parameters<typeof dispatchFrame> extends [object,...infer Rest]?Rest:never)=>dispatchFrame(presenter,...args),
    hero:member,conditions,hitResolution:resolution,fallen,pendingDefeats:new PendingEnemyDefeats(),
    partyControllers:new Map(),partySkills:new Map(),soundedSkills:new WeakSet(),allies:[],
    arena:['enemy','other'].map(key=>({key,definition:catalog.enemies[0],visual:visuals.get(key)})),
    app:{battleCatalog:catalog,session:{cooldowns:new CombatCooldownStore(()=>0),skills:configuration,party:{controlledId:'player'},isOneHitKill:()=>false},audio:{effect:(name:string)=>order.push(`sound:${name}`),
      playerSkill:()=>order.push('automatic-sound')}},
    scene:{facing:'east',refreshCombatTarget:()=>{},refreshSkillCooldowns:()=>{},
      events:{emit:(name:string)=>{if(name.startsWith('basic-attack-'))order.push(name);}}},
    feedback:{startShake:()=>order.push('shake'),vibrate:(ms:number)=>order.push(`vibrate:${ms}`)},
    memberOf:(id:string)=>id==='player'?member:undefined,
    visualOf:(id:string)=>visuals.get(id),
    movement:{position:(value:ReturnType<typeof visual>)=>({x:value.container.x,y:value.container.y}),
      actor:()=>({shape:()=>({collision:box})}),stop:()=>{},canStand:()=>true,place:()=>{}},
    partyPassives:()=>[],partyFighter:()=>conditions.fighter('player',member.panel),
    enemyFighter:(id:string)=>conditions.fighter(id,base),equipmentAttack:()=>basic,
    canSelectSkill:()=>true,skillManaCost:()=>0,
    roster:{enemySnapshot:(id:string)=>({...base,health:enemyHealth.get(id),mana:0,maxMana:0}),
      setEnemyHealth:(id:string,value:number)=>enemyHealth.set(id,value)},
    resolveHitReactions:()=>react(),showHit:(event:{targetId:string})=>order.push(`damage:${event.targetId}`),dropMana:()=>{},
    memberDefeated:(id:string)=>{
      assert.equal(resolution.isAwaitingDefeat(id),false);
      order.push(`defeat:${id}`);fallen.add(id);conditions.remove(id);
      host.app.session.party.controlledId='survivor';
    },
  },WorldCombat.prototype);
  host.combatants=()=>[...visuals.keys()].flatMap(id=>{const actor=host.combatant(id);return actor?[actor]:[];});
  host.runActionDispatch=(play:ActionPlayback,definition:ActionDispatchDefinition,work:()=>void)=>{
    dispatches.push(definition);return method('runActionDispatch').call(host,play,definition,work);
  };
  const presenter=Object.setPrototypeOf({
    scene:host.scene,pose:()=>{},visual:(id:string)=>visuals.get(id),candidates:()=>host.combatants(),
    visualEffect:(effect:{effect:string})=>order.push(`effect:${effect.effect}`),placedEffect:()=>{},
    play:(play:ActionPlayback,onFrame:(index:number)=>void,onComplete:()=>void)=>{
      playback=play;frame=onFrame;complete=onComplete;return ()=>{};
    },
    clear:()=>{},
    transition:(_transition:unknown,_target:unknown,_position:unknown,_facing:unknown,arrive:(center?:Point)=>void)=>{
      order.push('launch');arrivals.push(arrive);
    },
    fly:(_effect:unknown,_position:unknown,_target:unknown,_facing:unknown,_x:unknown,_y:unknown,_step:unknown,_time:unknown,arrive:()=>void)=>{
      order.push('launch');arrivals.push(arrive);
    },
    summon:()=>order.push('summon'),
  },CombatPresenter.prototype);
  const {controller,port}=method('createPartyController').call(host,'player',visuals.get('player'),presenter,basic??null) as {controller:CombatController;port:CombatPort};
  const unit=port.unit!,contact=port.contact!;
  port.unit=hit=>{attempts.push(hit);order.push(`unit:${hit.cueIndex}:${hit.targetId}`);const result=unit(hit);afterUnit(hit);return result;};
  port.contact=hit=>{if(!hit.skillId)contacts.push(hit.targetId);contact(hit);};
  return {host,conditions,resolution,order,fallen,member,enemyHealth,visuals,arrivals,attempts,contacts,dispatches,controller,
    learn:(rank:number)=>{learnedRank=rank;},buffApplications,
    frame:(index:number)=>frame(index),complete:()=>complete(),playback:()=>playback!,
    start:()=>controller.request(basic?undefined:skill,'enemy'),
    stealth:()=>conditions.applyState('player','stealthed',10000,'player'),
    unhide:()=>removeState('player','stealthed'),
    react:(callback:()=>void)=>{react=callback;},afterUnit:(callback:typeof afterUnit)=>{afterUnit=callback;},
    reflect:()=>method('settleHit').call(host,{casterId:'enemy',targetId:'player'},{kind:'hit',damage:30},member),
  };
}

test('the real dispatch captures stealth at the action event rather than at animation start or its tail',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const [atStart,atEntry,insideWork,expectedHidden] of [
    [false,true,undefined,false],[true,false,undefined,false],
    [true,true,true,false],[false,false,true,true],
  ] as const){
    const run=fixture();run.learn(3);if(atStart)run.stealth();assert.equal(run.start(),'started');
    assert.equal(run.conditions.hasState('player','stealthed'),atStart,'starting animation does not break stealth');
    if(atEntry)run.stealth();else run.unhide();
    run.afterUnit(hit=>{if(hit.cueIndex===0&&insideWork){run.unhide();run.stealth();}});
    run.frame(2);
    assert.equal(run.conditions.hasState('player','stealthed'),expectedHidden);
    assert.equal(run.order.filter(value=>value==='remove-stealth').length,atEntry?1:0);
    assert.equal(run.conditions.hasBuff('player','dark-sense'),atEntry);
    assert.equal(run.buffApplications.length,atEntry?1:0);
    assert.equal(run.order.filter(value=>value==='sound:dispatch-sound').length,1);
  }
});

test('failed and empty Direct targets still finish units and caster effects before feedback and stealth removal',()=>{
  for(const empty of [false,true]){
    const run=fixture();run.stealth();run.conditions.applyState('enemy','damage-immune',10000);
    assert.equal(run.start(),'started');
    if(empty){run.visuals.delete('enemy');run.controller.targetRemoved('enemy');}
    run.frame(2);
    const tail=['unit:1:player','effect:dispatch-tail','shake','vibrate:150','remove-stealth','sound:dispatch-sound'];
    assert.deepEqual(run.order.slice(-tail.length),tail);
    assert.equal(run.enemyHealth.get('enemy'),10000);
    run.frame(2);assert.equal(run.dispatches.length,1);
  }
});

test('a captured projectile batch breaks stealth once at launch and never again at its delayed arrivals',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const action=skillAction();action.transition={kind:'position',effect:'projectile',actionEffect:null,
    switchFrame:1,stepDistancePx:1,offsetX:0,offsetY:0};
  action.events.unshift({kind:'capture-targets',frame:0,target:'area',targetRangePx:100,limit:16});
  const run=fixture(action);run.learn(2);run.stealth();assert.equal(run.start(),'started');run.frame(2);
  assert.equal(run.arrivals.length,2);assert.equal(run.attempts.length,0);assert.equal(run.dispatches.length,1);
  assert.deepEqual(run.order,['launch','launch','effect:dispatch-tail','shake','vibrate:150','remove-stealth','dark-sense:player','sound:dispatch-sound']);
  run.complete();run.stealth();run.conditions.update(60);
  const buffBefore=run.conditions.snapshot('player').find(value=>value.id==='dark-sense');
  run.arrivals[0]({x:16,y:0});run.arrivals[0]({x:16,y:0});run.arrivals[1]({x:24,y:0});
  assert.equal(run.attempts.length,4);assert.equal(run.dispatches.length,1);
  assert.equal(run.buffApplications.length,1);
  assert.deepEqual(run.conditions.snapshot('player').find(value=>value.id==='dark-sense'),buffBefore);
  assert.equal(run.conditions.hasState('player','stealthed'),true);
  assert.equal(run.order.filter(value=>value==='sound:dispatch-sound').length,1);
});

test('a lethal nested hit defers the real source death until the dispatch tail and controlled sound finish',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.learn(4);run.stealth();let reflected=false;
  run.react(()=>{
    if(reflected)return;reflected=true;run.reflect();
    assert.equal(run.member.player.health,0);assert.equal(run.fallen.has('player'),false);
    assert.equal(run.resolution.isAwaitingDefeat('player'),true);
  });
  assert.equal(run.start(),'started');run.frame(2);
  assert.equal(run.enemyHealth.get('enemy'),9900);
  assert.deepEqual(run.order.slice(-8),['unit:1:player','effect:dispatch-tail','shake','vibrate:150',
    'remove-stealth','dark-sense:player','sound:dispatch-sound','defeat:player']);
  assert.deepEqual(run.buffApplications,[{id:'player',sourceId:'player',strength:1009,health:0}]);
  assert.equal(run.conditions.hasBuff('player','dark-sense'),false);
  assert.equal(run.fallen.has('player'),true);assert.equal(run.member.player.health,0);
  assert.equal(run.host.app.session.party.controlledId,'survivor');
});

test('basic direct contact happens inside Presenter dispatch and still works without dispatch metadata',t=>{
  t.mock.method(Math,'random',()=>0.2);
  for(const hasDispatch of [true,false]){
    const basic=resolveBasicAttack(catalog,catalog.classes.find(value=>value.id==='dark-knight')!);
    basic.damage=damage;basic.swings=[];basic.targetEffects=[];
    if(hasDispatch)basic.dispatch=dispatch();else delete basic.dispatch;
    const run=fixture(skillAction(),basic);run.stealth();assert.equal(run.start(),'started');
    run.frame(basic.strikeFrame);
    assert.deepEqual(run.contacts,['enemy']);assert.equal(run.enemyHealth.get('enemy'),9900);
    assert.equal(run.conditions.hasState('player','stealthed'),!hasDispatch);
    if(hasDispatch)assert.deepEqual(run.order.slice(-6),
      ['damage:enemy','effect:dispatch-tail','shake','vibrate:150','remove-stealth','sound:dispatch-sound']);
    run.frame(basic.strikeFrame);assert.equal(run.contacts.length,1);
  }
});

test('summon-only events use the same dispatch boundary without creating damage units',()=>{
  const action=skillAction();
  const original=catalog.enemies.flatMap(enemy=>enemy.skills??[]).flatMap(skill=>'action' in skill?skill.action.events:[])
    .find((event):event is Extract<SkillEvent,{kind:'summon'}>=>event.kind==='summon');
  assert.ok(original,'native summon-only enemy event exists');
  action.combatUnits=[];action.events=[{...structuredClone(original),frame:2,dispatch:dispatch()}];
  const run=fixture(action);run.stealth();assert.equal(run.start(),'started');run.frame(2);
  assert.deepEqual(run.order,['summon','effect:dispatch-tail','shake','vibrate:150','remove-stealth','sound:dispatch-sound']);
  assert.equal(run.attempts.length,0);assert.equal(run.dispatches.length,1);
});


test('Dark Sense reads its current learned rank after the action and remains absent when unlearned',t=>{
  t.mock.method(Math,'random',()=>0.2);
  const run=fixture();run.learn(2);run.stealth();assert.equal(run.start(),'started');
  run.afterUnit(()=>{run.learn(6);run.unhide();});run.frame(2);
  assert.equal(run.playback().skill?.level,1);
  assert.deepEqual(run.buffApplications,[{id:'player',sourceId:'player',strength:1011,health:30}]);
  const unlearned=fixture();unlearned.stealth();assert.equal(unlearned.start(),'started');unlearned.frame(2);
  assert.equal(unlearned.conditions.hasState('player','stealthed'),false);
  assert.equal(unlearned.buffApplications.length,0);
});

test('a companion uses its own Dark Sense rank and a monster never borrows the controlled hero passive',()=>{
  const run=fixture();run.learn(8);
  const companion={...run.member,skills:{draft:()=>({levels:{'dark-sense':3},shortcuts:[]})}};
  run.host.memberOf=(id:string)=>id==='player'?run.member:id==='companion'?companion:undefined;
  for(const ownerId of ['companion','enemy']){
    run.conditions.applyState(ownerId,'stealthed',10000,ownerId);
    const caster={id:ownerId,team:ownerId==='enemy'?'enemy':'party',position:{x:0,y:0},bounds:{x:0,y:0,width:8,height:8}};
    method('runActionDispatch').call(run.host,{caster,facing:'east'},dispatch(),()=>{});
    assert.equal(run.conditions.hasState(ownerId,'stealthed'),false);
  }
  assert.deepEqual(run.buffApplications,[{id:'companion',sourceId:'companion',strength:1006,health:30}]);
  assert.equal(run.conditions.hasBuff('player','dark-sense'),false);
  assert.equal(run.conditions.hasBuff('enemy','dark-sense'),false);
  // 佣兵与主角同属玩家阵营，派发音效只响佣兵这一次；怪物仍然静音。
  assert.equal(run.order.filter(value=>value==='sound:dispatch-sound').length,1);
});

test('stealth expiration and external removal do not grant Dark Sense without an action dispatch',()=>{
  const run=fixture();run.learn(8);run.stealth();run.unhide();
  run.conditions.applyState('player','stealthed',60,'player');run.conditions.update(120);
  assert.equal(run.conditions.hasState('player','stealthed'),false);
  assert.equal(run.buffApplications.length,0);
});
