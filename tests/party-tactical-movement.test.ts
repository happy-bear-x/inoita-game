import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {PartyController,type PartyPort} from '../src/domain/party-ai.ts';
import {CombatController,type ActionPlayback,type Combatant} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {attackDistance,resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {BattleCatalog,EnemyPlayableSkill} from '../src/domain/battle.ts';
import type {Point} from '../src/domain/navigation.ts';
import {rectDistance} from '../src/domain/rect-distance.ts';

const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const wolf = battle.enemies.find(enemy=>enemy.id==='enemy-head-werewolf-1')!;

function battleWithWolf(role:'priest'|'ranger',canStand:(p:Point)=>boolean=()=>true) {
  const makeActor=(id:string,team:string,x:number,y:number):Combatant=>({
    id,team,position:{x,y},bounds:{x:-8,y:-8,width:16,height:16}
  });
  const member=makeActor(role,'party',100,100), leader=makeActor('player','party',46,100);
  const boss=makeActor(wolf.id,'hostile',120,120), attacker=makeActor('wolf-guard','hostile',110,100);
  const actors=[member,leader,boss,attacker];
  const basic=resolveBasicAttack(battle,battle.classes.find(entry=>entry.id===role)!);
  const prayer=battle.skills['prayer-of-recovery'];
  const skills:EnemyPlayableSkill[]=role==='priest'?[{id:'prayer-of-recovery',name:prayer.name,action:prayer.action!,level:1,
    manaCost:prayer.ranks[0].manaCost,frequency:1,clips:{north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'}}]:[];
  let health=100,mana=1000,frame=0;
  let waypoint:(()=>Point|undefined)|undefined,finish:(()=>void)|undefined;
  const casts:ActionPlayback[]=[], healed:string[]=[];
  const port:PartyPort={
    actor:id=>actors.find(actor=>actor.id===id),candidates:()=>actors,leader:()=>leader,inCombat:()=>true,attacking:()=>false,
    targetOf:id=>id===attacker.id?member.id:undefined,focusTarget:()=>boss.id,isBoss:id=>id===boss.id,
    attackRange:()=>basic.approachDistanceUnits,skills:()=>skills,skillUses:()=>['heal'],
    vitals:id=>id===leader.id||id===member.id?{health:id===leader.id?health:100,maxHealth:100}:undefined,
    healCandidates:()=>[leader,member].map(actor=>({actor,active:true,hasDisplay:true,score:actor===leader?health:100})),
    canSpendMana:cost=>mana>=cost,spendMana:cost=>{mana-=cost;return true;},
    cooldowns:new CombatCooldownStore(()=>frame).forActor(member.id),
    navigationBounds:()=>({x:0,y:0,width:320,height:320}),canStand,
    followPath:next=>{waypoint=next;},stop:()=>{waypoint=undefined;},facing:()=>'east',
    moveToward:()=>assert.fail('expected a traversable party path'),relocate:()=>assert.fail('unexpected teleport'),
    play:(action,onFrame,onFinish)=>{casts.push(action);finish=()=>{onFrame(8);onFinish();};return ()=>{};},
    frame:(action,index,_contact,ready)=>{for(const event of action.skill?.action.events??[]){
      if(event.kind==='units'&&event.frame===index)ready({event,selectedTargetId:action.target?.id});
    }},
    unit:hit=>{if(hit.skill.action.combatUnits?.[hit.cueIndex].effect==='heal'){healed.push(hit.targetId);health=100;}return 'success';},
    clearEffects(){}
  };
  const ai=new PartyController(member.id,port,new CombatController(member.id,basic,port));
  return {ai,member,leader,boss,attacker,casts,healed,port,waypoint:()=>waypoint?.(),mana:()=>mana,
    wound:()=>{health=10;},finish:()=>finish?.(),step:()=>{frame++;ai.step();}};
}

test('a ranged companion retreats from the nearby attacker toward the leader and shoots the focused boss',()=>{
  const fight=battleWithWolf('ranger');
  fight.step();
  const goal=fight.waypoint();
  assert.ok(goal&&goal.x<fight.member.position.x,'retreat toward the party');
  fight.member.position=goal;
  assert.ok(attackDistance(goal,fight.member.bounds,fight.attacker.position,fight.attacker.bounds)>4);
  for(let i=0;i<4&&!fight.casts.length;i++)fight.step();
  assert.equal(fight.casts[0]?.target?.id,fight.boss.id);
});

test('when every retreat is blocked the ranger shoots immediately',()=>{
  const fight=battleWithWolf('ranger',()=>false);
  fight.step();
  assert.equal(fight.waypoint(),undefined);
  assert.equal(fight.casts[0]?.target?.id,fight.boss.id);
});

test('a priest steps into recovery range, spends mana healing the leader, then resumes focus',()=>{
  const fight=battleWithWolf('priest');
  fight.leader.position={x:204,y:100};fight.wound();fight.step();
  const goal=fight.waypoint();
  assert.ok(goal&&goal.x>100&&goal.x<132,'stop at the heal range rather than at the ally');
  assert.equal(fight.mana(),1000);
  fight.member.position=goal;
  assert.ok(rectDistance(fight.member,fight.leader)+2<=11);
  for(let i=0;i<4&&!fight.casts.length;i++)fight.step();
  assert.equal(fight.casts[0]?.skill?.id,'prayer-of-recovery');
  assert.equal(fight.mana(),1000-battle.skills['prayer-of-recovery'].ranks[0].manaCost);
  fight.finish();assert.deepEqual(fight.healed,[fight.leader.id]);
  for(let i=0;i<5&&fight.casts.length<2;i++)fight.step();
  assert.equal(fight.casts[1]?.target?.id,fight.boss.id);
});

test('a blocked direct heal approach waits for path budget and goes around the obstacle',()=>{
  const canStand=(p:Point)=>!(p.x>102&&p.x<114&&p.y>=88&&p.y<=112);
  const fight=battleWithWolf('priest',canStand);
  fight.leader.position={x:216,y:100};fight.wound();
  let grants=0;
  fight.port.pathBudget={take:()=>++grants===1?0:5};
  fight.step();
  assert.equal(fight.waypoint(),undefined);
  for(let i=0;i<100&&!fight.casts.length;i++){
    fight.step();
    const next=fight.waypoint();
    if(next){assert.ok(canStand(next));fight.member.position=next;}
  }
  assert.ok(grants>1);
  assert.equal(fight.casts[0]?.skill?.id,'prayer-of-recovery');
  assert.ok(rectDistance(fight.member,fight.leader)+2<=11);
});
