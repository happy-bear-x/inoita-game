import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { Session, DEFAULT_ENEMY_RESPAWN_MS } from '../src/domain/session.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { rollQuestDrops, type DropCatalog } from '../src/domain/drops.ts';
import type { WorldMap } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';

const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}`, import.meta.url), 'utf8'));
const campaign = read('campaign.json') as Campaign;
const drops = read('drops.json') as DropCatalog;

test('death completion cannot settle twice through a repeated hit or a reentrant scene shutdown', () => {
  const pending = new PendingEnemyDefeats();
  let rewards = 0;
  assert.equal(pending.add('enemy', render => {
    assert.equal(render, true);
    rewards++;
    pending.flush();
    pending.complete('enemy');
  }), true);
  assert.equal(pending.add('enemy', () => { rewards += 100; }), false);
  assert.equal(rewards, 0);
  pending.complete('enemy');
  pending.complete('enemy');
  pending.flush();
  assert.equal(rewards, 1);
});

test('leaving during a death retains drops on the source map and starts one respawn timer', () => {
  const session = new Session(campaign);
  const map = read('maps/shadow-forest-west.json') as WorldMap;
  const roster = new WorldEnemyRoster(session, map, [], 1);
  const spawn = roster.spawns[0];
  const definition = read('battle.json').enemies.find((enemy: {id: string}) => enemy.id === spawn.enemyId);
  roster.setEnemyHealth(spawn.id, 0, definition);
  const pending = new PendingEnemyDefeats();
  pending.add(spawn.id, render => {
    assert.equal(render, false);
    session.enemyDefeated(spawn);
    groundLootFor(session).add(map.id, 80, 90, [{kind: 'money', amount: 7}]);
    roster.removeEnemy(spawn.id);
  });
  assert.deepEqual(roster.refresh(), {added: [], removed: []});
  assert.equal(roster.enemySnapshot(spawn.id, definition)?.health, 0);
  pending.flush();
  pending.complete(spawn.id);
  assert.equal(groundLootFor(session).forMap(map.id).length, 1);
  assert.equal(groundLootFor(session).forMap('shadow-camp').length, 0);
  assert.equal(new WorldEnemyRoster(session, map, [], 1).enemies.some(enemy => enemy.key === spawn.id), false);
  session.advanceGameTime(DEFAULT_ENEMY_RESPAWN_MS);
  assert.ok(roster.refresh().added.some(enemy => enemy.key === spawn.id));
});

test('a pending quest enemy gives its material once when shutdown precedes animation completion', () => {
  const session = new Session(campaign);
  // 首章三连走到能接 knight-uniform：格里普顿是击杀目标，另两条按交付对话结束。
  session.accept('grafton-mission'); session.enemyDefeated({ id: 'earl', enemyId: 'enemy-earl-grafton-1', x: 0, y: 0 }); session.complete('grafton-mission');
  session.accept('cardinal-summons'); session.complete('cardinal-summons');
  session.accept('meet-portia'); session.complete('meet-portia');
  assert.equal(session.accept('knight-uniform'), true);
  // 任务材料当前由普通怪按原版严格概率掉落、落地后拾取（生成点与边界见 quest-drops.test.ts）。
  const dungeon = read('maps/shadow-training-dungeon-2-a6b8293b.json') as WorldMap;
  const spawn = dungeon.enemySpawns!.find(spawn => spawn.enemyId === 'enemy-reagents-1')!;
  const store = groundLootFor(session);
  const pending = new PendingEnemyDefeats();
  pending.add(spawn.id, render => {
    // 场景在倒下动画播完前关闭：结算以 render=false 冲刷，材料照旧只掉一份。
    assert.equal(render, false);
    session.enemyDefeated(spawn);
    store.add(dungeon.id, spawn.x, spawn.y, rollQuestDrops(drops, spawn.enemyId, session.questDropRequirements(), () => 0));
  });
  assert.deepEqual(store.forMap(dungeon.id), []);
  pending.flush(); pending.complete(spawn.id); pending.flush();
  assert.equal(store.forMap(dungeon.id).length, 1);
  assert.equal(session.canRespawnEnemy(spawn), false);
  store.collectNearby(dungeon.id, spawn.x, spawn.y, reward => { if (reward.kind === 'item') session.bag.add(reward.item, reward.quantity); });
  assert.equal(session.itemCount('ectoplasm'), 1);
  assert.deepEqual(store.forMap(dungeon.id), []);
});
