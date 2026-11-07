import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Cooldown } from '../../domain/combat.ts';
import { SHORTCUT_SLOT_COUNT } from '../../domain/shortcut-bar.ts';
import type { ShortcutSlot } from '../shortcut-view.ts';
import type { ControlViewport } from '../control-layout.ts';
import { HUD_SIDE_BUTTON_SIZE } from '../control-layout.ts';
import { uiUnitScale } from '../viewport.ts';
import { DomComponent, DomImage } from './components.ts';
import { DomCooldown } from './cooldown.ts';
import { domAssets, type DomAssets } from './assets.ts';

const FRAME_SIZE = 80, ICON_SIZE = 64, GAP = 8;
const ROW_WIDTH = SHORTCUT_SLOT_COUNT * FRAME_SIZE + (SHORTCUT_SLOT_COUNT - 1) * GAP;
interface Cell { icon: DomImage; cooldown: DomCooldown; quantity: HTMLElement; file?: string; state?: string }

/** 电脑模式的只读技能行；整行拦截指针，按键仍由统一路由执行。 */
export class DomComputerSkillHud extends DomComponent {
  private readonly cells: Cell[] = [];
  private readonly assets: DomAssets;
  private readonly failed: (error: unknown) => void;
  private page: readonly ShortcutSlot[] = [];
  private cooldowns: Readonly<Record<string, Cooldown>> = {};
  constructor(parent: HTMLElement, skin: ControlSkin, failed: (error: unknown) => void, assets = domAssets) {
    super(parent); this.assets = assets; this.failed = failed;
    this.element.style.pointerEvents = 'auto';
    for (let index = 0; index < SHORTCUT_SLOT_COUNT; index++) {
      const cell = new DomComponent(this).rect({ x: 12 + index * (FRAME_SIZE + GAP), y: 56, width: FRAME_SIZE, height: FRAME_SIZE });
      for (const file of [skin['slot-shadow'], skin['slot-ring']]) {
        const image = new DomImage(cell).rect({ x: 0, y: 0, width: FRAME_SIZE, height: FRAME_SIZE }); this.load(image, file);
      }
      const icon = new DomImage(cell).rect({ x: 8, y: 8, width: ICON_SIZE, height: ICON_SIZE });
      const center = new DomComponent(cell).rect({ x: 40, y: 40, width: 0, height: 0 });
      const cooldown = new DomCooldown(center);
      const quantity = new DomComponent(cell, 'span').element;
      Object.assign(quantity.style, { left: '70px', top: '72px', transform: 'translate(-100%,-100%)', fontSize: '18px', color: '#fff', lineHeight: '1' });
      this.cells.push({ icon, cooldown, quantity });
    }
    this.visible(false);
  }
  private load(image: DomImage, file: string): void {
    void image.load(this.assets, file).catch(error => { if (!image.signal.aborted && (error as Error)?.name !== 'AbortError') this.failed(error); });
  }
  setPage(page: readonly ShortcutSlot[]): void { this.page = page; this.paint(); }
  setCooldowns(cooldowns: Readonly<Record<string, Cooldown>>): void { this.cooldowns = cooldowns; this.paint(); }
  private paint(): void {
    this.cells.forEach((cell, index) => {
      const slot = this.page[index], entry = slot?.entry, item = entry?.kind === 'item';
      const cooldown = entry?.kind === 'skill' ? this.cooldowns[entry.id] : slot?.cooldown;
      cell.cooldown.update(cooldown, ICON_SIZE / 2, true);
      const cooling = !!cooldown && cooldown.remainingMs > 0;
      const usable = !!entry && !cooling && (item ? slot.quantity > 0 : slot.enabled);
      const alpha = cooling ? '.45' : usable ? '1' : '.4';
      const file = entry ? slot.icon : undefined, quantity = item ? String(slot.quantity) : '';
      const state = `${file}|${quantity}|${alpha}`;
      if (state === cell.state) return;
      cell.state = state; cell.icon.visible(!!file);
      if (file && cell.file !== file) { cell.file = file; this.load(cell.icon, file); }
      cell.icon.element.style.opacity = alpha; cell.quantity.textContent = quantity; cell.quantity.style.opacity = alpha;
    });
  }
  layout(viewport: ControlViewport): void {
    const safeWidth = Math.max(1, viewport.width - viewport.insets.left - viewport.insets.right);
    const desired = uiUnitScale(viewport.width, viewport.height) * HUD_SIDE_BUTTON_SIZE / FRAME_SIZE;
    const scale = Math.max(.5, Math.min(desired, safeWidth * .7 / (ROW_WIDTH + 24)));
    const x = viewport.insets.left + safeWidth / 2 - (ROW_WIDTH / 2 + 12) * scale;
    const y = viewport.height - viewport.insets.bottom - (94 + 96) * scale;
    this.rect({ x, y, width: ROW_WIDTH + 24, height: 210 });
    Object.assign(this.element.style, { transformOrigin: '0 0', transform: `scale(${scale})` });
  }
}
