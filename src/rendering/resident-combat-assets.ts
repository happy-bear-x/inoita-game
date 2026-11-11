import { resolveBasicAttack } from '../domain/basic-attack.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import { feedbackEffects } from '../domain/combat-feedback.ts';
import { COMBAT_OUTCOME_EFFECTS } from '../domain/combat-outcomes.ts';
import type { WorldIndex, ClipName } from '../domain/content.ts';
import type { CompanionCatalog } from '../domain/party.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { classSummonEnemyIds, enemyCombatAssets } from './combat-assets.ts';
import {
  characterAssets, classEffects, combatFeedbackAssets, combatOutcomeAssets, effectAssets,
  sharedCombatEffectMap, type EffectMap
} from './combat-asset-descriptors.ts';
import type { PendingAsset } from './scene-assets.ts';
import { mergePendingAsset } from './scene-assets.ts';
import { targetFocusAssets } from './target-focus-assets.ts';

export interface ResidentCombatInput {
  battle: BattleCatalog;
  wardrobe: WardrobeCatalog;
  world: WorldIndex;
  companions: CompanionCatalog;
  /**
   * 省略 = 全部职业（构建期全量校验）；运行时可只传主角与已拥有成员的职业。
   */
  classIds?: Iterable<string>;
  /**
   * 只装职业的基础动作（idle/walk/attack/die 等），技能动作按已学技能装载。
   * 标题页公共预载为 true；进图常驻包保留全量动作，构建期也省略。
   */
  baseOnlyClasses?: boolean;
  /**
   * 伙伴外观范围。省略 = 全部伙伴；运行时也省略，只限定具体成员时才传。
   * 默认装配每个 actor 的全部动作；`baseOnlyCompanions` 为真时只装非技能动作。
   */
  ownedCompanionIds?: Iterable<string>;
  /**
   * 只装伙伴的基础动作（idle/walk/attack/die 等），技能动作按使用者装载。
   * 运行时为 true；构建期省略以保留全量覆盖校验。
   */
  baseOnlyCompanions?: boolean;
  /**
   * 已学技能 id（主角与已拥有伙伴的并集）。省略 = 全部技能（构建期全量校验）；
   * 运行时只装已学技能的动画特效与召唤物。
   */
  learnedSkillIds?: Iterable<string>;
  /** 只装通用反馈与战斗结果，用于调试或轻量场景；正式游玩不使用。 */
  feedbackOnly?: boolean;
}

/** 会话常驻的战斗视觉资源：一次加载，切图与战斗结束都不释放。 */
interface CombatAssetPack {
  assets: PendingAsset[];
  /** 计划覆盖的特效名，构建期用它核对运行时引用。 */
  effectNames: Set<string>;
  actorIds: Set<string>;
}

/**
 * 会话常驻的战斗视觉资源：伙伴基础动作、主角与已拥有成员已学技能的特效。
 * 构建期默认枚举全部玩家资源，也可指定职业、伙伴和技能范围核对覆盖。
 * 同一纹理键必须指向同一文件和帧配置，否则直接报错。
 */
export function residentCombatAssets(input: ResidentCombatInput): CombatAssetPack {
  const { battle, wardrobe, world, companions } = input;
  const assets = new Map<string, PendingAsset>();
  const effectNames = new Set<string>();
  const actorIds = new Set<string>();
  const addAssets = (list: readonly PendingAsset[]): void => {
    for (const asset of list) {
      const previous = assets.get(asset.key);
      if (previous) {
        assets.set(asset.key, mergePendingAsset(previous, asset));
        continue;
      }
      assets.set(asset.key, asset);
    }
  };
  const addEffects = (effects: EffectMap): void => {
    for (const name of Object.keys(effects)) effectNames.add(name);
    addAssets(effectAssets(effects));
  };
  const learnedSkills = input.learnedSkillIds === undefined ? undefined : new Set(input.learnedSkillIds);
  const addClass = (classId: string): void => {
    const character = battle.classes.find(value => value.id === classId);
    if (!character) return;
    actorIds.add(character.actor.id);
    const clips: ClipName[] | undefined = input.baseOnlyClasses
      ? (Object.keys(character.actor.clips) as ClipName[]).filter(name => !name.startsWith('skill-'))
      : undefined;
    addAssets(characterAssets(character.actor, clips));
    const attack = resolveBasicAttack(battle, { actor: character.actor, basicAttack: character.basicAttack });
    addEffects(classEffects(battle, character, attack, wardrobe, learnedSkills));
    for (const id of classSummonEnemyIds(battle, classId, learnedSkills)) {
      const definition = battle.enemies.find(enemy => enemy.id === id);
      if (!definition) throw new Error(`召唤物定义缺失：${id}`);
      addAssets(enemyCombatAssets(battle, definition));
    }
    for (const skillId of character.skills) {
      if (learnedSkills && !learnedSkills.has(skillId)) continue;
      const icon = battle.skills[skillId].icon;
      addAssets([{ kind: 'image', key: icon, file: icon }]);
    }
  };

  const shared = sharedCombatEffectMap(battle, wardrobe, !input.feedbackOnly);
  addEffects(shared);
  for (const name of feedbackEffects(battle.feedback)) effectNames.add(name);
  for (const name of COMBAT_OUTCOME_EFFECTS) effectNames.add(name);
  addAssets(combatOutcomeAssets(battle));
  addAssets(combatFeedbackAssets(battle));
  // 脚下选中圈在探索和战斗里都用，体量很小，随标题页公共批次常驻，进图不再等它。
  addAssets(targetFocusAssets);
  if (input.feedbackOnly) return { assets: [...assets.values()], effectNames, actorIds };
  const selectedClasses = input.classIds === undefined ? undefined : new Set(input.classIds);
  if (selectedClasses) for (const id of selectedClasses)
    if (!battle.classes.some(character => character.id === id)) throw new Error(`常驻战斗包职业不存在：${id}`);
  for (const character of battle.classes)
    if (!selectedClasses || selectedClasses.has(character.id)) addClass(character.id);
  // 伙伴基础动作全部常驻，招募后立刻能进场；技能动作与特效按使用者装载。
  const selectedCompanions = input.ownedCompanionIds === undefined ? undefined : new Set(input.ownedCompanionIds);
  if (selectedCompanions) for (const id of selectedCompanions)
    if (!companions.definitions[id]) throw new Error(`常驻战斗包伙伴不存在：${id}`);
  for (const [id, definition] of Object.entries(companions.definitions)) {
    if (selectedCompanions && !selectedCompanions.has(id)) continue;
    const actor = world.actors[definition.actor];
    if (!actor) continue;
    actorIds.add(actor.id);
    const clips: ClipName[] | undefined = input.baseOnlyCompanions
      ? (Object.keys(actor.clips) as ClipName[]).filter(name => !name.startsWith('skill-'))
      : undefined;
    addAssets(characterAssets(actor, clips));
  }
  return { assets: [...assets.values()], effectNames, actorIds };
}
