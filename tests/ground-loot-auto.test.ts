import test from 'node:test';
import assert from 'node:assert/strict';
import { GroundLootStore } from '../src/domain/ground-loot.ts';

test('collectAll takes every drop on the map, including flying magic gems, and leaves other maps alone',()=>{
  const store=new GroundLootStore();
  store.add('camp',10,10,[{kind:'money',amount:5},{kind:'item',item:'potion',quantity:1}]);
  store.add('camp',20,20,[{kind:'item',item:'sword',quantity:1}]);
  store.addFlying('camp',{x:1,y:1},{x:5,y:5,direction:0},'mana-gem',1000);
  store.add('other',10,10,[{kind:'money',amount:9}]);
  const rewards:string[]=[];
  const taken=store.collectAll('camp',reward=>{rewards.push(reward.kind==='money'?'money':'item');});
  assert.equal(taken.length,4);
  assert.equal(rewards.length,4);
  assert.deepEqual(store.forMap('camp'),[]);
  assert.equal(store.forMap('other').length,1,'其他地图的掉落不受影响');
});

test('collectAll keeps a drop when the receiver refuses it',()=>{
  const store=new GroundLootStore();
  store.add('camp',1,1,[{kind:'money',amount:1}]);
  const taken=store.collectAll('camp',()=>false);
  assert.deepEqual(taken,[]);
  assert.equal(store.forMap('camp').length,1);
});

test('collectAll follows the same store snapshot as manual pickup',()=>{
  const store=new GroundLootStore();
  store.add('camp',1,1,[{kind:'money',amount:1}]);
  const restored=new GroundLootStore();
  restored.restoreState(store.captureState());
  assert.equal(restored.collectAll('camp',()=>true).length,1);
  assert.deepEqual(restored.forMap('camp'),[]);
});

test('clearOtherMaps removes ordinary drops elsewhere, keeps retained ones and leaves the current map alone',()=>{
  const store=new GroundLootStore();
  store.add('camp',1,1,[{kind:'money',amount:5}]);
  store.add('mine',2,2,[{kind:'money',amount:7},{kind:'item',item:'quest-piece',quantity:1}]);
  const removed=store.clearOtherMaps('camp',drop=>drop.reward.kind==='item'&&drop.reward.item==='quest-piece');
  assert.equal(removed,1);
  assert.deepEqual(store.forMap('camp').map(drop=>drop.reward),[{kind:'money',amount:5}],'当前地图的普通掉落不受影响');
  assert.deepEqual(store.forMap('mine').map(drop=>drop.reward),[{kind:'item',item:'quest-piece',quantity:1}],'保留判定的掉落留在原图');
});

test('stationary pickup retries only after availability, position or ground contents change',()=>{
  const store=new GroundLootStore();store.add('camp',1,1,[{kind:'money',amount:1}]);
  let attempts=0,accept=false;
  const collect=()=>{attempts++;return accept;};
  for(let frame=0;frame<100;frame++)store.collectNearby('camp',1,1,collect,0);
  assert.equal(attempts,1,'原地且接收条件未变时只尝试一次');
  store.collectNearby('camp',2,1,collect,0);assert.equal(attempts,2);
  accept=true;assert.equal(store.collectNearby('camp',2,1,collect,1).length,1);
  store.add('camp',2,1,[{kind:'money',amount:2}]);
  assert.equal(store.collectNearby('camp',2,1,collect,1).length,1,'新增掉落立即使检查失效');
});

test('flight landing invalidates pickup and restored flights continue independently of settled drops',()=>{
  const original=new GroundLootStore();original.addFlying('camp',{x:0,y:0},{x:1,y:1,direction:0},'gem',100);
  original.add('camp',100,100,Array.from({length:50},()=>({kind:'money' as const,amount:1})));
  const store=new GroundLootStore();store.restoreState(original.captureState());
  assert.equal(store.collectNearby('camp',1,1,()=>true,0).length,0);
  store.advance('camp',50);assert.equal(store.collectNearby('camp',1,1,()=>true,0).length,0);
  store.advance('camp',50);assert.equal(store.collectNearby('camp',1,1,()=>true,0).length,1);
  const state=store.captureState();
  for(let frame=0;frame<100;frame++)store.advance('camp',16);
  assert.deepEqual(store.captureState(),state,'没有飞行物时推进不改地面记录');
});

test('discarded flights cannot reappear or change revisions when their old flight would finish',()=>{
  const store=new GroundLootStore();store.addFlying('camp',{x:0,y:0},{x:1,y:1,direction:0},'gem',100);
  store.collectAll('camp',()=>true);const revision=store.revision;
  store.advance('camp',200);assert.equal(store.revision,revision);assert.deepEqual(store.forMap('camp'),[]);
});
