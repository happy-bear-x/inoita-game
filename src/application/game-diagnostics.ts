import Phaser from 'phaser';
import type { FrameSampler } from './frame-sampler.ts';

interface DiagnosticCollector {
  record(kind: string, details: unknown, withSnapshot?: boolean): void;
  flush(): Promise<void>;
  setSnapshot(provider: () => unknown): void;
  markFrame(phase: string): void;
  stopFrames(): void;
  export(): string;
}
declare global { var storyDiagnostics: DiagnosticCollector | undefined; }

/** 使用引擎事件观察帧阶段，不替换引擎的更新函数或异常处理。 */
export function installGameDiagnostics(game: Phaser.Game, snapshot: () => unknown,
  sampler?: FrameSampler, suspended: () => boolean = () => false): void {
  const collector = globalThis.storyDiagnostics;
  if (!collector) return;
  collector.setSnapshot(snapshot);
  const reset = () => sampler?.reset();
  const beforeUpdate = () => {
    collector.markFrame('update');
    if (!sampler) return;
    if (document.hidden || game.isPaused || suspended()) sampler.reset();
    else sampler.begin();
  };
  const beforeRender = () => { collector.markFrame('render'); sampler?.updated(); };
  const afterRender = () => { collector.markFrame('idle'); sampler?.rendered(); };
  if (sampler) {
    document.addEventListener('visibilitychange', reset);
    game.events.on(Phaser.Core.Events.PAUSE, reset);
    game.events.on(Phaser.Core.Events.RESUME, reset);
  }
  game.events.on(Phaser.Core.Events.PRE_STEP, beforeUpdate);
  game.events.on(Phaser.Core.Events.POST_STEP, beforeRender);
  game.events.on(Phaser.Core.Events.POST_RENDER, afterRender);
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    if (sampler) {
      document.removeEventListener('visibilitychange', reset);
      game.events.off(Phaser.Core.Events.PAUSE, reset);
      game.events.off(Phaser.Core.Events.RESUME, reset);
      reset();
    }
    game.events.off(Phaser.Core.Events.PRE_STEP, beforeUpdate);
    game.events.off(Phaser.Core.Events.POST_STEP, beforeRender);
    game.events.off(Phaser.Core.Events.POST_RENDER, afterRender);
    collector.stopFrames();
    collector.setSnapshot(() => null);
  });
}
