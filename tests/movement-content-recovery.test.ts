import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import { NavigationWorld } from '../src/domain/navigation-world.ts';
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
