import type { DomLabel, DomUi } from './dom-ui.ts';

/** 页面坐标 → 画框内 CSS 坐标与倍率；倍率用来把字号换算到屏幕。 */
export interface MenuTextPoint { x: number; y: number; scale: number }

/** 一段菜单文字；字号和 Phaser `UiSurface.text` 的 size 同一口径。 */
interface MenuTextStyle {
  size: number;
  color?: string;
  contrastBackground?: boolean;
  /** 对应 Phaser 的 `setOrigin`：0 是左/上，.5 是中，1 是右/下。 */
  anchorX?: number;
  anchorY?: number;
  align?: 'left' | 'center' | 'right';
  /** 换行宽度，页面坐标单位；给出后才启用多行，不给出保持单行。 */
  width?: number;
  /** 每行高度，页面坐标单位；默认 `size + 5`，与 `UiSurface.text` 的 lineSpacing 一致。 */
  lineHeight?: number;
  /** 换行模式；默认 `none`（不换行），`word` 按词断，`anywhere` 任意位置断。 */
  wrap?: MenuTextWrap;
}

type MenuTextWrap = 'none' | 'word' | 'anywhere';

/** 滚动视口在页面坐标里的上下边界；越界的行不显示。 */
export interface MenuTextClip { top: number; bottom: number }

export interface MenuTextSpec {
  /** 同一页内唯一；重绘时按它复用 DOM 标签。 */
  key: string;
  text: string;
  x: number;
  y: number;
  style: MenuTextStyle;
  /** 文字所在滚动区名。给出时 y 会扣掉该区当前偏移。 */
  scroll?: string;
  clip?: MenuTextClip;
}

export interface MenuTextWriter { add(spec: MenuTextSpec): void }

/** 一个页面的文字产出函数；新增页面时在这里登记，不重写 `MenuTextLayer`。 */
type MenuTextPageRenderer = (writer: MenuTextWriter) => void;

interface MenuTextEntry {
  label: DomLabel;
  text: string;
  styleKey: string;
  wrapKey: string;
  x: number;
  y: number;
  visible: boolean;
}

/** 一块滚动窗口的裁剪容器；标签挂进去后由浏览器按矩形裁边。 */
interface MenuTextClipBox {
  label: DomLabel;
  top: number;
  height: number;
}

/**
 * 菜单页面的 DOM 文字层。
 *
 * 图框、按钮和滑条由 DOM 组件绘制；这里统一管理页面文字与滚动裁剪。
 * 页面重绘时按 key 复用标签，内容、字号和位置都没变就不写 DOM。滚动和窗口
 * 缩放由宿主调用 `refresh()`，这里只重算位置，不重建标签。
 */
export class MenuTextLayer {
  private readonly dom: Pick<DomUi, 'label'>;
  private readonly pointOf: (x: number, y: number) => MenuTextPoint;
  private readonly scrollTopOf: (page: string, scroll: string) => number | undefined;
  private readonly renderers = new Map<string, MenuTextPageRenderer>();
  private readonly entries = new Map<string, MenuTextEntry>();
  private readonly clips = new Map<string, MenuTextClipBox>();
  private baseLayer?: HTMLElement;
  private specs: MenuTextSpec[] = [];
  private page = '';
  private shown = true;
  private signature = '';

  constructor(
    dom: Pick<DomUi, 'label'>,
    pointOf: (x: number, y: number) => MenuTextPoint,
    scrollTopOf: (page: string, scroll: string) => number | undefined
  ) {
    this.dom = dom;
    this.pointOf = pointOf;
    this.scrollTopOf = scrollTopOf;
  }

  /** 登记一个页面的文字渲染函数；同一页重复登记会替换。 */
  register(page: string, renderer: MenuTextPageRenderer): void {
    this.renderers.set(page, renderer);
  }

  /** 切换页面时清掉上一页的标签；页面没变则什么都不做。 */
  beginPage(page: string): void {
    if (page === this.page) return;
    this.page = page;
    this.clearEntries();
    this.specs = [];
  }

