import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
const { WorldScene } = await import('../src/scenes/world-scene.ts');
hook.deregister();

const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;

function combatHost(overrides: Record<string, unknown> = {}) {
  return Object.setPrototypeOf({
    closed: false, defeated: false, movement: {}, arena: [], pendingDefeats: new PendingEnemyDefeats(),
    app: { battleCatalog: battle, session: { party: { activeIds: [] } } },
    ...overrides
  }, WorldCombat.prototype) as {
    closed: boolean; defeated: boolean; arena: unknown[]; app: unknown;
    spawnPressureEnemy(enemyId?: string): boolean;
    reviveFallenForPressure(): void;
  };
}

test('压测刷怪达到上限后不再生成', () => {
  const host = combatHost({ arena: Array.from({ length: 40 }, (_, index) => ({ key: `enemy-${index}` })) });
  assert.equal(host.spawnPressureEnemy(), false);
});

test('压测阵亡只补满倒下的成员，全灭入口不进入阵亡状态', () => {
  const revived: string[] = [];
  const host = combatHost({
    app: { pressureMode: true, battleCatalog: battle, session: { party: { activeIds: ['player', 'ally'] } } },
    memberOf: (id: string) => ({ player: { health: id === 'player' ? 0 : 100 } }),
    scene: { reviveMember: (id: string) => { revived.push(id); return { ok: true }; } }
  });
  host.reviveFallenForPressure();
  assert.deepEqual(revived, ['player']);

  const playerDefeated = Reflect.get(WorldCombat.prototype, 'playerDefeated') as (this: unknown) => void;
  playerDefeated.call(host);
  assert.equal(host.defeated, false, '压测全灭不进入 defeated');
  assert.deepEqual(revived, ['player', 'player'], '全灭入口会再次尝试补满倒下成员');
});

test('压测模式拒绝手动存档和检查点', () => {
  const host = Object.setPrototypeOf({ app: { pressureMode: true }, session: {} }, WorldScene.prototype) as {
    app: { pressureMode: boolean };
  };
  const captureSaveWorld = WorldScene.prototype.captureSaveWorld as (this: unknown) => unknown;
  assert.deepEqual(captureSaveWorld.call(host), { ok: false, reason: 'pressure' });
  const captureCheckpoint = Reflect.get(WorldScene.prototype, 'captureCheckpoint') as (this: unknown) => boolean;
  assert.equal(captureCheckpoint.call(host), false);
});
