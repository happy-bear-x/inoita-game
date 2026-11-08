import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type Phaser from 'phaser';
import { GAME_FRAME_TIMING, installFrameLimitClock } from '../src/application/game-timing.ts';
import { CombatClock } from '../src/domain/combat-clock.ts';
import { PathBudget } from '../src/domain/path-budget.ts';

const require = createRequire(import.meta.url);
const TimeStep = require('../node_modules/phaser/src/core/TimeStep.js') as typeof Phaser.Core.TimeStep;

function fixture(t: test.TestContext, smoothStep = false) {
  let now = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { performance: { now: () => now }, cancelAnimationFrame() {} } });
  const loop = new TimeStep({} as Phaser.Game, { ...GAME_FRAME_TIMING, smoothStep });
  loop.raf.start = () => {};
  const restore = installFrameLimitClock(loop);
  const steps: { time: number; delta: number }[] = [];
  loop.start((time, delta) => steps.push({ time, delta }));
  const step = (delta: number) => { now += delta; loop.stepLimitFPS(now); };
  t.after(() => {
    restore(); loop.destroy();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { loop, steps, step, restore, skip: (delta: number) => { now += delta; } };
}

test('limited real TimeStep counts each millisecond once across refresh changes and long frames', t => {
  const f = fixture(t);
  for (const hz of [144, 90, 30, 120, 59.94, 60]) {
    for (let i = 0; i < hz * 2; i++) f.step(1000 / hz);
    f.step(80);
    f.step(600);
    const last = f.steps.at(-1)!;
    const elapsed = f.steps.reduce((sum, step) => sum + step.delta, 0);
    assert.ok(Math.abs(elapsed - last.time) < 1e-7, `${hz} Hz clock drift: ${elapsed} / ${last.time}`);
    assert.ok(f.steps.every(step => step.delta > 0), 'every delivered interval must advance time');
  }
});

test('focus and background recovery clear already-counted limiter remainder', t => {
  const f = fixture(t);
  f.step(20);
  f.skip(2000); f.loop.pause();
  f.skip(3000); f.loop.resume();
  f.step(20);
  f.skip(1000); f.loop.focus(); f.step(20);
  assert.deepEqual(f.steps.map(step => step.delta), [20, 20, 20]);
});

test('low refresh startup keeps real elapsed time while Phaser smooths its scheduling delta', t => {
  const f = fixture(t, true);
  for (let i = 0; i < 60; i++) f.step(1000 / 30);
  const last = f.steps.at(-1)!;
  assert.ok(Math.abs(f.steps.reduce((sum, step) => sum + step.delta, 0) - last.time) < 1e-7);
  assert.ok(last.time >= 1900, 'startup must advance approximately two real seconds');
});

test('restoring the adapter restores instance methods without changing other game loops', t => {
  const f = fixture(t), untouched = new TimeStep({} as Phaser.Game, GAME_FRAME_TIMING);
  assert.notEqual(f.loop.start, untouched.start);
  assert.notEqual(f.loop.resetDelta, untouched.resetDelta);
  f.restore();
  assert.equal(f.loop.start, untouched.start);
  assert.equal(f.loop.resetDelta, untouched.resetDelta);
  untouched.destroy();
});

test('switching limits on the running Phaser loop preserves elapsed time and takes effect', t => {
  const f = fixture(t, true);
  const counts:number[]=[];
  for (const limit of [30,60,120,60] as const) {
    f.loop.setFPSLimit(limit);
    const before=f.steps.length;
    for (let i=0;i<1200;i++) f.step(1000/120);
    counts.push(f.steps.length-before);
    const last=f.steps.at(-1)!;
    assert.ok(Math.abs(f.steps.reduce((sum,step)=>sum+step.delta,0)-last.time)<1e-6);
  }
  assert.ok(Math.abs(counts[0]!-300)<=2,`30 FPS: ${counts[0]}`);
  assert.ok(Math.abs(counts[1]!-600)<=2,`60 FPS: ${counts[1]}`);
  assert.ok(counts[2]!>=1195,`120 FPS: ${counts[2]}`);
  assert.ok(Math.abs(counts[3]!-600)<=2,`60 FPS: ${counts[3]}`);
  f.skip(1000); f.loop.pause(); f.skip(1000); f.loop.resume();
  const before=f.steps.length;
  for(let i=0;i<4;i++)f.step(1000/120);
  assert.ok(f.steps.slice(before).every(step=>step.delta<50),'暂停时间不应计入游戏');
});

test('logic-driven path searches receive the same budget at 30, 60 and 120 FPS', async t => {
  const simulate=async(limit:30|60|120)=>{
    let result: { totals:number[]; frames:number; maxFrame:number } | undefined;
    await t.test(`${limit} FPS`, child=>{
      const f=fixture(child,false),clock=new CombatClock(),budget=new PathBudget(512);
      const totals=[0,0,0,0,0];let maxFrame=0;
      f.loop.setFPSLimit(limit);
      const deliver=f.loop.callback;
      f.loop.callback=(time,delta)=>{
        deliver(time,delta);
        budget.reset();let used=0;
        clock.advance(Math.min(f.steps.at(-1)!.delta,120),()=>{
          for(let i=0;i<totals.length;i++){
            const granted=budget.take(`actor-${i}`,512);
            totals[i]!+=granted;used+=granted;
          }
        });
        maxFrame=Math.max(maxFrame,used);
      };
      for(let i=0;i<1200;i++)f.step(1000/120);
      result={ totals,frames:clock.currentFrame,maxFrame };
    });
    return result!;
  };
  const at30=await simulate(30),at60=await simulate(60),at120=await simulate(120);
  assert.equal(at30.frames,at60.frames);
  assert.deepEqual(at30.totals,at60.totals);
  assert.equal(at60.frames,at120.frames);
  assert.deepEqual(at60.totals,at120.totals);
  assert.ok(at30.maxFrame<=512&&at60.maxFrame<=512&&at120.maxFrame<=512);
  assert.ok(at60.totals.every(total=>total>0));
});

test('a long render frame shares one path budget across both combat steps',()=>{
  const clock=new CombatClock(),budget=new PathBudget(512);
  let steps=0,used=0;
  budget.reset();
  clock.advance(120,()=>{
    steps++;
    for(let i=0;i<5;i++)used+=budget.take(`actor-${i}`,512);
  });
  assert.equal(steps,2);
  assert.equal(used,512);
});
