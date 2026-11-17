import { FONT } from '../text-style.ts';

/** 画框内的 CSS 矩形；由菜单表面的根变换计算。 */
export interface QuestSearchInputRect {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
}

interface QuestSearchInputOptions {
  /** 每次输入都直接回给面板；面板按新值重画搜索结果。 */
  onInput(value: string): void;
  /** 回车打开第一条结果。 */
  onSubmit(value: string): void;
  /** Escape 只清空输入并收起键盘，菜单本身保持打开。 */
  onEscape(): void;
}

/**
 * GM 任务页的搜索框。它是盖在右栏顶部的原生 input，输入任务名或任务组名后
 * 由面板在右栏画出跨组结果；输入框本身只负责接收文字和键盘。
 *
 * 输入框挂在 `#game-frame` 内、使用 CSS 坐标：键盘弹出时画框跟随可视区偏移，
 * 输入框随画框一起移动。重画面板不会重建这个节点，所以输入焦点不会丢。
 */
export class QuestSearchInput {
  private readonly options: QuestSearchInputOptions;
  private root?: HTMLDivElement;
  private field?: HTMLInputElement;

  constructor(options: QuestSearchInputOptions) {
    this.options = options;
  }

  /** 输入框获得焦点时，菜单键盘处理器要让路，避免 Escape 关掉菜单。 */
  get focused(): boolean {
    if (typeof document === 'undefined') return false;
    return document.activeElement === this.field;
  }

  show(rect: QuestSearchInputRect, options: { value: string; placeholder?: string }): void {
    this.ensure();
    this.applyRect(rect);
    if (this.field) {
      if (this.field.value !== options.value) this.field.value = options.value;
      if (options.placeholder !== undefined && this.field.placeholder !== options.placeholder) {
        this.field.placeholder = options.placeholder;
      }
    }
    if (this.root) this.root.style.display = 'block';
  }

  hide(): void {
    if (this.focused) this.blur();
    if (this.root) this.root.style.display = 'none';
  }

  setRect(rect: QuestSearchInputRect): void {
    this.ensure();
    this.applyRect(rect);
  }

  setValue(value: string): void {
    this.ensure();
    if (this.field && this.field.value !== value) this.field.value = value;
  }

  blur(): void {
    this.field?.blur();
  }

  destroy(): void {
    this.blur();
    this.root?.remove();
    this.root = undefined;
    this.field = undefined;
  }

  private ensure(): void {
    if (this.root || typeof document === 'undefined') return;
    const root = document.createElement('div');
    root.className = 'gm-quest-search';

    const field = document.createElement('input');
    field.className = 'gm-quest-search-field';
    field.type = 'search';
    field.placeholder = '搜索任务名或任务组';
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('autocapitalize', 'off');
    field.setAttribute('inputmode', 'search');
    field.setAttribute('enterkeyhint', 'search');
    field.setAttribute('spellcheck', 'false');

    root.append(field);
    // 画布容器是 fixed 定位；挂在它里面，输入框跟着画布一起跟随可视区偏移。
    (document.getElementById('game-frame') ?? document.body).append(root);
    this.root = root;
    this.field = field;
    field.style.fontFamily = FONT;

    field.addEventListener('input', () => this.options.onInput(field.value));
    field.addEventListener('keydown', event => {
      // 中文输入法正在选词时，回车用于确认候选，不当作打开第一条结果。
      // 部分安卓 WebView / 旧版 Safari 在确认候选时只给 keyCode 229。
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.options.onSubmit(field.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.options.onEscape();
      }
    });
  }

  private applyRect(rect: QuestSearchInputRect): void {
    const field = this.field;
    if (!field) return;
    const height = Math.max(22, rect.height);
    field.style.left = `${rect.left}px`;
    // 画框缩小后 28px 的设计高度可能低于 16px 字号所需空间；加高时保持原来的垂直中心。
    field.style.top = `${Math.max(0, rect.top - (height - rect.height) / 2)}px`;
    field.style.width = `${Math.max(1, rect.width)}px`;
    field.style.height = `${height}px`;
    // iOS Safari 会把小于 16px 的输入框整体放大；这里保底 16px，避免聚焦时页面乱缩放。
    field.style.fontSize = `${Math.max(16, rect.fontSize)}px`;
  }
}
