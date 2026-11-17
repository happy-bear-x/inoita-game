import type Phaser from 'phaser';
import { AssetPool } from '../application/assets.ts';
import type { AssetLease } from '../application/assets.ts';
import { versionedAsset } from '../application/asset-version.ts';
import { releaseEffectAnimations } from './effect-animations.ts';
import { cancelPendingTextureRemoval, releaseTextureWhenUnused } from './texture-lifecycle.ts';

export type PendingAsset =
  | { kind: 'image'; key: string; file: string }
  | { kind: 'spritesheet'; key: string; file: string; config: Phaser.Types.Loader.FileTypes.ImageFrameConfig }
  /** 打包后的图集：图片和 JSON 必须成对加载，纹理键下会注册所有帧。 */
  | { kind: 'atlas'; key: string; file: string; atlas: string; frame?: string; frames?: readonly string[] };
/** 队列按纹理管理器排队：同一份纹理库只有一个 loader 能写，跨场景并发会重复注册同一纹理键。 */
const textureQueues = new WeakMap<Phaser.Textures.TextureManager, Promise<void>>();
/**
 * 正在加载某个纹理键的调用数。损坏缓存重建前必须区分“其他加载者”和“真正持有纹理的用户”：
 * 前者还没开始用这张纹理，可以一起等重建；后者不能删。
 */
const activeLoaders = new WeakMap<Phaser.Textures.TextureManager, Map<string, number>>();
/**
 * 场景关闭后 Loader 会摘掉监听，但文件对象还在，`File.state` 仍会从“加载中”走到
 * “完成/失败”。按文件状态轮询，等文件真的结束才释放写入权，不能按固定秒数猜。
 */
const WRITE_POLL_MS = 200;
/**
 * 长时间没有任何文件事件才认为写入停摆。单个文件有 15 秒超时、最多重试一次
 * （见 src/main.ts），在途文件一定会在更短的时间里发 `filecomplete` 或 `loaderror`；
 * 连续这么久没有事件，剩下的只可能是没启动的文件或已经损坏的 loader。
 */
const WRITE_DEADLINE_MS = 35_000;

/**
 * 同一纹理键的写入登记。
 *
 * Phaser 4 没有单文件取消：场景关闭或 loader.reset() 只清空记账，已经发出的请求仍会写回
 * 全局纹理库。取消一次加载如果直接把写入权让给后来者，两代文件就会各写一次同一个键，
 * 第二次在 TextureManager.checkKey 处报 `Texture key already in use`，而且引擎不抛错，
 * 上层仍把文件当作加载成功。
 *
 * 这里维持一条不变量：对任一纹理键，从它“缺失或残帧”到下一次成功注册之间，全局最多只有
 * 一个 loader 文件集被接受。取消只解除调用方的等待，写入权要等文件落定、加载失败或兜底
 * 到期才释放；后来者先等这次写入结束，再决定复用还是自己下载。
 */
interface TextureWrite {
  key: string;
  /** 下载身份：同键不同资源时不能共用一次写入。 */
  identity: string;
  scene: Phaser.Scene;
  round: TextureWriteRound;
  /** Loader 接受的顶层文件；图集的子文件不单独登记。 */
  file?: Phaser.Loader.File;
  settled: boolean;
  done: Promise<void>;
  resolve: () => void;
}
/** 一个批次登记的一组写入，共用一套监听、轮询与兜底定时器。 */
interface TextureWriteRound {
  writes: TextureWrite[];
  byKey: Map<string, TextureWrite>;
  finished: boolean;
  detach: () => void;
  /** 有文件事件就把“停摆期限”重新计时。 */
  touch: () => void;
  closed: Promise<void>;
  close: () => void;
}
interface TextureLedger {
  textures: Phaser.Textures.TextureManager;
  anims: Phaser.Animations.AnimationManager;
  pool: AssetPool;
  writes: Map<string, TextureWrite>;
  /** 宽限到期后仍可能迟到的写入；落地时按有无租约决定去留，过期自动清掉。 */
  late: Map<string, ReturnType<typeof setTimeout>>;
}
const ledgers = new WeakMap<Phaser.Textures.TextureManager, TextureLedger>();

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** 只比较“下载同一份文件”所需的信息，不比较帧需求：同一页图集被不同动作引用不同帧仍是一次写入。 */
function downloadIdentity(asset: PendingAsset): string {
  if (asset.kind === 'atlas')
    return JSON.stringify(['atlas', versionedAsset(asset.file), versionedAsset(asset.atlas)]);
  if (asset.kind === 'image') return JSON.stringify(['image', versionedAsset(asset.file)]);
  const { frameWidth, frameHeight, startFrame = 0, endFrame = -1, margin = 0, spacing = 0 } = asset.config;
  return JSON.stringify(['spritesheet', versionedAsset(asset.file),
    frameWidth, frameHeight, startFrame, endFrame, margin, spacing]);
}

