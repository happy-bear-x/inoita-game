import Phaser from 'phaser';
import type { StoryDirector } from '../domain/story-director.ts';

interface DiagnosticCollector {
  record(kind: string, details: unknown, withSnapshot?: boolean): void;
  flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void;
  markFrame(phase: string): void;
  stopFrames(): void;
  export(): string;
}
declare global { var storyDiagnostics: DiagnosticCollector | undefined; }

/** 每次跳过只写一条轻量摘要；阶段时间都从点击时刻开始算。 */
export function installStorySkipDiagnostics(director: Pick<StoryDirector, 'onSkipProgress'>,
  record: (kind: string, details: object) => void, now: () => number = () => performance.now()): void {
  let timing: { started: number; logicMs?: number; worldReadyMs?: number; cancelled?: boolean } | undefined;
  director.onSkipProgress = phase => {
    if (phase === 'requested') { timing ??= { started: now() }; return; }
    if (!timing) return;
    const elapsed = Math.max(0, Math.round((now() - timing.started) * 10) / 10);
    if (phase === 'logic-complete') { timing.logicMs = elapsed; return; }
    if (phase === 'world-ready') { timing.worldReadyMs = elapsed; return; }
    if (phase === 'cancelled') { timing.cancelled = true; return; }
    const details = { outcome: timing.cancelled ? 'cancelled' : phase,
      logicMs: timing.logicMs ?? null, worldReadyMs: timing.worldReadyMs ?? null,
      unlockedMs: phase === 'released' ? elapsed : null, elapsedMs: elapsed };
    timing = undefined; record('story-skip-summary', details);
  };
}

/** 使用引擎事件观察帧阶段，不替换引擎的更新函数或异常处理。 */
export function installGameDiagnostics(game: Phaser.Game, snapshot: () => unknown): void {
  const collector = globalThis.storyDiagnostics;
  if (!collector) return;
  collector.setSnapshot(snapshot);
  const beforeUpdate = () => collector.markFrame('update');
  const beforeRender = () => collector.markFrame('render');
  const afterRender = () => collector.markFrame('idle');
  game.events.on(Phaser.Core.Events.PRE_STEP, beforeUpdate);
  game.events.on(Phaser.Core.Events.POST_STEP, beforeRender);
  game.events.on(Phaser.Core.Events.POST_RENDER, afterRender);
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    game.events.off(Phaser.Core.Events.PRE_STEP, beforeUpdate);
    game.events.off(Phaser.Core.Events.POST_STEP, beforeRender);
    game.events.off(Phaser.Core.Events.POST_RENDER, afterRender);
    collector.stopFrames();
    collector.setSnapshot(() => null);
  });
}
