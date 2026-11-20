import { questJumpHistory } from './quest-jump-history.ts';
import type { Campaign, CampaignPlacement, CampaignQuest } from '../domain/campaign.ts';
import type { Facing, QuestStatus, TravelDestination } from '../domain/content.ts';
import type { QuestBookState, QuestProgress } from '../domain/quest-book.ts';
import { evaluateStoryCondition, type StoryCondition } from '../domain/story-condition.ts';
import { STORY_TRIGGER_SOURCES, storyExitTargets, type StoryCommand, type StoryEvent, type StoryPlace, type StoryScript } from '../domain/story-graph.ts';
import type { StoryCastMember, StoryStage } from '../domain/story-performance.ts';
import type { Session } from '../domain/session.ts';
import { encounterSpawnId } from '../domain/world-enemies.ts';

export type QuestStartMode = 'available' | 'active' | 'ready';

const soloInfiltrationStages: readonly { mode: QuestStartMode; label: string }[] = [
  { mode: 'available', label: '独自进城救人' },
  { mode: 'ready', label: '已救出圣女，返回与莱曼汇合' },
];

export function questJumpStages(questId: string): readonly { mode: QuestStartMode; label: string }[] {
  return questId === 'quest-40' ? soloInfiltrationStages : [];
}

export interface QuestAcceptCandidate {
  script: string;
  eventId?: string;
}

export interface QuestStatusChange {
  id: string;
  title: string;
  from: QuestStatus;
  to: QuestStatus;
}

export interface QuestConditionPatch {
  quests: { id: string; status: QuestStatus }[];
  choices: { choice: string; value: string }[];
  flags: { flag: string; value: boolean }[];
  completedEvents: string[];
  removedEvents: string[];
  unsatisfied: string[];
}

export interface QuestStartPlan {
  questId: string;
  quest: CampaignQuest;
  mode: QuestStartMode;
  changedQuests: QuestStatusChange[];
  accept?: QuestAcceptCandidate;
  acceptAlternatives: QuestAcceptCandidate[];
  conditionPatch: QuestConditionPatch;
  /** 接取舞台依赖的世界实体，由原始剧情里的 world/flag 命令重建。 */
  worldCommands: StoryCommand[];
  destination?: TravelDestination;
  warnings: string[];
  /** 请求可接取，但目标没有接取入口，实际按进行中开始。 */
  fallback: boolean;
}

interface AcceptCandidate extends QuestAcceptCandidate {
  event?: StoryEvent;
}

interface Spot {
  map: string;
  x: number;
  y: number;
  facing?: Facing;
}

const SOURCE_RANK: Record<string, number> = {
  quest: 0, region: 1, near: 2, interaction: 3, choice: 4,
  'map-entry': 5, battle: 6, inventory: 7, event: 8, start: 9,
};

const emptyPatch = (): QuestConditionPatch => ({
  quests: [], choices: [], flags: [], completedEvents: [], removedEvents: [], unsatisfied: [],
});

const clonePatch = (patch: QuestConditionPatch): QuestConditionPatch => ({
  quests: patch.quests.map(entry => ({ ...entry })),
  choices: patch.choices.map(entry => ({ ...entry })),
  flags: patch.flags.map(entry => ({ ...entry })),
  completedEvents: [...patch.completedEvents],
  removedEvents: [...patch.removedEvents],
  unsatisfied: [...patch.unsatisfied],
});

/** 把一组补丁并进目标补丁；同一任务后写的状态覆盖先写的状态。 */
function mergePatch(target: QuestConditionPatch, source: QuestConditionPatch): void {
  for (const entry of source.quests) {
    const existing = target.quests.findIndex(value => value.id === entry.id);
    if (existing >= 0) target.quests[existing] = { ...entry };
    else target.quests.push({ ...entry });
  }
  for (const entry of source.choices) {
    const existing = target.choices.findIndex(value => value.choice === entry.choice);
    if (existing >= 0) target.choices[existing] = { ...entry };
    else target.choices.push({ ...entry });
  }
  for (const entry of source.flags) {
    const existing = target.flags.findIndex(value => value.flag === entry.flag);
    if (existing >= 0) target.flags[existing] = { ...entry };
    else target.flags.push({ ...entry });
  }
  for (const id of source.completedEvents) if (!target.completedEvents.includes(id)) target.completedEvents.push(id);
  for (const id of source.removedEvents) if (!target.removedEvents.includes(id)) target.removedEvents.push(id);
  for (const value of source.unsatisfied) if (!target.unsatisfied.includes(value)) target.unsatisfied.push(value);
}

function placementCovers(placement: Campaign['placements'][number], quest: CampaignQuest): boolean {
  return (placement.characterId !== undefined
    && (placement.characterId === quest.giverCharacterId || placement.characterId === quest.deliveryCharacterId))
    || (placement.actor !== undefined
      && (placement.actor === quest.giver || placement.actor === quest.delivery));
}

/** 发布者/交付者可能出现的地图；任务地点有多个候选时优先能放下 NPC 的那张。 */
function npcMaps(campaign: Campaign, quest: CampaignQuest): ReadonlySet<string> {
  return new Set(campaign.placements
    .filter(placement => placementCovers(placement, quest))
    .map(placement => placement.map));
}

function questOf(campaign: Campaign, questId: string): CampaignQuest | undefined {
  return campaign.quests.find(quest => quest.id === questId);
}

