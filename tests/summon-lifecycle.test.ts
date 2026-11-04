import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  SummonLifecycle, advanceSummonLifetime, releasesSummonVitals, summonDurationMs,
  summonLifetimeExpired, summonedChildren,
} from '../src/domain/summon-lifecycle.ts';

const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: 'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}' }
    : next(specifier, context);
}});
const { WorldCombat } = await import('../src/scenes/world-combat.ts');
hook.deregister();

test('summon groups follow ownership, replacement and removal', () => {
  const life = new SummonLifecycle();
  assert.deepEqual(life.beginSummon('player'), [], '首次召唤没有旧单位');
  life.register('player', 'soldier-a');
  life.register('player', 'soldier-b');
  life.register('ally', 'soldier-c');
  assert.deepEqual(life.capture(), [['player', ['soldier-a', 'soldier-b']], ['ally', ['soldier-c']]]);

  assert.deepEqual(life.beginSummon('player'), ['soldier-a', 'soldier-b'], '同主人召唤顶替全部旧单位');
  assert.deepEqual(life.capture(), [['player', []], ['ally', ['soldier-c']]], '顶替后保留空的归属分组');

  life.remove('soldier-c');
  assert.deepEqual(life.capture(), [['player', []], ['ally', []]], '移除的单位从所有分组消失');

  life.register('player', 'soldier-d');
  assert.deepEqual(life.removeOwner('player'), ['soldier-d'], '主人离队/阵亡返回名下召唤');
  assert.deepEqual(life.capture(), [['ally', []]]);
  life.clear();
  assert.deepEqual(life.capture(), []);
});

test('summon groups round-trip through checkpoint state', () => {
  const life = new SummonLifecycle();
  life.register('player', 'old');
  life.restore([['player', ['restored']], ['ally', []]]);
  assert.deepEqual(life.capture(), [['player', ['restored']], ['ally', []]], '恢复替换旧分组而不是叠加');
});

test('summon lifetime uses rank duration or owner-derived logic frames', () => {
  assert.equal(summonDurationMs(1500), 1500);
  assert.equal(summonDurationMs(1500, 10), (10 + 1) * 60, '帧数换算保留最后一帧');
  assert.equal(advanceSummonLifetime(120), 60);
  assert.equal(advanceSummonLifetime(30, 120), -90);
  assert.equal(summonLifetimeExpired(undefined), false, '没有寿命的召唤不会自然消失');
  assert.equal(summonLifetimeExpired(60), false);
  assert.equal(summonLifetimeExpired(0), true);
  assert.equal(summonLifetimeExpired(-60), true);
});

test('only summons release their session vitals, and checkpoint restore keeps them', () => {
  assert.equal(releasesSummonVitals('player', false), true);
  assert.equal(releasesSummonVitals('player', true), false, '检查点重建同一批召唤物时保留状态');
  assert.equal(releasesSummonVitals(undefined, false), false, '普通敌人不清理召唤状态');
});

test('removing a summon also lists the summons it owns', () => {
  const arena = [
    { key: 'owner', summonedBy: 'player' },
    { key: 'child-a', summonedBy: 'owner' },
    { key: 'child-b', summonedBy: 'owner' },
    { key: 'other', summonedBy: 'player' },
  ];
  assert.deepEqual(summonedChildren(arena, 'owner'), ['child-a', 'child-b']);
  assert.deepEqual(summonedChildren(arena, 'player'), ['owner', 'other']);
});

function combatHost() {
  const forgotten: string[] = [];
  const cooldowns: string[] = [];
  const session = {
    forgetEnemyVitals: (key: string) => { forgotten.push(key); },
    cooldowns: { removeActor: (key: string) => { cooldowns.push(key); } },
  };
  const host = Object.setPrototypeOf({
    app: { session },
    arena: [] as { key: string }[],
    threat: { removeActor() {}, clear() {} },
    combatRuntime: { removeActor() {} },
    movement: { remove() {} },
  }, WorldCombat.prototype) as unknown as {
    arena: unknown[];
    destroyEnemy(enemy: unknown, preserveCooldown?: boolean, keepSummonState?: boolean): void;
    clearEnemies(preserveCooldown?: boolean, keepSummonStates?: boolean): void;
  };
  const enemy = (key: string, summonedBy?: string) => ({
    key, summonedBy, definition: { id: 'enemy-test' },
    visual: { container: { destroy() {} } }, presenter: { clear() {} },
  });
  return { host, forgotten, cooldowns, enemy };
}

test('destroying or clearing a summon forgets its session vitals', () => {
  const run = combatHost();
  const summon = run.enemy('summon-1', 'player'), ordinary = run.enemy('enemy-1');
  run.host.destroyEnemy(summon);
  run.host.destroyEnemy(ordinary);
  assert.deepEqual(run.forgotten, ['summon-1'], '只有召唤物清理会话状态');
  assert.deepEqual(run.cooldowns, ['summon-1', 'enemy-1']);
});

test('checkpoint restore clears visuals while keeping the summon states it will rebuild', () => {
  const run = combatHost();
  run.host.arena = [run.enemy('summon-1', 'player'), run.enemy('summon-2', 'player')];
  run.host.clearEnemies(true, true);
  assert.deepEqual(run.forgotten, [], '检查点恢复保留即将重建的召唤物状态');
  assert.deepEqual(run.cooldowns, [], '恢复路径保留冷却');
  assert.equal(run.host.arena.length, 0, '场上实例仍然清空');

  run.host.arena = [run.enemy('summon-3', 'player')];
  run.host.clearEnemies();
  assert.deepEqual(run.forgotten, ['summon-3'], '正常销毁会清理召唤物状态');
});