function armLateWrite(ledger: TextureLedger, key: string): void {
  if (ledger.late.has(key)) return;
  const timer = setTimeout(() => { ledger.late.delete(key); }, WRITE_DEADLINE_MS);
  unrefTimer(timer);
  ledger.late.set(key, timer);
}

/** 落地纹理没有租约接管时才退役；删除统一走可见引用优先的延迟队列。 */
function retireUnclaimedTexture(ledger: TextureLedger, key: string): void {
  if (ledger.pool.holders(key) !== 0) return;
  if (!ledger.textures.exists(key)) return;
  // 取消预取后旧文件落地再被回收是常态，不记诊断，避免每次换向都刷日志。
  releaseTextureWhenUnused(ledger.textures, ledger.anims, key);
}

/** Phaser 的文件状态：10 还没开始，13 以上都是已经结束（失败、完成、待销毁）。 */
const FILE_PENDING = 10;
const FILE_FAILED = 13;
function fileFinished(file: Phaser.Loader.File | undefined): boolean {
  // 没有文件被 Loader 接受，就不会再有写入落地。
  if (!file) return true;
  const state = (file as unknown as { state?: number }).state ?? FILE_PENDING;
  return state <= FILE_PENDING || state >= FILE_FAILED;
}

function finishWrite(ledger: TextureLedger, write: TextureWrite, retire: boolean): void {
  if (write.settled) return;
  write.settled = true;
  if (ledger.writes.get(write.key) === write) ledger.writes.delete(write.key);
  if (retire) retireUnclaimedTexture(ledger, write.key);
  write.resolve();
  write.round.touch();
}

/**
 * 结算整批。`complete` 表示 Loader 正常结束；`stalled` 表示长时间没有任何文件事件；
 * `destroy` 表示场景已销毁，之后不可能再有文件写进纹理库。
 * 后两种都要留迟到登记：取消的请求仍可能在结算后落地。
 */
function settleRound(ledger: TextureLedger, round: TextureWriteRound,
  kind: 'complete' | 'stalled' | 'destroy'): void {
  if (round.finished) return;
  round.finished = true;
  round.detach();
  let unsettled = 0;
  for (const write of round.writes) {
    if (write.settled) continue;
    unsettled++;
    if (kind !== 'complete') armLateWrite(ledger, write.key);
    finishWrite(ledger, write, true);
  }
  round.close();
  if (kind !== 'complete' && unsettled)
    globalThis.storyDiagnostics?.record(
      kind === 'stalled' ? 'texture-write-timeout' : 'texture-write-unobservable',
      { key: round.writes[0]!.key, keys: unsettled });
}

