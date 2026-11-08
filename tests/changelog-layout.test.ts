import assert from 'node:assert/strict';
import test from 'node:test';
import { changelogMetrics, changelogVisibleRange } from '../src/ui/changelog-layout.ts';

test('changelog entries leave one gap between neighbours, none after the last',()=>{
  const metrics=changelogMetrics([100,50,80],10);
  assert.deepEqual(metrics.offsets,[0,110,170]);
  assert.equal(metrics.total,250,'100 + 10 + 50 + 10 + 80');
});

test('only the visible window plus overscan is rendered',()=>{
  const heights=Array.from({length:20},()=>100);
  const {offsets,total}=changelogMetrics(heights,0);
  assert.equal(total,2000);
  const range=changelogVisibleRange(offsets,heights,800,300,0);
  assert.deepEqual(range,{first:8,last:10},'视口 800…1100 覆盖第 9–11 条');
  assert.deepEqual(changelogVisibleRange(offsets,heights,0,200,0),{first:0,last:1});
  assert.deepEqual(changelogVisibleRange([],[],0,300),{first:0,last:-1});
});
