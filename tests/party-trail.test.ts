import assert from 'node:assert/strict';
import test from 'node:test';
import { PARTY_TRAIL_MAX_POINTS, PartyTrail } from '../src/domain/party-trail.ts';

test('the trail stores points at a fixed spacing and measures behind the newest point',()=>{
  const trail=new PartyTrail();
  trail.record({x:0,y:0});
  trail.record({x:4,y:0});
  assert.equal(trail.length,1,'不足一个间距不新建点');
  trail.record({x:8,y:0});
  assert.equal(trail.length,2);
  assert.deepEqual(trail.pointBehind(4),{x:4,y:0});
  assert.deepEqual(trail.pointBehind(12),{x:0,y:0},'路径不够长时返回最旧点');
});

test('a frame that moves several spacings fills the intermediate points',()=>{
  const trail=new PartyTrail();
  trail.record({x:0,y:0});
  trail.record({x:32,y:0});
  assert.equal(trail.length,5);
  assert.deepEqual(trail.pointBehind(12),{x:20,y:0});
  assert.deepEqual(trail.pointBehind(0),{x:32,y:0});
});

test('the trail is capped and a teleport resets it instead of drawing a straight line',()=>{
  const trail=new PartyTrail();
  for(let index=0;index<PARTY_TRAIL_MAX_POINTS+20;index++)trail.record({x:index*8,y:0});
  assert.equal(trail.length,PARTY_TRAIL_MAX_POINTS);
  trail.reset({x:1000,y:1000});
  trail.record({x:2000,y:1000});
  assert.equal(trail.length,1,'跨得太远视为传送，不补中间点');
  assert.deepEqual(trail.pointBehind(24),{x:2000,y:1000});
});

test('reset without a point clears the path',()=>{
  const trail=new PartyTrail();
  trail.record({x:0,y:0});
  trail.reset();
  assert.equal(trail.length,0);
  assert.equal(trail.pointBehind(8),undefined);
});