const intakeIndexes = new WeakMap<Campaign, Map<string, AcceptCandidate[]>>();

function questIntakes(campaign: Campaign): Map<string, AcceptCandidate[]> {
  const cached = intakeIndexes.get(campaign);
  if (cached) return cached;
  const index = new Map<string, AcceptCandidate[]>();
  const eventsByScript = new Map<string, StoryEvent[]>();
  for (const event of campaign.events) {
    const entries = eventsByScript.get(event.script) ?? [];
    entries.push(event);
    eventsByScript.set(event.script, entries);
  }
  for (const [name, script] of Object.entries(campaign.scripts)) {
    const accepted = new Set<string>();
    for (const node of script.nodes) for (const command of node.commands)
      if (command.type === 'quest' && command.command.type === 'accept') accepted.add(command.command.quest);
    if (!accepted.size) continue;
    const events = eventsByScript.get(name);
    const sources = events?.map(event => ({ script: name, eventId: event.id, event })) ?? [{ script: name }];
    for (const id of accepted) {
      const candidates = index.get(id) ?? [];
      candidates.push(...sources);
      index.set(id, candidates);
    }
  }
  intakeIndexes.set(campaign, index);
  return index;
}

function acceptCandidates(campaign: Campaign, session: Session, questId: string): AcceptCandidate[] {
  const candidates = [...(questIntakes(campaign).get(questId) ?? [])];
  return candidates.sort((left, right) => {
    const leftReady = left.event ? (!left.event.condition || session.evaluateCondition(left.event.condition)) : false;
    const rightReady = right.event ? (!right.event.condition || session.evaluateCondition(right.event.condition)) : false;
    if (leftReady !== rightReady) return leftReady ? -1 : 1;
    const leftSource = left.event ? SOURCE_RANK[left.event.source] ?? 99 : 100;
    const rightSource = right.event ? SOURCE_RANK[right.event.source] ?? 99 : 100;
    if (leftSource !== rightSource) return leftSource - rightSource;
    const leftIndex = left.event ? campaign.events.indexOf(left.event) : Number.MAX_SAFE_INTEGER;
    const rightIndex = right.event ? campaign.events.indexOf(right.event) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.script.localeCompare(right.script);
  });
}

function pushQuestPatch(patch: QuestConditionPatch, id: string, status: QuestStatus): void {
  const existing = patch.quests.findIndex(entry => entry.id === id);
  if (existing >= 0) patch.quests[existing] = { id, status };
  else patch.quests.push({ id, status });
}

function plannedContext(session: Session, patch: QuestConditionPatch) {
  const original = session.conditionContext();
  return {
    ...original,
    questStatus: (id: string) => patch.quests.find(entry => entry.id === id)?.status ?? original.questStatus(id),
    choice: (id: string) => patch.choices.find(entry => entry.choice === id)?.value ?? original.choice(id),
    flag: (id: string) => patch.flags.find(entry => entry.flag === id)?.value ?? original.flag(id),
    eventStatus: (id: string) => patch.removedEvents.includes(id) ? 'idle' as const
      : patch.completedEvents.includes(id) ? 'completed' as const : original.eventStatus(id),
  };
}

/** 逐叶补接取剧情自己的条件；只补这一段剧情需要的任务/选择/标志/事件。 */
function satisfyCondition(condition: StoryCondition | undefined, session: Session, patch: QuestConditionPatch): boolean {
  if (!condition) return true;
  const context = plannedContext(session, patch);
  if (evaluateStoryCondition(condition, context)) return true;
  switch (condition.type) {
    case 'always':
      if (condition.value) return true;
      patch.unsatisfied.push('always=false');
      return false;
    case 'all': {
      let ok = true;
      for (const child of condition.conditions) if (!satisfyCondition(child, session, patch)) ok = false;
      return ok;
    }
    case 'any': {
      for (const child of condition.conditions) {
        const trial = clonePatch(patch);
        if (satisfyCondition(child, session, trial)) { mergePatch(patch, trial); return true; }
      }
      patch.unsatisfied.push('any 没有可满足的分支');
      return false;
    }
    case 'not': {
      const child = condition.condition;
      if (child.type === 'flag') return satisfyCondition({ ...child, value: !(child.value ?? true) }, session, patch);
      patch.unsatisfied.push(`无法让否定条件成立：${condition.type}`);
      return false;
    }
    case 'quest': {
      const current = context.questStatus(condition.quest);
      if (condition.status === 'accepted') {
        if (['active', 'ready', 'completed'].includes(current)) return true;
        pushQuestPatch(patch, condition.quest, 'active');
        return true;
      }
      if (condition.status === 'settled') {
        if (current === 'completed' || (context.questCompletedCycles?.(condition.quest) ?? 0) > 0) return true;
        pushQuestPatch(patch, condition.quest, 'completed');
        return true;
      }
      if (current === condition.status) return true;
      if (condition.status === 'locked') {
        patch.unsatisfied.push(`任务 ${condition.quest} 需要保持锁定`);
        return false;
      }
      pushQuestPatch(patch, condition.quest, condition.status);
      return true;
    }
    case 'choice': {
      const current = context.choice(condition.choice);
      if (current === condition.value) return true;
      const existing = patch.choices.findIndex(entry => entry.choice === condition.choice);
      if (existing >= 0) patch.choices[existing] = { choice: condition.choice, value: condition.value };
      else patch.choices.push({ choice: condition.choice, value: condition.value });
      return true;
    }
    case 'flag': {
      const value = condition.value ?? true;
      if (context.flag(condition.flag) === value) return true;
      const existing = patch.flags.findIndex(entry => entry.flag === condition.flag);
      if (existing >= 0) patch.flags[existing] = { flag: condition.flag, value };
      else patch.flags.push({ flag: condition.flag, value });
      return true;
    }
    case 'event': {
      const current = context.eventStatus(condition.event);
      if (current === condition.status) return true;
      if (condition.status === 'completed') {
        if (!patch.completedEvents.includes(condition.event)) patch.completedEvents.push(condition.event);
        return true;
      }
      if (condition.status === 'idle') {
        if (!patch.removedEvents.includes(condition.event)) patch.removedEvents.push(condition.event);
        return true;
      }
      patch.unsatisfied.push(`事件 ${condition.event} 需要处于 ${condition.status}`);
      return false;
    }
    case 'world':
      patch.unsatisfied.push(`不支持世界条件：${condition.key}`);
      return false;
  }
}

