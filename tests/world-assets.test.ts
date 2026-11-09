import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const hook = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'phaser'
      ? { url: 'data:text/javascript,export default {Scene:class{},Physics:{Arcade:{Body:class{}}},BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3}}', shortCircuit: true }
      : next(specifier, context);
  }
});
const { planMapVisuals, potentialMapEnemyIds, sharedEntryAssets } = await import('../src/rendering/map-assets.ts');
hook.deregister();

function actor(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: id, portrait: null,
    clips: { 'idle-south': { layers: [{ key: `${id}-idle`, file: `assets/${id}.png` }], frameWidth: 8, frameHeight: 8, frames: 1 } },
    ...extra
  };
}

function inputs() {
  return {
    world: {
      version: 1, maps: [], portraits: {}, storyEffects: { effect: { clips: {} } },
      props: [{ key: 'prop-a', file: 'assets/props/prop-a.png' }],
      actors: {
        'start-actor': actor('start-actor'), 'player-base': actor('player-base'),
        base: actor('base'), downgraded: actor('downgraded'),
        'spring-a': actor('spring-a'), 'spring-empty': actor('spring-empty'),
        placement: actor('placement'), 'map-entry-actor': actor('map-entry-actor'),
        'stage-actor': actor('stage-actor'), 'placed-actor': actor('placed-actor'),
        mapped: actor('mapped'), 'chest-actor': actor('chest-actor', { chest: 'wooden' })
      }
    },
    campaign: {
      start: { actor: 'start-actor' },
      placements: [{ id: 'p', map: 'map-a', actor: 'placement' }],
      mapEntryPlacements: [{ id: 'me', map: 'map-a', actor: 'map-entry-actor' }],
      enemyPlacements: [],
      quests: [], events: [],
      scripts: {
        s: { entry: 'n', nodes: [{
          id: 'n',
          stage: { type: 'stage', map: 'map-a', x: 0, y: 0, facing: 'south', playerVisible: true, cast: [{ id: 'c', actor: 'stage-actor', x: 0, y: 0, facing: 'south' }] },
          presentation: [{ type: 'stage', map: 'map-a', x: 0, y: 0, facing: 'south', playerVisible: true, cast: [{ id: 'c', actor: 'stage-actor', x: 0, y: 0, facing: 'south' }] }],
          commands: [
            { type: 'world', command: { kind: 'place', entity: { id: 'placed', map: 'map-a', actor: 'placed-actor', x: 0, y: 0 } } },
            { type: 'world', command: { kind: 'actor-appearance', actor: 'base', appearance: 'mapped' } },
            { type: 'encounter', encounter: { id: 'enc', map: 'map-a', status: 'prepared', spawns: [{ id: 's1', enemyId: 'encounter-enemy', x: 0, y: 0 }] } }
          ],
          exit: { type: 'end' }
        }] }
      }
    },
    battle: {
      enemies: [], classes: [], skills: {}, statusAttackBuffs: {},
      attackEffects: Object.fromEntries(['energy-column', 'enemy-vanish', 'level-up-aura', 'level-up-light', 'level-up-burst', 'hit'].map(name => [name, { clips: {} }])),
      feedback: { digits: {}, normalImpacts: [], skillImpact: 'hit', criticalImpact: 'hit', criticalRing: 'hit', criticalBursts: [], missEffect: 'hit' }
    },
    items: { items: {} }, wardrobe: { textures: [], attacks: {}, dualWieldAttacks: {}, skillStances: {} },
    drops: { version: 2, questItems: {}, chests: { wooden: { spawn: { enemyId: 'chest-enemy' } } }, breakables: { jar: { spawn: { enemyId: 'jar-enemy' } } }, enemies: {}, pools: {}, equipment: { weapon: [], armor: [], special: [], unique: [] } },
    springs: {
      version: 1, empty: 'spring-empty',
      springs: [{ id: 'spring-a', name: 'A', unlockLevel: 1 }],
      effects: [{ spring: 'spring-a', kind: 'spawn', weight: 1, text: '', enemy: 'spring-enemy' }]
    },
    statusHud: { assets: { 'overhead-frame': 'hud.png', 'overhead-leader': 'leader.png' }, buffIcons: { catalog: { icon: 'buff.png' } } },
    controlSkin: { stick: 'stick.png' },
    storyInterface: { assets: {}, portraits: {}, player: {} },
    storyWorld: {
      actorAppearance: (id: string) => id === 'base' ? 'mapped' : id,
      enemySpawns: () => [],
      activeEncounters: [],
      projectEntities: () => []
    },
    companions: { definitions: {} },
    hero: { level: 10, classId: 'knight' },
    playerBase: actor('player-base')
  } as unknown as Parameters<typeof planMapVisuals>[1];
}

const map = {
  id: 'map-a', name: 'A', width: 100, height: 100, ground: 'assets/map-a-ground.png', canopy: 'assets/map-a-canopy.png',
  features: [{ texture: 'prop-a', x: 0, y: 0 }],
  entities: [
    { id: 'e', actor: 'base', x: 0, y: 0, spring: true, downgrade: { atLeast: 1, actor: 'downgraded' } },
    { id: 'chest', actor: 'chest-actor', x: 0, y: 0 }
  ],
  enemySpawns: [{ id: 'spawn', enemyId: 'goblin', x: 0, y: 0, breakableEligible: true }]
} as unknown as Parameters<typeof planMapVisuals>[0];

test('visual plan includes conservative actors, springs, stage cast, placements and story placements', () => {
  const plan = planMapVisuals(map, inputs());
  const keys = new Set(plan.assets.map(asset => asset.key));
  for (const key of ['start-actor-idle', 'player-base-idle', 'base-idle', 'downgraded-idle', 'spring-a-idle', 'spring-empty-idle',
    'placement-idle', 'map-entry-actor-idle', 'stage-actor-idle', 'placed-actor-idle', 'mapped-idle', 'prop-a', 'map-a-ground', 'map-a-canopy'])
    assert.ok(keys.has(key), `missing ${key}`);
  assert.ok(plan.actorIds.has('mapped'));
});

test('enemy ids are a conservative superset across spawns, chests, springs, encounters and checkpoints', () => {
  const ids = new Set(potentialMapEnemyIds(map, inputs(), { scripts: ['s'], checkpointEnemies: ['checkpoint-enemy'] }));
  for (const id of ['goblin', 'chest-enemy', 'spring-enemy', 'encounter-enemy', 'checkpoint-enemy',
    'enemy-bush-1', 'enemy-jar-1', 'enemy-box-1', 'jar-enemy']) assert.ok(ids.has(id), `missing ${id}`);
});

test('shared entry assets include story effects and HUD art', () => {
  const keys = sharedEntryAssets(inputs()).map(asset => asset.key);
  assert.ok(keys.includes('hud.png'));
  assert.ok(keys.includes('leader.png'));
  assert.ok(keys.includes('stick.png'));
});
