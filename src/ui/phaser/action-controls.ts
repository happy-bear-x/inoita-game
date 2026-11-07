import type Phaser from 'phaser';
import type { Hud } from '../../rendering/hud.ts';
import type { ControlSkin } from '../../domain/control-skin.ts';
import type { Cooldown } from '../../domain/combat.ts';
import type { ActionControlsHandlers } from '../../rendering/action-controls.ts';
import { UI_EVENTS } from '../../application/ui-events.ts';
import { ControlLayoutPreferences, resolveControlLayout } from '../control-layout.ts';
import { controlViewport } from './control-layout-viewport.ts';
import type { DomUi } from '../dom/dom-ui.ts';
import { DomActionControls } from '../dom/action-controls.ts';
import type { ShortcutSlot } from '../shortcut-view.ts';
export { SLOT_ICON_SIZE, ITEM_ICON_SIZE, type ShortcutSlot } from '../shortcut-view.ts';

/** 共用控件布局的参考锚点。 */
export function controlPlacement(scene: Phaser.Scene, width: number, height: number): { scale: number; anchor: { x: number; y: number } } {
  const { attack } = resolveControlLayout(controlViewport(scene, width, height));
  return { scale: attack.scale, anchor: { x: attack.x / attack.scale, y: attack.y / attack.scale } };
}

/** 场景生命周期适配；可见画面与输入由 DOM 组件持有。 */
export class ActionControls {
  private readonly view: DomActionControls;
  private readonly owner: Phaser.Scene;
  private readonly scene: Phaser.Scene;
  private readonly preferences?: ControlLayoutPreferences;
  private readonly unsubscribe: () => void;
  private requested = false;
  private viewportSize?: { width: number; height: number };
  constructor(owner: Phaser.Scene, hud: Hud, handlers: ActionControlsHandlers, skin: ControlSkin, preferences?: ControlLayoutPreferences, domUi?: DomUi) {
    const parent = domUi?.layer('hud');
    if (!parent) throw new Error('操作界面尚未就绪');
    this.owner = owner; this.scene = hud.scene; this.preferences = preferences;
    this.view = new DomActionControls(parent, skin, handlers, error => {
      globalThis.storyDiagnostics?.record('ui-image-error', { error });
    });
    this.unsubscribe = preferences?.subscribe(() => { if (this.viewportSize) this.layout(this.viewportSize.width, this.viewportSize.height); }) ?? (() => {});
    for (const event of ['sleep', 'wake', 'pause', 'resume']) owner.events.on(event, this.refresh);
    owner.game.events.on(UI_EVENTS.cancelInput, this.resetInput);
    window.addEventListener('blur', this.resetInput);
  }
  private readonly refresh = (): void => { this.view.visible(this.requested && this.owner.sys.isActive()); };
  readonly resetInput = (): void => { this.view.resetInput(); };
  setShortcutPage(slots: readonly ShortcutSlot[]): void { this.view.setShortcutPage(slots); }
  snapshot(): readonly ShortcutSlot[] { return this.view.snapshot(); }
  setCooldowns(cooldowns: Readonly<Record<string, Cooldown>>): void { this.view.setCooldowns(cooldowns); }
  setAttack(enabled: boolean, dimUnavailable = true): void { this.view.setAttack(enabled, dimUnavailable); }
  layout(width: number, height: number): void {
    this.viewportSize = { width, height };
    this.view.layout(controlViewport(this.scene, width, height), this.preferences?.snapshot());
  }
  setVisible(visible: boolean): void { this.requested = visible; this.refresh(); }
  destroy(): void {
    this.unsubscribe();
    for (const event of ['sleep', 'wake', 'pause', 'resume']) this.owner.events.off(event, this.refresh);
    this.owner.game.events.off(UI_EVENTS.cancelInput, this.resetInput);
    window.removeEventListener('blur', this.resetInput);
    this.view.destroy();
  }
}