  /** 按登记的函数重建当前页文字；没有登记函数的页面只保留空层。 */
  renderPage(page: string): void {
    this.beginPage(page);
    const specs: MenuTextSpec[] = [];
    this.renderers.get(page)?.({ add: spec => specs.push(spec) });
    this.specs = specs;
    this.apply();
  }

  /** 滚动、窗口缩放后重新换算位置；不会重建标签。 */
  refresh(): void {
    this.apply();
  }

  /** 菜单整体隐藏或让位给弹层时调用。 */
  setVisible(visible: boolean): void {
    if (this.shown === visible) return;
    this.shown = visible;
    for (const entry of this.entries.values()) entry.label.setVisible(visible && entry.visible);
    for (const clip of this.clips.values()) clip.label.setVisible(visible);
  }

  /** 滑条这类不走整页重绘的值：只改一条已存在的文字。 */
  setText(page: string, key: string, text: string): void {
    if (page !== this.page) return;
    const spec = this.specs.find(value => value.key === key);
    if (spec) spec.text = text;
    const entry = this.entries.get(key);
    if (!entry || entry.text === text) return;
    entry.text = text;
    entry.label.setText(text);
    this.signature = '';
  }

  destroy(): void {
    this.clearEntries();
    this.specs = [];
    this.renderers.clear();
    this.page = '';
  }

  private clearEntries(): void {
    for (const entry of this.entries.values()) entry.label.remove();
    for (const clip of this.clips.values()) clip.label.remove();
    this.entries.clear();
    this.clips.clear();
    this.baseLayer = undefined;
    this.signature = '';
  }

  private newLabel(className: string, anchor: MenuTextPoint | { x: number; y: number }): DomLabel {
    const label = this.dom.label('screen', className, anchor);
    this.baseLayer ??= label.element.parentElement ?? undefined;
    return label;
  }

  /** 同一组上下边界共用一个裁剪容器；滚动时只换标签位置，容器不动。 */
  private clipBox(spec: MenuTextSpec): MenuTextClipBox | undefined {
    if (!spec.clip) return undefined;
    const key = `${spec.clip.top}|${spec.clip.bottom}`;
    let box = this.clips.get(key);
    if (!box) {
      box = { label: this.newLabel('dom-menu-clip', { x: 0, y: 0 }), top: NaN, height: NaN };
      box.label.setVisible(false);
      this.clips.set(key, box);
    }
    const top = this.pointOf(0, spec.clip.top).y;
    const height = Math.max(0, this.pointOf(0, spec.clip.bottom).y - top);
    if (box.top !== top || box.height !== height) {
      box.top = top;
      box.height = height;
      box.label.setStyle({ left: '0px', top: '0px', width: '100%', height: `${height.toFixed(2)}px` })
        .setPosition(0, top).setVisible(this.shown);
    }
    return box;
  }

  private bodyY(spec: MenuTextSpec): number {
    if (!spec.scroll) return spec.y;
    return spec.y - (this.scrollTopOf(this.page, spec.scroll) ?? 0);
  }

  private withinClip(spec: MenuTextSpec, y: number): boolean {
    return !spec.clip || (y >= spec.clip.top && y <= spec.clip.bottom);
  }

  private lineHeightOf(style: MenuTextStyle): number {
    return style.lineHeight ?? style.size + 5;
  }

  /**
   * 多行样式。没给宽度时返回空 key，让标签沿用 `.dom-label` 的单行样式；
   * 从多行改回单行时再写一次重置值，避免样式留在复用标签上。
   */
  private wrappingOf(style: MenuTextStyle, scale: number): { key: string; css: Partial<CSSStyleDeclaration> } {
    if (style.width === undefined) {
      return {
        key: '',
        css: { whiteSpace: 'nowrap', overflowWrap: 'normal', width: '', lineHeight: '' }
      };
    }
    const wrap = style.wrap ?? 'none';
    const width = Math.max(0, style.width * scale);
    const lineHeight = Math.max(0, this.lineHeightOf(style) * scale);
    const overflowWrap = wrap === 'word' ? 'break-word' : wrap === 'anywhere' ? 'anywhere' : 'normal';
    return {
      key: `${width.toFixed(2)}|${lineHeight.toFixed(2)}|${wrap}`,
      css: {
        whiteSpace: 'pre-wrap',
        overflowWrap,
        width: `${width.toFixed(2)}px`,
        lineHeight: `${lineHeight.toFixed(2)}px`
      }
    };
  }

