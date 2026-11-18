import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import { CombatConditions } from '../src/domain/combat-conditions.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { BREAKABLE_ENEMY_IDS, breakableKindOf, parseDrops, rollBreakableLoot } from '../src/domain/drops.ts';
import type { ItemCatalog } from '../src/domain/items.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
hook.deregister();

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const items = read<ItemCatalog>('items');
const battle = read<BattleCatalog>('battle');
const stats = read<CharacterStatsCatalog>('character-stats');
const catalog = parseDrops(read<Record<string, unknown>>('drops'), items, battle.enemies.map(enemy => enemy.id));

test('breakable enemy ids map exactly, without substring matching', () => {
  assert.equal(breakableKindOf(BREAKABLE_ENEMY_IDS.bush), 'bush');
  assert.equal(breakableKindOf(BREAKABLE_ENEMY_IDS.jar), 'jar');
  assert.equal(breakableKindOf(BREAKABLE_ENEMY_IDS.box), 'box');
  assert.equal(breakableKindOf('enemy-bush-scorpion-1'), undefined);
  assert.equal(breakableKindOf('enemy-box-mimic-1'), undefined);
});

test('breakable loot is not suppressed by an overleveled hero', () => {
  const data=structuredClone(catalog);
  const rule=data.breakables!.jar!;
  for(const slot of Object.keys(rule.chances) as (keyof typeof rule.chances)[])rule.chances[slot]=0;
  rule.chances.money=9000;rule.uniqueChance.numerator=0;delete rule.spawn;
  assert.equal(rollBreakableLoot(data,stats,'jar',1,100,()=>0.05).rewards.length,1);
});

test('breakable loot uses the same rolled result shape as a chest', () => {
  const result = rollBreakableLoot(catalog, stats, 'jar', 5, 10, () => 0, {});
  assert.ok(Array.isArray(result.rewards));
  assert.ok(Array.isArray(result.enemies));
  for (const reward of result.rewards) {
    if (reward.kind === 'item') assert.equal(reward.quantity, 1);
  }
});

test('a defeated breakable opens one death ticket and reports its settlement', t => {
  t.mock.method(Math, 'random', () => 0);
  let syncs = 0;
  const removals: string[] = [], settled: Record<string, unknown>[] = [];
  const session = {
    isOneHitKill: () => false,
    settleEnemyDefeat: (input: Record<string, unknown>) => {
      settled.push(input);
      return { settlement: { isBreakable: true }, levelledIds: [], notify() {} };
    }
  };
  const enemy = battle.enemies.find(value => value.id === BREAKABLE_ENEMY_IDS.jar)!;
  const spawn = { id: 'spawn', enemyId: enemy.id, x: 10, y: 20, breakableEligible: true };
  const target = { key: spawn.id, definition: enemy,
    visual: { container: { x: 10, y: 20, active: true, disableInteractive() {} } }, presenter: { clear() {} } };
  const hero = { level: 10 };
  let enemyHealth = 1;
  const roster = {
    isPresent: () => true,
    enemySnapshot: () => ({ health: enemyHealth, maxHealth: 1000, level: 1, elite: false }),
    source: () => spawn, setEnemyHealth: (_key: string, value: number) => { enemyHealth = value; }
  };
  const scene = { map: { id: 'breakable-map', lootLevel: 0 }, refreshCombatTarget() {}, refreshGroundLoot() {}, lootLanding: () => ({ x: 10, y: 20 }) };
  const host = Object.setPrototypeOf({
    app: { session, characterStats: stats, audio: { monsterDeath() {} }, director: { healthChanged: () => false } },
    drops: catalog, conditions: new CombatConditions(), hitResolution: new CombatHitResolution(),
    pendingDefeats: new PendingEnemyDefeats(), roster, scene, hero, arena: [],
    memberOf: (id: string) => id === 'player' ? { player: { health: 100 }, level: 10 } : undefined,
    removeEnemy: (key: string) => { removals.push(key); }, syncChestEnemies: () => { syncs += 1; },
    outcomes: { cancelDeath() {}, vanish() {}, levelUp() {} },
    runtime: { cancel() {}, schedule() {} }, movement: { stop() {}, setEnabled() {} },
    partyControllers: new Map(), showHit() {}
  }, WorldCombat.prototype);
  Reflect.get(WorldCombat.prototype, 'settleHit').call(host,
    { casterId: 'player', targetId: spawn.id }, { damage: 5 }, hero, target);
  host.pendingDefeats.flush();

  assert.equal(settled.length, 1, '一次击杀只开一张死亡单');
  const input = settled[0]!;
  assert.equal(input.key, spawn.id);
  assert.equal(input.spawn, spawn);
  assert.equal(input.map, 'breakable-map');
  assert.equal(input.enemyLevel, 1);
  assert.equal(input.earnsExperience, true, '由队伍命中，经验由奖励层按景物怪规则决定');
  assert.equal(input.drops, catalog);
  assert.deepEqual(removals, [spawn.id]);
  assert.equal(syncs, 1, '景物结算后同步衍生怪');
});