function spotOf(place: StoryPlace | undefined,
  current: { map: string; x: number; y: number; facing: Facing } | undefined,
  preferredMaps?: ReadonlySet<string>): Spot | undefined {
  if (!place) return undefined;
  if (place.type === 'fixed') return { map: place.map, x: place.x, y: place.y };
  if (place.type === 'alternatives') {
    const spots = place.spots;
    const preferred = spots.filter(spot => preferredMaps?.has(spot.map));
    return preferred.find(spot => spot.map === current?.map)
      ?? preferred[0]
      ?? spots.find(spot => spot.map === current?.map)
      ?? spots[0];
  }
  if (place.type === 'current') return current ? { ...current } : undefined;
  return undefined;
}

function giverSpot(campaign: Campaign, session: Session, quest: CampaignQuest): Spot | undefined {
  const placements = campaign.placements.filter(placement => placementCovers(placement, quest));
  const visible = placements.find(placement => session.evaluateCondition(placement.condition)) ?? placements[0];
  return visible ? { map: visible.map, x: visible.x, y: visible.y, facing: visible.facing } : undefined;
}

function resolveDestination(campaign: Campaign, session: Session, quest: CampaignQuest,
  accept: AcceptCandidate | undefined, mode: QuestStartMode): TravelDestination | undefined {
  const current = session.storyWorld.currentLocation;
  const place = accept?.event?.place;
  const location = current ? { ...current } : undefined;
  // 接取事件的 `place` 常是 `current`（它继承前置任务完成时的位置），不能拿它当任务起点；
  // 这种情况下优先用任务自己的阶段地点，只有任务也没有具体地点时才留在当前图。
  const eventSpot = place?.type === 'current' ? undefined : spotOf(place, location);
  const stagePlace = mode === 'available'
    ? quest.places?.available
    : mode === 'ready' ? quest.places?.ready ?? quest.places?.active : quest.places?.active;
  const stageSpot = spotOf(stagePlace, location, npcMaps(campaign, quest));
  const spot = eventSpot ?? stageSpot ?? (place?.type === 'current' ? location : undefined)
    ?? giverSpot(campaign, session, quest);
  if (!spot) {
    // `places.available.type === 'current'`：留在当前地图。
    if (current) return { map: current.map, x: current.x, y: current.y, facing: current.facing };
    return undefined;
  }
  return { map: spot.map, x: spot.x, y: spot.y, facing: spot.facing ?? 'south' };
}

/** 目的地确定后，把同图发布者/交付者 placement 的显示条件补进计划；flag 驱动的 NPC 才会出现。 */
function satisfyNpcPlacements(campaign: Campaign, session: Session, quest: CampaignQuest,
  destination: TravelDestination | undefined, patch: QuestConditionPatch): void {
  if (!destination) return;
  for (const placement of campaign.placements) {
    if (placement.map !== destination.map || !placementCovers(placement, quest)) continue;
    satisfyCondition(placement.condition, session, patch);
  }
}

interface AcceptStageDeclaration {
  stage: StoryStage;
  /** 实际演出地图；`mapFromWorld` 时取目的地或当前地图。 */
  map?: string;
}

/** 接取脚本自身节点里的舞台声明；接取演出不会先跳到别的脚本，不需要递归 call/next。 */
function acceptStageDeclarations(campaign: Campaign, accept: AcceptCandidate | undefined, session: Session,
  destination: TravelDestination | undefined): AcceptStageDeclaration[] {
  const script = accept ? campaign.scripts[accept.script] : undefined;
  if (!script) return [];
  const inherited = destination?.map ?? session.storyWorld.currentLocation?.map;
  const declarations: AcceptStageDeclaration[] = [];
  for (const node of script.nodes) {
    const stages: StoryStage[] = [];
    if (node.stage) stages.push(node.stage);
    for (const action of node.presentation) if (action.type === 'stage') stages.push(action);
    for (const stage of stages) declarations.push({ stage, map: stage.mapFromWorld ? inherited : stage.map });
  }
  return declarations;
}

/** 舞台 cast 引用的世界摆放：`worldEntityId` 优先，没有时按同图的角色匹配。 */
function placementForCast(campaign: Campaign, member: StoryCastMember,
  map: string | undefined): CampaignPlacement | undefined {
  if (member.worldEntityId) return campaign.placements.find(placement => placement.id === member.worldEntityId);
  if (!map || member.memberId || member.enemyId) return undefined;
  const matches = campaign.placements.filter(placement => placement.map === map
    && (member.characterId ? placement.characterId === member.characterId : placement.actor === member.actor));
  return matches.find(placement => placement.x === member.x && placement.y === member.y) ?? matches[0];
}

