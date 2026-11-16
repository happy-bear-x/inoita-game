import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PartyController,type PartyPort,type PartySkillKind} from '../src/domain/party-ai.ts';
import {CombatController,type ActionPlayback,type Combatant} from '../src/domain/combat.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {BattleCatalog,EnemyPlayableSkill} from '../src/domain/battle.ts';
import type {Point} from '../src/domain/navigation.ts';
import {CombatSpatialIndex} from '../src/domain/combat-spatial-index.ts';
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const box={x:-8,y:-8,width:16,height:16};

function setup(random=()=>0){
  const time={frame:0};
  const member:Combatant={id:'member',team:'party',position:{x:32,y:32},bounds:box};
  const leader:Combatant={id:'player',team:'party',position:{x:128,y:128},bounds:box};
  const enemy:Combatant={id:'enemy',team:'enemy',position:{x:360,y:360},bounds:box};
  const enemy2:Combatant={id:'enemy2',team:'enemy',position:{x:380,y:360},bounds:box};
  const actors=new Map([member,leader,enemy,enemy2].map(actor=>[actor.id,actor]));
  const targets=new Map<string,string>();
  const plays:ActionPlayback[]=[];let completed:(()=>void)|undefined,path:(()=>Point|undefined)|undefined;
  const vitals=new Map([[member.id,{health:100,maxHealth:100}],[leader.id,{health:100,maxHealth:100}]]);
  const attacking=new Set<string>();let focus:string|undefined,mana=1000,skills:EnemyPlayableSkill[]=[],fighting=false;
  let sharedTarget:string|undefined,sharedCalls=0,facing:'north'|'south'|'east'|'west'='east',slot:0|1=0,range=4;
  const kinds=new Map<string,PartySkillKind>();
  const port:PartyPort={cooldowns:new CombatCooldownStore(()=>time.frame).forActor(member.id),actor:id=>actors.get(id),candidates:()=>[...actors.values()],leader:()=>leader,
    leaderFacing:()=>facing,followSlot:()=>slot,
    focusTarget:()=>focus,partyTarget:()=>{sharedCalls++;return sharedTarget;},targetOf:id=>targets.get(id),inCombat:()=>fighting||!!focus,
    facing:()=> 'east',face:()=>{},
    navigationBounds:()=>({x:0,y:0,width:400,height:400}),canStand:p=>p.x>=0&&p.x<=400&&p.y>=0&&p.y<=400,
    followPath:next=>{path=next;},moveToward:()=>assert.fail('party movement must use its navigable path'),
    stop:()=>{path=undefined;},relocate:p=>{member.position={...p};},
    skills:()=>skills,skillKind:id=>kinds.get(id),vitals:id=>vitals.get(id),attacking:id=>attacking.has(id),attackRange:()=>range,
    canSpendMana:cost=>cost<=mana,spendMana:cost=>{if(cost>mana)return false;mana-=cost;return true;},
    play:(action,_frame,complete)=>{plays.push(action);completed=complete;return ()=>{};},frame:()=>{},clearEffects:()=>{}};
  const combat=new CombatController(member.id,resolveBasicAttack(catalog,catalog.classes[0]),port);
  const ai=new PartyController(member.id,port,combat,random);
  const installSkill=(id:string,kind:PartySkillKind,frequency=1)=>{
    const entry=catalog.skills[id];
    kinds.set(id,kind);skills=[...skills.filter(skill=>skill.id!==id),{id,name:entry.name,action:entry.action!,
      manaCost:entry.ranks[0].manaCost,frequency,clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}];
  };
  return {ai,combat,port,time,member,leader,enemy,enemy2,actors,plays,vitals,attacking,waypoint:()=>path?.(),
    focus:(id:string|undefined)=>{focus=id;},shared:(id:string|undefined)=>{sharedTarget=id;},
    fighting:(value=true)=>{fighting=value;},setTarget:(actorId:string,targetId:string|undefined)=>{
      if(targetId===undefined)targets.delete(actorId);else targets.set(actorId,targetId);
    },
    setAttackRange:(value:number)=>{range=value;},
    skill:installSkill,finish:()=>completed?.()};
}

function enableNearby(run:ReturnType<typeof setup>):void {
  run.port.nearbyCandidates=circles=>new CombatSpatialIndex([...run.actors.values()]).within(circles);
}

