import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {BattleBuffEffect} from '../src/domain/battle.ts';

const pulse:BattleBuffEffect={durationMs:600,tickMs:60,simulationFrames:{lastActiveFrame:9,pulseIntervalFrames:1},
  states:[],modifiers:[],periodic:[{kind:'fixed-damage',amount:1}]};

// 空的增益/状态表会让 update 直接返回、不推进共享余量；用一条长寿命增益让时钟保持推进。
const clockAnchor={durationMs:60000,tickMs:0,states:[],modifiers:[],periodic:[]};

test('standalone state frames begin at the shared next boundary and keep inclusive age zero',()=>{
  const conditions=new CombatConditions();
  conditions.applyBuff('clock','blood-curse',1,clockAnchor);
  conditions.update(17.5);
  assert.equal(conditions.applyStateFrames('target','stun',0,'source'),true);
  assert.equal(conditions.snapshot('target')[0].remainingMs,102.5);
  const before=conditions.captureState();
  for(const delta of [0,-60,NaN,Infinity])conditions.update(delta);
  assert.deepEqual(conditions.captureState(),before);
  conditions.update(42.5);assert.equal(conditions.hasState('target','stun'),true);
  conditions.update(59);assert.equal(conditions.snapshot('target')[0].remainingMs,1);
  conditions.update(1);assert.equal(conditions.hasState('target','stun'),false);
  for(const invalid of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>conditions.applyStateFrames('target','stun',invalid),/非负整数/);
});

test('each frame expires states before buff pulses and new callback states wait until the next boundary',()=>{
  const conditions=new CombatConditions(),canAct:boolean[]=[];
  conditions.applyStateFrames('target','sleep',0);
  conditions.applyBuff('target','blood-curse',1,pulse);
  conditions.update(180,()=>{
    canAct.push(conditions.canAct('target'));
    if(canAct.length===2)conditions.applyStateFrames('target','stun',0,'new-source');
  });
  assert.deepEqual(canAct,[false,true,false]);
  const current=conditions.captureState().states[0][1][0];
  assert.equal(current.id,'stun');assert.equal(current.nextFrameAge,1);
  assert.equal(current.remainingMs,60);
  conditions.update(60);assert.equal(conditions.canAct('target'),true);
});

test('long frame updates match split updates when periodic callbacks refresh a state',()=>{
  const run=(deltas:number[])=>{
    const conditions=new CombatConditions();conditions.update(13.25);
    conditions.applyBuff('target','blood-curse',1,pulse);let hits=0;
    for(const delta of deltas)conditions.update(delta,()=>{
      hits++;if(hits===1||hits===4)conditions.applyStateFrames('target','stun',2,`hit-${hits}`);
    });
    return {hits,saved:conditions.captureState(),visible:conditions.snapshot('target')};
  };
  assert.deepEqual(run([461.5]),run([6.75,40,200,214.75]));
});

test('callbacks create legacy states without consuming the entire current render delta',()=>{
  const conditions=new CombatConditions();let created=false;
  conditions.applyBuff('source','blood-curse',1,pulse);
  conditions.update(175,()=>{
    if(created)return;created=true;conditions.applyState('target','stun',1000);
  });
  assert.equal(conditions.snapshot('target')[0].remainingMs,1000);
  conditions.update(100);assert.equal(conditions.snapshot('target')[0].remainingMs,900);
});

test('state snapshots preserve independent ages, source ownership and the shared remainder',()=>{
  const original=new CombatConditions(),restored=new CombatConditions();
  original.applyBuff('clock','blood-curse',1,clockAnchor);
  original.update(13.25);
  original.applyBuff('target','attack-stun',1,{...pulse,states:['stun']},'source',()=>({lastActiveFrame:4}));
  original.applyState('target','sleep',1000,'other');original.update(129.5);
  const saved=original.captureState();restored.restoreState(saved);
  saved.states[0][1][0].nextFrameAge=999;saved.states[0][1][0].sourceId='changed';saved.simulationFrameRemainderMs=0;
  original.update(141);restored.update(141);
  assert.deepEqual(restored.captureState(),original.captureState());
  original.update(76.25);restored.update(76.25);
  assert.deepEqual(restored.captureState(),original.captureState());
  assert.equal(restored.hasState('target','stun'),false);
  assert.equal(restored.hasBuff('target','attack-stun'),true);
  assert.equal(restored.hasState('target','sleep'),true);
});
