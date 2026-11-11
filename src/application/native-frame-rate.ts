import type { FrameRateLimit } from './display-settings.ts';

/**
 * 把玩家选的帧率告诉安卓壳。
 *
 * 壳据此选一个刷新率是目标帧率整数倍的显示模式：30 选 60/90/120，60 选 60/120。
 * 每个游戏帧占整数个屏幕节拍，避免 60 帧在 90Hz 上出现 3:2 抖动。
 * 网页版没有原生桥时静默跳过。
 */
export function requestNativeFrameRate(rate: FrameRateLimit): void {
  const bridge = (globalThis as {
    InotiaNative?: { setFrameRate?: (rate: number) => void };
  }).InotiaNative;
  try { bridge?.setFrameRate?.(rate); } catch { /* 旧壳或网页版没有这个能力 */ }
}
