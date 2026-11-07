export interface MenuPanels {
  assets: Record<string, string>;
  itemMessages: Record<string,string>;
  /** Coordinates in the original equipment panel, in reference pixels. */
  equipmentSlots: { id: string; name: string; x: number; y: number; emptyIcon: string }[];
  skillPositions: { column: number; row: number }[];
  skillColumns: { label: string; image: string }[];
  classes: Record<string, { preview: string }>;
  character: {
    portraits: Record<string, { image: string; partyIcon: string }>;
    /** 佣兵没有专属身份时，人物页大立绘使用的职业状态图（252×271）。 */
    classPortraits: Record<string, string>;
    combatLabels: string[];
    labels: { statPoints: string; skillPoints: string; health: string; mana: string; experience: string };
  };
  /** 技能窗口设置页的原版文案：初始技能点与初始化按钮。 */
  skillPanel: { labels: { initialSkillPoints: string; resetButton: string } };
}

export const ITEM_ACTION_ASSETS = ['item-equip', 'item-unequip', 'item-use', 'item-discard'];

export const SKILL_ASSETS = ['skill-slot', 'skill-selected', 'skill-rank', 'skill-tab-directory',
  'skill-tab-ai', 'skill-tab-settings', 'skill-confirm',
  // 说明面板底部的三态按钮与按下态、下一级预览的箭头，以及已学习技能格右下角的八个等级数字贴图
  // （`UISkill_SetDescMenu @0x164488`、`UISkill_DrawAbility @0x164c24`、`UISkill_SkillDrawIcon @0x162a2c`）。
  'skill-learn', 'skill-shortcut', 'skill-shortcut-cancel', 'skill-button-pressed', 'skill-compare-arrow',
  ...Array.from({ length: 8 }, (_value, index) => `skill-rank-${index + 1}`)];

/** AI 设置页的技能格皮肤与三档档位图，设置页复用同一组档位图。 */
export const SKILL_AI_ASSETS = ['skill-locked', 'skill-selected-ai',
  'skill-level-none', 'skill-level-normal', 'skill-level-high', 'skill-level-pressed'];

export const QUEST_ASSETS = ['quest-main', 'quest-ready', 'quest-row', 'quest-row-selected', 'quest-row-pressed'];

export const PARTY_ASSETS = ['party-slot', 'party-empty', 'party-frame', 'party-selected', 'party-deployed',
  'party-page-1', 'party-page-2', 'party-dismiss', 'party-join', 'party-reserve', 'party-button-pressed',
  'party-tab-info', 'party-tab-equipment', 'party-tab-skills', 'party-skill-unavailable',
  ...['dark-knight','assassin','warlock','priest','ranger','warrior'].map(id=>`party-class-${id}`)];

interface MemberArt { image: string; partyIcon: string }

/**
 * 队员在菜单里的形象。大立绘优先用专属状态图；佣兵用职业状态图，小头像用职业图。
 * 角色没有专属立绘时回到职业图，和原版队员栏 `PORTRAITCLASSBASE` 的兜底一致。
 */
export function memberArt(
  panels: MenuPanels,
  actor: { portrait?: string | null } | undefined,
  classId: string,
  source?: 'mercenary' | 'story',
): MemberArt {
  const classImage = panels.assets[`party-class-${classId}`];
  if (source === 'mercenary') {
    return { image: panels.character.classPortraits[classId] ?? classImage, partyIcon: classImage };
  }
  const portrait = actor?.portrait ? panels.character.portraits[actor.portrait] : undefined;
  return portrait ?? { image: classImage, partyIcon: classImage };
}

export const CHARACTER_ASSETS = [
  'character-nw', 'character-ne', 'character-sw', 'character-se', 'character-gauge',
  'character-adjust', 'character-step', 'character-step-pressed', 'character-party-frame',
  ...['health', 'mana', 'experience'].flatMap(kind=>['start', 'fill', 'end'].map(part=>`character-${kind}-${part}`))
];
