import type { BattleCatalog, SkillLoadout } from './battle.ts';
import { SHORTCUT_PAGE_COUNT } from './shortcut-bar.ts';

export interface SkillConfigurationState {
  loadouts: [string, SkillLoadout][];
  pages: [string, number][];
}

/**
 * 队员的技能配置：等级、按职业记的技能组页码，以及默认快捷栏要用的「已学会主动技能」。
 * 快捷栏本身不在这里——它每组六格、技能与物品共用，存在 `shortcut-bar.ts`。
 */
export class SkillConfiguration {
  protected loadouts = new Map<string, SkillLoadout>();
  private pages = new Map<string, number>();
  private revision=0;
  private draftCallCount=0;
  get version():number {return this.revision;}
  /**
   * 开发期计数器：每次 `draft` 真正克隆已有配置或按职业构建新配置时 +1，
   * 命中已有 loadout 也算一次。只读、不持久化，供性能测量比较调用次数。
   */
  get draftCalls():number {return this.draftCallCount;}
  /** 技能等级或页码写入后推进版本，供地图快捷栏复用页面内容。 */
  protected markChanged():void {this.revision++;}
  captureState(): SkillConfigurationState { return structuredClone({loadouts:[...this.loadouts],pages:[...this.pages]}); }
  restoreState(state: SkillConfigurationState): void {
    const restored=structuredClone(state);this.loadouts=new Map(restored.loadouts);this.pages=new Map(restored.pages);
    this.markChanged();
  }
  shortcutPage(classId: string): number { return this.pages.get(classId) ?? 0; }
  setShortcutPage(classId: string, page: number): void {
    if (!Number.isInteger(page) || page < 0 || page >= SHORTCUT_PAGE_COUNT) throw new Error('技能组无效');
    this.pages.set(classId, page);this.markChanged();
  }
  nextShortcutPage(classId: string): number {
    const page = (this.shortcutPage(classId) + 1) % SHORTCUT_PAGE_COUNT;
    this.setShortcutPage(classId, page); return page;
  }
  draft(catalog: BattleCatalog, classId: string): SkillLoadout {
    const existing = this.loadouts.get(classId);
    if (existing) { this.draftCallCount++; return structuredClone(existing); }
    const character = catalog.classes.find(c => c.id === classId);
    if (!character) throw new Error('职业不存在');
    this.draftCallCount++;
    return { levels: Object.fromEntries(character.skills.map(id => [id, 1])) };
  }
  /** 该职业已学会的主动技能，按职业技能表次序。默认快捷栏用它排每组前五格。 */
  activeSkills(catalog: BattleCatalog, classId: string): string[] {
    const character = catalog.classes.find(c => c.id === classId);
    if (!character) return [];
    const levels = this.draft(catalog, classId).levels;
    return character.skills.filter(id => catalog.skills[id].kind === 'active' && (levels[id] ?? 0) > 0);
  }
  /** 等级只能通过学习改变：写入的等级与本职业当前值不一致就拒绝。 */
  save(catalog: BattleCatalog, classId: string, draft: SkillLoadout): void {
    const character = catalog.classes.find(c => c.id === classId);
    if (!character) throw new Error('技能配置无效');
    const current = this.draft(catalog, classId).levels;
    if (Object.keys(draft.levels).some(id => !character.skills.includes(id)) ||
      character.skills.some(id => draft.levels[id] !== current[id])) throw new Error('技能等级只能通过学习改变');
    this.loadouts.set(classId, structuredClone(draft));this.markChanged();
  }
}

/** 只读取技能等级的来源；正式游戏、伙伴成长和测试替身都满足这个形状。 */
export type SkillDraftSource = Pick<SkillConfiguration,'draft'>;

/**
 * 当前职业真正学会的技能 id：配置里等级大于 0 才算。
 * 省略配置或职业不存在时返回该职业全部技能（安全超集），供构建期和尚未入队的伙伴使用。
 */
export function learnedSkillIds(catalog: BattleCatalog, classId: string, configuration?: SkillDraftSource): Set<string> {
  const character = catalog.classes.find(value => value.id === classId);
  if (!character) return new Set();
  if (!configuration) return new Set(character.skills);
  const levels = configuration.draft(catalog, classId).levels;
  return new Set(character.skills.filter(id => (levels[id] ?? 0) > 0));
}
