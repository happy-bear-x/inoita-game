import type { Campaign, CampaignPlacement, CampaignQuest } from '../domain/campaign.ts';
import type { Facing, QuestStatus, TravelDestination } from '../domain/content.ts';
import type { QuestBookState, QuestProgress } from '../domain/quest-book.ts';
import { storyConditionReferences, type StoryCondition } from '../domain/story-condition.ts';
import type { StoryCommand, StoryEvent, StoryPlace } from '../domain/story-graph.ts';
import type { StoryCastMember, StoryStage } from '../domain/story-performance.ts';
import type { Session } from '../domain/session.ts';

export type QuestStartMode = 'available' | 'active' | 'ready';

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

function groupOf(campaign: Campaign, questId: string) {
  return campaign.questGroups.find(group => group.questIds.includes(questId));
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

function previousGroupQuests(campaign: Campaign, questId: string): string[] {
  const group = groupOf(campaign, questId);
  if (!group) return [];
  const index = group.questIds.indexOf(questId);
  return index <= 0 ? [] : group.questIds.slice(0, index);
}

/**
 * 找出脚本里接受目标任务的位置，并把它和直接使用这条脚本的事件关联起来。
 * 优先选条件已经满足的事件，再按来源从“任务/区域/近身”到“选择/事件”排序。
 */
function acceptCandidates(campaign: Campaign, session: Session, questId: string): AcceptCandidate[] {
  const candidates: AcceptCandidate[] = [];
  const seen = new Set<string>();
  for (const [scriptName, script] of Object.entries(campaign.scripts)) {
    for (const node of script.nodes) {
      for (const command of node.commands) {
        if (command.type !== 'quest' || command.command.type !== 'accept' || command.command.quest !== questId) continue;
        const events = campaign.events.filter(event => event.script === scriptName);
        if (!events.length) {
          const key = `${scriptName}\0`;
          if (!seen.has(key)) { seen.add(key); candidates.push({ script: scriptName }); }
          continue;
        }
        for (const event of events) {
          const key = `${scriptName}\0${event.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ script: scriptName, eventId: event.id, event });
        }
      }
    }
  }
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

/** 逐叶补接取剧情自己的条件；只补这一段剧情需要的任务/选择/标志/事件。 */
function satisfyCondition(condition: StoryCondition | undefined, session: Session, patch: QuestConditionPatch): boolean {
  if (!condition || session.evaluateCondition(condition)) return true;
  const context = session.conditionContext();
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
      // 当前 `not X` 不成立，要让 X 成立。
      const trial = clonePatch(patch);
      if (satisfyCondition(condition.condition, session, trial)) { mergePatch(patch, trial); return true; }
      patch.unsatisfied.push(`无法让否定条件成立：${condition.type}`);
      return false;
    }
    case 'quest': {
      const current = context.questStatus(condition.quest);
      if (condition.status === 'accepted') {
        if (['active', 'ready', 'completed'].includes(current)) return true;
        pushQuestPatch(patch, condition.quest, 'completed');
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
  const eventSpot = spotOf(place, location);
  const stagePlace = mode === 'available'
    ? quest.places?.available
    : mode === 'ready' ? quest.places?.ready ?? quest.places?.active : quest.places?.active;
  const stageSpot = spotOf(stagePlace, location, npcMaps(campaign, quest));
  const spot = eventSpot ?? stageSpot ?? giverSpot(campaign, session, quest);
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

/** 重放来源节点的世界命令；任务、物品和队伍命令留给正式任务流程，不在调试跳转里伪造。 */
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
 * `world place` + `flag` 建立。调试跳转没有播那段上游剧情，所以要把建立实体的原始命令
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

/** 规划一次“从可接取开始”的调试跳转；只读，不改会话。 */
export function planQuestStart(campaign: Campaign, session: Session, questId: string,
  requestedMode: QuestStartMode = 'available'): QuestStartPlan {
  const quest = questOf(campaign, questId);
  if (!quest) throw new Error(`未找到任务：${questId}`);
  const candidates = acceptCandidates(campaign, session, questId);
  const accept = candidates[0];
  const conditionPatch = emptyPatch();
  // 目标任务自己的 `availableWhen` 多数只引用前置任务；先补这些，接取剧情条件再覆盖。
  satisfyCondition(quest.availableWhen, session, conditionPatch);
  if (accept?.event) satisfyCondition(accept.event.condition, session, conditionPatch);
  const internal = quest.completion === 'internal';
  const fallback = requestedMode === 'available' && (internal || !hasAvailableEntry(quest, accept));
  let mode: QuestStartMode = fallback ? (quest.completion === 'talk' ? 'ready' : 'active') : requestedMode;
  // 对话任务没有进行中阶段：接取后引擎直接写 ready，调试起点也不能造出不存在的 active。
  if (mode === 'active' && quest.completion === 'talk') mode = 'ready';
  const targetStatus: QuestStatus = mode;

  const destination = resolveDestination(campaign, session, quest, accept, mode);
  const warnings: string[] = [];
  satisfyNpcPlacements(campaign, session, quest, destination, conditionPatch);
  const worldCommands = acceptSceneWorldCommands(campaign, session, questId, accept, destination, warnings);
  if (internal) warnings.push('这是内部任务，没有可接取入口，已改为从进行中开始');
  else if (fallback) warnings.push(quest.completion === 'talk'
    ? '没有找到可接取入口，已直接放到待交付状态'
    : '没有找到可接取入口，已改为从进行中开始');
  if (candidates.length > 1) warnings.push(`找到 ${candidates.length} 个接取脚本，已选 ${accept?.script}`);
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
  for (const id of previousGroupQuests(campaign, questId)) addChange(id, 'completed');
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
  const base = { cycle: current.cycle, completedCycles: current.completedCycles };
  if (status === 'completed') return { ...base, status, goals: current.goals };
  if (status === 'ready') return { ...base, status, goals: fullGoals(quest) };
  if (status === 'active') return { ...base, status, goals: zeroGoals(quest) };
  if (status === 'available') return {
    ...base, status, goals: zeroGoals(quest),
    cycle: current.cycle + (current.status === 'completed' ? 1 : 0),
  };
  return { ...base, status, goals: zeroGoals(quest) };
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
    if (entry.id === plan.questId) continue;
    const quest = questOf(session.campaign, entry.id);
    const progress = session.quests.get(entry.id);
    if (!quest || !progress) continue;
    session.questBook.forceProgress(entry.id, patchedProgress(quest, progress, entry.status));
  }

  // 调试起点补齐这批任务需要的交付物品；否则接取/完成脚本会在 handoverItems 检查处中断。
  const itemQuestIds = new Set<string>([...quests.keys(), ...plan.conditionPatch.quests.map(entry => entry.id)]);
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

  const runtime = structuredClone(session.runtimeState);
  const removed = new Set([...plan.conditionPatch.removedEvents, ...(plan.accept?.eventId ? [plan.accept.eventId] : [])]);
  // 任何任务调试都发生在游戏开场之后；不记录 start 事件，换图时会再次尝试播放开场。
  const startEvents = session.campaign.events
    .filter(event => event.source === 'start')
    .map(event => event.id);
  const completed = [...new Set([...runtime.completedEvents, ...plan.conditionPatch.completedEvents, ...startEvents])]
    .filter(id => !removed.has(id));
  session.runtimeState = {
    ...runtime,
    completedEvents: completed,
    handledOccurrences: runtime.handledOccurrences.filter(([id]) => !removed.has(id)),
  };
  session.emit();
}


const focusEventCache = new WeakMap<Campaign, Map<string, string[]>>();

function collectQuestReferences(value: unknown, output: Set<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectQuestReferences(item, output);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'quest' && typeof child === 'string') { output.add(child); continue; }
    collectQuestReferences(child, output);
  }
}

/** 每个任务被哪些事件剧本引用；只扫事件真正用到的脚本，按 campaign 对象缓存。 */
function questScriptEvents(campaign: Campaign): Map<string, string[]> {
  const cached = focusEventCache.get(campaign);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  const perScript = new Map<string, Set<string>>();
  for (const event of campaign.events) {
    let questIds = perScript.get(event.script);
    if (!questIds) {
      questIds = new Set<string>();
      const script = campaign.scripts[event.script];
      for (const node of script?.nodes ?? []) {
        collectQuestReferences(node.commands, questIds);
        collectQuestReferences(node.presentation, questIds);
      }
      perScript.set(event.script, questIds);
    }
    for (const questId of questIds) {
      const events = index.get(questId);
      if (events) events.push(event.id); else index.set(questId, [event.id]);
    }
  }
  focusEventCache.set(campaign, index);
  return index;
}

const focusConditionCache = new WeakMap<Campaign, Map<string, string[]>>();

/** 哪些事件的触发条件引用了某个任务；用于从完成事件反向找到它的前置事件。 */
function questConditionEvents(campaign: Campaign): Map<string, string[]> {
  const cached = focusConditionCache.get(campaign);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const event of campaign.events) {
    for (const questId of storyConditionReferences(event.condition).quests) {
      const events = index.get(questId);
      if (events) events.push(event.id); else index.set(questId, [event.id]);
    }
  }
  focusConditionCache.set(campaign, index);
  return index;
}

/**
 * 调试运行只自动播放与目标任务有关的剧情事件；显式播放的接取剧情不受此集合限制。
 *
 * 除了直接引用目标任务的事件，还沿事件条件反向展开：完成事件条件里的前置任务，
 * 由哪些事件的脚本/条件提供，这些事件也属于本轮剧情链。`satisfied` 里的任务已经由
 * 调试起点补好，不再把生产它们的历史事件放进来。
 */
export function questFocusEventIds(campaign: Campaign, quest: CampaignQuest, acceptEventId?: string,
  satisfied: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  const eventsById = new Map(campaign.events.map(event => [event.id, event]));
  const scriptEvents = questScriptEvents(campaign);
  const conditionEvents = questConditionEvents(campaign);
  const ids = new Set<string>();
  const pending: string[] = [];
  const seed = (id: string | undefined): void => { if (id && !ids.has(id)) pending.push(id); };
  seed(acceptEventId);
  seed(quest.interactionEvent);
  const scripts = new Set([quest.offerScript, quest.completeScript]
    .filter((value): value is string => !!value));
  for (const event of campaign.events) if (scripts.has(event.script)) seed(event.id);
  for (const eventId of scriptEvents.get(quest.id) ?? []) seed(eventId);
  for (const eventId of conditionEvents.get(quest.id) ?? []) seed(eventId);

  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    const event = eventsById.get(id);
    if (!event) continue;
    for (const required of storyConditionReferences(event.condition).quests) {
      if (required === quest.id || satisfied.has(required)) continue;
      for (const provider of scriptEvents.get(required) ?? []) if (!ids.has(provider)) pending.push(provider);
      for (const provider of conditionEvents.get(required) ?? []) if (!ids.has(provider)) pending.push(provider);
    }
  }
  return ids;
}
