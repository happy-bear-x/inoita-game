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

/** 设备侧的渲染能力。安卓掉帧先要分清 WebGL、Canvas 回退和软件 GL，这三条路的修法完全不同。 */
interface RendererFacts {
  type: 'webgl' | 'canvas' | 'none';
  vendor: string | null;
  renderer: string | null;
  version: string | null;
  maxTextureSize: number | null;
  maxTextureUnits: number | null;
}

function rendererFacts(game: Phaser.Game): RendererFacts {
  const type = game.renderer?.type === Phaser.WEBGL ? 'webgl'
    : game.renderer?.type === Phaser.CANVAS ? 'canvas' : 'none';
  const facts: RendererFacts = { type, vendor: null, renderer: null, version: null, maxTextureSize: null, maxTextureUnits: null };
  if (type !== 'webgl') return facts;
  try {
    const gl = (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    facts.vendor = String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
    facts.renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    facts.version = String(gl.getParameter(gl.VERSION));
    facts.maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    facts.maxTextureUnits = Number(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS));
  } catch {
    // 上下文丢失后 getParameter 会抛；保留类型，其余留空。
  }
  return facts;
}

/** 最近一小段 rAF 间隔的均值；与 actualFps 一起看，能区分「浏览器只给 30 次回调」和「回调来了但游戏跑得慢」。 */
function averageFrameMs(loop: Phaser.Core.TimeStep): number {
  const history = loop.deltaHistory;
  const count = Math.min(history.length, loop.deltaSmoothingMax || history.length);
  if (!count) return 0;
  let total = 0;
  for (let index = 0; index < count; index++) total += history[index] ?? 0;
  return Math.round(total / count * 10) / 10;
}

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

/**
 * 使用引擎事件观察帧阶段，不替换引擎的更新函数或异常处理。
 *
 * 每秒把「浏览器给了多少次 rAF」和「游戏真正交付了多少帧」分开记；
 * 低于 50 时最多每 15 秒上报一条 `perf-sample`，带渲染器、画布尺寸和最近帧间隔。
 * 这样安卓上不用连 devtools 也能判断是限帧、rAF 被压到 30，还是 WebGL 回退。
 */
export function installGameDiagnostics(game: Phaser.Game, snapshot: () => unknown): void {
  const collector = globalThis.storyDiagnostics;
  if (!collector) return;
  let renderer: RendererFacts | undefined;
  const rendererInfo = (): RendererFacts => renderer ??= rendererFacts(game);
  let stepFps = 0, rafFps = 0, frames = 0, windowStart = performance.now(), lastSample = 0, announced = false;
  const perf = (): Record<string, unknown> => ({ stepFps, rafFps, limit: game.loop.fpsLimit, frameMs: averageFrameMs(game.loop) });
  collector.setSnapshot(() => ({ ...(snapshot() as Record<string, unknown> | null ?? {}), renderer: rendererInfo(), perf: perf() }));
  const beforeUpdate = () => collector.markFrame('update');
  const beforeRender = () => collector.markFrame('render');
  const afterRender = () => {
    collector.markFrame('idle');
    if (typeof document !== 'undefined' && document.hidden) { frames = 0; windowStart = performance.now(); return; }
    frames += 1;
    const now = performance.now(), elapsed = now - windowStart;
    if (elapsed < 1000) return;
    // 切后台、弹系统框或长时间停顿时，这段空档不是渲染慢；丢掉这一窗，别上报 0 帧。
    if (elapsed > 3000) { frames = 0; windowStart = now; return; }
    stepFps = Math.round(frames * 1000 / elapsed);
    rafFps = Math.round(game.loop.actualFps);
    frames = 0; windowStart = now;
    if (!announced) {
      announced = true;
      collector.record('renderer-ready', { canvas: [game.canvas.width, game.canvas.height],
        css: [game.canvas.clientWidth, game.canvas.clientHeight], dpr: globalThis.devicePixelRatio ?? 1 });
    }
    if ((stepFps < 50 || rafFps < 50) && now - lastSample >= 15000) {
      lastSample = now;
      collector.record('perf-sample', {
        stepFps, rafFps, limit: game.loop.fpsLimit, frameMs: averageFrameMs(game.loop),
        canvas: [game.canvas.width, game.canvas.height],
        css: [game.canvas.clientWidth, game.canvas.clientHeight],
        dpr: globalThis.devicePixelRatio ?? 1,
        scenes: game.scene.getScenes(true).map(scene => scene.scene.key),
      });
    }
  };
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
