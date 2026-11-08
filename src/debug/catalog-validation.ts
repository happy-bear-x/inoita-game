import type {Campaign} from '../domain/campaign.ts';
import type {EntityPlacement, QuestStatus, WorldMap} from '../domain/content.ts';
import type {StoryCastMember} from '../domain/story-performance.ts';
import {evaluateStoryCondition, type StoryCondition, type StoryConditionContext} from '../domain/story-condition.ts';
import type {StoryDebugCatalog, StoryDebugTask} from '../domain/story-debug.ts';

interface DebugCatalogInput {
  campaign: Campaign;
  maps: ReadonlyMap<string, WorldMap>;
  catalog: StoryDebugCatalog;
}

const absentKey = (map: string, character: string): string => JSON.stringify(['absent-actor', map, character]);
const actorBase = (actor: string): string => actor.replace(/-[0-9a-f]{8}$/, '');
const worldBound = (member: StoryCastMember): boolean =>
  member.binding === 'world' || member.inheritPosition === true || !!member.worldEntityId
  || !!member.characterId || !!member.memberId || !!member.enemyId;

/** 现场表里的标记条件只需要判定标记；未知条件不冒充否定，交给运行时安装复核。 */
interface TaskVisibility {
  flags: Set<string>;
  holds(condition: StoryCondition | undefined): boolean;
}

/**
 * 现场表的显隐按任务状态和标记求值。
 * 没写进现场表的任务按干净会话的可用条件推初始状态；未知事件/选择/世界值不冒充成立。
 */
function taskVisibility(task: StoryDebugTask, campaign: Campaign): TaskVisibility {
  const flags = new Set(task.start?.world?.flags ?? []);
  const explicit = new Map((task.start?.quests ?? []).map(entry => [entry.id, entry]));
  const definitions = new Map(campaign.quests.map(quest => [quest.id, quest]));
  const resolved = new Map<string, QuestStatus>();
  const resolving = new Set<string>();
  const context: StoryConditionContext = {
    questStatus: id => {
      const listed = explicit.get(id);
      if (listed) return listed.status;
      const cached = resolved.get(id);
      if (cached) return cached;
      const definition = definitions.get(id);
      if (!definition || resolving.has(id)) return 'locked';
      resolving.add(id);
      const value: QuestStatus = evaluateStoryCondition(definition.availableWhen, context) ? 'available' : 'locked';
      resolving.delete(id);
      resolved.set(id, value);
      return value;
    },
    questCompletedCycles: id => explicit.get(id)?.completedCycles ?? 0,
    eventStatus: () => 'idle',
    choice: () => undefined,
    flag: id => flags.has(id),
    world: () => undefined
  };
  return { flags, holds: condition => evaluateStoryCondition(condition, context) };
}

/**
 * 构建期门禁：现场表必须能让开幕第一幕的世界绑定演员出现在地图上，
 * 且同一地图的阶段互斥角色不能同时可见。这里不构造 Session，保持校验低成本。
 */
export function validateDebugCatalog(input: DebugCatalogInput): void {
  const {campaign, maps, catalog} = input;
  const pairs = phasePairs(campaign);
  for (const task of catalog.tasks) {
    if (!task.start) continue;
    const view = taskVisibility(task, campaign);
    const mapId = task.entry.map;
    assertEntryCast(task, campaign, maps, mapId, view);
    assertQuestContacts(task, campaign, maps, view);
    for (const [character, partner] of pairs.get(mapId) ?? []) {
      const visible = visibleCharacters(campaign, maps, mapId, view);
      if (visible.has(character) && visible.has(partner))
        throw new Error(`调试现场表 ${task.quest} 的阶段角色同时可见：${mapId} ${character} / ${partner}`);
    }
  }
}

