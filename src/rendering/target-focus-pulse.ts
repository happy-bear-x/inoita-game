/** 原版换目标后的红圈脉冲帧数。 */
export const FOCUS_PULSE_FRAMES = 17;

/**
 * 红圈剩余脉冲帧对应的缩放。
 *
 * 原版 `GAMEPLAY_DrawFocus` 用 `((帧 % 6) * 10) + 80` 作为 `SPR_DrawEx`
 * 的缩放百分比，从 130% 往回到 80% 循环，17 帧后恢复 100%。
 */
export function focusRingScale(remaining: number): number {
  return remaining > 0 ? ((remaining % 6) * 10 + 80) / 100 : 1;
}
