import type Phaser from 'phaser';

/** 逻辑目标 60，默认上限 60；实际交付上限由 `frame-pacing.ts` 按玩家选项和屏幕刷新率换算。 */
export const GAME_FRAME_TIMING = { target: 60, limit: 60 } satisfies Phaser.Types.Core.FPSConfig;

/** Phaser 负责限帧调度；游戏耗时取相邻两次交付的时间差，覆盖余量重复及低帧率启动平滑。 */
export function installFrameLimitClock(loop: Phaser.Core.TimeStep): () => void {
  const start = loop.start, resetDelta = loop.resetDelta;
  let lastDeliveredTime = loop.lastTime;
  let originalCallback: Phaser.Types.Core.TimeStepCallback | undefined;
  loop.resetDelta = function (): void {
    resetDelta.call(this);
    lastDeliveredTime = this.lastTime;
  };
  loop.start = function (callback): void {
    originalCallback = callback;
    return start.call(this, time => {
      const elapsedMs = Math.max(0, time - lastDeliveredTime);
      lastDeliveredTime = Math.max(lastDeliveredTime, time);
      callback(time, elapsedMs);
    });
  };
  return () => {
    loop.start = start;
    loop.resetDelta = resetDelta;
    if (originalCallback) loop.callback = originalCallback;
  };
}
