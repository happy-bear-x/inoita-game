import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { loadSceneAssets, missingSceneAssets, retainLoadedSceneAssets } from '../src/rendering/scene-assets.ts';
import type { PendingAsset } from '../src/rendering/scene-assets.ts';

const asset: PendingAsset = { kind: 'spritesheet', key: 'skill-effect', file: 'assets/effect.png', config: { frameWidth: 8, frameHeight: 8, endFrame: 2 } };
const diagnostic = (pattern: RegExp) => (error: unknown) => error instanceof Error && pattern.test(String(error.cause));

function setup() {
  const events = new EventEmitter();
  const textureEvents = new EventEmitter();
  const frames = new Map<string, Set<string | number>>();
  const textureObjects = new Map<string, { has(frame: string): boolean }>();
  const removed: string[] = [];
  /** 模拟 Phaser.Loader.File：state 10 未开始、11 加载中、17 完成、16 失败。 */
  const files = new Map<string, { key: string; state: number }>();
  /** 与 Phaser 一致：同一个键第二次写入只报错、不覆盖、不发 addtexture。 */
  const duplicateWrites: string[] = [];
  const queued: PendingAsset[] = [];
  let starts = 0;
  let outcome: 'success' | 'decode-error' | 'network-error' | 'missing-frame' | 'pending' = 'success';
  const textureFor = (key: string) => {
    let texture = textureObjects.get(key);
    if (!texture) {
      texture = { has: (frame: string) => {
        const values = frames.get(key)!;
        return values.has(frame) || values.has(Number(frame));
      } };
      textureObjects.set(key, texture);
    }
    return texture;
  };
  const addTexture = (key: string, values: Set<string | number> = new Set([0, 1, 2])): boolean => {
    if (frames.has(key)) { duplicateWrites.push(key); return false; }
    frames.set(key, values);
    textureFor(key);
    textureEvents.emit('addtexture', key);
    return true;
  };
  const load = Object.assign(new EventEmitter(), {
    spritesheet: (key: string, file: string, config: Phaser.Types.Loader.FileTypes.ImageFrameConfig) =>
      queued.push({ kind: 'spritesheet', key, file, config }),
    image: (key: string, file: string) => queued.push({ kind: 'image', key, file }),
    atlas: (key: string, file: string, atlas: string) => queued.push({ kind: 'atlas', key, file, atlas }),
    start: () => {
      starts++;
      const batch = queued.splice(0).map(asset => {
        // 图集是 MultiFile：Loader 实际接受的是图片和 JSON 两个子文件，父对象自己一直是 FILE_PENDING。
        const children = asset.kind === 'atlas'
          ? [{ key: asset.key, state: 11 }, { key: asset.key, state: 11 }]
          : [{ key: asset.key, state: 11 }];
        const parent = asset.kind === 'atlas' ? { key: asset.key, state: 10, files: children } : undefined;
        for (const child of children) (child as { multiFile?: unknown }).multiFile = parent;
        const file = children[children.length - 1]!;
        files.set(asset.key, file);
        // Loader 接受文件时发 addfile；场景关闭后实现靠这些对象的状态判断是否还在路上。
        for (const child of children) load.emit('addfile', child.key, asset.kind, load, child);
        return { asset, file, children, parent };
      });
      queueMicrotask(() => {
        if (outcome === 'pending') return;
        for (const { asset, file, children, parent } of batch) {
          if (outcome === 'network-error') {
            for (const child of children) child.state = 16;
            load.emit('loaderror', file); continue;
          }
          if (outcome === 'decode-error') { for (const child of children) child.state = 16; continue; }
          for (const child of children) child.state = 17; // FILE_COMPLETE
          if (parent) parent.state = 20; // FILE_PENDING_DESTROY
          if (asset.kind === 'atlas') addTexture(asset.key, new Set(outcome === 'success' ? ['frame-a', 'frame-b'] : ['frame-a']));
          else addTexture(asset.key, new Set(outcome === 'success' ? [0, 1, 2] : [0, 2]));
          // Phaser 在写进纹理库之后才发 filecomplete。
          load.emit('filecomplete', asset.key, asset.kind);
        }
        // Phaser's decode failure reaches complete without loaderror or a failed count.
        load.emit('complete', load, 0, 0);
      });
    }
  });
  const scene = {
    events, load,
    textures: {
      on: textureEvents.on.bind(textureEvents),
      exists: (key: string) => frames.has(key),
      get: textureFor,
      remove: (key: string) => { removed.push(key); frames.delete(key); textureObjects.delete(key); }
    },
    anims: { exists: () => false, remove: () => {} }
  } as unknown as Phaser.Scene;
  return { scene, events, load, frames, files, removed, duplicateWrites, queued, starts: () => starts,
    outcome: (next: typeof outcome) => { outcome = next; }, addTexture };
}

