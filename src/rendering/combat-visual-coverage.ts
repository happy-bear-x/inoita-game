import { buffEffectNames } from '../domain/buff-effects.ts';
import { feedbackEffects } from '../domain/combat-feedback.ts';
import { COMBAT_OUTCOME_EFFECTS } from '../domain/combat-outcomes.ts';
import { skillEffectNames } from '../domain/skill-action.ts';
import { skillReactionEffects } from '../domain/skill-reactions.ts';
import { skillForGrowth, type BattleCatalog } from '../domain/battle.ts';
import type { ActorDefinition, WorldIndex } from '../domain/content.ts';
import type { CompanionCatalog } from '../domain/party.ts';
import type { WardrobeCatalog } from '../domain/wardrobe.ts';
import { basicAttackEffects, characterAssets, stateMarkerEffects } from './combat-asset-descriptors.ts';
import { classSummonEnemyIds, enemyCombatAssets, partyMemberCombatAssets } from './combat-assets.ts';
import { residentCombatAssets, type ResidentCombatInput } from './resident-combat-assets.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../generated/effect-atlas.ts';
import { CHARACTER_ATLAS_PAGES } from '../generated/character-atlas.ts';
import { characterAtlasEntry } from './character-atlas.ts';

interface CoverageInput extends ResidentCombatInput {
  battle: BattleCatalog;
  wardrobe: WardrobeCatalog;
  world: WorldIndex;
  companions: CompanionCatalog;
}

interface CoverageGaps {
  /** 运行时可能播放、但常驻包没有登记的特效名。 */
  effects: string[];
  /** 常驻包里缺少的特效纹理键。 */
  layers: string[];
  /** 常驻包缺少的角色图层键。 */
  actorLayers: string[];
  /** 内容里根本不存在的特效定义。 */
  definitions: string[];
  /** 可招募佣兵无法通过按需路径加载外观。 */
  companions: string[];
}

/**
 * 独立枚举运行时可能引用的战斗视觉资源，再和常驻包比对。
 * 枚举只读领域数据，不调用预载函数，避免「用同一份清单证明自己完整」。
 */
