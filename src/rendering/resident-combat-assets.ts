import { resolveBasicAttack } from '../domain/basic-attack.ts';
import type { BattleCatalog } from '../domain/battle.ts';
import { feedbackEffects } from '../domain/combat-feedback.ts';
import { COMBAT_OUTCOME_EFFECTS } from '../domain/combat-outcomes.ts';
import type { WorldIndex } from '../domain/content.ts';
import type { CompanionCatalog } from '../domain/party.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { classSummonEnemyIds, enemyCombatAssets } from './combat-assets.ts';
import {
  characterAssets, classEffects, combatFeedbackAssets, combatOutcomeAssets, effectAssets,
  sharedCombatEffectMap, type EffectMap
} from './combat-asset-descriptors.ts';
import type { PendingAsset } from './scene-assets.ts';

export interface ResidentCombatInput {
  battle: BattleCatalog;
  wardrobe: WardrobeCatalog;
  world: WorldIndex;
  companions: CompanionCatalog;
  /**
   * 省略 = 全部职业（构建期全量校验）；运行时只传当前主角职业。
   */
  classIds?: Iterable<string>;
  /**
   * 已拥有的伙伴外观定义 id。省略 = 全部伙伴（构建期全量校验）；
   * 运行时只传当前队伍已拥有的伙伴，未拥有的成员按需加载。
   */
  ownedCompanionIds?: Iterable<string>;
  /**
   * 已学技能 id（主角与已拥有伙伴的并集）。省略 = 全部技能（构建期全量校验）；
   * 运行时只装已学技能的动画特效与召唤物。
   */
  learnedSkillIds?: Iterable<string>;
  /** 正式游玩只常驻通用反馈，角色、武器与技能交给当前地图及施法者持有。 */
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
 * 运行时通过 feedbackOnly 持有通用反馈，职业、装备与技能由地图及使用者准备。
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
        if (JSON.stringify(previous) !== JSON.stringify(asset)) throw new Error(`贴图键指向不同资源：${asset.key}`);
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
    addAssets(characterAssets(character.actor));
    const attack = resolveBasicAttack(battle, { actor: character.actor, basicAttack: character.basicAttack });
    addEffects(classEffects(battle, character, attack, wardrobe, learnedSkills));
    for (const id of classSummonEnemyIds(battle, classId, learnedSkills)) {
      const definition = battle.enemies.find(enemy => enemy.id === id);
      if (!definition) throw new Error(`召唤物定义缺失：${id}`);
      addAssets(enemyCombatAssets(battle, definition));
    }
    for (const skillId of character.skills) {
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
  if (input.feedbackOnly) return { assets: [...assets.values()], effectNames, actorIds };
  const selectedClasses = input.classIds === undefined ? undefined : new Set(input.classIds);
  if (selectedClasses) for (const id of selectedClasses)
    if (!battle.classes.some(character => character.id === id)) throw new Error(`常驻战斗包职业不存在：${id}`);
  for (const character of battle.classes)
    if (!selectedClasses || selectedClasses.has(character.id)) addClass(character.id);
  // 佣兵的基础外观只装已拥有的成员；招募后由队伍面板和战斗开场按需加载。
  const selectedCompanions = input.ownedCompanionIds === undefined ? undefined : new Set(input.ownedCompanionIds);
  if (selectedCompanions) for (const id of selectedCompanions)
    if (!companions.definitions[id]) throw new Error(`常驻战斗包伙伴不存在：${id}`);
  for (const [id, definition] of Object.entries(companions.definitions)) {
    if (selectedCompanions && !selectedCompanions.has(id)) continue;
    const actor = world.actors[definition.actor];
    if (!actor) continue;
    actorIds.add(actor.id);
    addAssets(characterAssets(actor));
  }
  return { assets: [...assets.values()], effectNames, actorIds };
}
