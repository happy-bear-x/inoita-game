import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EnemyController} from '../src/domain/enemy-ai.ts';
import type {EnemyPort} from '../src/domain/enemy-ai.ts';
import type {EnemyBehavior,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {Combatant} from '../src/domain/combat.ts';
import type {Facing} from '../src/domain/content.ts';
import type {Point} from '../src/domain/navigation.ts';
import {CombatSpatialIndex} from '../src/domain/combat-spatial-index.ts';

const box={x:-8,y:-8,width:16,height:16};
const attack:ResolvedBasicAttack={profileId:'test',step:0,stepCount:1,frameDurationMs:60,cycleFrames:4,effectiveCycleFrames:4,
  damage:{effect:'physical',source:'bestNormalDamage',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]},
  approachDistanceUnits:2,searchRadiusPx:1,strikeFrame:1,swingFrame:null,swings:[],impacts:[],projectile:null,
  clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'},
  sequence:{north:[0,1,2,3],south:[0,1,2,3],east:[0,1,2,3],west:[0,1,2,3]}};

function setup(overrides:Partial<EnemyBehavior>={}) {
  const actor:Combatant={id:'monster',team:'enemy',position:{x:16,y:32},bounds:box};
  const player:Combatant={id:'player',team:'party',position:{x:96,y:32},bounds:box};
  const home={...actor.position};
  let waypoint:Point|undefined;
  let heading:Facing='south';
  const behavior:EnemyBehavior={aggression:'active',awarenessRangeUnits:12,moveSpeedPxPerSecond:100,canMove:true,canTurn:true,...overrides};
  const port:EnemyPort={cooldowns:new CombatCooldownStore(()=>0).forActor(actor.id),actor:id=>[actor,player].find(a=>a.id===id),candidates:()=>[actor,player],facing:()=>heading,face:facing=>{heading=facing;},
    moveToward:point=>{waypoint={...point};},followPath:next=>{waypoint=next();},stop:()=>{waypoint=undefined;},home:()=>home,
    navigationBounds:()=>({x:8,y:8,width:144,height:80}),
    canStand:point=>point.x>=8&&point.x<=152&&point.y>=8&&point.y<=88&&!(Math.abs(point.x-player.position.x)<16&&Math.abs(point.y-player.position.y)<16),
    relocate:point=>{actor.position={...point};},play:()=>()=>{},frame:()=>{},clearEffects:()=>{}};
  const ai=new EnemyController(actor.id,behavior,attack,port,[],()=>0);
  return {ai,actor,player,port,waypoint:()=>waypoint};
}

test('nearby awareness query keeps the full-scan target and covers diagonal 8px distance',()=>{
  const build=(nearby:boolean)=>{
    const run=setup();
    run.player.states=['stealthed']; // 不让 96px 外的玩家抢走最近目标
    const diagonal:Combatant={id:'diagonal',team:'party',
      position:{x:run.actor.position.x+70,y:run.actor.position.y+70},bounds:box};
    const outside:Combatant={id:'outside',team:'party',
      position:{x:run.actor.position.x+95,y:run.actor.position.y+95},bounds:box};
    const list=[run.actor,run.player,diagonal,outside];
    run.port.candidates=()=>list;
    const original=run.port.actor;
    run.port.actor=id=>id===diagonal.id?diagonal:id===outside.id?outside:original(id);
    if(nearby)run.port.nearbyCandidates=circles=>new CombatSpatialIndex(list).within(circles);
    run.ai.update(60);
    return run.ai.snapshot().targetId;
  };
  assert.equal(build(false),'diagonal','全表扫描能接受 8px 量化距离的斜角目标');
  assert.equal(build(true),'diagonal','附近查询必须覆盖同一斜角目标');
});

test('map-wide awareness scans all candidates instead of the nearby index',()=>{
  const run=setup({engagement:'map-wide',awarenessRangeUnits:1});
  run.player.position={x:120,y:80};
  let nearbyCalls=0;
  run.port.nearbyCandidates=()=>{nearbyCalls++;return [];};
  run.ai.update(60);
  assert.equal(nearbyCalls,0);
  assert.equal(run.ai.snapshot().targetId,'player');
});

test('threat notice scan uses nearby candidates and still applies the awareness filter',()=>{
  const run=setup();
  const near:Combatant={id:'near',team:'party',position:{x:run.actor.position.x+16,y:run.actor.position.y},bounds:box};
  const far:Combatant={id:'far',team:'party',position:{x:400,y:32},bounds:box};
  const list=[run.actor,near,far];
  run.port.candidates=()=>list;
  const original=run.port.actor;
  run.port.actor=id=>id===near.id?near:id===far.id?far:original(id);
  const noticed:string[]=[];
  run.port.threat={select:()=>undefined,notice:id=>noticed.push(id),has:()=>false,clear:()=>{}};
  let nearbyCalls=0;
  run.port.nearbyCandidates=circles=>{nearbyCalls++;return new CombatSpatialIndex(list).within(circles);};
  run.ai.update(60);
  assert.ok(nearbyCalls>0,'普通警戒的仇恨扫描应走附近查询');
  assert.deepEqual(noticed,['near'],'附近查询外的远目标仍被原警戒过滤排除');
});