test('nearby threat scan matches full candidates for own range, leader leash and outside both',()=>{
  const scenario=(kind:'own'|'leader'|'outside',nearby:boolean)=>{
    const run=setup();
    run.member.position={x:32,y:32};run.leader.position={x:200,y:200};
    run.enemy.position=kind==='own'?{x:64,y:32}:kind==='leader'?{x:300,y:200}:{x:600,y:600};
    run.enemy2.position={x:600,y:600};run.setTarget('enemy','member');run.setTarget('enemy2',undefined);
    if(nearby)enableNearby(run);
    run.ai.update(60);
    const state=run.ai.captureState();
    // 近身目标会由战斗控制器锁定；队长圆内的远处目标只体现在追击目的地。
    return state.destinationTarget==='enemy'?'enemy':run.ai.selectedTargetId();
  };
  for(const kind of ['own','leader','outside'] as const)
    assert.equal(scenario(kind,true),scenario(kind,false),`${kind} 场景的附近查询结果应与全表一致`);
  assert.equal(scenario('own',true),'enemy');
  assert.equal(scenario('leader',true),'enemy','队长 200px 内的敌人也要进入威胁扫描');
  assert.equal(scenario('outside',true),undefined,'两个圆之外的目标保持原样被放弃');
});

test('nearby threat scan preserves candidate order when distances tie',()=>{
  const build=(nearby:boolean)=>{
    const run=setup();
    run.member.position={x:32,y:32};run.leader.position={x:32,y:32};
    run.enemy.position={x:64,y:32};run.enemy2.position={x:32,y:64};
    const list=[run.member,run.leader,run.enemy2,run.enemy];
    run.port.candidates=()=>list;
    run.setTarget('enemy','member');run.setTarget('enemy2','member');
    if(nearby)run.port.nearbyCandidates=circles=>new CombatSpatialIndex(list).within(circles);
    run.ai.update(60);
    return run.ai.selectedTargetId();
  };
  assert.equal(build(false),'enemy2','全表扫描取候选顺序里的第一个同距离敌人');
  assert.equal(build(true),'enemy2','附近查询必须保持同一顺序');
});

test('nearby threat scan keeps oversized boss bodies',()=>{
  const build=(nearby:boolean)=>{
    const run=setup();
    run.member.position={x:32,y:32};run.leader.position={x:1000,y:1000};
    // 脚点在 240px 外，但 400×400 的身体已经贴到成员，矩形攻击距离仍在范围内。
    const boss:Combatant={id:'boss',team:'enemy',position:{x:240,y:32},
      bounds:{x:-200,y:-200,width:400,height:400}};
    run.actors.set(boss.id,boss);run.setTarget('boss','member');
    if(nearby)enableNearby(run);
    run.ai.update(60);
    return run.ai.selectedTargetId();
  };
  assert.equal(build(false),'boss','全表扫描按矩形距离选中超大身体');
  assert.equal(build(true),'boss','附近查询必须并入无法被脚点圆覆盖的大身体');
});

test('threat scan keeps party ids from the full candidate list',()=>{
  const run=setup();
  run.member.position={x:32,y:32};run.leader.position={x:200,y:200};
  const farAlly:Combatant={id:'far-ally',team:'party',position:{x:900,y:900},bounds:box};
  run.actors.set(farAlly.id,farAlly);
  run.enemy.position={x:64,y:32};run.setTarget('enemy',farAlly.id);
  enableNearby(run);
  run.ai.update(60);
  assert.equal(run.ai.selectedTargetId(),'enemy','远处队友被攻击也必须算作威胁');
});

test('ally-combat readiness still scans the full candidate list',()=>{
  const run=setup();
  const farAlly:Combatant={id:'far-ally',team:'party',position:{x:900,y:900},bounds:box};
  run.actors.set(farAlly.id,farAlly);run.attacking.add(farAlly.id);
  run.enemy.position={x:56,y:32};run.focus('enemy');run.fighting();
  run.skill('curse-of-screams','ally-combat');enableNearby(run);
  run.ai.update(60);
  assert.equal(run.plays.at(-1)?.skill?.id,'curse-of-screams','远处队友正在战斗也要触发协同技能');
});