function needsWorldPlacement(session: Session, placement: CampaignPlacement): boolean {
  if (!session.evaluateCondition(placement.condition)) return true;
  const placed = session.storyWorld.entity(placement.id);
  if (!placed) return false;
  // 另一张地图或另一次访问留下的登记会被世界投影忽略，按没有登记处理。
  if (placed.mapVisit !== undefined && placed.mapVisit !== session.storyWorld.visit) return false;
  return placed.removed === true || placed.visible === false || placed.map !== placement.map;
}

/** 条件要求目标任务已经完成的事件一定发生在跳转点之后，不能拿来当世界状态的来源。 */
function conditionAfterQuest(condition: StoryCondition | undefined, questId: string): boolean {
  if (!condition) return false;
  switch (condition.type) {
    case 'all': return condition.conditions.some(child => conditionAfterQuest(child, questId));
    case 'any': return condition.conditions.length > 0
      && condition.conditions.every(child => conditionAfterQuest(child, questId));
    case 'quest': return condition.quest === questId
      && (condition.status === 'completed' || condition.status === 'settled');
    default: return false;
  }
}

function futureOnlyScript(campaign: Campaign, scriptName: string, questId: string): boolean {
  const events = campaign.events.filter(event => event.script === scriptName);
  return events.length > 0 && events.every(event => conditionAfterQuest(event.condition, questId));
}

/** 找真正把这个世界实体摆到目标地图的剧本节点；坐标一致优先，并排除目标任务之后的事件。 */
function worldPlaceSource(campaign: Campaign, placement: CampaignPlacement,
  questId: string): { script: string; node: string } | undefined {
  const exact: { script: string; node: string }[] = [];
  const sameMap: { script: string; node: string }[] = [];
  for (const [scriptName, script] of Object.entries(campaign.scripts)) {
    if (futureOnlyScript(campaign, scriptName, questId)) continue;
    for (const node of script.nodes) {
      let exactHit = false, mapHit = false;
      for (const command of node.commands) {
        if (command.type !== 'world' || command.command.kind !== 'place') continue;
        const entity = command.command.entity;
        if (entity.id !== placement.id || entity.map !== placement.map) continue;
        mapHit = true;
        if (entity.x === placement.x && entity.y === placement.y) exactHit = true;
      }
      if (exactHit) exact.push({ script: scriptName, node: node.id });
      else if (mapHit) sameMap.push({ script: scriptName, node: node.id });
    }
  }
  return exact[0] ?? sameMap[0];
}

/** 只有 flag/always 这类“世界应当有这个人”的条件才值得报缺来源；任务、选择和否定条件可能本来就该隐藏。 */
function placementVisibleByFlag(condition: StoryCondition | undefined): boolean {
  if (!condition) return true;
  switch (condition.type) {
    case 'always':
    case 'flag': return true;
    case 'all':
    case 'any': return condition.conditions.every(placementVisibleByFlag);
    default: return false;
  }
}

/** 重放来源节点的世界命令；任务、物品和队伍命令留给正式任务流程，不在剧情跳转里伪造。 */
function worldStateCommands(campaign: Campaign, sources: readonly { script: string; node: string }[]): StoryCommand[] {
  const commands: StoryCommand[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.script}\0${source.node}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = campaign.scripts[source.script]?.nodes.find(value => value.id === source.node);
    if (!node) continue;
    for (const command of node.commands) if (command.type === 'world' || command.type === 'flag') commands.push(command);
  }
  return commands;
}

/**
 * 接取舞台的 cast 按 `worldEntityId` 引用世界实体；正式流程里这些实体由更早的剧本用
 * `world place` + `flag` 建立。剧情跳转没有播那段上游剧情，所以要把建立实体的原始命令
 * 通过正式命令执行器重放一遍，演出本身仍走正式管线。
 */
function acceptSceneWorldCommands(campaign: Campaign, session: Session, questId: string,
  accept: AcceptCandidate | undefined, destination: TravelDestination | undefined, warnings: string[]): StoryCommand[] {
  const sources: { script: string; node: string }[] = [];
  for (const { stage, map } of acceptStageDeclarations(campaign, accept, session, destination)) {
    for (const member of stage.cast) {
      const placement = placementForCast(campaign, member, map);
      if (!placement || !needsWorldPlacement(session, placement)) continue;
      const source = worldPlaceSource(campaign, placement, questId);
      if (!source) {
        if (placementVisibleByFlag(placement.condition))
          warnings.push(`接取舞台 ${map ?? '当前地图'} 的演员 ${member.id} 需要世界摆放 ${placement.id}，但找不到对应的剧情命令`);
        continue;
      }
      sources.push(source);
    }
  }
  return worldStateCommands(campaign, sources);
}

function hasAvailableEntry(quest: CampaignQuest, accept: AcceptCandidate | undefined): boolean {
  if (accept) return true;
  const place = quest.places?.available;
  return !!place && place.type !== 'unavailable';
}

