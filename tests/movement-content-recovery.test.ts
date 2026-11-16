import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import { NavigationWorld, blocksActor, collisionAt, overlaps, type NavigationActor, type NavigationShape } from '../src/domain/navigation-world.ts';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import type { MovementWorld as MovementWorldType } from '../src/rendering/movement-world.ts';

const require = createRequire(import.meta.url);
const World = require('../node_modules/phaser/src/physics/arcade/World.js') as typeof Phaser.Physics.Arcade.World;
const bodyUrl = new URL('../node_modules/phaser/src/physics/arcade/Body.js', import.meta.url).href;
const shim = `import Body from ${JSON.stringify(bodyUrl)};export default {Physics:{Arcade:{Body}},Scenes:{Events:{PRE_UPDATE:'preupdate',POST_UPDATE:'postupdate',PRE_RENDER:'prerender',RENDER:'render'}}};`;
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { url: `data:text/javascript,${encodeURIComponent(shim)}`, shortCircuit: true }
    : next(specifier, context);
} });
const { MovementWorld } = await import('../src/rendering/movement-world.ts');
hook.deregister();

const map = JSON.parse(readFileSync(new URL('../public/content/maps/east-kamuran-b52d2b0e.json', import.meta.url), 'utf8'));
const world = JSON.parse(readFileSync(new URL('../public/content/world.json', import.meta.url), 'utf8'));
const heroCollision = world.actors.kiyan.collision;
const flameCollision = world.actors['story-flame-7ce0ff5c'].collision;
const flames = [[536, 40], [520, 88], [568, 72], [584, 136], [616, 72]];

function visual(id: string, collision: unknown, x: number, y: number): CharacterVisual {
  return { actor: { collision }, entity: { id }, container: Object.assign(new EventEmitter(), {
    x, y, scaleX: 1, scaleY: 1, angle: 0, rotation: 0, displayOriginX: 0, displayOriginY: 0, active: true, visible: true,
    setPosition(nx: number, ny: number) { this.x = nx; this.y = ny; return this; },
    setDepth() { return this; }, setVisible(value: boolean) { this.visible = value; return this; },
  }) } as unknown as CharacterVisual;
}

function harness() {
  const events = new EventEmitter();
  const group = { scene: {}, add() {}, remove() {}, destroy() {} };
  const scene = { sys: { scale: { width: 640, height: 480 } }, events, add: { group: () => group } } as unknown as Phaser.Scene;
  const physics = new World(scene, { gravity: { x: 0, y: 0 }, debug: false });
  scene.physics = { world: physics, add: { collider: (...args: Parameters<typeof physics.addCollider>) => physics.addCollider(...args) } } as Phaser.Physics.Arcade.ArcadePhysics;
  const navigation = new NavigationWorld(map);
  const movement = new MovementWorld(scene, navigation);
  const hero = visual('hero', heroCollision, 488, 136);
  const body = movement.register(hero, true, true, 'party');
  for (const [x, y] of flames) movement.register(visual(`flame-${x}-${y}`, flameCollision, x, y), false);
  const setFoot = (x: number, y: number) => {
    body.position.set(x + heroCollision.x, y + heroCollision.y);
    body.updateCenter();
  };
  const cleanup = () => { movement.destroy(); physics.destroy(); };
  return { movement, navigation, hero, body, setFoot, cleanup };
}

function settle(movement: MovementWorldType): void {
  (movement as unknown as { settleStep(delta: number): void }).settleStep(16);
}

test('settleStep repairs a party unit embedded in a warehouse flame', t => {
  for (const point of [{ x: 568, y: 136 }, { x: 568, y: 140 }, { x: 560, y: 136 }]) {
    const h = harness();
    t.after(h.cleanup);
    h.setFoot(point.x, point.y);
    (h.body as unknown as { stepStart: { x: number; y: number } }).stepStart = { ...point };
    const actor = h.movement.actor(h.hero);
    assert.equal(h.navigation.blockedByContent(h.movement.actor(h.hero).shape(), point, actor), true,
      `测试点 ${JSON.stringify(point)} 应当压在火焰上`);
    settle(h.movement);
    const landing = h.movement.position(h.hero);
    assert.equal(h.navigation.blockedByContent(h.movement.actor(h.hero).shape(), landing, actor), false,
      `自愈后仍压在火焰上：${JSON.stringify(landing)}`);
    assert.equal(h.navigation.canStand(actor, landing), true, `自愈后的脚点仍不可站：${JSON.stringify(landing)}`);
    assert.equal(h.navigation.bodyTerrainFree(h.movement.actor(h.hero).shape(), landing), true,
      `自愈后的整盒仍压墙：${JSON.stringify(landing)}`);
    assert.ok((h.movement.state(h.hero)?.contentRecoveries ?? 0) >= 1, '应当记录一次内容机关自愈');
  }
});

