import type { EntityPlacement, WorldMap } from '../domain/content.ts';
import { learnedSkillIds } from '../domain/skill-configuration.ts';
import { localStoryScripts, storyReachableScripts } from '../domain/story-entry.ts';
import { residentCombatAssets } from '../rendering/resident-combat-assets.ts';
import { planMapCombat, planMapVisuals, potentialMapEnemyIds, sharedEntryAssets, storyPresentationAssets, type MapVisualPlan, type WorldAssetInputs } from '../rendering/map-assets.ts';
import type { PendingAsset } from '../rendering/scene-assets.ts';

interface MapEntryPlan {
  map: WorldMap;
  visuals: MapVisualPlan;
  /** 进入这张地图要加载的全部场景资源（不含 shared）。 */
  assets: PendingAsset[];
}

/**
 * 进图计划只保证落脚图可玩，首次进入世界时额外并入当前队伍已拥有的佣兵外观。
 * 后续剧情地图不在这里读取或预取，换图时由目标图自己的入口加载。
 */
export interface EntryPlan {
  current: MapEntryPlan;
  shared: PendingAsset[];
  /** 首次进入世界时与主入口一起加载的玩家侧战斗资源；常驻后不再出现。 */
  residentCombat?: PendingAsset[];
  portraits: string[];
  sounds: string[];
  /**
   * 本图可能触发的剧情脚本（含读档时运行中的脚本，已经过 call/分支展开）。
   * 进图加载用它收集本图这段演出的立绘与音效，开演前就不用再补。
   */
  scripts: string[];
}

interface EntryPlanInput {
  currentMap: WorldMap;
  /** 当前图已经投影出来的实体；用于按实际随机结果加载。 */
  currentEntities?: readonly EntityPlacement[];
  inputs: WorldAssetInputs;
  /** 已完成的剧情事件；start 事件完成后不再算本图脚本。 */
  completedEvents?: readonly string[];
  /** 当前会话的任务状态：进行中的任务可能在这张图上把 quest 事件推进到可触发。 */
  questStatus?: (id: string) => string;
  /** 读档/失败恢复时运行中的剧情游标，必须一起计入当前图闭包。 */
  activeScripts?: Iterable<string>;
  checkpoint?: { roster: { enemies: readonly { enemyId: string }[] } };
  /** 首次进入世界时把玩家侧战斗资源并入第一次 load；已常驻时传 false。 */
  includeResidentCombat?: boolean;
}

function mapPlan(map: WorldMap, input: EntryPlanInput, scripts: readonly string[]): MapEntryPlan {
  const visuals = planMapVisuals(map, input.inputs, {
    entities: input.currentEntities,
    scripts
  });
  const combat = planMapCombat(map, input.inputs, {
    scripts,
    ...(input.currentEntities ? { entities: input.currentEntities } : {}),
    ...(input.checkpoint ? { checkpointEnemies: input.checkpoint.roster.enemies.map(enemy => enemy.enemyId) } : {})
  });
  return { map, visuals, assets: [...visuals.assets, ...combat] };
}

/** 一次进图真正要交给加载器的资源；进入地图和演出前补素材共用这一份口径。 */
export function entryPlanAssets(plan: EntryPlan): PendingAsset[] {
  return [...plan.shared, ...plan.current.assets, ...(plan.residentCombat ?? [])];
}

/**
 * 常驻包只装主角和已拥有伙伴真正学会的技能。
 * 没有主角技能配置时返回 undefined，保持构建期/测试的全量口径。
 */
function residentLearnedSkills(inputs: WorldAssetInputs): Set<string> | undefined {
  if (!inputs.heroSkills) return undefined;
  const learned = new Set<string>();
  for (const id of learnedSkillIds(inputs.battle, inputs.hero.classId, inputs.heroSkills)) learned.add(id);
  for (const member of inputs.party?.snapshot().members ?? []) {
    if (!inputs.companions.definitions[member.definitionId]) continue;
    for (const [id, level] of Object.entries(member.skillLevels)) if (level > 0) learned.add(id);
  }
  return learned;
}

export function buildEntryPlan(input: EntryPlanInput): EntryPlan {
  const { campaign } = input.inputs;
  const localEnemies = potentialMapEnemyIds(input.currentMap, input.inputs, { scripts: [] });
  const local = localStoryScripts({
    campaign,
    map: input.currentMap,
    entities: input.currentEntities,
    completedEvents: input.completedEvents,
    questStatus: input.questStatus,
    enemyIds: localEnemies
  });
  const roots = [...new Set([...local, ...(input.activeScripts ?? [])])];
  // 只沿脚本自身的 call/分支展开：这些节点会在本图这段演出里直接执行。
  // 不展开任务/事件链，也不读取后续地图；跨图素材由目标图入口在换图时加载。
  const scripts = storyReachableScripts(campaign, roots);
  const presentation = storyPresentationAssets(campaign, scripts, input.inputs);
  return {
    current: mapPlan(input.currentMap, input, scripts),
    shared: sharedEntryAssets(input.inputs),
    ...(input.includeResidentCombat ? {
      residentCombat: residentCombatAssets({
        battle: input.inputs.battle, wardrobe: input.inputs.wardrobe,
        world: input.inputs.world, companions: input.inputs.companions,
        classIds: [input.inputs.hero.classId],
        ownedCompanionIds: input.inputs.party?.ownedDefinitionIds() ?? [],
        learnedSkillIds: residentLearnedSkills(input.inputs)
      }).assets
    } : {}),
    portraits: presentation.portraits,
    sounds: presentation.sounds,
    scripts
  };
}