function prepareJumpHistory(campaign: Campaign, session: Session, timeline: NonNullable<ReturnType<typeof questJumpHistory>>,
  questId: string, mode: QuestStartMode, patch: QuestConditionPatch, world: StoryCommand[]): TravelDestination | undefined {
  const history: StoryCommand[] = [];
  const pastScripts = new Set(timeline.past);
  for (const name of [...timeline.past, ...timeline.future]) {
    const script = campaign.scripts[name];
    if (!script) throw new Error(`任务跳转的前后剧情缺少脚本：${name}`);
    const event = campaign.events.find(entry => entry.script === name);
    const past = pastScripts.has(name);
    if (event) (past ? patch.completedEvents : patch.removedEvents).push(event.id);
    // 玩家亲自交付、击败目标也能触发下一段。后续脚本自身未必再次写入这项任务。
    if (past && event) satisfyCondition(event.condition, session, patch);
    // 没有独立事件的接取脚本由上一项交付调用，任务定义记录其正式前置。
    if (past && !event) {
      for (const node of script.nodes) for (const command of node.commands)
        if (command.type === 'quest' && command.command.type === 'accept')
          satisfyCondition(questOf(campaign, command.command.quest)?.availableWhen, session, patch);
    }
    for (const node of script.nodes) for (const command of node.commands) {
      if (command.type === 'quest') {
        const action = command.command;
        if (!('quest' in action) || action.quest === questId) continue;
        if (past) {
          if (action.type === 'accept') pushQuestPatch(patch, action.quest,
            questOf(campaign, action.quest)?.completion === 'talk' ? 'ready' : 'active');
          if (action.type === 'script-complete') pushQuestPatch(patch, action.quest, 'completed');
          if (action.type === 'script-ready') pushQuestPatch(patch, action.quest, 'ready');
        } else if (action.type === 'accept' && ['active', 'ready', 'completed'].includes(session.status(action.quest))) {
          pushQuestPatch(patch, action.quest, 'available');
        }
      }
      if (command.type === 'flag') {
        if (past) history.push(command);
        else if (command.value !== false && session.storyWorld.hasFlag(command.flag)) {
          world.push({ ...command, value: false });
        }
      }
      if (command.type !== 'world') continue;
      const placement = command.command;
      if (past && (placement.kind === 'remove' || (placement.kind === 'place' && placement.scope !== 'visit')))
        history.push(command);
      if (!past && placement.kind === 'place' && placement.scope !== 'visit'
        && session.storyWorld.entity(placement.entity.id)?.map === placement.entity.map)
        world.push({ type: 'world', command: { kind: 'remove', id: placement.entity.id } });
    }
  }
  world.push(...history);
  if (questId === 'quest-40' && mode === 'ready') {
    const stages = campaign.scripts['event-52'].nodes.flatMap(node =>
      node.presentation.filter(action => action.type === 'stage'));
    const exit = stages.at(-1);
    if (!exit?.map) throw new Error('找不到救出圣女后的返回地点');
    return { map: exit.map, x: exit.x, y: exit.y, facing: exit.facing ?? 'south' };
  }
}

/** 所有能走到接取命令的路径，都经过这次交付（或明确检查过它已经交付）。 */
function intakeHandovers(script: StoryScript, name: string, questId: string): string[] {
  const nodes = new Map(script.nodes.map(node => [node.id, node]));
  const delivered = new Set<string>();
  for (const node of script.nodes) for (const action of node.commands)
    if (action.type === 'quest' && action.command.type === 'script-complete' && action.command.quest !== questId)
      delivered.add(action.command.quest);
  return [...delivered].filter(predecessor => {
    const pending = [script.entry], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      const node = nodes.get(id);
      if (!node || visited.has(id)) continue;
      visited.add(id);
      let handedOver = false;
      for (const action of node.commands) {
        if (action.type !== 'quest') continue;
        if (action.command.type === 'accept' && action.command.quest === questId) return false;
        if (action.command.type === 'script-complete' && action.command.quest === predecessor) { handedOver = true; break; }
      }
      if (handedOver) continue;
      const exit = node.exit;
      if (exit.type === 'branch' && conditionAfterQuest(exit.condition, predecessor)) pending.push(exit.otherwise.node);
      else for (const target of storyExitTargets(exit)) {
        // 跨脚本调用可能在外部完成接取；未知路径不能用来判定必经的交付。
        if (target.script !== name) return false;
        pending.push(target.node);
      }
    }
    return true;
  });
}

/** 已经接取或交付的前置任务，其必经的一次性接取演出也已经发生。 */
function recordPriorIntakes(campaign: Campaign, quest: CampaignQuest, intake: AcceptCandidate | undefined,
  patch: QuestConditionPatch): void {
  const pending = new Set<string>();
  const completed = new Set(patch.completedEvents);
  const reopened = new Set(patch.removedEvents);
  const sources = questIntakes(campaign);
  const requireCondition = (condition: StoryCondition | undefined): void => {
    if (condition?.type === 'all') condition.conditions.forEach(requireCondition);
    if (condition?.type === 'quest' && condition.status !== 'available' && condition.status !== 'locked')
      pending.add(condition.quest);
  };
  requireCondition(quest.availableWhen);
  requireCondition(intake?.event?.condition);
  if (intake) for (const id of intakeHandovers(campaign.scripts[intake.script], intake.script, quest.id)) pending.add(id);

  for (const id of pending) {
    if (id === quest.id) continue;
    const earlier = questOf(campaign, id);
    if (!earlier || earlier.repeat) continue;
    requireCondition(earlier.availableWhen);
    const candidates = sources.get(id);
    // 有独立接取人或可选剧情时，不能用某条可能的路线冒充必经历史。
    if (earlier.giverCharacterId || earlier.giver || candidates?.length !== 1) continue;
    const source = candidates[0];
    if (source.script === intake?.script || source.event?.repeat || (source.eventId && reopened.has(source.eventId))) continue;
    if (source.eventId) completed.add(source.eventId);
    for (const name of questJumpHistory(source.script, id, 'available')?.past ?? []) {
      const event = campaign.events.find(entry => entry.script === name);
      if (event && !event.repeat && !reopened.has(event.id)) completed.add(event.id);
    }
    requireCondition(source.event?.condition);
    for (const delivered of intakeHandovers(campaign.scripts[source.script], source.script, id)) {
      pending.add(delivered);
      if (delivered !== quest.id && !patch.quests.some(entry => entry.id === delivered))
        pushQuestPatch(patch, delivered, 'completed');
    }
  }
  patch.completedEvents = [...completed];
}

