import Phaser from 'phaser';
import { MemorySampler, textureMemory } from './memory-sampler.ts';
import type { FrameSampler } from './frame-sampler.ts';
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

// Text 和 Mask 用 TextureSource.updateSize 改画布尺寸，没有对应的尺寸事件。
// 只装在本局的可变源上；共享的观察函数通过引擎现有的 manager 找账本。
type TextureSource = Phaser.Textures.TextureSource;
const resizeMethods = new WeakMap<TextureSource, TextureSource['updateSize']>();
function observeResize(this: TextureSource, width: number, height: number): void {
  const before = this.width * this.height;
  resizeMethods.get(this)!.call(this, width, height);
  const texture = this.texture;
  if (texture) textureMemory.get(texture.manager)?.resizeTexture(texture.key, (this.width * this.height - before) * 4);
}

/** 开发页与安卓浏览器共用 Phaser 的增删事件。退出时从原发射器上摘掉监听。 */
export function installDevelopmentMemory(game: Phaser.Game, dev: boolean, port: string,
  context: () => object, record: (kind: string, details: object) => void): MemorySampler | undefined {
  if (!dev || port !== '4003') return;
  const memory = new MemorySampler(context, record);
  const textures = game.textures, audio = game.cache.audio, audioEvents = audio.events;
  textureMemory.set(textures, memory);
  const addTexture = (key: string, texture: Phaser.Textures.Texture) => {
    const bytes = texture.source.reduce((total, source) => total + source.width * source.height * 4, 0);
    memory.addTexture(key, bytes);
    for (const source of texture.source) {
      if (!(source.isCanvas || source.isRenderTexture) || resizeMethods.has(source)) continue;
      resizeMethods.set(source, source.updateSize);
      source.updateSize = observeResize;
    }
  };
  // Text/Mask 直接调用 texture.destroy()，引擎只经过 removeKey，未发 removetexture。
  const removeKey = textures.removeKey;
  textures.removeKey = function (key) {
    const result = removeKey.call(this, key);
    memory.removeTexture(key);
    return result;
  };
  const addAudio = (_cache: unknown, key: string, data: Partial<AudioBuffer> | null) => {
    const bytes = typeof data?.numberOfChannels === 'number' && typeof data.length === 'number'
      ? data.length * data.numberOfChannels * 4 : null;
    memory.setAudio(key, bytes);
  };
  const removeAudio = (_cache: unknown, key: string) => memory.setAudio(key, undefined);
  for (const key of textures.getTextureKeys()) addTexture(key, textures.get(key));
  for (const key of audio.getKeys()) addAudio(audio, key, audio.get(key));
  textures.on('addtexture', addTexture);
  audioEvents.on('add', addAudio);
  audioEvents.on('remove', removeAudio);
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    textures.off('addtexture', addTexture);
    textures.removeKey = removeKey;
    audioEvents.off('add', addAudio);
    audioEvents.off('remove', removeAudio);
    textureMemory.delete(textures);
  });
  return memory;
}

/** 只统计引擎公开的场景加载队列和输入/场景监听器，不保留回调或场景引用。 */
export function sceneMemoryCounts(game: Phaser.Game) {
  let pendingFiles = 0, listeners = 0;
  for (const scene of game.scene.scenes) {
    const loader = scene.load;
    if (loader) pendingFiles += (loader.list?.size ?? 0) + (loader.inflight?.size ?? 0) + (loader.queue?.size ?? 0);
    for (const emitter of [scene.events, scene.input, scene.input?.keyboard]) {
      if (emitter) for (const event of emitter.eventNames()) listeners += emitter.listenerCount(event);
    }
  }
  for (const emitter of [game.events, game.scale]) {
    for (const event of emitter.eventNames()) listeners += emitter.listenerCount(event);
  }
  return { pendingFiles, listeners };
}
