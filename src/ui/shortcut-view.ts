import type { ShortcutEntry } from '../domain/shortcut-bar.ts';
import type { Cooldown } from '../domain/combat.ts';

/** 世界计算的快捷位显示内容；DOM 组件只消费结果。 */
export interface ShortcutSlot {
  entry: ShortcutEntry | null;
  icon?: string;
  quantity: number;
  enabled: boolean;
  cooldown?: Cooldown;
}
export const SLOT_ICON_SIZE = 75;
export const ITEM_ICON_SIZE = 64;
