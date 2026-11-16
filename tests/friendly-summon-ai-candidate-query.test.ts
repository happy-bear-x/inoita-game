import test from 'node:test';
import assert from 'node:assert/strict';
import {FriendlySummonController,type FriendlySummonPort,type FriendlySummonRole,type FriendlySummonTactics} from '../src/domain/friendly-summon-ai.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {ActionPlayback,Combatant} from '../src/domain/combat.ts';
import type {EnemyBehavior,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {GameRectangle,Point} from '../src/domain/navigation.ts';
import {CombatSpatialIndex,type CombatQueryCircle} from '../src/domain/combat-spatial-index.ts';

const box={x:-8,y:-8,width:16,height:16};
const attack:ResolvedBasicAttack={profileId:'test',step:0,stepCount:1,frameDurationMs:60,cycleFrames:15,effectiveCycleFrames:15,
  damage:{effect:'physical',source:'bestNormalDamage',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]},
  approachDistanceUnits:4,searchRadiusPx:64,strikeFrame:8,swingFrame:null,swings:[],impacts:[],projectile:null,
  clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'},
  sequence:{north:Array(15).fill(0),south:Array(15).fill(0),east:Array(15).fill(0),west:Array(15).fill(0)}};
const defaultBehavior:EnemyBehavior={aggression:'active',awarenessRangeUnits:8,moveSpeedPxPerSecond:133.33333333333334,canMove:true,canTurn:true};

function setup(role:FriendlySummonRole='hell-soldier',id='summon',behaviorOverrides:Partial<EnemyBehavior>={}) {
  const behavior:EnemyBehavior={...defaultBehavior,...behaviorOverrides};
  const owner:Combatant={id:'owner',team:'party',position:{x:0,y:0},bounds:box};
  const actor:Combatant={id,team:'party',position:{x:48,y:0},bounds:box};
  const actors=[owner,actor];
  const vitals=new Map<string,{current:number;maximum:number}>([['owner',{current:100,maximum:100}]]);
  let tactics:FriendlySummonTactics={engagedTargetIds:[],threats:[],partyIds:['owner']};
  let autonomous:(id:string)=>boolean=()=>true;
  let bounds:GameRectangle={x:-128,y:-128,width:768,height:256};
  let blocked:(point:Point)=>boolean=()=>false;
  let follow:(()=>Point|undefined)|undefined;
  let time=0,recalls=0,allowedRecall=false,paused=false,searches=0,interruptions=0,budgetRequests=0;
  let budgetGrant:(owner:string,limit:number)=>number=(_owner,limit)=>limit;
  const actions:ActionPlayback[]=[];
  let playback:{action:ActionPlayback;frame:(index:number)=>void;complete:()=>void;index:number}|undefined;
  const stand=(point:Point)=>!blocked(point)&&!actors.some(other=>other!==actor&&Math.abs(other.position.x-point.x)<16&&Math.abs(other.position.y-point.y)<16);
  const port:FriendlySummonPort={
    cooldowns:new CombatCooldownStore(()=>Math.floor(time/60)).forActor(id),isPaused:()=>paused,
    actor:key=>actors.find(item=>item.id===key),candidates:()=>actors,isAlive:key=>actors.some(item=>item.id===key),
    health:key=>vitals.get(key),facing:()=> 'south',moveToward:()=>assert.fail('budgeted pathfinding must own movement'),
    followPath:next=>{follow=next;},stop:()=>{follow=undefined;},home:()=>({x:48,y:0}),
    navigationBounds:()=>bounds,canStand:stand,pathBudget:{take:(owner,limit)=>{budgetRequests++;return budgetGrant(owner,limit);}},
    navigationSnapshot:()=>{
      searches++;
      const positions=actors.filter(other=>other!==actor).map(other=>({...other.position}));
      const obstacle=blocked;
      return {bounds:{...bounds},start:{...actor.position},canStand:point=>!obstacle(point)&&!positions.some(position=>Math.abs(position.x-point.x)<16&&Math.abs(position.y-point.y)<16)};
    },
    tactics:()=>tactics,tryRecall:()=>{recalls++;if(!allowedRecall)return false;actor.position={x:32,y:0};return true;},
    autonomousTarget:id=>autonomous(id),
    relocate:point=>{actor.position={...point};},
    play:(action,frame,complete)=>{
      actions.push(action);const active={action,frame,complete,index:0};playback=active;
      return ()=>{if(playback===active){interruptions++;playback=undefined;}};
    },frame:()=>{},clearEffects:()=>{},
  };
  const ai=new FriendlySummonController(id,owner.id,role,behavior,attack,port);
  const enemy=(key:string,position:Point)=>{const result:Combatant={id:key,team:'enemy',position:{...position},bounds:box};actors.push(result);return result;};
  const advance=(ticks=1,move=true)=>{for(let i=0;i<ticks;i++){
    time+=60;
    if(move){const next=follow?.();if(next){const dx=next.x-actor.position.x,dy=next.y-actor.position.y,length=Math.hypot(dx,dy),step=Math.min(length,8);if(length)actor.position={x:actor.position.x+dx/length*step,y:actor.position.y+dy/length*step};}}
    if(playback){const active=playback;active.frame(++active.index);if(active.index>=15&&playback===active){playback=undefined;active.complete();}}
    ai.step();
  }};
  return {ai,actor,owner,actors,vitals,enemy,advance,actions,port,
    setTactics:(value:Partial<FriendlySummonTactics>)=>{tactics={...tactics,...value};},
    setBlocked:(value:(point:Point)=>boolean)=>{blocked=value;},
    setAutonomousTarget:(value:(id:string)=>boolean)=>{autonomous=value;},
    setPathBudget:(value:(owner:string,limit:number)=>number)=>{budgetGrant=value;},
    recalls:()=>recalls,searches:()=>searches,interruptions:()=>interruptions,budgetRequests:()=>budgetRequests,next:()=>follow?.(),
    allowRecall:()=>{allowedRecall=true;},setPaused:(value:boolean)=>{paused=value;},
    setBounds:(value:GameRectangle)=>{bounds=value;}};
}