test('decode failure rejects with the asset key and path, then retry can acquire and release it', async () => {
  const run = setup(); run.outcome('decode-error');
  await assert.rejects(loadSceneAssets(run.scene, [asset], () => {}), diagnostic(/skill-effect.*assets\/effect\.png/));
  assert.equal(run.events.listenerCount('shutdown'), 0);
  assert.deepEqual(run.load.eventNames(), []);
  run.outcome('success');
  const lease = await loadSceneAssets(run.scene, [asset], () => {});
  lease.release(); lease.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('missing middle frames reject both fresh and cached sprite sheets', async () => {
  for (const cached of [false, true]) {
    const run = setup(); run.outcome('missing-frame');
    if (cached) run.frames.set(asset.key, new Set([0, 2]));
    await assert.rejects(loadSceneAssets(run.scene, [asset], () => {}), diagnostic(/skill-effect.*帧 1/));
    assert.equal(run.starts(), 1, '预检判缺时必须真的进入 loader');
    assert.equal(run.frames.size, 0);
    assert.equal(run.events.listenerCount('shutdown'), 0);
  }
});

test('cached sprite sheet with missing frames is rebuilt instead of skipped', async () => {
  const run = setup();
  run.frames.set(asset.key, new Set([0, 2]));
  assert.equal(missingSceneAssets(run.scene, [asset]).length, 1, '预检按帧判断');
  const lease = await loadSceneAssets(run.scene, [asset], () => {});
  assert.equal(run.starts(), 1, '残帧缓存必须重新加载');
  assert.deepEqual([...run.frames.get(asset.key)!], [0, 1, 2]);
  assert.equal(missingSceneAssets(run.scene, [asset]).length, 0);
  lease.release();
  assert.deepEqual(run.removed, [asset.key, asset.key], '重建时删旧纹理，租约释放时删新纹理');
});

test('a residual texture held by another lease is not rebuilt', async () => {
  const run = setup();
  const held = await loadSceneAssets(run.scene, [asset], () => {}, true);
  run.frames.set(asset.key, new Set([0, 2]));
  await assert.rejects(loadSceneAssets(run.scene, [asset], () => {}), /仍被其他租约持有/);
  assert.deepEqual([...run.frames.get(asset.key)!], [0, 2], '共享纹理不能删');
  assert.equal(run.removed.includes(asset.key), false);
  held.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('valid cached assets stay alive until the last lease is released', async () => {
  const run = setup();
  const first = await loadSceneAssets(run.scene, [asset, asset], () => {});
  const second = await loadSceneAssets(run.scene, [asset], () => {}, true);
  assert.equal(run.queued.length, 0);
  run.events.emit('shutdown');
  assert.equal(run.frames.size, 1);
  first.release(); second.release(); second.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('simultaneous requests on one scene share a loader batch and retain independent leases', async () => {
  const run = setup();
  const [first, second] = await Promise.all([
    loadSceneAssets(run.scene, [asset], () => {}),
    loadSceneAssets(run.scene, [asset], () => {}, true)
  ]);
  assert.equal(run.starts(), 1);
  first.release();
  assert.equal(run.frames.size, 1);
  second.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('scenes sharing one texture manager register a key only once', async () => {
  const run = setup();
  let otherStarts = 0;
  const otherLoad = Object.assign(new EventEmitter(), {
    image() {}, spritesheet() {}, start() { otherStarts++; }
  });
  const otherScene = { ...run.scene, events: new EventEmitter(), load: otherLoad } as unknown as Phaser.Scene;
  const [first, second] = await Promise.all([
    loadSceneAssets(run.scene, [asset], () => {}),
    loadSceneAssets(otherScene, [asset], () => {})
  ]);
  assert.equal(run.starts(), 1);
  assert.equal(otherStarts, 0, '同一纹理库已有加载在排队，另一个场景不应再启动 loader');
  assert.deepEqual(run.duplicateWrites, [], '同一个纹理键只允许写一次');
  first.release(); second.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('network failure and shutdown clean up loading listeners and ownership', async () => {
  const network = setup(); network.outcome('network-error');
  await assert.rejects(loadSceneAssets(network.scene, [asset], () => {}), diagnostic(/skill-effect/));
  assert.deepEqual(network.load.eventNames(), []);
  const cancelled = setup(); cancelled.outcome('pending');
  const pending = loadSceneAssets(cancelled.scene, [asset], () => {});
  cancelled.events.emit('shutdown');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled.events.listenerCount('shutdown'), 0);
  // 在途写入继续观察文件；loader 结束后才摘掉监听、清掉兜底定时器。
  cancelled.load.emit('complete', cancelled.load, 0, 0);
  assert.deepEqual(cancelled.load.eventNames(), []);
});

test('an explicit prefetch cancellation releases late textures without stopping the host scene', async () => {
  const run = setup(); run.outcome('pending');
  const controller = new AbortController();
  const pending = loadSceneAssets(run.scene, [asset], () => {}, true, controller.signal);
  // 让下载真正开始：取消只对已经在路上的文件有意义。
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(run.addTexture(asset.key), true);
  assert.equal(run.frames.has(asset.key), false);
  assert.deepEqual(run.duplicateWrites, []);
});

test('cancelling a queued request does not wait for another download', async () => {
  const run = setup(); run.outcome('pending');
  const firstController = new AbortController();
  const first = loadSceneAssets(run.scene, [asset], () => {}, true, firstController.signal);
  await new Promise(resolve => setImmediate(resolve));
  const secondController = new AbortController();
  const second = loadSceneAssets(run.scene, [{ kind: 'image', key: 'other', file: 'other.png' }], () => {}, true, secondController.signal);
  secondController.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(run.starts(), 1);
  firstController.abort();
  await assert.rejects(first, { name: 'AbortError' });
});

test('cancelled loading removes a texture that arrives after the lease is released', async () => {
  const run = setup(); run.outcome('pending');
  const pending = loadSceneAssets(run.scene, [asset], () => {});
  // 让下载真正开始，再模拟场景关闭：只有已经在路上的文件才会迟到落地。
  await new Promise(resolve => setImmediate(resolve));
  run.events.emit('shutdown');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(run.addTexture(asset.key), true);
  assert.equal(run.frames.has(asset.key), false, '迟到纹理没有新租约时应立即删除');
  assert.ok(run.removed.includes(asset.key));
  assert.deepEqual(run.duplicateWrites, []);
  // 写入登记已经清掉，之后同键请求可以重新下载。
  run.outcome('success');
  const lease = await loadSceneAssets(run.scene, [asset], () => {});
  assert.equal(run.starts(), 2);
  assert.equal(run.frames.has(asset.key), true);
  lease.release();
  assert.equal(run.frames.has(asset.key), false);
});

test('a request for a key already being written waits and adopts that write', async () => {
  const run = setup(); run.outcome('pending');
  const pending = loadSceneAssets(run.scene, [asset], () => {});
  // 让下载真正开始，再模拟场景关闭：只有已经在路上的文件才会迟到落地。
  await new Promise(resolve => setImmediate(resolve));
  run.events.emit('shutdown');
  await assert.rejects(pending, { name: 'AbortError' });
  run.outcome('success');
  let settled = false;
  const waiting = loadSceneAssets(run.scene, [asset], () => {}).then(lease => { settled = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '旧文件还没落定时，新请求不能自己再开一次下载');
  assert.equal(run.starts(), 1, '同一个纹理键不新开写入代');
  assert.equal(run.addTexture(asset.key), true);
  const lease = await waiting;
  assert.equal(run.duplicateWrites.length, 0, '同一个纹理键只允许写一次');
  assert.equal(run.frames.has(asset.key), true, '新租约接管的是这次写入的纹理');
  lease.release();
  assert.equal(run.frames.has(asset.key), false);
});

test('atlas assets load with string frames and verify their sentinel frame', async () => {
  const atlas: PendingAsset = { kind: 'atlas', key: 'props-atlas:0', file: 'assets/props/atlas/props-0.png',
    atlas: 'assets/props/atlas/props-0.json', frame: 'frame-a' };
  const run = setup();
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 1);
  run.frames.set(atlas.key, new Set(['frame-b']));
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 1, '哨兵帧缺失必须重新加载');
  const lease = await loadSceneAssets(run.scene, [atlas], () => {});
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 0);
  assert.equal(run.queued.length, 0);
  lease.release();
  assert.deepEqual(run.removed, [atlas.key, atlas.key], '哨兵帧缺失时先删旧纹理，释放时再删新纹理');
});

test('concurrent loaders can repair one damaged atlas texture without one failing', async () => {
  const atlas: PendingAsset = { kind: 'atlas', key: 'props-atlas:0', file: 'assets/props/atlas/props-0.png',
    atlas: 'assets/props/atlas/props-0.json', frame: 'frame-a' };
  const run = setup();
  run.frames.set(atlas.key, new Set(['frame-b'])); // 哨兵帧缺失的损坏缓存
  const [first, second] = await Promise.all([
    loadSceneAssets(run.scene, [atlas], () => {}),
    loadSceneAssets(run.scene, [atlas], () => {})
  ]);
  assert.equal(missingSceneAssets(run.scene, [atlas]).length, 0);
  first.release(); second.release();
  assert.deepEqual(run.removed, [atlas.key, atlas.key], '只删一次旧缓存，最后释放一次新纹理');
});

test('retaining assets verifies textures and frames before taking a lease', () => {
  const run = setup();
  assert.throws(() => retainLoadedSceneAssets(run.scene, [asset]), /常驻资源尚未就绪：skill-effect/);
  run.frames.set(asset.key, new Set([0, 2]));
  assert.throws(() => retainLoadedSceneAssets(run.scene, [asset]), /缺少帧 1/);
  run.frames.set(asset.key, new Set([0, 1, 2]));
  const lease = retainLoadedSceneAssets(run.scene, [asset]);
  lease.release();
  assert.deepEqual(run.removed, [asset.key]);
});

test('ready and empty asset requests finish while an unrelated download is still pending', async () => {
  const run = setup(); run.outcome('pending');
  const unrelated = { kind: 'image' as const, key: 'far-map', file: 'far-map.png' };
  const downloading = loadSceneAssets(run.scene, [unrelated], () => {}, true);
  await new Promise(resolve => setImmediate(resolve));
  run.frames.set(asset.key, new Set([0, 1, 2]));
  const otherScene = { ...run.scene, events: new EventEmitter() } as unknown as Phaser.Scene;
  let ready = false, empty = false;
  const cached = loadSceneAssets(otherScene, [asset], () => {}, true).then(lease => { ready = true; return lease; });
  const noAssets = loadSceneAssets(otherScene, [], () => {}).then(lease => { empty = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, true, '已经齐全的贴图不等远图下载'); assert.equal(empty, true);
  assert.equal(run.starts(), 1);
  run.frames.set(unrelated.key, new Set([0])); run.load.emit('complete');
  const leases = await Promise.all([downloading, cached, noAssets]);
  for (const lease of leases) lease.release();
  assert.equal(run.frames.size, 0);
});

test('missing frames still wait for the writer queue before repairing the texture', async () => {
  const run = setup(); run.outcome('pending');
  const unrelated = { kind: 'image' as const, key: 'far-map', file: 'far-map.png' };
  const downloading = loadSceneAssets(run.scene, [unrelated], () => {}, true);
  await new Promise(resolve => setImmediate(resolve));
  run.frames.set(asset.key, new Set([0, 2]));
  let repaired = false;
  const repairing = loadSceneAssets(run.scene, [asset], () => {}, true).then(lease => { repaired = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repaired, false); assert.equal(run.starts(), 1); assert.deepEqual([...run.frames.get(asset.key)!], [0, 2]);
  run.frames.set(unrelated.key, new Set([0])); run.outcome('success'); run.load.emit('complete');
  const leases = await Promise.all([downloading, repairing]);
  assert.equal(repaired, true); assert.equal(run.starts(), 2);
  for (const lease of leases) lease.release();
});

test('a late texture still drawn by a visible scene is retired after the reference disappears', async () => {
  const run = setup();
  const drawn = { type: 'Sprite', visible: true, frame: { texture: { key: asset.key } } };
  const frameEvents = new EventEmitter();
  const visible = { sys: { isVisible: () => true, settings: { key: 'world' } }, children: { list: [drawn] } };
  (run.scene.textures as unknown as { game: unknown }).game = { scene: { scenes: [visible] }, events: frameEvents };
  run.outcome('pending');
  const controller = new AbortController();
  const pending = loadSceneAssets(run.scene, [asset], () => {}, true, controller.signal);
  // 让下载真正开始：取消只对已经在路上的文件有意义。
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(run.addTexture(asset.key), true);
  assert.equal(run.frames.has(asset.key), true, '画面还在引用时不能删');
  visible.children.list = [];
  frameEvents.emit('postrender');
  assert.equal(run.frames.has(asset.key), false, '引用消失后在帧后检查里补删');
});

test('a different file for a key already being written is rejected without a second download', async () => {
  const run = setup(); run.outcome('pending');
  const controller = new AbortController();
  const first = loadSceneAssets(run.scene, [asset], () => {}, true, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const other = { ...asset, file: 'assets/other.png' };
  await assert.rejects(loadSceneAssets(run.scene, [other], () => {}), /贴图键指向不同资源/);
  assert.equal(run.starts(), 1, '冲突时不能启动第二次下载');
  run.addTexture(asset.key);
  assert.equal(run.frames.has(asset.key), false);
});

test('shutdown keeps the key blocked while the file is still in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = setup(); run.outcome('pending');
  const first = loadSceneAssets(run.scene, [asset], () => {});
  await new Promise(resolve => setImmediate(resolve));
  run.events.emit('shutdown');
  await assert.rejects(first, { name: 'AbortError' });
  run.outcome('success');
  let settled = false;
  const waiting = loadSceneAssets(run.scene, [asset], () => {}).then(lease => { settled = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '文件还在路上时，5 秒不能放行第二次写入');
  assert.equal(run.starts(), 1, '同一个键始终只有一个写入代');
  // 文件失败后轮询看到终态，才把写入权交给新请求。
  run.files.get(asset.key)!.state = 16;
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  const lease = await waiting;
  assert.equal(run.starts(), 2, '旧文件结束后新请求正常下载');
  lease.release();
});

test('shutdown keeps an atlas key blocked until all of its child files finish', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const atlas: PendingAsset = { kind: 'atlas', key: 'props-atlas:0', file: 'assets/props/atlas/props-0.png',
    atlas: 'assets/props/atlas/props-0.json', frame: 'frame-a' };
  const run = setup(); run.outcome('pending');
  const first = loadSceneAssets(run.scene, [atlas], () => {});
  await new Promise(resolve => setImmediate(resolve));
  run.events.emit('shutdown');
  await assert.rejects(first, { name: 'AbortError' });
  run.outcome('success');
  let settled = false;
  const waiting = loadSceneAssets(run.scene, [atlas], () => {}).then(lease => { settled = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  const file = run.files.get(atlas.key) as unknown as { multiFile: { state: number; files: { state: number }[] } };
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '图集还有子文件在路上时不能放行');
  file.multiFile.files[0]!.state = 17; // 只完成了图片，JSON 还在路上
  t.mock.timers.tick(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '只完成一个子文件仍不算结束');
  file.multiFile.files[1]!.state = 17;
  file.multiFile.state = 20;
  run.addTexture(atlas.key, new Set(['frame-a', 'frame-b']));
  const lease = await waiting;
  assert.equal(settled, true);
  lease.release();
});

test('a texture that lands after the write timed out is retired', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = setup(); run.outcome('pending');
  const pending = loadSceneAssets(run.scene, [asset], () => {});
  await new Promise(resolve => setImmediate(resolve));
  run.events.emit('shutdown');
  await assert.rejects(pending, { name: 'AbortError' });
  t.mock.timers.tick(35000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run.addTexture(asset.key), true);
  assert.equal(run.frames.has(asset.key), false, '停摆后落地的旧文件没有租约，应被迟到登记回收');
});

test('a write that never settles stops blocking the key after the fallback deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const run = setup(); run.outcome('pending');
  const first = loadSceneAssets(run.scene, [asset], () => {});
  await new Promise(resolve => setImmediate(resolve));
  run.events.emit('shutdown');
  await assert.rejects(first, { name: 'AbortError' });
  run.outcome('success');
  let settled = false;
  const waiting = loadSceneAssets(run.scene, [asset], () => {}).then(lease => { settled = true; return lease; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, '兜底到期前一直等这次写入');
  t.mock.timers.tick(35000);
  const lease = await waiting;
  assert.equal(settled, true);
  assert.equal(run.starts(), 2, '到期后允许重新下载');
  assert.deepEqual(run.duplicateWrites, [], '旧文件没有落地，不存在重复写入');
  lease.release();
});