function followsProgress(condition: StoryCondition | undefined, quests: ReadonlySet<string>, events: ReadonlySet<string>): boolean {
  if (!condition) return false;
  switch (condition.type) {
    case 'quest': return quests.has(condition.quest) && !['available', 'locked'].includes(condition.status);
    case 'event': return events.has(condition.event) && condition.status === 'completed';
    case 'all': return condition.conditions.some(child => followsProgress(child, quests, events));
    case 'any': return condition.conditions.length > 0 && condition.conditions.every(child => followsProgress(child, quests, events));
    default: return false;
  }
}

/** 沿原存档中实际播过的后续演出追踪交接；独立支线和其他选择分支保留各自进度。 */
function reopenFollowups(campaign: Campaign, session: Session, questId: string, intake: AcceptCandidate | undefined,
  patch: QuestConditionPatch): void {
  const quests = new Set([questId]), events = new Set(patch.removedEvents);
  const recorded = new Set([...session.runtimeState.completedEvents, ...session.runtimeState.handledOccurrences.map(([id]) => id)]);
  const remaining = new Set(campaign.events.filter(event => recorded.has(event.id) && event.source !== 'start'
    && event.id !== intake?.eventId && !patch.completedEvents.includes(event.id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of remaining) {
      const script = campaign.scripts[event.script];
      const deliversQuest = script.nodes.some(node => node.commands.some(action => action.type === 'quest'
        && action.command.type === 'script-complete' && quests.has(action.command.quest)));
      if (!events.has(event.id) && !deliversQuest && !followsProgress(event.condition, quests, events)) continue;
      remaining.delete(event);
      events.add(event.id);
      changed = true;
      for (const node of campaign.scripts[event.script].nodes) for (const action of node.commands) {
        if (action.type !== 'quest' || action.command.type !== 'accept') continue;
        const id = action.command.quest;
        if (quests.has(id) || patch.quests.some(entry => entry.id === id && entry.status !== 'available')) continue;
        quests.add(id);
        if (['active', 'ready', 'completed'].includes(session.status(id))) pushQuestPatch(patch, id, 'available');
      }
    }
  }
  patch.removedEvents = [...events];
}

/** 规划一次“从可接取开始”的剧情跳转；只读，不改会话。 */
export function planQuestStart(campaign: Campaign, session: Session, questId: string,
  requestedMode: QuestStartMode = 'available'): QuestStartPlan {
  const quest = questOf(campaign, questId);
  if (!quest) throw new Error(`未找到任务：${questId}`);
  const candidates = acceptCandidates(campaign, session, questId);
  const intake = candidates[0];
  const internal = quest.completion === 'internal';
  const fallback = requestedMode === 'available' && (internal || !hasAvailableEntry(quest, intake));
  let mode: QuestStartMode = fallback ? (quest.completion === 'talk' ? 'ready' : 'active') : requestedMode;
  if (mode === 'active' && quest.completion === 'talk') mode = 'ready';
  const accept = mode === 'available' ? intake : undefined;
  const targetStatus: QuestStatus = mode;
  const conditionPatch = emptyPatch();
  const history: StoryCommand[] = [];
  const timeline = questJumpHistory(intake?.script, questId, mode);
  const phaseDestination = timeline && prepareJumpHistory(campaign, session, timeline, questId, mode, conditionPatch, history);
  satisfyCondition(quest.availableWhen, session, conditionPatch);
  if (intake) {
    if (accept || !timeline) satisfyCondition(intake.event?.condition, session, conditionPatch);
    for (const id of intakeHandovers(campaign.scripts[intake.script], intake.script, questId)) {
      if (!accept) { pushQuestPatch(conditionPatch, id, 'completed'); continue; }
      const status = plannedContext(session, conditionPatch).questStatus(id);
      if (status !== 'available' && status !== 'locked') continue;
      const prior = questOf(campaign, id)!;
      pushQuestPatch(conditionPatch, id, prior.completion === 'all' || prior.completion === 'talk' ? 'ready' : 'active');
    }
  }
  recordPriorIntakes(campaign, quest, intake, conditionPatch);
  reopenFollowups(campaign, session, questId, intake, conditionPatch);
  if (intake?.eventId && !accept && !conditionPatch.completedEvents.includes(intake.eventId))
    conditionPatch.completedEvents.push(intake.eventId);
  const destination = phaseDestination ?? resolveDestination(campaign, session, quest, accept, mode);
  const warnings: string[] = [];
  satisfyNpcPlacements(campaign, session, quest, destination, conditionPatch);
  const worldCommands = [...acceptSceneWorldCommands(campaign, session, questId, accept, destination, warnings), ...history];
  if (mode === 'available') {
    const final = clonePatch(conditionPatch);
    pushQuestPatch(final, questId, 'available');
    for (const command of worldCommands)
      if (command.type === 'flag') final.flags.unshift({ flag: command.flag, value: command.value ?? true });
    if (accept?.eventId) final.removedEvents.push(accept.eventId);
    const context = plannedContext(session, final);
    if (!evaluateStoryCondition(quest.availableWhen, context) || !evaluateStoryCondition(accept?.event?.condition, context))
      conditionPatch.unsatisfied.push('合并任务与现场状态后，正式接取条件仍未满足');
  }
  if (internal) warnings.push('这是日志外任务，没有可接取入口，已改为从进行中开始');
  else if (fallback) warnings.push(quest.completion === 'talk'
    ? '没有找到可接取入口，已直接放到待交付状态'
    : '没有找到可接取入口，已改为从进行中开始');
  if (accept && candidates.length > 1) warnings.push(`找到 ${candidates.length} 个接取脚本，已选 ${accept.script}`);
  if (conditionPatch.unsatisfied.length)
    warnings.push(`接取剧情有无法自动补齐的条件：${conditionPatch.unsatisfied.join('；')}`);
  if (!destination) warnings.push('没有找到任务开始位置，跳转后停留在当前地图');

  const changed = new Map<string, QuestStatusChange>();
  const addChange = (id: string, to: QuestStatus): void => {
    const definition = questOf(campaign, id);
    if (!definition) return;
    const from = session.status(id);
    if (from === to) return;
    changed.set(id, { id, title: definition.title, from, to });
  };
  for (const entry of conditionPatch.quests) {
    if (entry.id === questId) continue;
    addChange(entry.id, entry.status);
  }
  addChange(questId, targetStatus);

  return {
    questId, quest, mode,
    changedQuests: [...changed.values()],
    ...(accept ? { accept: { script: accept.script, ...(accept.eventId ? { eventId: accept.eventId } : {}) } } : {}),
    acceptAlternatives: candidates.map(candidate => ({
      script: candidate.script, ...(candidate.eventId ? { eventId: candidate.eventId } : {}) })),
    conditionPatch, worldCommands, ...(destination ? { destination } : {}), warnings, fallback,
  };
}

function zeroGoals(quest: CampaignQuest): Record<string, number> {
  return Object.fromEntries(quest.goals.map(goal => [goal.id, 0]));
}

function fullGoals(quest: CampaignQuest): Record<string, number> {
  return Object.fromEntries(quest.goals.map(goal => [goal.id, goal.quantity]));
}

function patchedProgress(quest: CampaignQuest, current: QuestProgress, status: QuestStatus): QuestProgress {
  const base = {
    cycle: current.cycle + (current.status === 'completed' && status !== 'completed' ? 1 : 0),
    completedCycles: current.completedCycles,
  };
  if (status === 'completed') return { ...base, status, goals: current.goals, completedCycles: Math.max(1, base.completedCycles) };
  if (status === 'ready') return { ...base, status, goals: fullGoals(quest) };
  return { ...base, status, goals: zeroGoals(quest) };
}

/** 放回剧情战斗之前的现场时，一并丢弃旧实例和它留下的清场命令。 */
function rewindEncounters(session: Session, removedEvents: ReadonlySet<string>): void {
  const definitions = new Set<string>();
  for (const event of session.campaign.events) {
    if (!removedEvents.has(event.id)) continue;
    for (const node of session.campaign.scripts[event.script].nodes)
      if (node.exit.type === 'waitEncounter') definitions.add(node.exit.encounter.id);
  }
  if (!definitions.size) return;
  const world = session.storyWorld.captureState();
  const encounters = world.encounters.filter(entry => entry.definitionId && definitions.has(entry.definitionId));
  if (!encounters.length) return;
  const ids = new Set(encounters.map(encounter => encounter.id));
  const spawns = new Set(encounters.flatMap(encounter =>
    encounter.spawns.map(spawn => encounterSpawnId(encounter.id, spawn.id))));
  world.encounters = world.encounters.filter(entry => !ids.has(entry.id));
  world.entities = world.entities.filter(entity => !spawns.has(entity.id));
  world.enemyRemovals = world.enemyRemovals?.filter(removal => !encounters.some(encounter =>
    (!removal.map || encounter.map === removal.map) && encounter.spawns.some(spawn => spawn.enemyId === removal.enemyId)));
  session.storyWorld.restoreState(world);
  for (const id of spawns) session.forgetEnemyVitals(id);
}

/**
 * 把计划写进会话：任务簿、选择/标志和运行时事件。
 * 这里不切图、不开演；调用方负责先暂停触发，再传送和播放。
 */
export function applyQuestStartPlan(session: Session, plan: QuestStartPlan): void {
  const targetQuest = questOf(session.campaign, plan.questId)!;
  const targetInternal = targetQuest.completion === 'internal';
  const current = session.questBook.captureState();
  const states = new Map<string, QuestProgress>(current.quests.map(([id, progress]) => [id, progress]));
  const quests = new Map(plan.changedQuests.map(change => [change.id, change.to]));
  // 先回到任务状态机的入口：普通任务放成可接取，内部任务放成锁定；
  // 后续用真实的 `quest accept` 命令走到 active/ready，不让调试层复制状态规则。
  quests.set(plan.questId, targetInternal ? 'locked' : 'available');
  for (const [id, status] of quests) {
    const quest = questOf(session.campaign, id);
    const progress = states.get(id);
    if (!quest || !progress) continue;
    states.set(id, patchedProgress(quest, progress, status));
  }
  // 运行池必须和 active/ready 完全一致；保留原有顺序，新增任务按内容顺序补齐。
  const nextRunning = [...current.runningQuestIds].filter(id => {
    const status = states.get(id)?.status;
    return status === 'active' || status === 'ready';
  });
  for (const quest of session.campaign.quests) {
    const status = states.get(quest.id)?.status;
    if ((status === 'active' || status === 'ready') && !nextRunning.includes(quest.id)) nextRunning.push(quest.id);
  }
  const state: QuestBookState = {
    ...current,
    quests: [...states],
    runningQuestIds: nextRunning,
  };
  session.questBook.installTrustedState(state);

  if (!targetInternal) session.questBook.forceAvailable(plan.questId, true);
  for (const entry of plan.conditionPatch.quests)
    if (entry.status === 'available' && entry.id !== plan.questId) session.questBook.forceAvailable(entry.id, true);
  // 条件任务的状态变化可能解锁/锁住别的任务；强制集合已经在视图里生效。
  session.questBook.commit(session.questBook.plan({ type: 'refresh' }));

  const commands: StoryCommand[] = [
    ...plan.conditionPatch.choices.map(entry => ({ type: 'choice' as const, choice: entry.choice, value: entry.value })),
    ...plan.conditionPatch.flags.map(entry => ({ type: 'flag' as const, flag: entry.flag, value: entry.value })),
    ...plan.worldCommands,
  ];
  if (commands.length) session.applyStoryCommands(commands);

  // 接取剧情要求 ready/active 时，普通刷新会按背包物品把状态改回去；把条件任务钉住。
  for (const entry of plan.conditionPatch.quests) {
    if (entry.id === plan.questId || (entry.status !== 'active' && entry.status !== 'ready')) continue;
    const quest = questOf(session.campaign, entry.id);
    const progress = session.quests.get(entry.id);
    if (!quest || !progress) continue;
    session.questBook.forceProgress(entry.id, patchedProgress(quest, progress, entry.status));
  }

  // 跳转起点补齐这批任务需要的交付物品；否则接取/完成脚本会在 handoverItems 检查处中断。
  const itemQuestIds = new Set([plan.questId, ...plan.conditionPatch.quests
    .filter(entry => entry.status === 'active' || entry.status === 'ready').map(entry => entry.id)]);
  for (const id of itemQuestIds) {
    const quest = questOf(session.campaign, id);
    for (const item of quest?.handoverItems ?? []) {
      const held = session.bag.count(item.item);
      if (held < item.quantity) session.bag.add(item.item, item.quantity - held);
    }
  }

  // 待交付/进行中起点走真实接取命令：talk 自动变 ready，周期、运行池和接取物品都由任务簿决定。
  if (plan.mode !== 'available') {
    const cycle = session.questBook.state(plan.questId)?.cycle;
    session.applyStoryCommands([{
      type: 'quest',
      command: {
        type: 'accept', quest: plan.questId,
        ...(cycle !== undefined ? { cycle } : {}),
        ...(targetInternal ? { source: 'script' as const } : {}),
      },
    }]);
  }

  if (plan.mode === 'ready' && session.status(plan.questId) !== 'ready') {
    if (targetQuest.completion === 'all') {
      for (const goal of targetQuest.goals.filter(goal => goal.kind === 'item')) {
        const missing = goal.quantity - session.bag.count(goal.target);
        if (missing > 0) session.bag.add(goal.target, missing);
      }
      const snapshot = session.questBook.captureState();
      const entry = snapshot.quests.find(([id]) => id === plan.questId)!;
      entry[1] = patchedProgress(targetQuest, entry[1], 'ready');
      session.questBook.installTrustedState(snapshot);
    } else {
      session.applyStoryCommands([{ type: 'quest', command: { type: 'script-ready', quest: plan.questId } }]);
    }
  }

  const runtime = structuredClone(session.runtimeState);
  const removed = new Set([...plan.conditionPatch.removedEvents, ...(plan.accept?.eventId ? [plan.accept.eventId] : [])]);
  // 任何剧情跳转都发生在游戏开场之后；不记录 start 事件，换图时会再次尝试播放开场。
  const startEvents = session.campaign.events
    .filter(event => event.source === 'start')
    .map(event => event.id);
  const completed = [...new Set([...runtime.completedEvents, ...plan.conditionPatch.completedEvents, ...startEvents])]
    .filter(id => !removed.has(id));
  const removedSequences = new Set([...removed].flatMap(id =>
    STORY_TRIGGER_SOURCES.map(source => JSON.stringify([id, source]))));
  rewindEncounters(session, removed);
  session.runtimeState = {
    ...runtime,
    completedEvents: completed,
    runs: runtime.runs.filter(run => !run.eventId || !removed.has(run.eventId)),
    handledOccurrences: runtime.handledOccurrences.filter(([id]) => !removed.has(id)),
    occurrenceSequences: runtime.occurrenceSequences.filter(([key]) => !removedSequences.has(key)),
  };
  session.emit();
}
