import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { Session } from '../src/domain/session.ts';
import { SummonLifecycle } from '../src/domain/summon-lifecycle.ts';
import { WorldEnemyRoster } from '../src/domain/world-enemies.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldMap } from '../src/domain/content.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
hook.deregister();

const campaign = JSON.parse(readFileSync(new URL('../public/content/campaign.json', import.meta.url), 'utf8')) as Campaign;

test('roster refresh only syncs the arena projection and keeps the new roster identity', () => {
  const map = { id: 'breakable-map', breakableSpawn: 'jar', enemySpawns: [
    { id: 'slot', enemyId: 'enemy-base', x: 0, y: 0, breakableEligible: true }
  ] } as unknown as WorldMap;
  let questIds = new Set<string>();
  const roster = new WorldEnemyRoster(new Session(campaign), map, [], 1,
    { snapshot: () => ({ revision: questIds.size, ids: questIds }) }, () => 0);
  assert.equal(roster.source('slot')?.enemyId, 'enemy-jar-1');

  // 任务关键敌人出现：breakableSpawnFor 把同 key 从罐子换回原怪。
  questIds = new Set(['enemy-base']);
  const destroyed: string[] = [], spawned: { key: string; enemyId: string }[] = [];
  const host = Object.setPrototypeOf({
    roster,
    arena: [{ key: 'slot', definition: { id: 'enemy-jar-1' }, visual: { container: {} } }],
    pendingDefeats: new PendingEnemyDefeats(),
    conditions: { remove() {} },
    summons: new SummonLifecycle(),
    partyControllers: new Map(),
    scene: { refreshCombatTarget() {} },
    destroyEnemy: (enemy: { key: string }) => { destroyed.push(enemy.key); },
    spawnEnemy: (placed: { key: string; enemyId: string }) => { spawned.push({ key: placed.key, enemyId: placed.enemyId }); }
  }, WorldCombat.prototype);

  (host as { syncChestEnemies(): void }).syncChestEnemies();

  assert.deepEqual(destroyed, ['slot'], '旧场景实例要被销毁');
  assert.deepEqual(spawned, [{ key: 'slot', enemyId: 'enemy-base' }], '新身份要重新建场景实例');
  assert.equal(roster.enemies.find(enemy => enemy.key === 'slot')?.enemyId, 'enemy-base',
    '消费 refresh diff 时不能把刚加回的名册条目再删掉');
});