  private apply(): void {
    if (!this.specs.length) {
      this.clearEntries();
      return;
    }
    const origin = this.pointOf(0, 0);
    const signature = JSON.stringify([this.page, origin.x, origin.y, origin.scale, ...this.specs.map(spec => {
      const y = this.bodyY(spec);
      return [spec.key, spec.text, spec.style.size, spec.style.color ?? '', !!spec.style.contrastBackground, spec.style.anchorX ?? 0,
        spec.style.anchorY ?? 0, spec.style.align ?? 'left', spec.x, y, this.withinClip(spec, y),
        spec.style.width ?? null, this.lineHeightOf(spec.style), spec.style.wrap ?? 'none',
        spec.clip ? [spec.clip.top, spec.clip.bottom] : null];
    })]);
    if (signature === this.signature) return;
    this.signature = signature;

    const seen = new Set<string>(), usedClips = new Set<string>();
    for (const spec of this.specs) {
      seen.add(spec.key);
      const y = this.bodyY(spec);
      const point = this.pointOf(spec.x, y);
      const box = this.clipBox(spec);
      if (box) usedClips.add(`${spec.clip!.top}|${spec.clip!.bottom}`);
      const fontSize = Math.max(1, spec.style.size * point.scale);
      const anchorX = spec.style.anchorX ?? 0, anchorY = spec.style.anchorY ?? 0;
      const color = spec.style.color ?? '#f3deb0';
      const align = spec.style.align ?? 'left';
      const contrastBackground = !!spec.style.contrastBackground;
      const styleKey = `${fontSize.toFixed(2)}|${color}|${contrastBackground}|${anchorX}|${anchorY}|${align}`;
      const wrapping = this.wrappingOf(spec.style, point.scale);
      let entry = this.entries.get(spec.key);
      if (!entry) {
        const label = this.newLabel('dom-menu-text', { x: anchorX, y: anchorY });
        // 先隐藏；下面按可视结果统一决定，新建标签就不会闪一帧。
        label.setVisible(false);
        entry = { label, text: '', styleKey: '', wrapKey: '', x: NaN, y: NaN, visible: false };
        this.entries.set(spec.key, entry);
      }
      // 裁剪窗口内的标签挂进容器，浏览器负责把越出窗口的部分裁掉；切回普通页时再挂回顶层。
      const parent = box?.label.element ?? this.baseLayer;
      if (parent && typeof parent.appendChild === 'function'
        && entry.label.element.parentElement !== parent) parent.appendChild(entry.label.element);
      if (entry.text !== spec.text) {
        entry.text = spec.text;
        entry.label.setText(spec.text);
      }
      if (entry.styleKey !== styleKey) {
        entry.styleKey = styleKey;
        entry.label.setAnchor(anchorX, anchorY);
        entry.label.setStyle({ fontSize: `${fontSize.toFixed(2)}px`, color, textAlign: align, pointerEvents: 'none',
          background: contrastBackground ? 'rgba(0,0,0,.8)' : '', padding: contrastBackground ? '0 3px' : '',
          borderRadius: contrastBackground ? '3px' : '' });
      }
      if (entry.wrapKey !== wrapping.key) {
        entry.wrapKey = wrapping.key;
        entry.label.setStyle(wrapping.css);
      }
      const x = point.x, top = point.y - (box?.top ?? 0);
      if (entry.x !== x || entry.y !== top) {
        entry.x = x;
        entry.y = top;
        entry.label.setPosition(x, top);
      }
      const visible = this.withinClip(spec, y);
      if (entry.visible !== visible) {
        entry.visible = visible;
        entry.label.setVisible(this.shown && visible);
      }
    }
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue;
      entry.label.remove();
      this.entries.delete(key);
    }
    for (const [key, clip] of this.clips) {
      if (usedClips.has(key)) continue;
      clip.label.remove();
      this.clips.delete(key);
    }
  }
}
