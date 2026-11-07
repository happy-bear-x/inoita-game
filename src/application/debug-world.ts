import { prepareCombatRestore } from '../domain/combat-snapshot.ts';
import { validateSceneSnapshot } from '../domain/scene-snapshot.ts';
import type { StoryWorldViewSnapshot } from '../scenes/world-scene.ts';
import type { StoryContext } from './ports.ts';

/** 持久现场中的队伍外观由当前装备重新合成，不能复用上次进程的纹理键。 */
export function persistentDebugWorld(snapshot: StoryWorldViewSnapshot): StoryWorldViewSnapshot {
  const copy = structuredClone(snapshot);
  if (copy.scene) for (const actor of copy.scene.actors) {
    if (actor.id === 'player' || actor.memberId) delete actor.appearance;
  }
  return copy;
}

/** 在改变地图前验证全部位置、身份与战斗数据。 */
export function prepareDebugWorld(value: unknown, content: Pick<StoryContext, 'world' | 'battleCatalog' | 'session'>): StoryWorldViewSnapshot {
  const state = persistentDebugWorld(value as StoryWorldViewSnapshot);
  const point = state?.location;
  if (!point || !content.world.maps.some(map => map.id === point.map) || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !['north', 'south', 'east', 'west'].includes(point.facing)) throw new Error('调试标记地图或位置无效');
  if (!Array.isArray(state.generatedEntities) || new Set(state.generatedEntities.map(entity => entity.id)).size !== state.generatedEntities.length
    || state.generatedEntities.some(entity => !content.world.actors[entity.actor] || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)))
    throw new Error('调试标记地图角色无效');
  if (state.scene) {
    validateSceneSnapshot(state.scene);
    const player = state.scene.actors.find(actor => actor.id === 'player');
    if (state.scene.map !== point.map || !player || player.x !== point.x || player.y !== point.y || player.facing !== point.facing)
      throw new Error('调试标记地图与角色位置不一致');
  }
  if (state.world) state.world = prepareCombatRestore(state.world, content.battleCatalog, content.session.party?.activeIds ?? []);
  return state;
}
