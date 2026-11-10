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
import { classSummonEnemyIds, enemyCombatAssets, partyMemberCombatAssets } from '../src/rendering/combat-assets.ts';
import { characterAssets, effectAssets } from '../src/rendering/combat-asset-descriptors.ts';
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
  // 特效也会进图集页，按 firestorm 实际需要的页/纹理判断，而不是单个纹理键。
  const firestorm = effectAssets({ 'firestorm-swing': battle.attackEffects['firestorm-swing'] }).map(asset => asset.key);
  const planKeys = (value: WorldAssetInputs) => new Set(planMapCombat(map, value, { scripts: [] }).map(asset => asset.key));
  const full = planKeys(inputs), without = planKeys(scoped);
  for (const key of firestorm) assert.ok(full.has(key), `全量规划包含姿态特效 ${key}`);
  const firestormOnly = firestorm.filter(key => !without.has(key));
  assert.ok(firestormOnly.length > 0, '未学技能不进入进图计划');
  levels.firestorm = 1;
  const learned = planKeys(scoped);
  for (const key of firestormOnly) assert.ok(learned.has(key), `学会新技能后进图计划补上 ${key}`);
});

test('party actor textures follow learned skills while preserving basic actions', () => {
  const character = battle.classes.find(value => value.id === 'dark-knight')!;
  const actor = structuredClone(character.actor);
  const template = actor.clips['idle-south']!;
  const clip = (key: string) => ({ ...template, layers: [{ key, file: `${key}.png`, blend: 'normal' as const }] });
  actor.clips['idle-south'] = clip('learned-idle');
  actor.clips['attack-south'] = clip('learned-attack');
  actor.clips[`skill-${character.skills[0]}-south`] = clip('learned-skill');
  actor.clips[`skill-${character.skills[1]}-south`] = clip('unlearned-skill');
  const keys = new Set(partyMemberCombatAssets(battle, wardrobe, character.id, actor, new Set([character.skills[0]!])).map(asset => asset.key));
  assert.ok(keys.has('learned-idle'));
  assert.ok(keys.has('learned-attack'));
  assert.ok(keys.has('learned-skill'));
  assert.equal(keys.has('unlearned-skill'), false);
});

test('enemy plans preserve custom skill and command clips while skipping unrelated story poses', () => {
  const enemy = structuredClone(battle.enemies.find(value => value.basicAttack && value.skills?.some(skill => 'action' in skill))!);
  const template = enemy.actor.clips['idle-south']!;
  const clip = (key: string) => ({ ...template, layers: [{ key, file: `${key}.png`, blend: 'normal' as const }] });
  enemy.actor.clips['skill-custom-south'] = clip('custom-action');
  enemy.actor.clips['skill-command-south'] = clip('command-action');
  enemy.actor.clips['skill-unrelated-south'] = clip('unrelated-action');
  const skill = enemy.skills!.find((value): value is EnemyPlayableSkill => 'action' in value)!;
  skill.clips = { north: 'skill-custom-south', south: 'skill-custom-south', east: 'skill-custom-south', west: 'skill-custom-south' };
  enemy.commandAction = { ...skill, clips: { north: 'skill-command-south', south: 'skill-command-south', east: 'skill-command-south', west: 'skill-command-south' } };
  const keys = new Set(enemyCombatAssets(battle, enemy).map(asset => asset.key));
  assert.ok(keys.has('custom-action'));
  assert.ok(keys.has('command-action'));
  assert.equal(keys.has('unrelated-action'), false);
  for (const name of Object.values(enemy.basicAttack!.clips))
    for (const asset of characterAssets(enemy.actor, [name])) assert.ok(keys.has(asset.key), `${name}: ${asset.key}`);
});

test('class summon preparation includes companion growth and passive follow-up actions', () => {
  const catalog = structuredClone(battle);
  const character = catalog.classes[0]!;
  const skill = catalog.skills[character.skills[0]!]!;
  const summon = (creature: string) => ({ ...skill.action!, events: [], combatUnits: [{ effect: 'summon', creature }] }) as unknown as NonNullable<typeof skill.action>;
  skill.action = null;
  skill.followUpAction = summon('follow-up-summon');
  skill.companion = { ...skill.companion!, action: summon('companion-summon') };
  assert.deepEqual(classSummonEnemyIds(catalog, character.id, new Set([skill.id])).sort(), ['companion-summon', 'follow-up-summon']);
  assert.deepEqual(classSummonEnemyIds(catalog, character.id, new Set()), []);
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
