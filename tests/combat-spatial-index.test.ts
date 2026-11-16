import assert from 'node:assert/strict';
import test from 'node:test';
import { CombatSpatialIndex, attackRangeQueryRadius, awarenessRangeQueryRadius, bodyReachFromFoot, quantizedDistanceQueryRadius } from '../src/domain/combat-spatial-index.ts';
import type { Combatant } from '../src/domain/combat.ts';

const box = { x: -8, y: -8, width: 16, height: 16 };

function actor(id: string, x: number, y: number): Combatant {
  return { id, team: id.startsWith('enemy') ? 'hostile' : 'party', position: { x, y }, bounds: box };
}

test('spatial index returns candidates in original order and does not duplicate overlapping circles', () => {
  const candidates = [
    actor('party-a', 0, 0),
    actor('enemy-b', 96, 0),
    actor('enemy-c', 8, 8),
    actor('enemy-d', 200, 0),
  ];
  const index = new CombatSpatialIndex(candidates);
  const result = index.within([
    { x: 0, y: 0, radius: 20 },
    { x: 8, y: 0, radius: 96 }, // 与第一个圆重叠，并覆盖 enemy-b
  ]);
  assert.deepEqual(result.map(candidate => candidate.id), ['party-a', 'enemy-b', 'enemy-c']);
});

test('spatial index includes boundary points and ignores invalid circles', () => {
  const candidates = [actor('party-a', 10, 0), actor('enemy-b', 20, 0)];
  const index = new CombatSpatialIndex(candidates);
  assert.deepEqual(index.within([{ x: 0, y: 0, radius: 10 }]).map(candidate => candidate.id), ['party-a']);
  assert.deepEqual(index.within([{ x: 0, y: 0, radius: Number.NaN }]), []);
  assert.deepEqual(index.within([{ x: 0, y: 0, radius: -1 }]), []);
  assert.deepEqual(index.within([]), []);
  assert.deepEqual(index.within([{ x: 0, y: 0, radius: Number.POSITIVE_INFINITY }]).map(candidate => candidate.id),
    ['party-a', 'enemy-b'], '无限半径退化时仍返回全部候选');
});

test('spatial index matches a full scan for a deterministic set of union circles', () => {
  const candidates = Array.from({ length: 40 }, (_, index) =>
    actor(index % 2 ? `enemy-${index}` : `party-${index}`, (index * 37) % 320 - 80, (index * 53) % 240 - 60));
  const index = new CombatSpatialIndex(candidates);
  const circles = [
    { x: -40, y: -20, radius: 90 },
    { x: 120, y: 60, radius: 130 },
    { x: 40, y: 40, radius: 20 },
  ];
  const expected = candidates.filter(candidate => circles.some(circle =>
    Math.hypot(candidate.position.x - circle.x, candidate.position.y - circle.y) <= circle.radius));
  assert.deepEqual(index.within(circles).map(candidate => candidate.id), expected.map(candidate => candidate.id));
});

test('large query circles fall back to the same ordered result as a full scan', () => {
  const candidates = [actor('enemy-a', -1000, 50), actor('party-b', 0, 0), actor('enemy-c', 900, -50)];
  const index = new CombatSpatialIndex(candidates);
  assert.deepEqual(index.within([{ x: 0, y: 0, radius: 100_000 }]).map(candidate => candidate.id),
    ['enemy-a', 'party-b', 'enemy-c']);
});

test('query radius helpers cover the quantized and rectangle distance rules', () => {
  // 8px 量化距离接受 (70,70)；欧氏距离约 99px，裸半径 96px 会漏掉。
  const quantized = quantizedDistanceQueryRadius(96);
  assert.ok(quantized >= Math.hypot(70, 70));
  // floor(距离/8) <= 12 接受量化距离 103；最坏坐标差 103，真实圆心距小于 104·√2。
  assert.ok(awarenessRangeQueryRadius(12) >= Math.hypot(104, 104));
  assert.ok(quantizedDistanceQueryRadius(200) >= Math.hypot(201, 201));
  // 攻击距离 4 点（含 2 点基础值）允许两轴各不到 24px 的间隙，再叠加上双方身体。
  const ranged = attackRangeQueryRadius(4, box);
  assert.ok(ranged >= Math.hypot(24 + bodyReachFromFoot(box) * 2, 24 + bodyReachFromFoot(box) * 2));
});
