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
