import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseBattle } from '../src/application/content-validation.ts';

const battle = parseBattle(JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')));

test('every enemy carries the original special rank', () => {
  assert.equal(battle.enemies.length, 553);
  const counts = new Map<number, number>();
  for (const enemy of battle.enemies) {
    assert.ok(enemy.specialRank === 0 || enemy.specialRank === 1 || enemy.specialRank === 2 || enemy.specialRank === 3,
      `${enemy.id} 缺少 specialRank`);
    counts.set(enemy.specialRank, (counts.get(enemy.specialRank) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...counts].sort((a, b) => a[0] - b[0])), { 0: 415, 1: 77, 2: 30, 3: 31 });
});

test('special rank follows the original monster table, not the drop tier', () => {
  const rank = new Map(battle.enemies.map(enemy => [enemy.id, enemy.specialRank]));
  assert.equal(rank.get('enemy-earl-grafton-1'), 3, '原版特殊怪，掉落分层是 normal');
  assert.equal(rank.get('enemy-royal-family-s-knight-1'), 0, '掉落分层是 boss，原版不标记');
  assert.equal(rank.get('enemy-queen-spider-1'), 2);
  assert.equal(rank.get('enemy-shadow-of-darkness-1'), 3);
  assert.equal(rank.get('enemy-boss-skeleton-1'), 1);
});
