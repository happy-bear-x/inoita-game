import test from 'node:test';
import assert from 'node:assert/strict';
import {ThreatLedger,THREAT_CAPACITY,calculateDamageThreat,calculateHealingThreat,calculateStateThreat,reduceThreat} from '../src/domain/combat-threat.ts';

test('damage threat uses supplied overkill damage and truncates distance reduction before generation rate',()=>{
  assert.equal(calculateDamageThreat({damage:7,rectangleDistanceUnits:30,generationRate:1500}),10);
  assert.equal(calculateDamageThreat({damage:7,rectangleDistanceUnits:31,generationRate:1500}),7);
  assert.equal(calculateDamageThreat({damage:100,rectangleDistanceUnits:0}),100);
  for(const damage of [0,-5])assert.equal(calculateDamageThreat({damage,rectangleDistanceUnits:0}),0);
  assert.equal(calculateDamageThreat({damage:100,rectangleDistanceUnits:0,generationRate:-1}),0);
});

test('actual healing uses the near 20 and far 15 constants and keeps signed or zero HP differences',()=>{
  assert.equal(calculateHealingThreat({actualHealing:101,rectangleDistanceUnits:30}),2);
  assert.equal(calculateHealingThreat({actualHealing:101,rectangleDistanceUnits:31}),1);
  assert.equal(calculateHealingThreat({actualHealing:101,rectangleDistanceUnits:30,generationRate:1500}),3);
  assert.equal(calculateHealingThreat({actualHealing:0,rectangleDistanceUnits:0}),0);
  assert.equal(calculateHealingThreat({actualHealing:-101,rectangleDistanceUnits:0}),-2);
  assert.equal(calculateHealingThreat({actualHealing:100,rectangleDistanceUnits:0,generationRate:-1}),0);
});

test('successful direct state threat scales caster level and generation rate with one division',()=>{
  assert.equal(calculateStateThreat({casterLevel:3}),6);
  assert.equal(calculateStateThreat({casterLevel:3,generationRate:333}),1);
  assert.equal(calculateStateThreat({casterLevel:3,generationRate:1500}),9);
  assert.equal(calculateStateThreat({casterLevel:3,generationRate:-1}),0);
});

test('source reduction handles negative increments and rates above one hundred percent without clamping',()=>{
  assert.equal(reduceThreat(7,500),4);
  assert.equal(reduceThreat(-7,500),-4);
  assert.equal(reduceThreat(7,1500),-3);
  assert.equal(reduceThreat(7,-500),7);
  assert.equal(reduceThreat(0,1500),0);
  assert.equal(reduceThreat(-7,1000),0);
});

test('multiplication and score addition retain native signed 32-bit arithmetic',()=>{
  assert.equal(calculateDamageThreat({damage:3000000,rectangleDistanceUnits:0}),-1294967);
  const ledger=new ThreatLedger();
  ledger.add('enemy','hero',2147483647,1);ledger.add('enemy','hero',1,2);
  assert.equal(ledger.score('enemy','hero'),-2147483648);
});

test('zero and negative additions create entries and refresh timestamps until a decay pass removes them',()=>{
  const ledger=new ThreatLedger();
  assert.equal(ledger.add('enemy','hero',0,1),true);
  assert.equal(ledger.add('enemy','hero',-7,2,{sourceReductionRate:500}),true);
  assert.deepEqual(ledger.entries(),[{ownerId:'enemy',sourceId:'hero',score:-4,updatedTick:2}]);
  assert.equal(ledger.select('enemy',undefined,()=>true),'hero');
  ledger.decay(()=>false);
  assert.equal(ledger.score('enemy','hero'),undefined);
  ledger.add('enemy','first-zero',0,3);ledger.add('enemy','second-zero',0,3);
  assert.equal(ledger.select('enemy',undefined,()=>true),'first-zero');
  ledger.clear();
  ledger.add('enemy','more-negative',-20,4);ledger.add('enemy','less-negative',-5,4);
  assert.equal(ledger.select('enemy',undefined,()=>true),'less-negative');
});

test('taunt source restriction rejects both new and existing other sources without refreshing or evicting',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','hero',100,1);ledger.add('enemy','ally',50,2);
  const saved=ledger.captureState();
  const rules={allowedSourceId:'hero',sourceReductionRate:500};
  assert.equal(ledger.add('enemy','ally',100,100,rules),false);
  assert.equal(ledger.add('enemy','new-ally',100,100,rules),false);
  assert.deepEqual(ledger.captureState(),saved);
  assert.equal(ledger.add('enemy','hero',10,100,rules),true);
  assert.equal(ledger.score('enemy','hero'),105);
  assert.equal(ledger.add('enemy','ally',10,101),true);
  assert.equal(ledger.score('enemy','ally'),60);
});

