import type Phaser from 'phaser';
import { FONT } from '../text-style.ts';
import { readSafeArea, UI_UNIT_HEIGHT, UI_UNIT_WIDTH } from '../viewport.ts';

export type DomLayerName = 'world' | 'hud' | 'screen';

/** 一个 DOM 文字节点；只改内容、位置和显隐，不参与 Phaser 渲染。 */
export interface DomLabel {
  readonly element: HTMLDivElement;
  setText(text: string): DomLabel;
  setPosition(x: number, y: number): DomLabel;
  setAnchor(x: number, y: number): DomLabel;
  setVisible(visible: boolean): DomLabel;
  setClassName(className: string): DomLabel;
  setStyle(style: Partial<CSSStyleDeclaration>): DomLabel;
  remove(): void;
}

export interface DomPoint { x: number; y: number }

/**
 * 画布上方的 DOM 文字层。
 *
 * 画布本身按 CSS 像素渲染，所以屏幕文字的 CSS 坐标就是画布坐标；世界文字
 * 由 `worldToScreen()` 用相机 `worldView` 和 `zoom` 投影。根节点延迟到第一次
 * `attach()` 才创建，Node 测试环境可以只导入类型和纯函数，不会碰 `document`。
 */
export class DomUi {
  private root?: HTMLDivElement;
  private frame?: HTMLElement;
  private readonly layers = new Map<DomLayerName, HTMLDivElement>();
  private readonly visible = new Map<DomLayerName, boolean>();
  private destroyed = false;

  /** 幂等：重复调用不会创建第二个根节点。 */
  attach(): void {
    if (this.destroyed || typeof document === 'undefined') return;
    if (this.root?.isConnected) return;
    const frame = document.getElementById('game-frame');
    if (!frame) return;
    this.frame = frame;
    const root = document.createElement('div');
    root.id = 'ui-root';
    root.style.setProperty('--font-game', FONT);
    for (const name of ['world', 'hud', 'screen'] as const) {
      const layer = document.createElement('div');
      layer.id = `ui-${name}`;
      layer.className = 'dom-ui-layer';
      root.appendChild(layer);
      this.layers.set(name, layer);
      this.visible.set(name, true);
    }
    frame.appendChild(root);
    this.root = root;
    this.layout();
  }

  get attached(): boolean { return !!this.root?.isConnected; }

  layer(name: DomLayerName): HTMLDivElement | undefined {
    this.attach();
    return this.layers.get(name);
  }

  label(name: DomLayerName, className = 'dom-label', anchor: DomPoint = { x: 0, y: 0 }): DomLabel {
    const parent = this.layer(name);
    const element = document.createElement('div');
    element.className = className;
    let anchorX = anchor.x, anchorY = anchor.y;
    const applyAnchor = () => {
      element.style.transformOrigin = `${anchorX * 100}% ${anchorY * 100}%`;
    };
    applyAnchor();
    parent?.appendChild(element);
    const label: DomLabel = {
      element,
      setText(text: string): DomLabel {
        if (element.textContent !== text) element.textContent = text;
        return label;
      },
      setPosition(x: number, y: number): DomLabel {
        element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(${-anchorX * 100}%, ${-anchorY * 100}%)`;
        return label;
      },
      setAnchor(x: number, y: number): DomLabel {
        anchorX = x; anchorY = y; applyAnchor();
        return label;
      },
      setVisible(visible: boolean): DomLabel {
        element.hidden = !visible;
        return label;
      },
      setClassName(className: string): DomLabel {
        if (element.className !== className) element.className = className;
        return label;
      },
      setStyle(style: Partial<CSSStyleDeclaration>): DomLabel {
        Object.assign(element.style, style);
        return label;
      },
      remove(): void {
        element.remove();
      }
    };
    return label;
  }

  setLayerVisible(name: DomLayerName, visible: boolean): void {
    if (!this.attached) return;
    if (this.visible.get(name) === visible) return;
    this.visible.set(name, visible);
    const layer = this.layers.get(name);
    if (layer) layer.hidden = !visible;
  }

  isLayerVisible(name: DomLayerName): boolean {
    return this.visible.get(name) !== false;
  }

  /** 重新读取画框与安全区；只在视口变化和字体就绪后调用。 */
  layout(): void {
    if (typeof document === 'undefined') return;
    const frame = this.frame ?? document.getElementById('game-frame');
    if (!frame) return;
    this.frame = frame;
    const rect = frame.getBoundingClientRect();
    const safe = readSafeArea();
    frame.style.setProperty('--story-unit', `${Math.min(rect.width / UI_UNIT_WIDTH, rect.height / UI_UNIT_HEIGHT)}px`);
    frame.style.setProperty('--safe-inset-left', `${safe.left}px`);
    frame.style.setProperty('--safe-inset-right', `${safe.right}px`);
    frame.style.setProperty('--safe-inset-top', `${safe.top}px`);
    frame.style.setProperty('--safe-inset-bottom', `${safe.bottom}px`);
    this.root?.style.setProperty('--ui-width', `${rect.width}px`);
    this.root?.style.setProperty('--ui-height', `${rect.height}px`);
  }

  /** 当前画框的 CSS 尺寸；DOM 文字用它换算字号和位置。 */
  frameSize(): { width: number; height: number } {
    if (typeof document === 'undefined') return { width: 0, height: 0 };
    const frame = this.frame ?? document.getElementById('game-frame');
    if (!frame) return { width: 0, height: 0 };
    const rect = frame.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }

  /** 界面单位：800×480 基准，与现有 `uiUnitScale` 同一口径。 */
  storyUnit(): number {
    const { width, height } = this.frameSize();
    return Math.min(width / UI_UNIT_WIDTH, height / UI_UNIT_HEIGHT);
  }

  /**
   * 世界坐标 → 画框内 CSS 坐标。
   * 必须在相机 `preRender` 之后读取，否则会用到上一帧的 `worldView`。
   */
  worldToScreen(camera: Phaser.Cameras.Scene2D.Camera, x: number, y: number): DomPoint {
    const frame = this.frame ?? (typeof document === 'undefined' ? undefined : document.getElementById('game-frame'));
    const canvas = camera.scene?.game?.canvas;
    if (!frame || !canvas) return { x: 0, y: 0 };
    const frameRect = frame.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / Math.max(1, camera.scene.scale.width);
    const scaleY = canvasRect.height / Math.max(1, camera.scene.scale.height);
    return {
      x: canvasRect.left - frameRect.left + (x - camera.worldView.x) * camera.zoom * scaleX,
      y: canvasRect.top - frameRect.top + (y - camera.worldView.y) * camera.zoom * scaleY
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.root?.remove();
    this.root = undefined;
    this.frame = undefined;
    this.layers.clear();
    this.visible.clear();
  }
}

/** 纯函数版本：不依赖 DomUi 实例，供测试和小模块复用。 */
export function worldToScreen(
  frame: Pick<DOMRect, 'left' | 'top'>,
  canvas: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  scale: { width: number; height: number },
  camera: Pick<Phaser.Cameras.Scene2D.Camera, 'worldView' | 'zoom'>,
  x: number, y: number
): DomPoint {
  const scaleX = canvas.width / Math.max(1, scale.width);
  const scaleY = canvas.height / Math.max(1, scale.height);
  return {
    x: canvas.left - frame.left + (x - camera.worldView.x) * camera.zoom * scaleX,
    y: canvas.top - frame.top + (y - camera.worldView.y) * camera.zoom * scaleY
  };
}