test('recoverContent moves the player out of a flame and leaves a free position alone', t => {
  const h = harness();
  t.after(h.cleanup);
  h.setFoot(568, 136);
  const recovered = h.movement.recoverContent(h.hero);
  assert.ok(recovered, '压在火焰上时应当找到新落点');
  assert.deepEqual(h.movement.position(h.hero), recovered.to);
  assert.equal(h.navigation.blockedByContent(h.movement.actor(h.hero).shape(), recovered.to, h.movement.actor(h.hero)), false);
  assert.equal(h.navigation.canStand(h.movement.actor(h.hero), recovered.to), true);

  h.setFoot(488, 136);
  assert.equal(h.movement.recoverContent(h.hero), undefined, '正常站位不应被搬走');
  assert.deepEqual(h.movement.position(h.hero), { x: 488, y: 136 });
});

test('only content actors participate in content recovery', () => {
  const navigation = new NavigationWorld(map);
  const point = { x: 568, y: 136 };
  const hero = { shape: () => ({ collision: heroCollision }), position: () => point, enabled: () => true };
  const unit = { shape: () => ({ collision: flameCollision }), position: () => point, enabled: () => true, content: () => false };
  navigation.register(hero); navigation.register(unit);
  assert.equal(navigation.blockedByContent(hero.shape(), point, hero), false, '普通单位不算内容机关');
});

test('content checks skip ordinary actors and track registration changes and indexed obstacle positions', () => {
  const navigation = new NavigationWorld(map), point = { x: 568, y: 136 };
  let ordinaryChecks = 0, content = false;
  const obstacle = { shape: () => ({ collision: flameCollision }), position: () => point, enabled: () => true,
    content: () => content };
  for (let index = 0; index < 1000; index++) navigation.register({ shape: () => ({}), position: () => point,
    enabled: () => true, content: () => { ordinaryChecks++; return false; } });
  const unregister = navigation.register(obstacle); ordinaryChecks = 0;
  const shape = { collision: heroCollision };
  for (let index = 0; index < 100; index++) assert.equal(navigation.blockedByContent(shape, point), false);
  assert.equal(ordinaryChecks, 0, '反复查询不再访问 1000 个普通角色');
  content = true; navigation.refreshActor(obstacle);
  assert.equal(navigation.blockedByContent(shape, point), true);
  assert.equal(navigation.blockedByContent(shape, { x: 400, y: 300 }), false);
  point.x = 400; point.y = 300;
  navigation.refreshActor(obstacle);
  assert.equal(navigation.blockedByContent(shape, point), true, '机关移动后刷新索引，查询按新位置命中');
  assert.equal(navigation.blockedByContent(shape, { x: 568, y: 136 }), false, '旧位置的格子不再留下机关');
  unregister(); assert.equal(navigation.blockedByContent(shape, point), false);
});

interface ContentActorFlags {
  enabled?: () => boolean;
  ghost?: () => boolean;
  faction?: () => 'party' | 'hostile' | 'neutral';
}

function contentActor(id: string, point: { x: number; y: number }, collision: { x: number; y: number; width: number; height: number },
  reads: Map<string, number>, flags: ContentActorFlags = {}): NavigationActor {
  return {
    shape: () => { reads.set(id, (reads.get(id) ?? 0) + 1); return { collision }; },
    position: () => point,
    enabled: flags.enabled ?? (() => true),
    ghost: flags.ghost,
    faction: flags.faction,
    content: () => true,
  };
}

/** 未建索引时的全表扫描；查询结果必须与它一致。 */
function fullContentScan(actors: readonly NavigationActor[], shape: NavigationShape, point: { x: number; y: number },
  ignore?: NavigationActor): boolean {
  const box = collisionAt(shape, point);
  if (!box) return false;
  for (const actor of actors) {
    if (actor === ignore || !actor.content?.() || !actor.enabled()) continue;
    if (ignore?.ghost?.() || actor.ghost?.()) continue;
    if (ignore && !blocksActor(ignore, actor)) continue;
    const other = actor.shape().collision;
    if (!other) continue;
    const at = actor.position();
    if (overlaps({ ...other, x: at.x + other.x, y: at.y + other.y }, box)) return true;
  }
  return false;
}

test('content index only checks nearby buckets and agrees with a full scan', () => {
  const navigation = new NavigationWorld({ name: 'index', bounds: { x: 0, y: 0, width: 384, height: 384 } });
  const reads = new Map<string, number>();
  const actors = [
    contentActor('near', { x: 40, y: 40 }, { x: -8, y: -8, width: 16, height: 16 }, reads),
    contentActor('far-east', { x: 320, y: 48 }, { x: -8, y: -8, width: 16, height: 16 }, reads),
    contentActor('far-south', { x: 48, y: 320 }, { x: -8, y: -8, width: 16, height: 16 }, reads),
    contentActor('diagonal', { x: 336, y: 336 }, { x: -8, y: -8, width: 16, height: 16 }, reads),
  ];
  for (const actor of actors) navigation.register(actor);
  const query = { collision: { x: -4, y: -4, width: 8, height: 8 } };
  reads.clear();
  assert.equal(navigation.blockedByContent(query, { x: 40, y: 40 }), true);
  assert.equal(reads.get('near'), 1, '命中附近的机关只读一次形状');
  for (const id of ['far-east', 'far-south', 'diagonal']) {
    assert.equal(reads.get(id) ?? 0, 0, `${id} 离查询很远，不应进入候选`);
  }

  for (const shape of [query, { collision: { x: -12, y: -12, width: 24, height: 24 } }]) {
    for (let y = 8; y <= 376; y += 24) for (let x = 8; x <= 376; x += 24) {
      assert.equal(navigation.blockedByContent(shape, { x, y }), fullContentScan(actors, shape, { x, y }),
        `查询点 ${x},${y} 的结果应与全表扫描一致`);
    }
  }
});

