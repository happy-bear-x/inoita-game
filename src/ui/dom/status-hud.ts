import type { StoryPlayerState } from '../../domain/story-interface.ts';
import type { ActiveCondition } from '../../domain/combat-conditions.ts';
import type { PartyActiveSnapshot } from '../../domain/party.ts';
import { LOGIC_FRAME_MS } from '../../domain/battle.ts';
import { buffIconBlinking, buffIconPosition, gaugeFillWidth, memberColumnLayout, memberPanelIds, targetNameAnchor, targetNameColor, type HudGauge, type StatusHudSkin, type TargetStatus } from '../../domain/status-hud.ts';
import { resolveControlLayout, type ControlViewport } from '../control-layout.ts';
import { uiUnitScale } from '../viewport.ts';
import { domAssets, type DomAssets } from './assets.ts';
import { DomButton, DomComponent, DomImage, type DomRect } from './components.ts';

export type MemberValues = Pick<StoryPlayerState, 'level' | 'health' | 'maxHealth' | 'mana' | 'maxMana' | 'experience' | 'nextLevelExperience'>;
export interface StatusHudSources {
  readPlayer(): Readonly<StoryPlayerState> | undefined;
  subscribe(listener: () => void): () => void;
  readParty?(): PartyActiveSnapshot | undefined;
  onSelect?(id: string): void;
  portraitFor?(id: string): string | undefined;
  onFocus?(): void;
  readConditions?(id: string): readonly ActiveCondition[];
  readHero?(): MemberValues | undefined;
}
interface Gauge { fill: DomImage; start: DomImage; end: DomImage; layout: HudGauge; width: number }
interface BuffIcon { image: DomImage; id?: string; remaining?: number }
interface MemberPanel {
  root: DomButton; portrait: DomImage; level: HTMLElement;
  gauges: Record<'health' | 'mana' | 'experience', Gauge>;
  icons: BuffIcon[]; id?: string; portraitKey?: string;
}

