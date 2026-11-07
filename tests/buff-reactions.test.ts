import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatResourceRecovery} from '../src/domain/combat-resources.ts';
import {applyCombatOperation} from '../src/domain/combat-operation.ts';
import {resolveBuffReactions,type BuffReaction,type BuffReactionEvent,type BuffReactionBuff} from '../src/domain/buff-reactions.ts';

const rates=[1200,1800,2700,3900,4200,4500,4800,5100];
type ChildBuffEffect=BattleBuffEffect&{reactions:Extract<BuffReaction,{buff:BuffReactionBuff}>[]};
function parent(rank=1):ChildBuffEffect {
  const duration={durationMs:13560,tickMs:0,maxStacks:1,simulationFrames:{lastActiveFrame:225},states:[],periodic:[]};
  return {...duration,modifiers:[],reactions:[{kind:'physical-avoidance',buff:{key:'mana-recovery',rankPriority:rank,
    effect:{...duration,modifiers:[{attribute:'manaRecoveryPerPulse',
      operation:{kind:'increase-thousandth',ratePerThousand:rates[rank-1]}}]}}}]};
}
const avoided:Extract<BuffReactionEvent,{kind:'physical-avoidance'}>={kind:'physical-avoidance',ownerId:'defender',damageKind:'physical',outcome:'miss'};

test('current buff reactions are isolated snapshots and disappear when their source is removed',()=>{
  const conditions=new CombatConditions(),effect=parent();
  conditions.applyBuff('defender','demon-s-shield',1,effect,'caster');
  const copy=conditions.buffReactions('defender');
  assert.ok('buff' in copy[0]);
  copy[0].buff.rankPriority=8;
  copy[0].buff.effect.modifiers.length=0;
  const current=conditions.buffReactions('defender')[0];
  assert.ok('buff' in current);
  assert.equal(current.buff.rankPriority,1);
  assert.equal(current.buff.effect.modifiers.length,1);
  conditions.removeBuff('defender','demon-s-shield');
  assert.deepEqual(conditions.buffReactions('defender'),[]);
  assert.equal(copy.length,1);
});

test('internal buff reactions reuse definitions without changing them during application or timing',()=>{
  const conditions=new CombatConditions(),effect=parent(),before=structuredClone(effect);
  conditions.applyBuff('defender','demon-s-shield',1,effect,'caster');
  const reactions=conditions.activeBuffReactions('defender');
  assert.equal(conditions.activeBuffReactions('defender'),reactions);
  for(const command of resolveBuffReactions(reactions,avoided))
    conditions.applyBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
  const withChild=conditions.activeBuffReactions('defender');
  conditions.update(60);
  assert.equal(conditions.activeBuffReactions('defender'),withChild,'计时推进不重建反应描述');
  assert.deepEqual(effect,before,'子增益和年龄保存在各自状态中，原反应定义保持不变');
  const copy=conditions.buffReactions('defender');assert.ok('buff' in copy[0]);
  copy[0].buff.effect.modifiers.length=0;
  assert.deepEqual(conditions.activeBuffReactions('defender'),withChild);
  assert.deepEqual(effect,before,'对外快照继续隔离修改');
});

test('internal buff reaction views expire on replacement, removal, restore and clear',()=>{
  const conditions=new CombatConditions();
  const empty=conditions.activeBuffReactions('defender');
  conditions.applyBuff('defender','demon-s-shield',1,parent(1));
  const first=conditions.activeBuffReactions('defender');
  conditions.applyBuff('defender','demon-s-shield',2,parent(2));
  const second=conditions.activeBuffReactions('defender');
  assert.notEqual(second,first);assert.ok('buff' in second[0]);assert.equal(second[0].buff.rankPriority,2);
  const saved=conditions.captureState();conditions.removeBuff('defender','demon-s-shield');
  assert.equal(conditions.activeBuffReactions('defender'),empty);
  conditions.restoreState(saved);assert.deepEqual(conditions.activeBuffReactions('defender'),second);
  conditions.update(14000);assert.equal(conditions.activeBuffReactions('defender'),empty);
  conditions.restoreState(saved);conditions.remove('defender');assert.equal(conditions.activeBuffReactions('defender'),empty);
  conditions.restoreState(saved);conditions.clear();assert.equal(conditions.activeBuffReactions('defender'),empty);
});

test('only physical avoidance results grant a child buff to the defender without extra actions',()=>{
  const effect=parent(),before=structuredClone(effect);
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['miss','hit','critical','weapon-block','shield-block'] as const){
    const result=resolveBuffReactions(effect.reactions!,{...avoided,damageKind,outcome});
    const applies=damageKind==='physical'&&['miss','weapon-block','shield-block'].includes(outcome);
    assert.deepEqual(result,applies?[{kind:'apply-buff',sourceId:'defender',targetId:'defender',buff:effect.reactions![0].buff}]:[]);
  }
  assert.deepEqual(effect,before);
  assert.deepEqual(resolveBuffReactions([],avoided),[]);
});

