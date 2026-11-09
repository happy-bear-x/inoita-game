import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlowField, FlowFieldStore, type FlowFieldQuery, type FlowRoute } from '../src/domain/flow-field.ts';
import type { Point } from '../src/domain/navigation.ts';

const openQuery = (bounds: { x: number; y: number; width: number; height: number }, blocked: (point: Point) => boolean = () => false): FlowFieldQuery => ({
  bounds,
  canStand: point => !blocked(point),
});

function finish(search: ReturnType<typeof createFlowField>, budget = 64): void {
  for (let frame = 0; frame < 10000; frame++) {
    const result = search.step(budget);
    assert.ok(result.expanded <= budget);
    if (result.status === 'complete') return;
  }
  assert.fail('流场没有铺完');
}

function follow(route: FlowRoute, start: Point, goal: Point, limit = 100): Point {
  let current = { ...start };
  for (let step = 0; step < limit; step++) {
    if (Math.hypot(current.x - goal.x, current.y - goal.y) <= 16) return current;
    const next = route.next(current);
    if (!next) return current;
    assert.ok(route.distanceAt(next) < route.distanceAt(current), `每一步都应缩短到目标环的距离：${JSON.stringify(current)} -> ${JSON.stringify(next)}`);
    current = next;
  }
  return current;
}

test('a flow field points every reachable cell toward the goal ring', () => {
  const goal = { x: 56, y: 16 };
  const field = createFlowField(goal, openQuery({ x: 0, y: 0, width: 64, height: 32 }), 8);
  finish(field);
  const arrived = follow(field, { x: 8, y: 16 }, goal);
  assert.ok(Math.hypot(arrived.x - goal.x, arrived.y - goal.y) <= 16, `应走到目标环附近，实际 ${JSON.stringify(arrived)}`);
});

test('a flow field routes around a wall instead of crossing it', () => {
  const goal = { x: 56, y: 24 };
  const blocked = (point: Point) => point.x === 32 && point.y < 48;
  const field = createFlowField(goal, openQuery({ x: 0, y: 0, width: 64, height: 64 }, blocked), 8);
  finish(field);
  let current: Point = { x: 8, y: 24 };
  let crossedWall = false;
  for (let step = 0; step < 100; step++) {
    if (Math.hypot(current.x - goal.x, current.y - goal.y) <= 16) break;
    const next = field.next(current);
    assert.ok(next, `墙中间不能断流：${JSON.stringify(current)}`);
    if (current.x < 32 && next.x > 32) crossedWall = true;
    assert.equal(blocked(next), false, '流场不能指向阻挡格');
    current = next;
  }
  assert.ok(Math.hypot(current.x - goal.x, current.y - goal.y) <= 16, `应绕过墙到达目标环，实际 ${JSON.stringify(current)}`);
  assert.equal(crossedWall, false, '不能直接穿过整堵墙');
});

test('flow field steps respect the node budget and resume next frame', () => {
  const field = createFlowField({ x: 40, y: 24 }, openQuery({ x: 0, y: 0, width: 64, height: 48 }), 8);
  const first = field.step(1);
  assert.equal(first.status, 'pending');
  assert.equal(first.expanded, 1);
  const empty = field.step(0);
  assert.equal(empty.status, 'pending');
  assert.equal(empty.expanded, 0);
  finish(field, 1);
  assert.equal(field.next({ x: 40, y: 24 }), undefined, '目标环内的格子没有下一步');
});

test('the shared store only builds one field after three units request the same target', () => {
  const store = new FlowFieldStore(10000);
  const goal = { x: 56, y: 16 };
  let builds = 0;
  const query = () => {
    builds++;
    return openQuery({ x: 0, y: 0, width: 64, height: 32 });
  };
  assert.equal(store.request('shared', goal, query, 8, 0), undefined);
  assert.equal(store.request('shared', goal, query, 8, 0), undefined);
  const field = store.request('shared', goal, query, 8, 0);
  assert.ok(field, '第三个请求者应开始建场并拿到已完成的场');
  assert.equal(builds, 1, '同一目标只建一张场');
  assert.equal(store.request('shared', goal, query, 8, 60), field, '后续请求复用同一张场');
  assert.equal(builds, 1);
});

test('the shared store rebuilds after the target moves a whole bucket or the field expires', () => {
  const store = new FlowFieldStore(10000);
  const goal = { x: 56, y: 16 };
  let builds = 0;
  const query = () => {
    builds++;
    return openQuery({ x: 0, y: 0, width: 64, height: 32 });
  };
  for (let index = 0; index < 3; index++) store.request('moving', goal, query, 8, 0);
  assert.equal(builds, 1);
  store.request('moving', { x: goal.x + 16, y: goal.y }, query, 8, 60);
  assert.equal(builds, 2, '目标移动 16 像素后重算');
  for (let index = 0; index < 2; index++) store.request('moving', goal, query, 8, 900);
  store.request('moving', goal, query, 8, 900);
  assert.equal(builds, 3, '超过 800 毫秒没有请求后重算');
});

test('a unit budget reset keeps the flow field advancing without a per-unit search', () => {
  const store = new FlowFieldStore(3);
  const query = () => openQuery({ x: 0, y: 0, width: 64, height: 32 });
  const goal = { x: 56, y: 16 };
  let field: FlowRoute | undefined;
  for (let frame = 0; frame < 200 && !field; frame++) {
    store.reset();
    for (let request = 0; request < 3; request++) field = store.request('budgeted', goal, query, 8, frame * 60);
  }
  assert.ok(field, '共享预算每次推进一点，最终也要铺完');
});