test('a content actor spanning several buckets is checked once per query', () => {
  const navigation = new NavigationWorld({ name: 'index', bounds: { x: 0, y: 0, width: 256, height: 256 } });
  const reads = new Map<string, number>();
  const large = contentActor('large', { x: 128, y: 128 }, { x: -32, y: -32, width: 64, height: 64 }, reads);
  navigation.register(large);
  reads.clear();
  const query = { collision: { x: -12, y: -12, width: 24, height: 24 } };
  assert.equal(navigation.blockedByContent(query, { x: 128, y: 128 }), true);
  assert.equal(reads.get('large'), 1, '查询盒覆盖多格时，同一机关也只做一次精确判定');
});

test('content index follows moves, unregistering and re-registering', () => {
  const navigation = new NavigationWorld({ name: 'index', bounds: { x: 0, y: 0, width: 320, height: 320 } });
  const point = { x: 40, y: 40 };
  const obstacle = contentActor('obstacle', point, { x: -8, y: -8, width: 16, height: 16 }, new Map());
  const unregister = navigation.register(obstacle);
  const query = { collision: { x: -4, y: -4, width: 8, height: 8 } };
  assert.equal(navigation.blockedByContent(query, { x: 40, y: 40 }), true);
  point.x = 200; point.y = 200;
  navigation.refreshActor(obstacle);
  assert.equal(navigation.blockedByContent(query, { x: 40, y: 40 }), false, '旧格子已撤销');
  assert.equal(navigation.blockedByContent(query, { x: 200, y: 200 }), true);
  unregister();
  assert.equal(navigation.blockedByContent(query, { x: 200, y: 200 }), false, '注销后同步移除索引');
  navigation.register(obstacle);
  assert.equal(navigation.blockedByContent(query, { x: 200, y: 200 }), true, '重新注册按当前位置登记');
  navigation.refreshActor(obstacle);
  assert.equal(navigation.blockedByContent(query, { x: 200, y: 200 }), true, '重复刷新保持幂等');
});

test('content index keeps ignore, ghost, enabled and faction filters live', () => {
  const navigation = new NavigationWorld({ name: 'index', bounds: { x: 0, y: 0, width: 256, height: 256 } });
  const point = { x: 80, y: 80 };
  let enabled = true, ghost = false;
  const obstacle = contentActor('flame', point, { x: -8, y: -8, width: 16, height: 16 }, new Map(), {
    enabled: () => enabled, ghost: () => ghost, faction: () => 'party',
  });
  navigation.register(obstacle);
  const query = { collision: { x: -4, y: -4, width: 8, height: 8 } };
  const ally: NavigationActor = {
    shape: () => ({ collision: { x: -4, y: -4, width: 8, height: 8 } }),
    position: () => point, enabled: () => true, faction: () => 'party',
  };
  const ghostQuery: NavigationActor = {
    shape: () => ({ collision: { x: -4, y: -4, width: 8, height: 8 } }),
    position: () => point, enabled: () => true, ghost: () => true,
  };

  assert.equal(navigation.blockedByContent(query, point, ally), false, '同阵营单位不互相阻挡');
  assert.equal(navigation.blockedByContent(query, point, ghostQuery), false, 'ghost 查询者被忽略');
  assert.equal(navigation.blockedByContent(query, point, obstacle), false, 'ignore 的机关不参与判定');
  assert.equal(navigation.blockedByContent(query, point), true, '没有过滤条件时按实体相交');
  ghost = true;
  assert.equal(navigation.blockedByContent(query, point), false, 'ghost 机关在查询时被过滤');
  ghost = false;
  enabled = false;
  assert.equal(navigation.blockedByContent(query, point), false, '停用机关在查询时被过滤');
  enabled = true;
  assert.equal(navigation.blockedByContent(query, point), true, '重新启用不需要刷新索引');
  const shapeless: NavigationActor = { shape: () => ({}), position: () => point, enabled: () => true, content: () => true };
  const empty = new NavigationWorld({ name: 'index', bounds: { x: 0, y: 0, width: 256, height: 256 } });
  empty.register(shapeless);
  assert.equal(empty.blockedByContent(query, point), false, '没有碰撞盒的机关本来就不挡人');
});
