import type { BattleCatalog } from '../../domain/battle.ts';
import type { Bag } from '../../domain/bag.ts';
import type { MenuPanels } from '../../domain/menu-panels.ts';
import type { StorySkillProgression } from '../../domain/story-skills.ts';
import { skillDescriptionParts, skillNextLevelPreview } from '../skill-detail-lines.ts';
import { SKILL_BOOK, skillBookCell } from '../skill-book-layout.ts';
import { TEXT_COLORS } from '../text-style.ts';
import { drawDescriptionText } from './description-text.ts';
import type { ScrollArea, UiSurface } from './widgets.ts';

/**
 * 技能书页面：从背包点「使用」进入的独立菜单页，和强化台同级。
 *
 * 左框只列当前能升级的技能图标，右框显示所选技能当前等级、使用后的等级变化和下一级数值预览。
 * 确认后才真正消耗技能书，结算走 `Bag.use`，和背包弹层用的是同一条领域路径。
 */
export class SkillBookPanel {
  readonly bag: Bag;
  readonly skills: StorySkillProgression;
  readonly catalog: BattleCatalog;
  readonly panels: MenuPanels;
  readonly entryId: string;
  private readonly changed: () => void;
  private readonly sound: () => void;
  private readonly close: (message?: string) => void;
  private selected?: string;
  private message = '';
  private scroll?: ScrollArea;
  private offset = 0;

  constructor(bag: Bag, skills: StorySkillProgression, catalog: BattleCatalog, panels: MenuPanels,
    entryId: string, changed: () => void, sound: () => void, close: (message?: string) => void) {
    this.bag = bag; this.skills = skills; this.catalog = catalog; this.panels = panels;
    this.entryId = entryId; this.changed = changed; this.sound = sound; this.close = close;
  }

  get skillIds(): string[] {
    return this.catalog.classes.find(entry => entry.id === this.bag.classId)?.skills ?? [];
  }

  /** 技能书页自己的显式状态，供页面签名使用。 */
  get viewModel(): { entryId: string; selected?: string; message: string } {
    return { entryId: this.entryId, selected: this.selected, message: this.message };
  }

  open(): void {
    this.selected = undefined; this.message = ''; this.offset = 0;
    // 绑定了具体技能的书只看那一门；普通技能书默认停在第一个可升级的技能上。
    const bound = this.bag.get(this.entryId)?.skill;
    this.selected = bound && !this.problemFor(bound) ? bound : this.nextEligible();
  }

  captureScroll(): void {
    this.offset = this.scroll?.scrollTop ?? this.offset;
  }

  render(v: UiSurface): void {
    const layout = SKILL_BOOK;
    v.border(this.panels.assets, layout.leftFrame.x, layout.leftFrame.y, layout.leftFrame.width, layout.leftFrame.height);
    v.border(this.panels.assets, layout.rightFrame.x, layout.rightFrame.y, layout.rightFrame.width, layout.rightFrame.height);
    this.scroll = undefined;
    this.renderGrid(v);
    this.renderDetails(v);
  }

  /** 当前能升级的技能；页面只列这些，不能升级的不出现在图标格里。 */
  private get upgradable(): string[] {
    return this.skillIds.filter(id => !this.problemFor(id));
  }

  private renderGrid(v: UiSurface): void {
    const layout = SKILL_BOOK, assets = this.panels.assets, skills = this.upgradable;
    if (!skills.length) {
      v.text('暂无可升级技能', layout.empty.x, layout.empty.y, 0, layout.empty.size).setOrigin(.5);
      return;
    }
    skills.forEach((id, index) => {
      const skill = this.catalog.skills[id];
      if (!skill) return;
      const cellAt = skillBookCell(index), rank = this.skills.level(id);
      const cell = v.button('', cellAt.x, cellAt.y, layout.grid.size, layout.grid.size, () => this.select(id),
        { image: skill.icon }).setData('label', skill.name);
      cell.addAt(v.image(assets['skill-slot'], layout.slotFrame.x, layout.slotFrame.y,
        layout.slotFrame.width, layout.slotFrame.height, cell), 0);
      if (!rank) v.image(assets['skill-locked'], 0, 0, layout.grid.size, layout.grid.size, cell);
      else {
        v.image(assets['skill-rank'], layout.rank.x, layout.rank.y, layout.rank.width, layout.rank.height, cell);
        v.image(assets[`skill-rank-${rank}`], layout.rankDigit.x, layout.rankDigit.y,
          layout.rankDigit.width, layout.rankDigit.height, cell);
      }
      if (id === this.selected) v.image(assets[rank ? 'skill-selected' : 'skill-selected-ai'],
        layout.selection.x, layout.selection.y, layout.selection.width, layout.selection.height, cell);
    });
  }