test('capacity is shared across owners and evicts the oldest update with first-slot ties and last-slot compaction',()=>{
  const ledger=new ThreatLedger();
  for(let index=0;index<THREAT_CAPACITY;index++)ledger.add(`enemy-${index%2}`,`source-${index}`,10,1);
  ledger.add('enemy-0','source-0',0,2);
  assert.equal(ledger.add('new-enemy','new-source',20,3,{allowedSourceId:'blocked'}),false);
  assert.equal(ledger.entries().length,THREAT_CAPACITY);
  ledger.add('new-enemy','new-source',20,3);
  assert.equal(ledger.score('enemy-1','source-1'),undefined);
  assert.equal(ledger.score('enemy-0','source-0'),10);
  assert.equal(ledger.entries()[1].sourceId,`source-${THREAT_CAPACITY-1}`);
  assert.equal(ledger.entries()[THREAT_CAPACITY-1].sourceId,'new-source');
  ledger.add('another-enemy','another-source',20,4);
  assert.equal(ledger.score('enemy-1',`source-${THREAT_CAPACITY-1}`),undefined);
  assert.equal(ledger.entries()[1].sourceId,'new-source');
});

test('highest only considers eligible sources and raiseTo lifts without lowering',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','hero',40,1);ledger.add('enemy','ally',90,2);ledger.add('enemy','summon',10,3);
  assert.equal(ledger.highest('enemy',id=>id!=='ally'),40);
  assert.equal(ledger.highest('enemy',id=>id==='missing'),undefined);
  assert.equal(ledger.raiseTo('enemy','summon',80,4),true);
  assert.equal(ledger.score('enemy','summon'),80);
  assert.equal(ledger.raiseTo('enemy','summon',60,5),false);
  assert.equal(ledger.entries('enemy').find(entry=>entry.sourceId==='summon')!.updatedTick,4,'降低分数不刷新更新时间');
  assert.equal(ledger.raiseTo('enemy','new',120,6),true);
  assert.equal(ledger.score('enemy','new'),120);
  assert.throws(()=>ledger.raiseTo('enemy','new',-1,7));
  assert.throws(()=>ledger.raiseTo('enemy','new',1.5,7));
});

test('raiseTo creates entries through the shared capacity rule',()=>{
  const ledger=new ThreatLedger();
  for(let index=0;index<THREAT_CAPACITY;index++)ledger.add('enemy',`source-${index}`,1,index);
  assert.equal(ledger.raiseTo('enemy','arrival',500,THREAT_CAPACITY),true);
  assert.equal(ledger.score('enemy','source-0'),undefined,'最旧条目被驱逐');
  assert.equal(ledger.entries().length,THREAT_CAPACITY);
  assert.equal(ledger.score('enemy','arrival'),500);
});

test('owner clearing and actor departure have distinct scopes and process swapped-in records',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','hero',10,1);ledger.add('other','enemy',20,1);
  ledger.add('third','ally',30,1);ledger.add('enemy','ally',40,1);
  ledger.clearOwner('enemy');
  assert.deepEqual(ledger.entries().map(entry=>[entry.ownerId,entry.sourceId]),[['third','ally'],['other','enemy']]);
  ledger.removeActor('enemy');
  assert.deepEqual(ledger.entries().map(entry=>entry.ownerId),['third']);
  ledger.clear();assert.deepEqual(ledger.entries(),[]);
});

test('decay occurs only beyond sight, removes all nonpositive records and visits swapped entries in the same pulse',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','equal-range',100,1);ledger.add('enemy','far-expired',20,2);
  ledger.add('enemy','near-zero',0,3);ledger.add('enemy','far-survives',43,4);
  const ranges=new Map([['equal-range',8],['far-expired',9],['near-zero',2],['far-survives',9]]);
  const seen:string[]=[];
  ledger.decay((_owner,source)=>{seen.push(source);return ranges.get(source)!>8;});
  assert.deepEqual(seen,['equal-range','far-expired','far-survives','near-zero']);
  assert.deepEqual(ledger.entries(),[
    {ownerId:'enemy',sourceId:'equal-range',score:100,updatedTick:1},
    {ownerId:'enemy',sourceId:'far-survives',score:11,updatedTick:4},
  ]);
  ledger.decay((_owner,source)=>ranges.get(source)!>8);
  assert.equal(ledger.score('enemy','far-survives'),undefined);
});

