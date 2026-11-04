import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BattleCatalog, EnemyDefinition, EnemyPlayableSkill } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { WorldIndex, WorldMap } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { enemyCombatAssets } from '../src/rendering/combat-assets.ts';
import { residentCombatCoverageGaps } from '../src/rendering/combat-visual-coverage.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';
import type { WorldAssetInputs } from '../src/rendering/map-assets.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {Scene:class{},Physics:{Arcade:{Body:class{}}},BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { planMapCombat, potentialMapEnemyIds } = await import('../src/rendering/map-assets.ts');
hook.deregister();

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const world = read<WorldIndex>('world');
const campaign = read<Campaign>('campaign');
const battle = read<BattleCatalog>('battle');
const items = read<ItemCatalog>('items');
const wardrobe = read<WardrobeCatalog>('wardrobe');
const companions = read<CompanionCatalog>('companions');
const stats = read<CharacterStatsCatalog>('character-stats');
const drops = read<Record<string, unknown>>('drops');
const springs = read<Record<string, unknown>>('springs');
const hero = new BattleCharacter('dark-knight', stats, items);

function assetInputs(): WorldAssetInputs {
  return {
    world, campaign, battle, items, wardrobe, drops, springs,
    statusHud: { assets: {}, buffIcons: { catalog: {} } },
    controlSkin: {},
    storyInterface: { assets: {}, portraits: {}, player: {} },
    storyWorld: {
      actorAppearance: (id: string) => id,
      enemySpawns: () => [],
      activeEncounters: [],
      projectEntities: (_map: string, base: unknown[]) => base,
      visible: () => true,
      visit: 0
    },
    companions, hero, playerBase: world.actors[campaign.start.actor]
  } as unknown as WorldAssetInputs;
}

test('every runtime combat effect and actor layer is in the resident pack', () => {
  const gaps = residentCombatCoverageGaps({ battle, wardrobe, world, companions });
  assert.deepEqual(gaps.effects, [], '常驻包缺少运行时特效');
  assert.deepEqual(gaps.definitions, [], '内容缺少特效定义');
  assert.deepEqual(gaps.layers, [], '常驻包缺少特效纹理');
  assert.deepEqual(gaps.actorLayers, [], '常驻包缺少角色纹理');
  assert.deepEqual(gaps.companions, [], '有佣兵无法通过按需路径加载外观');
});

test('the map combat plan follows the hero learned skills', () => {
  const inputs = assetInputs();
  const reference = world.maps.find(entry => entry.id === campaign.start.map)!;
  const map = read<WorldMap>(reference.file.replace('content/', '').replace(/\.json$/, ''));
  const character = battle.classes.find(value => value.id === hero.classId)!;
  const starter = character.skills[0]!;
  const levels: Record<string, number> = Object.fromEntries(character.skills.map(id => [id, id === starter ? 1 : 0]));
  const scoped = { ...inputs, heroSkills: { draft: () => ({ levels }) } } as unknown as WorldAssetInputs;
  const effectKey = 'firestorm-swing-default-screen';
  const planKeys = (value: WorldAssetInputs) => new Set(planMapCombat(map, value, { scripts: [] }).map(asset => asset.key));
  assert.ok(planKeys(inputs).has(effectKey), '全量规划包含姿态特效');
  assert.equal(planKeys(scoped).has(effectKey), false, '未学技能不进入进图计划');
  levels.firestorm = 1;
  assert.ok(planKeys(scoped).has(effectKey), '学会新技能后进图计划补上');
});

test('companion skill stance effects are resident, not only the hero class', () => {  const pack = residentCombatAssets({ battle, wardrobe, world, companions });
  for (const name of ['heavy-dark-slash', 'firestorm-swing', 'aimed-shot', 'orb-blue', 'rage-aura', 'giant-blow-swing']) {
    assert.ok(pack.effectNames.has(name), `缺少姿态特效 ${name}`);
  }
  assert.ok(pack.actorIds.has('mercenary-black-knight'));
});

test('each map plan covers every enemy reachable from that map', () => {
  const inputs = assetInputs();
  const missing: string[] = [];
  for (const reference of world.maps) {
    const map = read<WorldMap>(reference.file.replace('content/', '').replace(/\.json$/, ''));
    const ids = potentialMapEnemyIds(map, inputs, { scripts: [] });
    const plan = new Set(planMapCombat(map, inputs, { scripts: [] }).map(asset => asset.key));
    for (const id of ids) {
      const definition = battle.enemies.find(enemy => enemy.id === id);
      if (!definition) { missing.push(`${reference.id}: 敌人定义缺失 ${id}`); continue; }
      for (const asset of enemyCombatAssets(battle, definition))
        if (!plan.has(asset.key)) missing.push(`${reference.id}: ${id} 缺少 ${asset.key}`);
    }
  }
  assert.deepEqual(missing.slice(0, 20), []);
});

test('enemy summons are expanded recursively with a cycle guard', () => {
  const clone = structuredClone(battle);
  const template = clone.enemies[0]!;
  const summonAction = (creature: string) => ({
    requiresTarget: false, cooldownFrames: 0, approachDistanceUnits: 0, searchRadiusPx: 0, transition: null,
    combatUnits: [{ effect: 'summon' as const, creature }], events: []
  });
  const actorB = structuredClone(template.actor);
  actorB.id = 'coverage-actor-b';
  actorB.clips = {
    'idle-south': { ...actorB.clips['idle-south']!, layers: [{ key: 'coverage-actor-b-idle', file: 'coverage.png', blend: 'normal' }] }
  };
  const first = { ...structuredClone(template), id: 'coverage-summon-a',
    skills: [{ action: summonAction('coverage-summon-b') } as unknown as EnemyPlayableSkill] } as EnemyDefinition;
  const second = { ...structuredClone(template), id: 'coverage-summon-b', actor: actorB,
    skills: [{ action: summonAction('coverage-summon-a') } as unknown as EnemyPlayableSkill] } as EnemyDefinition;
  clone.enemies = [first, second];
  const assets = enemyCombatAssets(clone as BattleCatalog, first);
  assert.ok(assets.some(asset => asset.key === 'coverage-actor-b-idle'), '递归召唤的角色纹理缺失');
});

test('no texture key is described with two different frame layouts', () => {
  const pack = residentCombatAssets({ battle, wardrobe, world, companions });
  const inputs = assetInputs();
  const seen = new Map(pack.assets.map(asset => [asset.key, JSON.stringify(asset)]));
  const conflicts: string[] = [];
  for (const reference of world.maps) {
    const map = read<WorldMap>(reference.file.replace('content/', '').replace(/\.json$/, ''));
    for (const asset of planMapCombat(map, inputs, { scripts: [] })) {
      const previous = seen.get(asset.key);
      if (previous && previous !== JSON.stringify(asset)) conflicts.push(asset.key);
      else seen.set(asset.key, JSON.stringify(asset));
    }
  }
  assert.deepEqual([...new Set(conflicts)].slice(0, 20), []);
});