test('nearby owner circle keeps committed targets up to the 192px leash',()=>{
  const build=(x:number,nearby:boolean)=>{
    const run=setup('hell-soldier','summon',{awarenessRangeUnits:20});
    const enemy=run.enemy('committed',{x,y:0});
    run.setTactics({engagedTargetIds:[enemy.id],ownerTargetId:enemy.id});
    if(nearby)run.port.nearbyCandidates=circles=>new CombatSpatialIndex(run.actors).within(circles);
    run.advance(20,false);
    return run.ai.snapshot().targetId;
  };
  for(const x of [191,193])
    assert.equal(build(x,true),build(x,false),`${x}px 处附近查询与全表结果一致`);
  assert.equal(build(191,true),'committed','主人 192px 内仍可承诺目标');
  assert.equal(build(193,true),undefined,'超过主人 192px 的目标保持被放弃');
});

test('nearby query covers owner and summon circles while validTarget keeps the owner limit',()=>{
  const run=setup('hell-soldier','summon',{awarenessRangeUnits:16});
  run.actor.position={x:100,y:0};
  const enemy=run.enemy('noticed-but-far',{x:200,y:0});
  run.setTactics({engagedTargetIds:[enemy.id],ownerTargetId:enemy.id});
  let circles:readonly CombatQueryCircle[]=[];
  run.port.nearbyCandidates=value=>{circles=value;return new CombatSpatialIndex(run.actors).within(value);};
  run.advance(20);
  assert.equal(circles.length,2,'普通警戒要同时查主人和召唤物位置');
  assert.ok(circles[0]!.radius>=192,'主人圆覆盖 192px 承诺目标范围');
  assert.ok(circles[1]!.radius>=128,'召唤物圆覆盖自身警戒范围');
  assert.equal(run.ai.snapshot().targetId,undefined,'超过主人 192px 的目标仍被原过滤排除');
});

test('nearby candidate query matches full scan for summon selection and ordering',()=>{
  const build=(nearby:boolean)=>{
    const run=setup('hell-soldier','summon',{awarenessRangeUnits:16});
    const first=run.enemy('enemy-a',{x:0,y:0}),second=run.enemy('enemy-b',{x:96,y:0});
    run.setTactics({engagedTargetIds:[first.id,second.id]});
    if(nearby)run.port.nearbyCandidates=circles=>new CombatSpatialIndex(run.actors).within(circles);
    run.advance(20,false);
    return run.ai.snapshot().targetId;
  };
  assert.equal(build(false),'enemy-a','同优先级同距离时全表按候选顺序取第一个');
  assert.equal(build(true),'enemy-a','附近查询保持同一候选顺序');
});

test('map-wide summon awareness keeps the owner circle as the limiting query',()=>{
  const run=setup('hell-soldier','summon',{engagement:'map-wide',awarenessRangeUnits:8});
  let circles:readonly CombatQueryCircle[]=[];
  run.port.nearbyCandidates=value=>{circles=value;return new CombatSpatialIndex(run.actors).within(value);};
  run.advance(1,false);
  assert.equal(circles.length,1,'全图警戒不再放大召唤物圆');
  assert.ok(circles[0]!.radius>=192,'主人 192px 范围仍覆盖全部可接受候选');
});