test('selection switches at the truncated 110 percent boundary and otherwise keeps current target',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','hero',101,1);ledger.add('enemy','ally',110,1);
  assert.equal(ledger.select('enemy','hero',()=>true),'hero');
  ledger.add('enemy','ally',1,2);
  assert.equal(ledger.select('enemy','hero',()=>true),'ally');
  assert.equal(ledger.select('enemy','untracked-current',()=>true),'ally');
  assert.equal(ledger.select('empty','untracked-current',()=>true),'untracked-current');
  assert.equal(ledger.select('empty',undefined,()=>true),undefined);
});

test('equal maximum follows the owner index order while host target eligibility leaves invisible entries in the ledger',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','leaving',100,1);ledger.add('enemy','hero',100,1);ledger.add('enemy','ally',100,1);
  assert.equal(ledger.select('enemy',undefined,()=>true),'leaving');
  ledger.removeActor('leaving');
  // 同分时按 owner 索引的插入顺序取第一个；删除 leaving 不会把 ally 提到前面。
  assert.equal(ledger.select('enemy',undefined,()=>true),'hero');
  const before=ledger.captureState();
  assert.equal(ledger.select('enemy',undefined,source=>source!=='ally'),'hero');
  assert.equal(ledger.select('enemy',undefined,()=>false),undefined);
  assert.deepEqual(ledger.captureState(),before);
  assert.equal(ledger.select('enemy',undefined,()=>true),'hero');
});

test('taunt clamps only same-faction competitors after the caster entry exists without changing timestamps',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','high',200,1);ledger.add('enemy','low',20,2);
  ledger.add('enemy','neutral',300,3);ledger.add('other-enemy','high',300,4);
  assert.equal(ledger.clampCompetitors('enemy','hero',()=>true),false);
  ledger.add('enemy','hero',101,5);
  assert.equal(ledger.clampCompetitors('enemy','hero',source=>source!=='neutral'),true);
  assert.equal(ledger.score('enemy','hero'),101);
  assert.equal(ledger.score('enemy','high'),80);
  assert.equal(ledger.score('enemy','low'),20);
  assert.equal(ledger.score('enemy','neutral'),300);
  assert.equal(ledger.score('other-enemy','high'),300);
  assert.equal(ledger.entries('enemy').find(entry=>entry.sourceId==='high')?.updatedTick,1);
});

test('a second taunter without an entry is blocked while an existing competitor can clamp and replace the state source',()=>{
  const ledger=new ThreatLedger();
  ledger.add('enemy','first',100,1);ledger.add('enemy','second',80,1);
  assert.equal(ledger.add('enemy','newcomer',200,2,{allowedSourceId:'first'}),false);
  assert.equal(ledger.clampCompetitors('enemy','newcomer',()=>true),false);
  assert.equal(ledger.clampCompetitors('enemy','second',()=>true),true);
  assert.equal(ledger.score('enemy','first'),64);
  // 状态接受与否由宿主决定；已完成的压低不回滚。
  assert.equal(ledger.add('enemy','second',10,3,{allowedSourceId:'first'}),false);
  assert.equal(ledger.score('enemy','first'),64);
  assert.equal(ledger.add('enemy','second',10,4,{allowedSourceId:'second'}),true);
});

test('snapshots and reads are detached and restoration preserves order, signed scores and eviction timestamps',()=>{
  const ledger=new ThreatLedger();
  for(let index=0;index<THREAT_CAPACITY;index++)ledger.add('enemy',`source-${index}`,index-1,index);
  const saved=ledger.captureState(),restored=new ThreatLedger();restored.restoreState(saved);
  saved.entries[0].score=999;saved.entries.reverse();
  const read=restored.entries();(read[0] as {score:number}).score=888;read.reverse();
  assert.deepEqual(restored.captureState(),ledger.captureState());
  restored.add('other','new',1,100);
  assert.equal(restored.score('enemy','source-0'),undefined);
  assert.equal(restored.entries()[0].sourceId,`source-${THREAT_CAPACITY-1}`);
  assert.equal(ledger.score('enemy','source-0'),-1);
});

test('invalid or duplicate snapshot records are rejected atomically',()=>{
  const ledger=new ThreatLedger();ledger.add('enemy','hero',10,1);
  const saved=ledger.captureState(),entry=saved.entries[0];
  for(const entries of [[entry,{...entry}],[{...entry,score:NaN}],[{...entry,updatedTick:-1}],
    Array.from({length:THREAT_CAPACITY+1},(_,index)=>({...entry,sourceId:String(index)}))]){
    assert.throws(()=>ledger.restoreState({entries}));
    assert.deepEqual(ledger.captureState(),saved);
  }
  assert.throws(()=>ledger.add('enemy','ally',0.5,1));
  assert.throws(()=>ledger.add('enemy','ally',1,NaN));
  assert.throws(()=>calculateStateThreat({casterLevel:-1}));
});
