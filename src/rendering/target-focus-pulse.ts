/** 原版换目标后的红圈脉冲帧数。 */
export const FOCUS_PULSE_FRAMES = 17;

/** 原版一个脉冲帧的时长；原版按 30fps 推进，17 帧约 567ms。 */
export const FOCUS_PULSE_FRAME_MS = 1000 / 30;

/**
 * 红圈剩余脉冲帧对应的缩放。
 *
 * 原版 `GAMEPLAY_DrawFocus` 用 `((帧 % 6) * 10) + 80` 作为 `SPR_DrawEx`
 * 的缩放百分比，从 130% 往回到 80% 循环，17 帧后恢复 100%。
 */
export function focusRingScale(remaining: number): number {
  return remaining > 0 ? ((remaining % 6) * 10 + 80) / 100 : 1;
}

/** 按真实耗时推进脉冲，避免 120/144Hz 屏上播得更快。 */
export function advanceFocusPulse(remaining: number, deltaMs: number): number {
  if (remaining <= 0 || deltaMs <= 0) return Math.max(0, remaining);
  return Math.max(0, remaining - deltaMs / FOCUS_PULSE_FRAME_MS);
}
