import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const frameEffect=(lastActiveFrame:number,extra:Partial<BattleBuffEffect>={}):BattleBuffEffect=>({
  durationMs:(lastActiveFrame+1)*60,tickMs:0,simulationFrames:{lastActiveFrame},
  modifiers:[],states:[],periodic:[],...extra,
});
const legacyEffect=():BattleBuffEffect=>({durationMs:1000,tickMs:0,modifiers:[],states:['stun'],periodic:[]});
const pulseEffect=(lastActiveFrame:number,interval:number,extra:Partial<BattleBuffEffect>={}):BattleBuffEffect=>
  frameEffect(lastActiveFrame,{tickMs:interval*60,simulationFrames:{lastActiveFrame,pulseIntervalFrames:interval},
    periodic:[{kind:'fixed-damage',amount:1}],...extra});
/** 空的条件表会让 update 提前返回；需要推进共享帧余量时先挂一条长寿增益。 */
const clockAnchor=():BattleBuffEffect=>({durationMs:60000,tickMs:0,modifiers:[],states:[],periodic:[]});

test('frame buffs apply immediately, start at the next shared boundary and expire only after the inclusive last age',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('hero','shield-of-rage',1,frameEffect(0,{states:['stun'],
    modifiers:[{attribute:'physicalDamageRate',operation:{kind:'add',amount:65}}]}));
  conditions.applyState('hero','stealthed',60,'independent');
  assert.equal(conditions.attribute('hero','physicalDamageRate',0),65);
  assert.equal(conditions.snapshot('hero')[0].remainingMs,120);
  const saved=conditions.captureState();let ticks=0;
  for(const delta of [0,-60,NaN,Infinity])conditions.update(delta,()=>ticks++);
  assert.deepEqual(conditions.captureState(),saved);assert.equal(ticks,0);
  conditions.update(59);assert.equal(conditions.snapshot('hero')[0].remainingMs,61);
  conditions.update(1);
  assert.equal(conditions.hasBuff('hero','shield-of-rage'),true);
  assert.equal(conditions.hasState('hero','stun'),true);
  assert.equal(conditions.hasState('hero','stealthed'),false);
  assert.ok(conditions.snapshot('hero').every(condition=>condition.remainingMs===60));
  conditions.update(59);assert.equal(conditions.canAct('hero'),false);
  conditions.update(1);assert.equal(conditions.attribute('hero','physicalDamageRate',0),0);
  assert.deepEqual(conditions.snapshot('hero'),[]);
});

test('rage stacks refresh one shared age, cap at five and use the latest accepted rank for every layer',()=>{
  const conditions=new CombatConditions();
  const effect=(amount:number)=>frameEffect(75,{maxStacks:5,
    modifiers:[{attribute:'physicalDamageRate',operation:{kind:'add',amount}}]});
  conditions.applyBuff('hero','shield-of-rage',1,effect(65));
  conditions.update(4500);
  conditions.applyBuff('hero','shield-of-rage',1,effect(65));
  assert.equal(conditions.attribute('hero','physicalDamageRate',0),130);
  assert.equal(conditions.snapshot('hero')[0].remainingMs,4620);
  conditions.applyBuff('hero','shield-of-rage',2,effect(85),'new-source');
  assert.equal(conditions.attribute('hero','physicalDamageRate',0),255);
  for(let i=0;i<4;i++)conditions.applyBuff('hero','shield-of-rage',2,effect(85),'new-source');
  assert.equal(conditions.attribute('hero','physicalDamageRate',0),425);
  assert.equal(conditions.snapshot('hero')[0].stackCount,5);
  conditions.update(4560);
  const before=conditions.captureState();
  assert.equal(conditions.applyBuff('hero','shield-of-rage',1,effect(65),'weaker'),false);
  assert.deepEqual(conditions.captureState(),before);
  conditions.update(59);assert.equal(conditions.hasBuff('hero','shield-of-rage'),true);
  conditions.update(1);assert.equal(conditions.hasBuff('hero','shield-of-rage'),false);
});

test('periodic age zero runs on the first processing frame and a due pulse runs before expiry',()=>{
  const conditions=new CombatConditions(),pulses:number[]=[];let at=0;
  conditions.applyBuff('target','blood-curse',1,pulseEffect(2,3),'caster');
  for(let frame=0;frame<4;frame++){
    at+=60;conditions.update(60,tick=>{
      assert.equal(conditions.hasBuff(tick.targetId,tick.buffId),true);
      assert.equal(tick.sourceId,'caster');pulses.push(at);
    });
  }
  assert.deepEqual(pulses,[60,240]);assert.equal(conditions.hasBuff('target','blood-curse'),false);
});

test('frame catch-up matches split render updates and preserves the shared fractional remainder',()=>{
  const run=(deltas:number[])=>{
    const conditions=new CombatConditions(),pulses:string[]=[];
    conditions.applyBuff('clock','attack-stun',1,clockAnchor());
    conditions.update(17.5);
    conditions.applyBuff('target','blood-curse',1,pulseEffect(8,2),'caster');
    for(const delta of deltas)conditions.update(delta,tick=>pulses.push(`${tick.sourceId}:${tick.stackCount}`));
    return {pulses,state:conditions.captureState(),visible:conditions.snapshot('target')};
  };
  assert.deepEqual(run([401.25]),run([30,52.5,100,200,18.75]));
  assert.equal(run([401.25]).pulses.length,3);
  assert.equal(run([401.25]).state.simulationFrameRemainderMs,58.75);
});

