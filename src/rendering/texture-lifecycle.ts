import type Phaser from 'phaser';
import { releaseEffectAnimations } from './effect-animations.ts';

/**
 * 纹理退役：画面里还有对象在用这张图时先不删。
 *
 * 素材租约只统计「谁加载了这张纹理」，不统计「谁正在画它」。菜单里的角色预览
 * 直接借用世界角色的合成外观，却不持有那套外观的租约；世界换装或重建场景时
 * 旧外观被释放，预览里的图片还在画面上，下一帧渲染器读到已失效的帧，Phaser
 * 的帧循环就停在异常上，表现为黑屏。
 *
 * 删除前扫描所有仍在显示的场景：有可见对象引用它就先记账、等引用消失后再删。
 * 兜底覆盖 Sprite / Image / Container 链和当前动画的全部帧纹理；TilemapLayer
 * 这类通过 tileset 引用纹理的对象不在扫描范围内，它们仍应由场景租约保住。
 */

const PENDING_RETRY_MS = 500;
const MAX_SCAN_DEPTH = 8;
/** 同一轮扫描里同时记录引用者，诊断不必再全量遍历一次。 */
interface DrawnIndex { keys: Set<string>; holders: Map<string, DrawnHolder> }
interface DrawnHolder { scene: string; type: string }
interface PendingRemoval {
  anims: Phaser.Animations.AnimationManager;
  /** 排队时的纹理对象；期间被重新加载过就放弃这次删除。 */
  texture: Phaser.Textures.Texture;
  nextAt: number;
}

const pending = new WeakMap<Phaser.Textures.TextureManager, Map<string, PendingRemoval>>();
const watchers = new WeakMap<Phaser.Textures.TextureManager, () => void>();
/** 同一同步块里成批释放时共享一次扫描；跨微任务后重新扫，避免看到过期画面。 */
let scanned: { textures: Phaser.Textures.TextureManager; index: DrawnIndex } | undefined;

function collectIndex(list: readonly unknown[], index: DrawnIndex, scene: string, depth: number): void {
  if (depth > MAX_SCAN_DEPTH) return;
  for (const child of list) {
    const object = child as {
      visible?: boolean; type?: string;
      frame?: { texture?: { key?: string } };
      texture?: { key?: string };
      anims?: { currentAnim?: { frames?: readonly { textureKey?: string; frame?: { texture?: { key?: string } } }[] } };
      list?: unknown[];
    } | undefined;
    // `active` 只控制 update 循环，不参与渲染；只有 visible=false 才不会读帧。
    if (!object || object.visible === false) continue;
    const register = (key: string | undefined): void => {
      if (!key) return;
      index.keys.add(key);
      if (!index.holders.has(key)) index.holders.set(key, { scene, type: object.type ?? 'Sprite' });
    };
    register(object.frame?.texture?.key);
    register(object.texture?.key);
    const frames = object.anims?.currentAnim?.frames;
    if (Array.isArray(frames)) for (const frame of frames) register(frame.textureKey ?? frame.frame?.texture?.key);
    if (Array.isArray(object.list)) collectIndex(object.list, index, scene, depth + 1);
  }
}

function drawnIndex(game: Phaser.Game | undefined, textures: Phaser.Textures.TextureManager): DrawnIndex {
  if (scanned && scanned.textures === textures) return scanned.index;
  const index: DrawnIndex = { keys: new Set(), holders: new Map() };
  const scenes = game?.scene?.scenes;
  if (Array.isArray(scenes)) for (const scene of scenes) {
    const sys = scene?.sys;
    if (!sys || typeof sys.isVisible !== 'function' || !sys.isVisible()) continue;
    const list = (scene.children as unknown as { list?: unknown[] } | undefined)?.list;
    if (Array.isArray(list) && list.length) collectIndex(list, index, sys.settings.key, 0);
  }
  const record = { textures, index };
  scanned = record;
  queueMicrotask(() => { if (scanned === record) scanned = undefined; });
  return index;
}

/** 返回仍会渲染这张纹理的某个画面对象；没有则返回 undefined。 */
export function drawnHolder(game: Phaser.Game | undefined, key: string,
  textures: Phaser.Textures.TextureManager): DrawnHolder | undefined {
  return drawnIndex(game, textures).holders.get(key);
}

function removeNow(anims: Phaser.Animations.AnimationManager, textures: Phaser.Textures.TextureManager, key: string): void {
  releaseEffectAnimations(anims, key);
  if (anims.exists(key)) anims.remove(key);
  if (textures.exists(key)) textures.remove(key);
}

function detachWatcher(textures: Phaser.Textures.TextureManager): void {
  const handler = watchers.get(textures);
  if (!handler) return;
  const game = (textures as unknown as { game?: Phaser.Game }).game;
  game?.events?.off('postrender', handler);
  watchers.delete(textures);
}

function queue(anims: Phaser.Animations.AnimationManager, textures: Phaser.Textures.TextureManager,
  key: string, texture: Phaser.Textures.Texture, holder: DrawnHolder | undefined): void {
  let entries = pending.get(textures);
  if (!entries) { entries = new Map(); pending.set(textures, entries); }
  if (!entries.has(key)) {
    entries.set(key, { anims, texture, nextAt: 0 });
    globalThis.storyDiagnostics?.record('texture-retained',
      holder ? { key, scene: holder.scene, object: holder.type } : { key });
  }
  const game = (textures as unknown as { game?: Phaser.Game }).game;
  if (!game?.events || watchers.has(textures)) return;
  const handler = () => flush(textures);
  watchers.set(textures, handler);
  game.events.on('postrender', handler);
}

function flush(textures: Phaser.Textures.TextureManager): void {
  const entries = pending.get(textures);
  if (!entries?.size) { pending.delete(textures); detachWatcher(textures); return; }
  const game = (textures as unknown as { game?: Phaser.Game }).game;
  const now = Date.now();
  // 队列里的项来自不同时间点，必须重新扫描；扫描结果在本次同步块内共享。
  scanned = undefined;
  for (const [key, entry] of [...entries]) {
    if (now < entry.nextAt) continue;
    // 期间同 key 的纹理被重新加载：旧队列作废，新纹理由新租约管理。
    if (!textures.exists(key) || textures.get(key) !== entry.texture) { entries.delete(key); continue; }
    if (drawnIndex(game, textures).keys.has(key)) { entry.nextAt = now + PENDING_RETRY_MS; continue; }
    entries.delete(key);
    removeNow(entry.anims, textures, key);
  }
  if (!entries.size) { pending.delete(textures); detachWatcher(textures); }
}

/** 新租约接管同一纹理时取消排队，避免兜底队列删掉新使用者刚加载的图。 */
export function cancelPendingTextureRemoval(textures: Phaser.Textures.TextureManager, key: string): void {
  const entries = pending.get(textures);
  if (!entries?.delete(key)) return;
  if (!entries.size) { pending.delete(textures); detachWatcher(textures); }
}

/**
 * 最后一个租约离开时调用。纹理仍被任何可见画面对象引用时保留，等它不再被绘制后
 * 再删；返回是否已经立刻删除。
 */
export function releaseTextureWhenUnused(textures: Phaser.Textures.TextureManager,
  anims: Phaser.Animations.AnimationManager, key: string): boolean {
  if (!textures.exists(key)) return true;
  const game = (textures as unknown as { game?: Phaser.Game }).game;
  const index = drawnIndex(game, textures);
  if (index.keys.has(key)) {
    queue(anims, textures, key, textures.get(key), index.holders.get(key));
    return false;
  }
  removeNow(anims, textures, key);
  return true;
}