  private renderDetails(v: UiSurface): void {
    const layout = SKILL_BOOK, skill = this.selected ? this.catalog.skills[this.selected] : undefined;
    if (!skill) {
      if (this.message) v.text(this.message, layout.title.x, layout.title.y, layout.title.width, 20);
      this.renderButtons(v, false);
      return;
    }
    const rank = this.skills.level(skill.id), problem = this.problemFor(skill.id), entry = this.bag.get(this.entryId);
    v.text(skill.name, layout.title.x, layout.title.y, layout.title.width, layout.title.size);
    v.text(`当前等级 LV ${rank}　持有技能书 ${entry?.quantity ?? 0} 本`,
      layout.level.x, layout.level.y, layout.level.width, layout.level.size, TEXT_COLORS.primary);
    v.text(problem ?? `使用技能书：LV ${rank} → ${rank + 1}`, layout.status.x, layout.status.y,
      layout.status.width, layout.status.size, problem ? TEXT_COLORS.danger : '#ffd75e');
    if (this.message) v.text(this.message, layout.message.x, layout.message.y, layout.message.width,
      layout.message.size, '#ffd75e');

    const detail = v.scroll(layout.scroll.x, layout.scroll.y, layout.scroll.width, layout.scroll.height);
    let y = drawDescriptionText(v, skillDescriptionParts(skill, rank), 0, 0, layout.scroll.width, 20, detail.content);
    if (!problem) {
      if (y) y += 8;
      const center = layout.scroll.width / 2;
      for (const row of skillNextLevelPreview(skill.ranks, rank, skill.kind, skill.ranks.length, skill.display)) {
        const labelColor = row.kind === 'mana' ? '#0f7cf9' : TEXT_COLORS.white,
          valueColor = row.kind === 'mana' ? '#0f7cf9' : '#ff0000';
        v.text(row.label, center, y, 0, 17, labelColor, detail.content).setOrigin(.5, 0);
        const valuesY = y + 24;
        v.text(row.from, center - 12, valuesY, 0, 17, valueColor, detail.content).setOrigin(1, 0);
        v.image(this.panels.assets['skill-compare-arrow'], center - 10.5, valuesY - 1, 21, 24, detail.content);
        v.text(row.to, center + 12, valuesY, 0, 17, valueColor, detail.content);
        y += 48;
      }
    }
    detail.setHeight(Math.max(layout.scroll.height, y));
    detail.scrollTop = this.offset;
    detail.onScroll = () => { this.offset = detail.scrollTop; };
    this.scroll = detail;
    this.renderButtons(v, !problem && !!entry);
  }

  private renderButtons(v: UiSurface, canUse: boolean): void {
    const layout = SKILL_BOOK;
    v.button('使用技能书', layout.primary.x, layout.primary.y, layout.primary.width, layout.primary.height,
      () => this.use(), { disabled: !canUse, fontSize: 20 });
  }

  private select(id: string): void {
    if (id === this.selected) return;
    this.selected = id; this.message = ''; this.offset = 0; this.sound(); this.changed();
  }

  private use(): void {
    const id = this.selected;
    if (!id) { this.message = '请选择技能'; this.changed(); return; }
    const problem = this.problemFor(id);
    if (problem || !this.bag.get(this.entryId)) {
      this.message = problem ?? '技能书已不在背包中'; this.changed(); return;
    }
    try {
      const result = this.bag.use(this.entryId, undefined, id);
      this.message = result.message;
      this.sound();
    } catch (error) {
      this.message = (error as Error).message;
    }
    if (!this.bag.get(this.entryId)) { this.close(this.message); return; }
    // 还有副本就留在本页；升到顶后自动换到下一门可升级的技能，没有就显示空状态。
    if (this.problemFor(id)) this.selected = this.nextEligible();
    this.offset = 0; this.changed();
  }

  /** 绑定具体技能的书只能提升那一门；和 `Bag.use` 取 `source.skill` 优先的规则一致。 */
  private problemFor(id: string): string | undefined {
    const bound = this.bag.get(this.entryId)?.skill;
    if (bound && bound !== id) return '这本书只能提升指定的技能';
    return this.skills.bookProblem(id);
  }

  private nextEligible(): string | undefined {
    return this.skillIds.find(id => !this.problemFor(id));
  }
}