test('all eight ranks carry their semantic replacement priority and independent recovery effect',()=>{
  const expectedMana=[17,22,29,39,41,44,46,48];
  for(let rank=1;rank<=8;rank++){
    const effect=parent(rank),buff:BuffReactionBuff=resolveBuffReactions(effect.reactions!,avoided)[0].buff;
    assert.equal(buff.key,'mana-recovery');assert.equal(buff.rankPriority,rank);
    assert.equal(buff.effect.durationMs,13560);assert.deepEqual(buff.effect.simulationFrames,{lastActiveFrame:225});
    assert.equal(buff.effect.maxStacks,1);assert.equal(buff.effect.tickMs,0);assert.deepEqual(buff.effect.periodic,[]);
    assert.equal(applyCombatOperation(8,buff.effect.modifiers[0].operation),expectedMana[rank-1]);
  }
  assert.equal(applyCombatOperation(9,parent().reactions![0].buff.effect.modifiers[0].operation),19);
});

test('a later child keeps its own full lifetime after the parent expires and further avoidance stops',()=>{
  const conditions=new CombatConditions(),effect=parent();
  conditions.applyBuff('defender','demon-s-shield',1,effect,'original-caster');
  conditions.update(6000);
  const active=()=>conditions.buffReactions('defender');
  const command=resolveBuffReactions(active(),avoided)[0];
  conditions.applyBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
  conditions.update(7620);
  assert.equal(conditions.hasBuff('defender','demon-s-shield'),false);
  assert.deepEqual(resolveBuffReactions(active(),avoided),[]);
  assert.equal(conditions.hasBuff('defender','mana-recovery'),true);
  assert.equal(conditions.snapshot('defender')[0].sourceId,'defender');
  assert.equal(conditions.attribute('defender','manaRecoveryPerPulse',8),17);
  conditions.update(6000);
  assert.equal(conditions.hasBuff('defender','mana-recovery'),false);
});

test('a lower rank parent cannot refresh a stronger surviving child and equal rank refresh stays single layer',()=>{
  const conditions=new CombatConditions();
  const apply=(rank:number)=>{
    const effect=parent(rank);
    const command=resolveBuffReactions(effect.reactions!,avoided)[0];
    return conditions.applyBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
  };
  assert.equal(apply(8),true);conditions.update(3000);
  const before=conditions.snapshot('defender');assert.equal(apply(1),false);
  assert.deepEqual(conditions.snapshot('defender'),before);
  assert.equal(apply(8),true);assert.equal(conditions.snapshot('defender')[0].stackCount,1);
  assert.equal(conditions.attribute('defender','manaRecoveryPerPulse',8),48);
  assert.ok(conditions.snapshot('defender')[0].remainingMs>before[0].remainingMs);
});

test('the child changes the next shared recovery pulse without resetting its phase or adding an immediate pulse',()=>{
  const clock=new CombatResourceRecovery();
  assert.deepEqual(clock.advance(1800,[]),[]);
  const before=clock.captureState(),command=resolveBuffReactions(parent().reactions!,avoided)[0];
  assert.deepEqual(clock.captureState(),before);
  assert.equal(command.kind,'apply-buff');
  const manaRecoveryPerPulse=applyCombatOperation(8,command.buff.effect.modifiers[0].operation);
  const actor={actorId:'defender',alive:true,level:1,healthRecoveryPerPulse:0,manaRecoveryPerPulse};
  assert.deepEqual(clock.advance(60,[actor,{...actor,actorId:'dead',alive:false}]),[
    {atMs:1860,amounts:[{actorId:'defender',healthAmount:0,manaAmount:17}]},
  ]);
});

function frenzyParent(rank=1):ChildBuffEffect {
  const lastActiveFrame=[90,105,120,135,135,150,150,165][rank-1];
  return {durationMs:(lastActiveFrame+1)*60,tickMs:0,maxStacks:1,simulationFrames:{lastActiveFrame},
    states:[],modifiers:[],periodic:[],reactions:[{kind:'physical-success-party',buff:{
      key:'storm-of-frenzy-power',rankPriority:rank,effect:{durationMs:1860,tickMs:0,maxStacks:5,
        simulationFrames:{lastActiveFrame:30},states:[],periodic:[],modifiers:[
          {attribute:'physicalDamageRate',operation:{kind:'add',amount:80}},
          {attribute:'magicDamageRate',operation:{kind:'add',amount:80}},
        ]},
    }}]};
}
const partySuccess:Extract<BuffReactionEvent,{kind:'physical-success-party'}>={
  kind:'physical-success-party',ownerId:'attacker',damageKind:'physical',outcome:'hit',
  partyIds:['remote-member','attacker','hidden-member'],
};

