import type { StoryEvent, StoryGraph } from './story-graph.ts';

/** 索引只依赖角色的身份和可见性，不关心 Phaser 的视觉对象。 */
interface TriggerCharacter {
  entity: { actor: string; characterId?: string };
  container: { visible: boolean };
}

export interface StoryTriggerIndex<C extends TriggerCharacter> {
  /** 本图的区域事件，保持 campaign 里的原始顺序。 */
  regionEvents: StoryEvent[];
  /** 可能在本图触发的近身事件，保持 campaign 里的原始顺序。 */
  nearEvents: StoryEvent[];
  /** 按 actor 分组，组内保持场景角色数组的顺序。 */
  charactersByActor: Map<string, C[]>;
}

/**
 * 地图触发的纯数据索引。
 *
 * 每渲染帧扫描全部剧情事件在长内容里很贵；内容不可变，区域按地图分组，
 * 近身事件只与当前地图上的角色有关，所以进图和剧情投影后各建一次即可。
 * 条件仍然在每次判定时实时求值，索引不缓存条件结果。
 */
export function buildStoryTriggerIndex<C extends TriggerCharacter>(
  campaign: StoryGraph,
  mapId: string,
  characters: readonly C[],
): StoryTriggerIndex<C> {
  const regionEvents: StoryEvent[] = [];
  const nearEvents: StoryEvent[] = [];
  for (const event of campaign.events ?? []) {
    if (event.source === 'region' && event.map === mapId && event.region) regionEvents.push(event);
    else if (event.source === 'near' && event.near && (!event.map || event.map === mapId)) nearEvents.push(event);
  }
  const charactersByActor = new Map<string, C[]>();
  for (const character of characters) {
    const actor = character.entity.actor;
    const group = charactersByActor.get(actor);
    if (group) group.push(character); else charactersByActor.set(actor, [character]);
  }
  return { regionEvents, nearEvents, charactersByActor };
}