function ledgerFor(scene: Phaser.Scene): TextureLedger {
  let ledger = ledgers.get(scene.textures);
  if (ledger) return ledger;
  // 纹理和动画都属于全游戏共用的管理器；这里不能捕获某个具体 Scene，
  // 否则清理时会去错误的场景账本里找特效动画。
  const textures = scene.textures, anims = scene.anims;
  // 租约归零时画面里可能还有借用这张图的显示对象（菜单预览等），先确认没人再画；
  // 新租约接管同一张图时取消排队，避免兜底队列删掉刚重新加载的纹理。
  const pool = new AssetPool(key => releaseTextureWhenUnused(textures, anims, key),
    key => cancelPendingTextureRemoval(textures, key));
  const created: TextureLedger = { textures, anims, pool, writes: new Map(), late: new Map() };
  ledgers.set(textures, created);
  if (typeof textures.on === 'function') {
    textures.on('addtexture', (key: string) => {
      // 有登记的写入：这次落地就是它的结果。没有写入但还留着迟到登记的旧文件：
      // 无主就退役，有主则已经被新租约接管，什么都不用做。
      const write = created.writes.get(key);
      if (write) { finishWrite(created, write, true); return; }
      const timer = created.late.get(key);
      if (!timer) return;
      clearTimeout(timer);
      created.late.delete(key);
      retireUnclaimedTexture(created, key);
    });
  }
  return created;
}

function loaderCounts(scene: Phaser.Scene): Map<string, number> {
  let counts = activeLoaders.get(scene.textures);
  if (!counts) { counts = new Map(); activeLoaders.set(scene.textures, counts); }
  return counts;
}

function changeLoaders(scene: Phaser.Scene, keys: Iterable<string>, delta: 1 | -1): void {
  const counts = loaderCounts(scene);
  for (const key of keys) {
    const next = (counts.get(key) ?? 0) + delta;
    if (next > 0) counts.set(key, next); else counts.delete(key);
  }
}

/**
 * 已就绪的贴图再取一份租约，用于常驻资源与已生成的特效。
 *
 * 只接受**已经通过验收**的资源：缺纹理或缺帧时直接抛错。所有调用点都在加载完成之后，
 * 因此这里失败说明资源契约被破坏，应在加载期暴露，而不是等到播放动画时。
 */
export function retainLoadedSceneAssets(scene: Phaser.Scene,
  assets: Iterable<PendingAsset | string>): AssetLease {
  const keys: string[] = [];
  for (const asset of assets) {
    if (typeof asset === 'string') {
      if (!scene.textures.exists(asset)) throw new Error(`常驻资源尚未就绪：${asset}`);
      keys.push(asset);
      continue;
    }
    const gap = assetGap(scene, asset);
    if (gap) throw new Error(`常驻资源尚未就绪：${asset.key}（${gap === 'texture' ? '纹理未加载' : `缺少帧 ${gap.slice('frame:'.length)}`}）`);
    keys.push(asset.key);
  }
  return ledgerFor(scene).pool.acquire(keys);
}