function assertEntryCast(task: StoryDebugTask, campaign: Campaign,
  maps: ReadonlyMap<string, WorldMap>, mapId: string, view: TaskVisibility): void {
  if (!task.play) return;
  const script = campaign.scripts[task.play.script];
  const entry = task.play.node ?? script?.entry;
  const node = script?.nodes.find(row => row.id === entry);
  if (!node) return;
  const appeared = new Set(node.presentation.flatMap(action => action.type === 'appear' ? [action.target] : []));
  for (const action of node.presentation) {
    if (action.type !== 'stage') continue;
    const stageMap = action.mapFromWorld ? mapId : action.map;
    if (!maps.has(stageMap)) throw new Error(`调试现场表 ${task.quest} 的舞台地图不存在：${stageMap}`);
    const visible = visibleEntities(campaign, maps, stageMap, view);
    for (const member of action.cast) {
      if (appeared.has(member.id) || !worldBound(member) || member.visible === false) continue;
      const found = visible.some(entity =>
        (member.worldEntityId && entity.id === member.worldEntityId)
        || (member.characterId && entity.characterId === member.characterId)
        || entity.actor === member.actor);
      if (!found && worldBound(member))
        throw new Error(`调试现场表 ${task.quest} 的开幕演员不可见：${stageMap}/${member.id}`);
    }
  }
}

function assertQuestContacts(task: StoryDebugTask, campaign: Campaign,
  maps: ReadonlyMap<string, WorldMap>, view: TaskVisibility): void {
  const quest = campaign.quests.find(row => row.id === task.quest);
  if (!quest) return;
  for (const character of [quest.giverCharacterId, quest.deliveryCharacterId]) {
    if (!character) continue;
    const placement = campaign.placements.find(entity => entity.characterId === character);
    if (!placement) continue;
    const visible = visibleCharacters(campaign, maps, placement.map, view);
    if (!visible.has(character))
      throw new Error(`调试现场表 ${task.quest} 的任务联系人不可见：${placement.map}/${character}`);
  }
}

function visibleEntities(campaign: Campaign, maps: ReadonlyMap<string, WorldMap>,
  mapId: string, view: TaskVisibility): EntityPlacement[] {
  const map = maps.get(mapId);
  if (!map) return [];
  const authored = campaign.placements.filter(entity => entity.map === mapId);
  const base = map.entities.filter(entity => !authored.some(other =>
    other.characterId && entity.characterId ? other.characterId === entity.characterId : other.actor === entity.actor));
  return [...base, ...authored].filter(entity => {
    const character = entity.characterId ?? entity.actor;
    return !view.flags.has(absentKey(mapId, character)) && view.holds(entity.condition);
  });
}

function visibleCharacters(campaign: Campaign, maps: ReadonlyMap<string, WorldMap>,
  mapId: string, view: TaskVisibility): Set<string> {
  return new Set(visibleEntities(campaign, maps, mapId, view)
    .map(entity => entity.characterId).filter((value): value is string => !!value));
}

/** 同一节点里隐藏 A、显示 B，且 A/B 是同一地图同一角色基名，说明它们代表同一角色的不同时期。 */
function phasePairs(campaign: Campaign): Map<string, [string, string][]> {
  const pairs = new Map<string, [string, string][]>();
  const authored = new Set(campaign.placements.map(entity => `${entity.map}|${entity.characterId ?? ''}`));
  for (const graph of Object.values(campaign.scripts)) {
    for (const node of graph.nodes) {
      const hides: {map: string; character?: string; actor: string}[] = [];
      const shows: {map: string; character?: string; actor: string}[] = [];
      for (const command of node.commands) {
        if (command.type !== 'world' || command.command.kind !== 'actor-visibility') continue;
        const visibility = command.command;
        if (!visibility.characterId) continue;
        if (!authored.has(`${visibility.map}|${visibility.characterId}`)) continue;
        const entry = {map: visibility.map, character: visibility.characterId, actor: visibility.actor};
        (visibility.visible ? shows : hides).push(entry);
      }
      for (const hidden of hides) for (const shown of shows) {
        if (hidden.map !== shown.map || hidden.character === shown.character) continue;
        if (actorBase(hidden.actor) !== actorBase(shown.actor)) continue;
        const list = pairs.get(hidden.map) ?? [];
        if (!list.some(([left, right]) =>
          (left === hidden.character && right === shown.character)
          || (left === shown.character && right === hidden.character)))
          list.push([hidden.character!, shown.character!]);
        pairs.set(hidden.map, list);
      }
    }
  }
  return pairs;
}
