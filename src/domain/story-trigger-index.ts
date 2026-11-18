import type { StoryEvent, StoryGraph } from './story-graph.ts';

/** 索引只依赖角色的身份和可见性，不关心 Phaser 的视觉对象。 */
interface TriggerCharacter {
  entity: { id: string; actor: string; characterId?: string };
  container: { visible: boolean };
}

interface NearCharacter<C> { id: string; character: C; events: StoryEvent[] }

export interface StoryTriggerIndex<C extends TriggerCharacter> {
  /** 本图的区域事件，保持 campaign 里的原始顺序。 */
  regionEvents: StoryEvent[];
  /** 每个地图角色的近身事件。角色顺序取自首个匹配事件，组内按剧情优先级排列。 */
  nearCharacters: NearCharacter<C>[];
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
  const nearCharacters = new Map<string, NearCharacter<C>>();
  for (const event of campaign.events ?? []) {
    if (event.source === 'region' && event.map === mapId && event.region) regionEvents.push(event);
    if (event.source !== 'near' || (event.map && event.map !== mapId)) continue;
    for (const character of characters) {
      const entity = character.entity;
      if (entity.actor !== event.near || (event.nearCharacterId && entity.characterId !== event.nearCharacterId)
        || (event.entity && entity.id !== event.entity)) continue;
      const group = nearCharacters.get(entity.id);
      if (group) group.events.push(event);
      else nearCharacters.set(entity.id, { id: entity.id, character, events: [event] });
    }
  }
  for (const group of nearCharacters.values()) group.events.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return { regionEvents, nearCharacters: [...nearCharacters.values()] };
}