export function residentCombatCoverageGaps(input: CoverageInput): CoverageGaps {
  const { battle, wardrobe, world, companions } = input;
  const pack = residentCombatAssets(input);
  const assetKeys = new Set(pack.assets.map(asset => asset.key));
  const classIds = input.classIds === undefined ? undefined : new Set(input.classIds);
  const classes = classIds ? battle.classes.filter(character => classIds.has(character.id)) : battle.classes;
  const learnedSkills = input.learnedSkillIds === undefined ? undefined : new Set(input.learnedSkillIds);
  const effects = new Set<string>();
  const definitions = new Set<string>();

  const addAction = (action: Parameters<typeof skillEffectNames>[0]): void => {
    for (const name of skillEffectNames(action)) effects.add(name);
  };
  const addAttack = (attack: Parameters<typeof basicAttackEffects>[1]): void => {
    for (const name of Object.keys(basicAttackEffects(battle, attack))) effects.add(name);
  };

  for (const character of classes) {
    for (const id of character.skills) {
      if (learnedSkills && !learnedSkills.has(id)) continue;
      const skill = battle.skills[id];
      for (const profile of [skill, ...(skill.companion ? [skillForGrowth(skill, 'companion')] : [])]) {
        for (const name of skillReactionEffects(profile)) effects.add(name);
        if (profile.action) addAction(profile.action);
        if (profile.followUpAction) addAction(profile.followUpAction);
      }
    }
    for (const stance of Object.values(wardrobe.skillStances?.[character.id] ?? {}))
      for (const [skillId, action] of Object.entries(stance.actions ?? {})) {
        if (learnedSkills && !learnedSkills.has(skillId)) continue;
        if (action) addAction(action);
      }
  }
  for (const profile of Object.values(wardrobe.attacks)) addAttack(profile);
  for (const profile of Object.values(wardrobe.dualWieldAttacks ?? {})) addAttack(profile);
  for (const profile of Object.values(wardrobe.frenzyAttacks ?? {})) addAttack(profile);
  for (const value of Object.values(battle.statusAttackBuffs ?? {})) for (const name of buffEffectNames(value)) effects.add(name);
  for (const name of Object.keys(stateMarkerEffects(battle))) effects.add(name);
  for (const name of feedbackEffects(battle.feedback)) effects.add(name);
  for (const name of COMBAT_OUTCOME_EFFECTS) effects.add(name);

  const missingLayers: string[] = [];
  for (const name of effects) {
    const definition = battle.attackEffects[name];
    if (!definition) { definitions.add(name); continue; }
    if (!pack.effectNames.has(name)) continue;
    for (const clip of Object.values(definition.clips)) {
      for (const layer of clip.layers) {
        const atlas = EFFECT_ATLAS_BY_FILE[layer.file];
        const keys = atlas
          ? [...new Set(atlas.slice(0, clip.frames).map(frame => EFFECT_ATLAS_PAGES[frame.page]!.key))]
          : [layer.key];
        for (const key of keys) if (!assetKeys.has(key)) missingLayers.push(key);
      }
    }
  }
  const missingActorLayers: string[] = [];
  const addActorLayers = (actor: ActorDefinition): void => {
    for (const clip of Object.values(actor.clips)) if (clip)
      for (const layer of clip.layers) {
        if (!layer.file) continue;
        const atlas = characterAtlasEntry(layer.file);
        if (!atlas) {
          if (!assetKeys.has(layer.key)) missingActorLayers.push(layer.key);
          continue;
        }
        for (const pageIndex of new Set(atlas.pages.slice(0, clip.frames))) {
          const page = CHARACTER_ATLAS_PAGES[pageIndex];
          const key = page?.key ?? `characters-atlas:${pageIndex}`;
          if (!assetKeys.has(key)) missingActorLayers.push(key);
        }
      }
  };
  // 职业 actor 不在 world.actors 里，必须直接检查 battle.classes[].actor；
  // 伙伴外观只核对已拥有的成员，未拥有的走按需路径。
  for (const character of classes) addActorLayers(character.actor);
  const ownedCompanions = input.ownedCompanionIds === undefined ? undefined : new Set(input.ownedCompanionIds);
  for (const [id, definition] of Object.entries(companions.definitions)) {
    if (ownedCompanions && !ownedCompanions.has(id)) continue;
    const actor = world.actors[definition.actor];
    if (actor) addActorLayers(actor);
  }
  // 未拥有的佣兵不进常驻包，但招募后必须能只靠按需路径装好外观。
  const unusableCompanions: string[] = [];
  for (const definition of Object.values(companions.definitions)) {
    if ((definition.source ?? 'mercenary') !== 'mercenary' || definition.recruitable === false) continue;
    const actor = world.actors[definition.actor];
    const expected = actor ? characterAssets(actor) : [];
    if (!actor || !expected.length) { unusableCompanions.push(definition.id); continue; }
    try {
      const loaded = new Set(partyMemberCombatAssets(battle, wardrobe, definition.classId, actor).map(asset => asset.key));
      if (expected.some(asset => !loaded.has(asset.key))) unusableCompanions.push(definition.id);
    } catch { unusableCompanions.push(definition.id); }
  }
  // 职业召唤物是另一个独立资源闭包，不能只靠职业 actor 覆盖。
  for (const character of classes) for (const id of classSummonEnemyIds(battle, character.id, learnedSkills)) {
    const definition = battle.enemies.find(enemy => enemy.id === id);
    if (!definition) { definitions.add(`summon:${id}`); continue; }
    for (const asset of enemyCombatAssets(battle, definition)) {
      if (assetKeys.has(asset.key)) continue;
      if (asset.kind === 'spritesheet' || asset.key.startsWith('characters-atlas:')) missingActorLayers.push(asset.key);
      else missingLayers.push(asset.key);
    }
  }

  return {
    effects: [...effects].filter(name => !pack.effectNames.has(name)),
    layers: [...new Set(missingLayers)],
    actorLayers: [...new Set(missingActorLayers)],
    definitions: [...definitions],
    companions: [...new Set(unusableCompanions)]
  };
}