test('party reactions use physical success only and preserve the supplied slot order without random draws',t=>{
  t.mock.method(Math,'random',()=>{throw new Error('party buff must not draw random');});
  const effect=frenzyParent(),reactions=[...parent().reactions!,...effect.reactions!];
  const before=structuredClone(reactions);
  for(const damageKind of ['physical','magic'] as const)for(const outcome of ['miss','hit','critical','weapon-block','shield-block'] as const){
    const result=resolveBuffReactions(reactions,{...partySuccess,damageKind,outcome});
    const applies=damageKind==='physical'&&outcome!=='miss';
    assert.deepEqual(result,applies?partySuccess.partyIds.map(targetId=>({kind:'apply-buff',
      sourceId:'attacker',targetId,buff:effect.reactions![0].buff})):[]);
  }
  assert.deepEqual(resolveBuffReactions(effect.reactions!,avoided),[]);
  assert.deepEqual(resolveBuffReactions(reactions,{...avoided,outcome:'weapon-block'}).map(command=>command.buff.key),['mana-recovery']);
  assert.deepEqual(resolveBuffReactions(effect.reactions!,{...partySuccess,partyIds:[]}),[]);
  assert.deepEqual(resolveBuffReactions(effect.reactions!,{...partySuccess,partyIds:['third','first','second','summon']})
    .map(command=>command.targetId),['third','first','second']);
  assert.deepEqual(reactions,before);
});

test('party children read the accepted parent rank and use the attacking owner as their source',()=>{
  const conditions=new CombatConditions();
  for(let rank=1;rank<=8;rank++){
    conditions.applyBuff('attacker','storm-of-frenzy',rank,frenzyParent(rank),'original-caster');
    const commands=resolveBuffReactions(conditions.buffReactions('attacker'),partySuccess);
    assert.equal(commands.length,3);
    for(const command of commands){
      assert.equal(command.buff.rankPriority,rank);assert.equal(command.sourceId,'attacker');
      assert.equal(command.buff.effect.maxStacks,5);
      assert.deepEqual(command.buff.effect.simulationFrames,{lastActiveFrame:30});
    }
  }
  conditions.update(600);
  const before=conditions.snapshot('attacker');
  assert.equal(conditions.applyBuff('attacker','storm-of-frenzy',1,frenzyParent(1),'weaker-caster'),false);
  assert.deepEqual(conditions.snapshot('attacker'),before);
  assert.equal(resolveBuffReactions(conditions.buffReactions('attacker'),partySuccess)[0].buff.rankPriority,8);
});

test('each successful contact adds one party stack and both damage bonuses add to a maximum of 400',()=>{
  const conditions=new CombatConditions(),reactions=frenzyParent().reactions!;
  for(let contact=1;contact<=7;contact++){
    for(const command of resolveBuffReactions(reactions,partySuccess))
      conditions.applyBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
    for(const id of partySuccess.partyIds){
      assert.equal(conditions.snapshot(id)[0].stackCount,Math.min(contact,5));
      assert.equal(conditions.attribute(id,'physicalDamageRate',0),80*Math.min(contact,5));
      assert.equal(conditions.attribute(id,'magicDamageRate',0),80*Math.min(contact,5));
    }
  }
});

test('weaker party children preserve existing stacks and age while equal or stronger children refresh',()=>{
  const conditions=new CombatConditions();
  const apply=(rank:number,ownerId:string)=>{
    const command=resolveBuffReactions(frenzyParent(rank).reactions!,{...partySuccess,ownerId,partyIds:['recipient']})[0];
    return conditions.applyBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
  };
  apply(5,'first');apply(5,'first');conditions.update(600);
  const before=conditions.snapshot('recipient');
  assert.equal(apply(1,'weaker'),false);assert.deepEqual(conditions.snapshot('recipient'),before);
  assert.equal(apply(5,'equal'),true);
  assert.equal(conditions.snapshot('recipient')[0].stackCount,3);
  assert.equal(conditions.snapshot('recipient')[0].sourceId,'equal');
  assert.ok(conditions.snapshot('recipient')[0].remainingMs>before[0].remainingMs);
  assert.equal(apply(8,'stronger'),true);
  assert.equal(conditions.snapshot('recipient')[0].stackCount,4);
  assert.equal(conditions.snapshot('recipient')[0].strength,8);
});

test('the parent can expire while its newest party child completes its own final active frame',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('attacker','storm-of-frenzy',1,frenzyParent(),'original-caster');
  conditions.update(91*60);
  for(const command of resolveBuffReactions(conditions.buffReactions('attacker'),partySuccess))
    conditions.applyBuff(command.targetId,command.buff.key,command.buff.rankPriority,command.buff.effect,command.sourceId);
  conditions.update(60);
  assert.equal(conditions.hasBuff('attacker','storm-of-frenzy'),false);
  assert.deepEqual(resolveBuffReactions(conditions.buffReactions('attacker'),partySuccess),[]);
  assert.equal(conditions.hasBuff('attacker','storm-of-frenzy-power'),true);
  conditions.update(30*60);
  assert.equal(conditions.hasBuff('attacker','storm-of-frenzy-power'),true);
  conditions.update(60);
  for(const id of partySuccess.partyIds)assert.equal(conditions.hasBuff(id,'storm-of-frenzy-power'),false);
});