async function inTextureQueue<T>(scene: Phaser.Scene, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const textures = scene.textures;
  const previous = textureQueues.get(textures) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  textureQueues.set(textures, previous.then(() => turn));
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
    signal.throwIfAborted();
    return await work();
  } finally { release(); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

type AssetGap = 'texture' | `frame:${string}`;

/** 纹理存在且 spritesheet 帧完整才算就绪；预检、加载、验收共用这一判据。 */
function assetGap(scene: Phaser.Scene, asset: PendingAsset): AssetGap | undefined {
  if (!scene.textures.exists(asset.key)) return 'texture';
  const texture = scene.textures.get(asset.key);
  if (asset.kind === 'atlas') {
    if (asset.frame && !texture.has(asset.frame)) return `frame:${asset.frame}`;
    for (const frame of asset.frames ?? []) if (!texture.has(frame)) return `frame:${frame}`;
    return undefined;
  }
  if (asset.kind !== 'spritesheet') return undefined;
  const end = asset.config.endFrame ?? -1;
  const count = end < 0 ? 1 : end - (asset.config.startFrame ?? 0) + 1;
  for (let frame = 0; frame < count; frame++) if (!texture.has(String(frame))) return `frame:${frame}`;
  return undefined;
}

/** 同一纹理键的图集页可能被不同动作引用不同帧；合并帧集合，其他字段必须一致。 */
export function mergePendingAsset(previous: PendingAsset, next: PendingAsset): PendingAsset {
  if (previous.kind === 'atlas' && next.kind === 'atlas' && previous.file === next.file && previous.atlas === next.atlas) {
    const frames = [...new Set([...(previous.frames ?? []), ...(next.frames ?? [])])].sort();
    return { ...previous, frames };
  }
  if (JSON.stringify(previous) !== JSON.stringify(next))
    throw new Error(`贴图键指向不同资源：${next.key}`);
  return previous;
}

/** 纹理和 spritesheet 帧都不缺才算已加载；用于静默重建前的 preflight。 */
export function missingSceneAssets(scene: Phaser.Scene, assets: readonly PendingAsset[]): PendingAsset[] {
  return assets.filter(asset => assetGap(scene, asset) !== undefined);
}

function removeTexture(anims: Phaser.Animations.AnimationManager, textures: Phaser.Textures.TextureManager, key: string): void {
  releaseEffectAnimations(anims, key);
  if (anims.exists(key)) anims.remove(key);
  if (textures.exists(key)) textures.remove(key);
}

function verifyAssets(scene: Phaser.Scene, assets: PendingAsset[]): void {
  const failures: string[] = [];
  for (const asset of assets) {
    const gap = assetGap(scene, asset);
    if (gap === 'texture') failures.push(`${asset.key} (${asset.file})：纹理未加载`);
    else if (gap) failures.push(`${asset.key} (${asset.file})：缺少帧 ${gap.slice('frame:'.length)}`);
  }
  if (failures.length) throw new Error('部分画面未能加载，请重试', { cause: new Error(failures.join('\n')) });
}

/**
 * 登记本批要下载的纹理键，并在文件落定、失败、场景关闭或兜底到期时结算。
 * 监听必须在 scene.load.start() 之前挂好：已完成的文件不会再补发事件。
 */
function registerTextureWrites(ledger: TextureLedger, scene: Phaser.Scene,
  assets: readonly PendingAsset[]): TextureWriteRound {
  let closeRound!: () => void;
  const round: TextureWriteRound = {
    writes: [], byKey: new Map(), finished: false, detach: () => {}, touch: () => {},
    closed: new Promise<void>(resolve => { closeRound = resolve; }),
    close: () => closeRound(),
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  /** 文件事件不断把停摆期限往后推；慢网、排队、重试都不会被误判成停摆。 */
  round.touch = () => {
    if (round.finished) return;
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = setTimeout(() => settleRound(ledger, round, 'stalled'), WRITE_DEADLINE_MS);
    unrefTimer(deadline);
  };
  /** 场景关闭后 Loader 不再发事件，只能看文件自己的状态：还在加载就继续等。 */
  const pollFiles = () => {
    if (round.finished) return;
    let open = 0;
    for (const write of round.writes) {
      if (write.settled) continue;
      if (fileFinished(write.file)) finishWrite(ledger, write, true);
      else open++;
    }
    if (open) return;
    round.finished = true;
    round.detach();
    round.close();
    globalThis.storyDiagnostics?.record('texture-write-unobservable',
      { key: round.writes[0]?.key, keys: round.writes.length });
  };
  const startPoll = () => {
    if (poll !== undefined) return;
    poll = setInterval(pollFiles, WRITE_POLL_MS);
    unrefTimer(poll);
  };
  for (const asset of assets) {
    let resolve!: () => void;
    const done = new Promise<void>(value => { resolve = value; });
    const write: TextureWrite = {
      key: asset.key, identity: downloadIdentity(asset), scene, round, settled: false, done, resolve };
    ledger.writes.set(asset.key, write);
    const late = ledger.late.get(asset.key);
    if (late) { clearTimeout(late); ledger.late.delete(asset.key); }
    round.writes.push(write);
    round.byKey.set(asset.key, write);
  }
  const load = scene.load;
  const settleKey = (key: string): void => {
    // 同一纹理库的写入按队列串行，同一时刻不会有两个批次登记同一个键。
    const write = round.byKey.get(key);
    if (write && !write.settled) finishWrite(ledger, write, true);
  };
  // Loader 只在真正接受文件时发 addfile；记下文件对象，场景关闭后靠它的 state 结算。
  const onAddFile = (key: string, _type: string, _loader: unknown, file: Phaser.Loader.File) => {
    const write = round.byKey.get(key);
    if (write && !write.settled) write.file = file;
  };
  const onFileComplete = (key: string) => settleKey(key);
  const onLoadError = (file: { key?: string } | undefined) => { if (file?.key) settleKey(file.key); };
  const onComplete = () => settleRound(ledger, round, 'complete');
  const onShutdown = () => startPoll();
  const onDestroy = () => settleRound(ledger, round, 'destroy');
  load.on('addfile', onAddFile);
  load.on('filecomplete', onFileComplete);
  load.on('loaderror', onLoadError);
  load.once('complete', onComplete);
  scene.events.once('shutdown', onShutdown);
  scene.events.once('destroy', onDestroy);
  round.touch();
  round.detach = () => {
    load.off('addfile', onAddFile);
    load.off('filecomplete', onFileComplete);
    load.off('loaderror', onLoadError);
    load.off('complete', onComplete);
    scene.events.off('shutdown', onShutdown);
    scene.events.off('destroy', onDestroy);
    if (deadline !== undefined) clearTimeout(deadline);
    if (poll !== undefined) clearInterval(poll);
  };
  return round;
}

/** 等这些键的在途写入结束；期间如果对方的场景还活着，把它的进度接给当前进度条（只增不减）。 */
async function waitForTextureWrites(ledger: TextureLedger, keys: readonly string[],
  signal: AbortSignal, report: (value: number) => void): Promise<void> {
  const writes = keys.map(key => ledger.writes.get(key))
    .filter((write): write is TextureWrite => write !== undefined && !write.settled);
  if (!writes.length) return;
  const sources = new Set<Phaser.Loader.LoaderPlugin>();
  const onProgress = (value: number) => report(value);
  for (const write of writes) {
    const load = write.scene?.load;
    if (!load || typeof load.on !== 'function' || sources.has(load)) continue;
    sources.add(load);
    load.on('progress', onProgress);
  }
  try {
    await abortable(Promise.all(writes.map(write => write.done)), signal);
  } finally {
    for (const load of sources) load.off('progress', onProgress);
  }
}

/**
 * 取消只结束调用方的等待，不结束在途写入：后来者必须等这次写入落定，避免两代文件
 * 同时写同一个纹理键。返回仍被其他写入挡住的键，交给调用方等待后重试。
 */
async function writeFreeAssets(ledger: TextureLedger, scene: Phaser.Scene, needed: readonly PendingAsset[],
  progress: (value: number) => void, signal: AbortSignal): Promise<string[]> {
  const free: PendingAsset[] = [];
  const blocked: string[] = [];
  for (const asset of needed) {
    const write = ledger.writes.get(asset.key);
    if (!write) { free.push(asset); continue; }
    if (write.identity !== downloadIdentity(asset))
      throw new Error(`贴图键指向不同资源：${asset.key}`);
    blocked.push(asset.key);
  }
  // 残帧修复只处理本批真正要写的键：在途批次可能已经删过同一张残图，不能重复删。
  for (const asset of free) {
    if (assetGap(scene, asset) === 'texture') continue;
    const holders = ledger.pool.holders(asset.key);
    const loading = loaderCounts(scene).get(asset.key) ?? 0;
    // 只有“正在加载这个键、还没开始用纹理”的其他调用者可以和本次一起等重建；
    // 真正持有纹理的租约（地图/舞台/常驻包）仍然不能删。
    if (holders !== 1 && holders !== loading)
      throw new Error(`贴图 ${asset.key} 仍被其他租约持有，无法补齐缺失帧`);
    removeTexture(scene.anims, scene.textures, asset.key);
  }
  if (!free.length) return blocked;
  const round = registerTextureWrites(ledger, scene, free);
  await new Promise<void>((resolve, reject) => {
    const clean = () => { scene.load.off('progress', progress); scene.load.off('complete', complete); signal.removeEventListener('abort', cancelled); };
    const cancelled = () => { clean(); reject(signal.reason); };
    const complete = () => { clean(); resolve(); };
    scene.load.on('progress', progress); scene.load.once('complete', complete); signal.addEventListener('abort', cancelled, { once: true });
    // Loader 在已经关闭时 start() 会静默 no-op，永远等不到 complete；写入结算时也要放行，
    // 后面的缺口复查会给出明确失败，而不是把整条纹理队列卡死。
    void round.closed.then(() => { clean(); resolve(); });
    try {
      for (const asset of free) {
        if (asset.kind === 'image') scene.load.image(asset.key, versionedAsset(asset.file));
        else if (asset.kind === 'spritesheet') scene.load.spritesheet(asset.key, versionedAsset(asset.file), asset.config);
        else scene.load.atlas(asset.key, versionedAsset(asset.file), versionedAsset(asset.atlas));
      }
      scene.load.start();
    } catch (error) {
      // 文件没排进去就不会再有结算信号，别让这个键白占着写入权。
      clean();
      settleRound(ledger, round, 'complete');
      throw error;
    }
  });
  // complete 时已经结算过一轮；这里再兜一次，覆盖解码失败这类不发 addtexture 的情况。
  settleRound(ledger, round, 'complete');
  return blocked;
}

export async function loadSceneAssets(scene: Phaser.Scene, assets: PendingAsset[], progress: (value: number) => void, retain=false, signal?: AbortSignal): Promise<AssetLease> {
  signal?.throwIfAborted();
  const ledger = ledgerFor(scene);
  const pool = ledger.pool;
  const byKey = new Map<string, PendingAsset>();
  for (const asset of assets) {
    const previous = byKey.get(asset.key);
    if (previous) { byKey.set(asset.key, mergePendingAsset(previous, asset)); continue; }
    byKey.set(asset.key, asset);
  }
  const unique = [...byKey.values()];
  const keys = unique.map(asset=>asset.key);
  // 已齐全的纹理只需取得使用权；它们不会写纹理库，不必等其他地图的下载。
  if (unique.every(asset => assetGap(scene, asset) === undefined)) {
    const ownership = pool.acquire(keys);
    const lease = { release: () => { scene.events.off('shutdown', lease.release); ownership.release(); } };
    if (!retain) scene.events.once('shutdown', lease.release);
    try { progress(1); return lease; }
    catch (error) { lease.release(); throw error; }
  }
  changeLoaders(scene, keys, 1);
  const ownership = pool.acquire(keys);
  const lease = {release:()=>{scene.events.off('shutdown',lease.release);ownership.release();}};
  const controller = new AbortController();
  const shutdown = () => controller.abort(new DOMException('场景已关闭','AbortError'));
  scene.events.once('shutdown',shutdown);
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  // 等待别人的下载时，进度只能前进；自己的 loader 重新开始时也不会把进度条拉回 0。
  let reported = -1;
  const report = (value: number) => {
    if (!(value > reported)) return;
    reported = value;
    progress(value);
  };
  try {
    for (let pass = 0; ; pass++) {
      const blocked = await inTextureQueue(scene, controller.signal, async () => {
        controller.signal.throwIfAborted();
        const needed = unique.filter(asset => assetGap(scene, asset) !== undefined);
        if (!needed.length) return [];
        return writeFreeAssets(ledger, scene, needed, report, controller.signal);
      });
      if (!blocked.length) break;
      if (pass >= 2) throw new Error(`贴图 ${blocked[0]} 仍在写入中`);
      await waitForTextureWrites(ledger, blocked, controller.signal, report);
    }
    controller.signal.throwIfAborted();
    report(1);
    // Phaser 的图片解码失败不发 loaderror；complete 也不保证纹理和帧已入库。
    verifyAssets(scene, unique);
    scene.events.off('shutdown',shutdown);
    if(!retain)scene.events.once('shutdown',lease.release);
    return lease;
  }catch(error){
    // 取消只结束这边的等待：在途写入仍由登记负责结算和清理。
    if(!controller.signal.aborted) globalThis.storyDiagnostics?.record('asset-load-error',
      {error,files:unique.map(asset=>({key:asset.key,file:asset.file}))});
    scene.events.off('shutdown',shutdown);lease.release();throw error;
  }finally{
    signal?.removeEventListener('abort', cancel);
    changeLoaders(scene, keys, -1);
  }
}