/** 状态栏所有图片、文字、槽位与点击共用 DOM 容器和屏幕坐标。 */
export class DomStatusHud extends DomComponent {
  private readonly skin: StatusHudSkin;
  private readonly sources: StatusHudSources;
  private readonly assets: DomAssets;
  private readonly failed: (error: unknown) => void;
  private readonly playerPanel: MemberPanel;
  private readonly members: MemberPanel[];
  private readonly targetPanel: DomComponent;
  private readonly targetLabel: HTMLElement;
  private readonly targetGauge: Gauge;
  private readonly targetSpecial?: DomImage;
  private player?: Readonly<StoryPlayerState>;
  private target?: TargetStatus;
  private requested = false;
  private viewport?: ControlViewport;
  private memberCount = 0;
  private tick = -1;
  private layoutKey = '';
  private targetKey = '';
  constructor(parent: HTMLElement, skin: StatusHudSkin, sources: StatusHudSources, failed: (error: unknown) => void, assets = domAssets) {
    super(parent); this.skin = skin; this.sources = sources; this.failed = failed; this.assets = assets;
    Object.assign(this.element.style, { inset: '0', width: '100%', height: '100%' });
    this.playerPanel = this.panel(true);
    this.members = skin.member.slots.map(() => this.panel(false));
    this.targetPanel = new DomComponent(this).rect({ x: 0, y: 0, width: skin.target.width, height: skin.target.height });
    this.image(this.targetPanel, skin.assets['target-frame'], { x: 0, y: 0, width: skin.target.width, height: skin.target.height });
    this.targetGauge = this.gauge(this.targetPanel, 'target', skin.target.gauge);
    const anchor = targetNameAnchor(skin);
    this.targetLabel = this.label(this.targetPanel, anchor.x, anchor.y, 18, false);
    const mark = skin.target.specialMark;
    if (mark) this.targetSpecial = this.image(this.targetPanel, skin.assets['target-special'], {
      x: mark.centerX - mark.width / 2, y: mark.centerY - mark.height / 2, width: mark.width, height: mark.height
    }).visible(false);
    this.own(sources.subscribe(() => this.refresh()));
    this.refresh();
  }
  private load(image: DomImage, file: string): void {
    void image.load(this.assets, file).catch(error => {
      if (!image.signal.aborted && (error as Error)?.name !== 'AbortError') this.failed(error);
    });
  }
  private image(parent: DomComponent, file: string, rect: DomRect): DomImage {
    const image = new DomImage(parent).rect(rect); this.load(image, file); return image;
  }
  private label(parent: DomComponent, x: number, y: number, size: number, centerY = true): HTMLElement {
    const label = new DomComponent(parent, 'span').element;
    Object.assign(label.style, { left: `${x}px`, top: `${y}px`, transform: `translate(-50%,${centerY ? '-50%' : '0'})`,
      fontSize: `${size}px`, lineHeight: '1.2', color: '#fff', whiteSpace: 'nowrap', textShadow: 'none' });
    return label;
  }
  private panel(main: boolean): MemberPanel {
    const layout = main ? this.skin.player : this.skin.member;
    let panel!: MemberPanel;
    const root = new DomButton(this, { enabled: () => this.requested && !!panel.id,
      trigger: 'up', action: () => { if (main) this.sources.onFocus?.(); else if (panel.id) this.sources.onSelect?.(panel.id); } });
    root.rect({ x: 0, y: 0, width: layout.width, height: layout.height });
    if (main) this.image(root, this.skin.assets['player-shadow'], { x: 0, y: 0, width: layout.width, height: layout.height });
    const portrait = this.image(root, this.skin.assets[main ? 'player-portrait' : 'member-portrait'], layout.portrait).fitting('cover', .5, .35);
    this.image(root, this.skin.assets[main ? 'player-frame' : 'member-frame'], { x: 0, y: 0, width: layout.width, height: layout.height });
    const level = layout.level;
    const label = this.label(root, level.x + level.width / 2, level.y + level.height / 2, main ? 17 : 14);
    const gauges = Object.fromEntries((['health', 'mana', 'experience'] as const).map(kind => [kind, this.gauge(root, kind, layout.gauges[kind])])) as MemberPanel['gauges'];
    panel = { root, portrait, level: label, gauges, icons: [] };
    root.visible(false); return panel;
  }
  private gauge(parent: DomComponent, kind: 'health' | 'mana' | 'experience' | 'target', layout: HudGauge): Gauge {
    const image = (part: 'fill' | 'start' | 'end', x: number, width: number) => this.image(parent, this.skin.assets[`${kind}-${part}`], { x, y: layout.y, width, height: layout.height });
    return { fill: image('fill', layout.x + layout.fillOffset, layout.fillWidth), start: image('start', layout.x, layout.startWidth),
      end: image('end', layout.x + layout.fillOffset + layout.fillWidth, layout.endWidth), layout, width: -1 };
  }
  private updateGauge(gauge: Gauge, value: number, max: number): void {
    const width = gaugeFillWidth(value, max, gauge.layout.fillWidth);
    if (width === gauge.width) return;
    gauge.width = width;
    gauge.fill.element.style.clipPath = `inset(0 ${gauge.layout.fillWidth - width}px 0 0)`;
    gauge.end.element.style.left = `${gauge.layout.x + gauge.layout.fillOffset + width}px`;
    for (const image of [gauge.fill, gauge.start, gauge.end]) image.visible(width > 0);
  }
  private updatePanel(panel: MemberPanel, id: string | undefined, values: MemberValues | undefined, living: boolean, main: boolean): void {
    panel.id = values ? id : undefined;
    if (!panel.id || !values) { panel.root.visible(false); return; }
    const fallback = this.skin.assets[main ? 'player-portrait' : 'member-portrait'];
    const file = this.sources.portraitFor?.(panel.id) ?? fallback;
    if (file !== panel.portraitKey) { panel.portraitKey = file; this.load(panel.portrait, file); }
    const filter = living ? '' : 'brightness(.47)';
    if (panel.portrait.element.style.filter !== filter) panel.portrait.element.style.filter = filter;
    const text = String(values.level); if (panel.level.textContent !== text) panel.level.textContent = text;
    this.updateGauge(panel.gauges.health, values.health, values.maxHealth);
    this.updateGauge(panel.gauges.mana, values.mana, values.maxMana);
    this.updateGauge(panel.gauges.experience, values.experience, values.nextLevelExperience);
    this.updateIcons(panel, this.sources.readConditions?.(panel.id) ?? [], main);
  }
  private updateIcons(panel: MemberPanel, conditions: readonly ActiveCondition[], main: boolean): void {
    const skin = this.skin.buffIcons;
    const entries = conditions.filter(value => (!main || value.kind === 'buff') && skin.catalog[value.id]);
    entries.forEach((condition, index) => {
      const at = buffIconPosition(skin, main ? this.skin.player.height : this.skin.member.height, index);
      let icon = panel.icons[index];
      if (!icon) {
        icon = { image: this.image(panel.root, skin.catalog[condition.id], { ...at, width: skin.size, height: skin.size }), id: condition.id };
        panel.icons.push(icon);
      }
      if (icon.id !== condition.id) { icon.id = condition.id; this.load(icon.image, skin.catalog[condition.id]); }
      icon.remaining = condition.remainingMs;
      icon.image.visible(this.tick < 0 || !buffIconBlinking(Math.max(0, Math.ceil(condition.remainingMs / LOGIC_FRAME_MS)), this.tick));
    });
    for (const icon of panel.icons.slice(entries.length)) { icon.remaining = undefined; icon.image.visible(false); }
  }
  private refresh(): void {
    this.player = this.sources.readPlayer();
    const party = this.sources.readParty?.(), controlled = party?.controlled ?? 'player';
    this.updatePanel(this.playerPanel, controlled, this.player, party?.living.includes(controlled) ?? true, true);
    const others = memberPanelIds(party?.active ?? ['player'], controlled);
    this.memberCount = Math.min(others.length, this.members.length);
    this.members.forEach((panel, index) => {
      const id = others[index], member = party?.members.find(value => value.id === id);
      const values = id === 'player' ? this.sources.readHero?.() ?? member : member;
      this.updatePanel(panel, id, values as MemberValues | undefined, party?.living.includes(id) ?? true, false);
    });
    this.paintTarget(); this.syncVisibility();
    if (this.viewport) this.layout(this.viewport);
  }
  update(tick: number): void {
    if (tick === this.tick) return;
    this.tick = tick;
    for (const panel of [this.playerPanel, ...this.members]) for (const icon of panel.icons) {
      if (icon.remaining !== undefined) icon.image.visible(!buffIconBlinking(Math.max(0, Math.ceil(icon.remaining / LOGIC_FRAME_MS)), tick));
    }
  }
  setTarget(target: TargetStatus | undefined): void { this.target = target; this.paintTarget(); this.syncVisibility(); }
  private paintTarget(): void {
    if (!this.target) return;
    const target = this.target, text = `${target.name} (Lv.${target.level})`;
    const key = `${target.id}|${text}|${target.health}/${target.maxHealth}|${target.sceneLevel}|${target.specialRank}|${this.player?.level}`;
    if (key === this.targetKey) return;
    this.targetKey = key;
    if (text !== this.targetLabel.textContent) this.targetLabel.textContent = text;
    this.targetLabel.style.color = targetNameColor(this.skin, this.player?.level ?? 1, target);
    this.updateGauge(this.targetGauge, target.health, target.maxHealth);
    this.targetSpecial?.visible((target.specialRank ?? 0) !== 0);
  }
  layout(viewport: ControlViewport): void {
    this.viewport = viewport;
    const key = `${viewport.width}|${viewport.height}|${Object.values(viewport.insets).join(',')}|${this.memberCount}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const size = uiUnitScale(viewport.width, viewport.height), right = viewport.width - viewport.insets.right, top = viewport.insets.top;
    const place = (root: DomComponent, x: number, y: number, scale: number) => {
      Object.assign(root.element.style, { left: `${x}px`, top: `${y}px`, transformOrigin: '0 0', transform: `scale(${scale})` });
    };
    place(this.playerPanel.root, right - (this.skin.player.width - this.skin.player.inset.right) * size,
      top - this.skin.player.inset.top * size, size);
    place(this.targetPanel, (viewport.width - this.skin.target.width * size) / 2, top, size);
    const swap = resolveControlLayout(viewport).swap;
    const column = memberColumnLayout({ top, playerHeight: this.skin.player.height * size, memberHeight: this.skin.member.height,
      count: this.memberCount, limit: swap.y - swap.height / 2 - 8 * size, size, columnGap: 10 * size, rowGap: 8 * size });
    this.members.forEach((panel, index) => {
      const y = column.tops[index]; if (y === undefined) return;
      const scale = size * column.scale;
      place(panel.root, right - (this.skin.member.width - this.skin.member.inset.right) * scale, y, scale);
    });
  }
  setVisible(shown: boolean): void { this.requested = shown; this.syncVisibility(); }
  private syncVisibility(): void {
    this.playerPanel.root.visible(this.requested && !!this.player);
    this.targetPanel.visible(this.requested && !!this.target);
    for (const panel of this.members) panel.root.visible(this.requested && !!panel.id);
  }
}