test('all actors share the next frame while empty time freezes the phase without resetting it',()=>{
  const conditions=new CombatConditions(),pulses:string[]=[];
  conditions.applyBuff('clock','attack-stun',1,clockAnchor());
  conditions.update(55);
  conditions.applyBuff('first','blood-curse',1,pulseEffect(3,1));
  conditions.update(2);
  conditions.applyBuff('second','blood-curse',1,pulseEffect(3,1));
  conditions.update(3,tick=>pulses.push(tick.targetId));
  assert.deepEqual(pulses,['first','second']);
  // clear 不清共享余量；空的条件表也不会推进它，所以第三名要等满一帧。
  conditions.remove('first');conditions.clear();conditions.update(17);
  conditions.applyBuff('third','blood-curse',1,pulseEffect(3,1));
  conditions.update(42,tick=>pulses.push(tick.targetId));assert.equal(pulses.length,2);
  conditions.update(18,tick=>pulses.push(tick.targetId));assert.equal(pulses[2],'third');
});

test('refreshing during a long update processes each replacement only at the following frame',()=>{
  const conditions=new CombatConditions(),layers:number[]=[];
  const effect=pulseEffect(0,1,{maxStacks:3,states:['stun'],
    periodic:[{kind:'fixed-damage',amount:1},{kind:'visual',effect:'blood-curse-pulse'}]});
  conditions.applyBuff('target','blood-curse',1,effect,'first');
  conditions.update(180,tick=>{
    assert.equal(tick.effect.kind,'fixed-damage');layers.push(tick.stackCount);
    conditions.applyBuff('target','blood-curse',1,effect,'refreshed');
  });
  assert.deepEqual(layers,[1,2,3]);
  assert.ok(conditions.snapshot('target').every(condition=>condition.remainingMs===120&&condition.sourceId==='refreshed'));
  conditions.update(120);
  assert.deepEqual(conditions.snapshot('target'),[]);
});

test('removing from a frame callback stops remaining effects and new actors wait for the next frame',()=>{
  const conditions=new CombatConditions(),pulses:string[]=[];
  conditions.applyBuff('old','blood-curse',1,pulseEffect(4,1,{
    periodic:[{kind:'fixed-damage',amount:1},{kind:'visual',effect:'blood-curse-pulse'}]}));
  conditions.update(180,tick=>{
    pulses.push(tick.targetId);
    if(tick.targetId==='old'){
      conditions.remove('old');conditions.applyBuff('new','blood-curse',1,pulseEffect(0,1));
    }
  });
  assert.deepEqual(pulses,['old','new','new']);
  assert.deepEqual(conditions.snapshot('old'),[]);assert.deepEqual(conditions.snapshot('new'),[]);
});

test('frame callbacks cannot consume a newly created legacy buff with the entire render delta',()=>{
  const conditions=new CombatConditions();let created=false;
  conditions.applyBuff('frame','blood-curse',1,pulseEffect(3,1));
  conditions.update(180,()=>{
    if(created)return;created=true;
    conditions.applyBuff('legacy','attack-stun',1,legacyEffect());
  });
  assert.ok(conditions.snapshot('legacy').every(condition=>condition.remainingMs===1000));
  conditions.update(100);assert.ok(conditions.snapshot('legacy').every(condition=>condition.remainingMs===900));
});

test('legacy callbacks create frame buffs at the completed update phase and owner states follow the frame lifetime',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('legacy','blood-curse',1,{...legacyEffect(),tickMs:100,
    periodic:[{kind:'fixed-damage',amount:1}]});
  conditions.update(175,()=>{
    conditions.remove('legacy');conditions.applyBuff('frame','whist',1,frameEffect(0,{states:['stealthed']}));
  });
  assert.ok(conditions.snapshot('frame').every(condition=>condition.remainingMs===65));
  conditions.update(5);assert.equal(conditions.hasState('frame','stealthed'),true);
  conditions.removeState('frame','stealthed');assert.deepEqual(conditions.snapshot('frame'),[]);
});

test('snapshots restore frame age and remainder independently and accept existing snapshots without a frame clock',()=>{
  const original=new CombatConditions(),restored=new CombatConditions();
  original.applyBuff('target','blood-curse',1,pulseEffect(4,2));original.update(149);
  const saved=original.captureState();restored.restoreState(saved);
  saved.simulationFrameRemainderMs=0;saved.buffs[0][1][0].nextFrameAge=999;
  let originalPulses=0,restoredPulses=0;
  original.update(211,()=>originalPulses++);restored.update(211,()=>restoredPulses++);
  assert.equal(originalPulses,2);assert.equal(restoredPulses,originalPulses);
  assert.deepEqual(restored.captureState(),original.captureState());
  const legacy=new CombatConditions();legacy.applyBuff('old','attack-stun',1,legacyEffect());
  const oldState=legacy.captureState();delete oldState.simulationFrameRemainderMs;
  restored.restoreState(oldState);restored.update(999);assert.equal(restored.hasState('old','stun'),true);
  restored.update(1);assert.equal(restored.hasState('old','stun'),false);
});
