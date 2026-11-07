import { portraitFit } from '../portrait-fit.ts';
import type { AssetLease } from '../../application/assets.ts';
import type { DomAssets, DomImageSource } from './assets.ts';

export interface DomRect { x: number; y: number; width: number; height: number }

/** 一组节点共享取消与清理；父组件销毁会先取消其全部子组件。 */
export class DomComponent {
  readonly element: HTMLElement;
  readonly controller = new AbortController();
  private readonly disposers = new Set<() => void>();
  constructor(parent: HTMLElement | DomComponent, tag = 'div') {
    this.element = document.createElement(tag);
    Object.assign(this.element.style, { position: 'absolute', pointerEvents: 'none' });
    if (parent instanceof DomComponent) {
      parent.element.appendChild(this.element);
      const detach = parent.own(() => this.destroy());
      this.own(detach);
    } else parent.appendChild(this.element);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  own(dispose: () => void): () => void {
    if (this.signal.aborted) { dispose(); return () => {}; }
    this.disposers.add(dispose);
    return () => { this.disposers.delete(dispose); };
  }
  rect(rect: DomRect): this {
    Object.assign(this.element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    return this;
  }
  visible(shown: boolean): this { if (this.element.hidden === shown) this.element.hidden = !shown; return this; }
  destroy(): void {
    if (this.signal.aborted) return;
    this.controller.abort();
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    this.element.remove();
  }
}

/** 图集与独立图片共用一套裁剪，原始像素交给浏览器缩放。 */
export class DomImage extends DomComponent {
  private readonly picture: HTMLImageElement;
  private lease?: AssetLease;
  private request?: AbortController;
  private source?: DomImageSource;
  private box: DomRect = { x: 0, y: 0, width: 1, height: 1 };
  private fit: 'stretch' | 'cover' | 'contain' = 'stretch';
  private anchorX = .5;
  private anchorY = .5;
  constructor(parent: HTMLElement | DomComponent) {
    super(parent);
    this.element.style.overflow = 'hidden';
    this.picture = document.createElement('img');
    this.picture.alt = '';
    this.picture.draggable = false;
    Object.assign(this.picture.style, { position: 'absolute', maxWidth: 'none', pointerEvents: 'none' });
    this.element.appendChild(this.picture);
    this.own(() => { this.request?.abort(); this.lease?.release(); });
  }
  override rect(rect: DomRect): this { this.box = rect; super.rect(rect); this.layout(); return this; }
  fitting(fit: 'stretch' | 'cover' | 'contain', anchorX = .5, anchorY = .5): this {
    this.fit = fit; this.anchorX = anchorX; this.anchorY = anchorY; this.layout(); return this;
  }
  async load(assets: DomAssets, file: string): Promise<void> {
    this.signal.throwIfAborted();
    this.request?.abort();
    const request = this.request = new AbortController();
    const lease = await assets.acquire(file, request.signal);
    if (this.signal.aborted || this.request !== request) { lease.release(); return; }
    this.lease?.release(); this.lease = lease; this.source = lease.source;
    this.picture.src = lease.source.url;
    this.layout();
  }
  private layout(): void {
    if (!this.source) return;
    const { frame, width, height } = this.source;
    let sx = this.box.width / frame.width, sy = this.box.height / frame.height, left = 0, top = 0;
    if (this.fit === 'cover') {
      const fit = portraitFit(frame, this.box, this.anchorX, this.anchorY);
      sx = sy = fit.scale; left = -fit.cropX * sx; top = -fit.cropY * sy;
    } else if (this.fit === 'contain') {
      sx = sy = Math.min(sx, sy);
      left = (this.box.width - frame.width * sx) * this.anchorX;
      top = (this.box.height - frame.height * sy) * this.anchorY;
    }
    Object.assign(this.picture.style, { width: `${width * sx}px`, height: `${height * sy}px`,
      left: `${left - frame.x * sx}px`, top: `${top - frame.y * sy}px` });
  }
}

export interface DomPressOptions {
  enabled(): boolean;
  hitTest?(event: PointerEvent): boolean;
  press?(pointer: number): boolean;
  release?(pointer: number): void;
  trigger: 'down' | 'up';
  action(): void;
  hold?: { delayMs: number; intervalMs: number };
}

/** 只管理一次手势；全局动作互斥由调用方共享的 ActionPressGate 决定。 */
export class DomButton extends DomComponent {
  private pointer?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private repeated = false;
  private readonly options: DomPressOptions;
  constructor(parent: HTMLElement | DomComponent, options: DomPressOptions) {
    super(parent, 'button'); this.options = options;
    (this.element as HTMLButtonElement).type = 'button';
    Object.assign(this.element.style, { pointerEvents: 'auto', touchAction: 'none', padding: '0', border: '0', background: 'none' });
    const listen = (name: string, action: EventListener) => {
      this.element.addEventListener(name, action);
      this.own(() => this.element.removeEventListener(name, action));
    };
    listen('pointerdown', event => this.down(event as PointerEvent));
    listen('pointerup', event => this.up(event as PointerEvent));
    for (const name of ['pointercancel', 'lostpointercapture']) listen(name, event => {
      if ((event as PointerEvent).pointerId === this.pointer) this.reset();
    });
    listen('click', event => { event.preventDefault(); event.stopPropagation(); });
    this.own(() => this.reset());
  }
  private down(event: PointerEvent): void {
    event.stopPropagation(); event.preventDefault();
    if (event.button !== 0 || this.pointer !== undefined || !this.options.enabled() || this.options.hitTest?.(event) === false) return;
    if (this.options.press && !this.options.press(event.pointerId)) return;
    this.pointer = event.pointerId; this.repeated = false;
    this.element.setPointerCapture(event.pointerId);
    this.element.dataset.pressed = 'true';
    if (this.options.trigger === 'down') this.options.action();
    const hold = this.options.hold;
    if (hold) this.timer = setTimeout(() => this.repeat(), hold.delayMs);
  }
  private repeat(): void {
    if (this.pointer === undefined || !this.options.enabled()) { this.reset(); return; }
    this.repeated = true; this.options.action();
    if (this.pointer !== undefined && this.options.hold) this.timer = setTimeout(() => this.repeat(), this.options.hold!.intervalMs);
  }
  private up(event: PointerEvent): void {
    event.stopPropagation(); event.preventDefault();
    if (event.pointerId !== this.pointer) return;
    const bounds = this.element.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom;
    const activate = inside && !this.repeated && this.options.trigger === 'up' && this.options.enabled();
    this.reset();
    if (activate) this.options.action();
  }
  activate(): void { if (this.options.enabled()) this.options.action(); }
  reset(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const pointer = this.pointer; this.pointer = undefined;
    delete this.element.dataset.pressed;
    if (pointer !== undefined) {
      this.options.release?.(pointer);
      if (this.element.hasPointerCapture(pointer)) this.element.releasePointerCapture(pointer);
    }
  }
  override visible(shown: boolean): this { if (!shown) this.reset(); return super.visible(shown); }
}
