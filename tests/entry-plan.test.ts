import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import { BattleCharacter, type CharacterStatsCatalog } from '../src/domain/character-stats.ts';
import type { WorldIndex, WorldMap } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { WardrobeCatalog } from '../src/domain/wardrobe.ts';
import type { WorldAssetInputs } from '../src/rendering/map-assets.ts';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {Scene:class{},Physics:{Arcade:{Body:class{}}},BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { buildEntryPlan, entryPlanAssets } = await import('../src/application/entry-plan.ts');
const { planMapVisuals } = await import('../src/rendering/map-assets.ts');
const { characterAssets } = await import('../src/rendering/combat-asset-descriptors.ts');
hook.deregister();

test('dark-space dialogue prepares movement without meteor combat animations', () => {
  const map = read<WorldMap>('maps/dark-space-b5a13a13');
  const plan = planMapVisuals(map, inputs(), { scripts: ['event-413'] });
  const keys = new Set(plan.assets.map(asset => asset.key));
  const actor = world.actors['enemy-dark-forces-of-evil-1']!;
  const meteor = characterAssets(actor, (Object.keys(actor.clips) as (keyof typeof actor.clips)[]).filter(name => name.includes('meteor')));
  assert.ok(plan.actorIds.has(actor.id)); assert.ok(meteor.length > 0);
  for (const asset of meteor) assert.equal(keys.has(asset.key), false, asset.key);
  for (const asset of characterAssets(actor, ['idle-south'])) assert.ok(keys.has(asset.key), asset.key);
});

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

function inputs(): WorldAssetInputs {
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

const startMap = (() => {
  const reference = world.maps.find(entry => entry.id === campaign.start.map)!;
  return read<WorldMap>(reference.file.replace('content/', '').replace(/\.json$/, ''));
})();

test('entry plan assets are what open() hands to the loader', () => {
  const plan = buildEntryPlan({ currentMap: startMap, inputs: inputs(), includeResidentCombat: true });
  const keys = entryPlanAssets(plan).map(asset => asset.key);
  for (const key of [`${startMap.id}-ground`, `${startMap.id}-canopy`]) assert.ok(keys.includes(key), `missing ${key}`);
  for (const asset of plan.shared) assert.ok(keys.includes(asset.key), `missing shared ${asset.key}`);
  for (const asset of plan.residentCombat ?? []) assert.ok(keys.includes(asset.key), `missing resident ${asset.key}`);
  assert.ok(plan.scripts.length > 0, '起始图应该有本地剧情脚本');
});

test('target map local scripts stay in the plan when a chain activeScripts set is passed', () => {
  const plain = buildEntryPlan({ currentMap: startMap, inputs: inputs() });
  const chained = buildEntryPlan({ currentMap: startMap, inputs: inputs(), activeScripts: ['event-0'] });
  for (const id of plain.scripts) assert.ok(chained.scripts.includes(id), `本地脚本被链脚本挤掉：${id}`);
  assert.ok(chained.scripts.includes('event-0'), '链上的脚本也要保留');
});
