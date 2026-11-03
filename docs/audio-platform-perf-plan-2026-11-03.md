# 音频与平台服务：逐问题的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何代码**。每个问题单独成案，各自带代码证据、为什么会变慢（或为什么不会）、改法、风险、验证和预期。

排查范围是玩家反馈的「运行一段时间后很卡」在音频与平台服务这两块的表现。平台服务指页面上那几样常驻能力：诊断上报、自动存档、云存档、静态资源服务与资源池。

## 一句话结论

两处都没有「每帧越来越慢」的结构。会随游玩增长的只有内存：

1. 切歌时「加载到一半被放弃」的音频，解码后的原始声音数据留在缓存里没人删，一首 24–28 MB（问题一）。
2. 回菜单后 3 张地图的贴图不释放，继续占显存（问题六）。

手机 WebView（= 手机里负责显示网页的那个组件）在内存吃紧后会整体变慢、掉帧，甚至丢掉 WebGL 上下文（= 浏览器画图用的那块 GPU 会话）。这是「跑一段时间变卡」目前最像的链路。其余问题是固定上限或一次性尖峰，不会越玩越重。

## 三块各自的判断

| 块 | 判断 |
|---|---|
| 音频 | 播放本身每帧成本固定。解码缓存有明确上限（当前 + 上一首 BGM 约 50 MB，170 个音效约 18 MB），但「加载到一半被放弃」的曲子会突破这个上限。 |
| 平台服务 | 诊断、自动存档、云存档、静态服务全是事件驱动，没有轮询、没有定时请求；成本是「一次一次」的尖峰，不随时间累积。 |
| 观测 | 线上帧采样被 `?perf` 挡住，一条数据都没有。改完没法证明效果，这是第一个要补的。 |

## 数据与口径

- 本文**没有新的运行时测量**。结论来自三样：代码逐行核读、线上诊断 `client-errors*.jsonl`（2043 条、526 个会话）、仓库里既有的性能审查（其中 `docs/performance.md` 已在工作区删除，数字仍可用 `git show 974eb76:docs/performance.md` 查到）。
- 一首 BGM 解码后多大是复算的：用 `afinfo` 实测 13 首时长（24.0–85.6 秒），按 44.1 kHz、双声道、Float32（每样本 4 字节）算，**24–28 MB/首**，与既有文档一致。
- 170 个音效解码后约 18 MB（mp3 原文件共 2.2 MB）。
- 线上 `frame-stats` **0 条**，所以下文所有「预期」都是推算，不是实测。
- 手机上的音频确实在跑：826 条 iPhone 记录的音频设置都是音乐、音效全开；247 条 (0,0) 全是桌面开发期。
- 一处更正：剧情预取上限已经不是 20 张，`src/app.ts:178` 现在是 **2 张**；`docs/performance.md` 里那条待办已过期。

## 问题清单速览

| # | 问题 | 位置 | 会随时间变重 | 优先级 |
|---|---|---|---|---|
| 一 | 切歌时被放弃的音频缓存没人删 | `src/application/game-audio.ts:239` | 会，每首 24–28 MB | 高 |
| 二 | `stopAll()` 只停不删，声音对象残留 | `src/application/game-audio.ts:133` | 会，频率低 | 中 |
| 三 | 音频加载开关可能卡死，之后彻底没声音 | `src/application/game-audio.ts:285` | 不会，但不可恢复 | 中 |
| 四 | 诊断每次记录都同步写浏览器存储 | `public/diagnostics.js:101` | 不会，放大器 | 中 |
| 五 | 转屏或尺寸变化就写全量存档并重画界面 | `src/main.ts:661` | 不会，尖峰 | 中 |
| 六 | 回菜单后 3 张地图贴图不释放 | `src/app.ts:160`、`src/main.ts:371/531` | 会，占内存 | 中 |
| 七 | 线上没有任何帧数据 | `public/diagnostics.js:26` | — | 最高（先做） |

---

## 问题一：切歌时被放弃的音频缓存没人删

### 代码证据

`src/application/game-audio.ts:217` 的 `applyLoop()` 负责切曲。它先停掉并销毁当前循环音，再去加载新曲子：

```ts
// src/application/game-audio.ts:238-256
void this.load(key, path).then(loaded => {
  const current = music ? this.settings.music : this.settings.effects;
  if (!loaded || revision !== (music ? this.musicRevision : this.ambienceRevision) || current <= 0) return;
  ...
});
```

`:239` 这句 `return` 只表示「这次不播了」，**没有删 `scene.cache.audio` 里的 key**。

缓存的归属由两套手写逻辑管：

- `retainedMusic`（`:49` 声明，`:248 retainMusic()` 维护）：记录「播放过、后来被换下」的 BGM，最多 1 首（`MUSIC_CACHE_RETENTION = 1`，`:21`）。
- `releaseRetainedMusic()`（`:261`）：只在音乐音量被拖到 0 时清空这个数组。

两套都覆盖不到「**还在加载、从没播过就被换掉**」的曲子。这类 key 不在任何名单里，于是永久占着解码后的音频数据。

`docs/audio.md` 已经写过这条风险；`tests/game-audio.test.ts` 的用例名也印证了行为是「abandons late cinematic music loads」——只断言不播放，没断言释放。

### 为什么会越玩越卡

Web Audio 的缓存存的是**解码后的原始声音**（mp3 解开成 44.1 kHz 双声道浮点），不是压缩文件。一首 79 秒的曲子约 13.9 MB（单声道）到 27.9 MB（双声道），文档口径是 24–28 MB。

每次「切曲快于加载」就漏一首，且永不回收。内存涨上去以后，手机浏览器会先变慢（贴图上传变慢、GC 变频繁），再严重就丢上下文或整个页面被回收。

触发条件：

- 两次切曲的间隔小于一首曲子的加载时间（手机上 1.5 MB 的 mp3 约 0.3–2 秒）。
- 加载途中把音乐音量拖到 0。
- 进剧情、进菜单打断正在加载的曲子。

内容上 28.9% 的地图出口会换 BGM，所以「快速连续过图」是最容易踩的场景。

### 改法

把「谁该留、谁该删」收进一个函数，不要再让三套逻辑各管一段。

1. 新增字段：
   - `loadedLoops: Set<string>`：本类加载成功过的循环 key（`bgm:*`，以及当环境音用的 `se:*`）。
   - `musicKey?: string` / `ambienceKey?: string`：这一通道**想要**的 key。在 `applyLoop()` 发起加载时就写，不是等播放成功才写。
   - `previousMusicKey?: string`：上一首真正播过的 BGM。
2. 新增 `pruneLoops()`：

   ```ts
   const keep = new Set([this.musicKey, this.ambienceKey, this.playingMusicKey,
     this.playingAmbienceKey, this.previousMusicKey].filter(Boolean));
   for (const key of this.loadedLoops)
     if (!keep.has(key)) { this.scene.cache.audio.remove(key); this.loadedLoops.delete(key); }
   ```
3. 在 `applyLoop()` 的 `.then` 里调用：先把 `loaded` 的 key 记进 `loadedLoops`，然后**无论走哪条分支**（正常播放、过期、静音、失败）都调一次 `pruneLoops()`。被放弃的那次加载自己会触发清理，不需要别人记得。
4. 删掉 `MUSIC_CACHE_RETENTION`、`retainedMusic`、`retainMusic()`、`dropRetainedMusic()`、`releaseRetainedMusic()`，以及 `applyLoop` 里给它们的三处调用。

### 风险

- **A→B→A 连点**：同一个 key 的加载 promise 会被两代请求共用。删缓存只能依据「这个 key 现在还有人要吗」（keep 集），不能依据 revision；否则先注册的回调会把后一个回调要用的 key 删掉，`sound.add()` 拿到空音频。测试 harness 里的 `assert.ok(cache.has(key))` 会抓到这种错。
- 删缓存不影响正在播的那一首：`WebAudioSound` 在构造时就把 `audioBuffer` 取到自己身上（`node_modules/phaser/src/sound/webaudio/WebAudioSound.js:54`），播放和暂停恢复都用自己那份（同文件 `:423`），不再回缓存取。
- 如果一个名字同时被当环境音和一次性音效用，清理会把音效的缓存也删掉，下次播放重新加载一次，不影响正确性。

### 验证

`tests/game-audio.test.ts` 新增 4 条：

1. A 还没加载完就切到 B，A 的加载完成后 `cachedKeys()` 里不能有 A（先写成红，再改实现）。
2. A→B→A 连点，最终 A 在播、缓存存在、不抛异常。
3. 加载途中把音乐音量拖到 0，加载完成后缓存要删、不播放。
4. 加载失败路径不留下缓存。

现有 5 条契约用例（保留上一首、超量释放、音量变化不重启等）不能回归。

### 预期

正常游玩时音频常驻内存从「无上限增长」变回文档里的约 70 MB。快速切图场景下的内存曲线应该变平；具体数字要等第七条（采样）上线后才有真机证据。

---

## 问题二：`stopAll()` 只停不删

### 代码证据

```ts
// src/application/game-audio.ts:133-136
stopStoryAudio():void {
  this.restoreStoryAudio({music:null,ambience:null});
  this.scene.sound.stopAll();
}
```

`restoreStoryAudio` 已经把两个循环音停掉并销毁了；`stopAll()` 是给「正在播的一次性音效」补一刀，让它们立刻安静。

但 Phaser 的 `BaseSoundManager.stopAll` 是逐个 `forEachActiveSound(sound => sound.stop())`；而 `stop()` 只改 `isPlaying`/`isPaused`，只有 `destroy()` 才会把声音标记成可删除（`node_modules/phaser/src/sound/BaseSound.js:489` 的 `pendingRemove = true`）。

结果：被 `stopAll()` 打断的一次性音效**永远留在 `manager.sounds` 数组里**。每帧的 `update` 都要遍历它，它身上还挂着静音、音量、声像三个音频节点（`WebAudioSound.destroy` 才会 disconnect）。

### 为什么会越玩越卡

频率很低——`public/content` 全量只有 1 处 `stop-audio`——所以它是「确定的漏洞、很低的频率」。但它确实只增不减，属于同类问题里最便宜就能修掉的一条。

### 改法

推荐 A：保留「立刻静音」的语义，把对象一起清掉。

```ts
stopStoryAudio():void {
  this.restoreStoryAudio({music:null,ambience:null});
  for (const sound of [...this.scene.sound.sounds]) sound.destroy();
}
```

B 方案：直接删掉 `stopAll()`。语义变成「让当前音效播完」，代码更少，但与现在的听感不同。

### 风险

A 方案会连 UI 音效一起停掉——这正是现在 `stopAll()` 的行为，不算变化。遍历时先拷一份数组，因为 `destroy()` 在当帧不会从数组里移除，而是等下一帧 `update` 统一 splice。

### 验证

测试 harness 里的假 `sound.play()` 现在只往 `played` 数组塞字符串、不建对象。改成和 Phaser 一样「每播一次建一个对象」，再断言 `stopStoryAudio()` 之后 `sound.sounds.length === 0`。

### 预期

故事里的 `stop-audio` 动作不再留下任何声音对象。这条是「防止慢性漏」，不是本次卡顿的主要来源。

---

## 问题三：音频加载开关可能卡死

### 代码证据

`src/application/game-audio.ts:285` 的 `flush()` 用一个布尔量当开关：

```ts
if (this.loading || !this.queued.size) return;
...
this.loading = true;
...
this.scene.load.once('complete', () => { ...; this.loading = false; ... });
this.scene.load.start();
```

开关只在收到 `complete` 事件时关。而 Phaser 的 `LoaderPlugin.start()` 开头是：

```js
// node_modules/phaser/src/loader/LoaderPlugin.js:916
if (!this.isReady()) { return; }
```

`isReady()` 只在 IDLE / COMPLETE 两个状态为真（同文件 `:896`）。加载器正忙或被 shutdown 时，`start()` 静默返回，**不会发 `complete`**。于是开关永远是开的，之后所有音频加载都不再执行。

### 为什么会变卡（其实不会）

表现不是卡，是**彻底没声音而且不报错**。触发条件很窄：目前只有音频场景的加载器被 shutdown 才会（音频场景是常驻场景，正常流程不会停）。所以它不是本次卡顿的原因，但一旦发生不可恢复，值得顺手修。

### 改法

1. `start()` 之后检查一次：如果 `!this.scene.load.isLoading()`，说明这批根本没起来——立刻把这批全部 `resolve(false)`、把 `loading` 关掉、写 `failedUntil` 冷却。
2. 监听 `this.scene.events.once(SHUTDOWN, ...)`，场景退出时强制清开关。

### 风险

`isLoading()` 在 `start()` 之后同步返回 true（真正开始处理在下一帧的 `update`），所以判断不会误伤正常路径。

### 验证

把假 loader 的 `start()` 改成「什么都不发」，断言 promise 仍然会 resolve（false），并且后续一次正常加载还能成功。

### 预期

音频加载失败退化成「这次没声音、下次还能加载」，不再永久静音。

---

## 问题四：诊断每次记录都同步写浏览器存储

### 代码证据

`public/diagnostics.js:100`：

```js
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch {}
}
```

`record()`（`:150`）每记一条就：深拷贝快照 → 组 entry → `JSON.stringify` 判断是否超过 12 KB → 队列截到 32 条 → **同步** `persist()` → `void flush()`。

`flush()`（`:122`）每次只发 1 条（`const batch = pending.slice(0, 1)`），每 2 秒的定时器调一次（`:218`），所以 32 条积压要 64 秒才排空。

`console.error` 被整体包装（`:173-175`），每次调用都走一遍 `record`。

### 为什么会变慢

不是随时间累积，是「错误一多就放大」：单条记录约 1 KB（线上 p50 1064 B、p90 1695 B、最大 7917 B），32 条队列约 30 KB；`localStorage.setItem` 是同步阻塞主线程的，错误风暴时每条错误写一次盘，最坏约 384 KB。

线上数据里没有风暴（`console-error` 5 条、`story-error` 5 条），所以它是放大器，不是本次卡顿的原因。

### 改法

1. 记录只进内存；`persist()` 改成合并写：用 `setTimeout(0)` 或 `requestIdleCallback` 合并成一次写；`pagehide` 时强制同步写一次。
2. 同一 `kind` 在 1 秒内只记一条（丢掉重复的），避免错误风暴刷屏。
3. `flush()` 一次多发几条（比如 8 条），把队列排空速度提上来。

### 风险

页面被强杀时可能丢最后几条未落盘的记录——本来队列也只保留 32 条，可接受；`pagehide` 兜底已经覆盖正常退出。

### 验证

`public/diagnostics.js` 是浏览器 IIFE，目前没有单测。要测就把它包成可注入 `window`/`localStorage` 的函数，或在测试里用 `new Function` 注入假环境跑一遍，断言「100 次 record，写盘不超过 5 次」。

### 预期

错误风暴时的主线程阻塞从「每条一次」降到「每批一次」；正常游玩没有变化。

---

## 问题五：转屏或尺寸变化就写全量存档

### 代码证据

```ts
// src/main.ts:661-680
const setSuspended = (suspended: boolean): void => {
  ui.suspend(suspended);
  ... scene.scene.pause() / resume()
  if (suspended) app.game?.sound.pauseAll(); else app.game?.sound.resumeAll();
};
const sync = (): void => {
  const suspended = document.hidden || window.innerHeight > window.innerWidth;
  if(suspended&&!app.suspended)autoSaver?.flushForBackground();
  setSuspended(suspended);
};
```

`setSuspended` 没有「状态没变就直接返回」的短路；`sync` 绑在六类事件上：`visibilitychange`、`resize`、`orientationchange`、`visualViewport.resize`、竖屏媒体查询、`pageshow`。

每次触发都会：

- `ui.suspend()` → `updateControls()` → `view.sync()` 重画整个界面（`src/ui/game-ui.ts:95`）；
- 暂停/恢复场景、`pauseAll()`/`resumeAll()`；
- 从「没挂起」变成「挂起」时，同步写一份全量存档。

存档快照是 `structuredClone(this.baseEntities)` 加全部演员、战斗状态、舞台（`src/scenes/world-scene.ts:1452-1476`），然后 `JSON.stringify` 写 localStorage，全在同一个事件回调里。

### 为什么会卡

手机上地址栏一伸一缩、键盘弹出、转个屏，每次都是「整屏重排 + 一次全量深拷贝 + 序列化 + 同步写盘」，几十毫秒级。它不是渐变，但会在操作时突然一顿。

### 改法

1. `sync()` 先算新状态，和 `app.suspended` 相同就直接返回；`pagehide`/`pageshow` 仍然强制处理。
2. `flushForBackground()` 只在 `document.hidden` 或 `pagehide` 时调用；转屏和尺寸变化不落盘——后面还有进图、任务状态变化、5 分钟定时三种兜底。

### 风险

转屏后若进程立刻被系统回收，最后几秒进度可能丢。但转屏本身不是离开页面，隐藏（切后台）和 `pagehide` 两条路径仍然会写。

### 验证

`tests/auto-save.test.ts` 补两条：隐藏时写、尺寸变化不写。再手工转屏确认 localStorage 里的槽位时间戳没变。

### 预期

转屏、键盘、地址栏伸缩不再触发写盘；界面重排也从「每次事件」降到「状态真的变了才做」。

---

## 问题六：回菜单后 3 张地图贴图不释放

### 代码证据

```ts
// src/app.ts:160-163
retainMapAssets(lease: AssetLease): void {
  this.mapAssetHistory.push(lease);
  while(this.mapAssetHistory.length+(this.mapPrefetch ? 1 : 0)>3)this.mapAssetHistory.shift()!.release();
}
```

`mapAssetHistory` 记录最近 3 张地图的贴图「租约」（= 借用凭证，归还了才会真正删纹理）。回菜单时只清了预取：

```ts
// src/main.ts:371（stopCurrent）与 :531（返回菜单）
app.clearMapPrefetch(); app.clearStoryPrefetch();
```

没有清 `mapAssetHistory`。于是菜单界面上仍然压着 3 张地图的贴图，直到下次进图被顶掉。剧情预取池现在是 2 张（`src/app.ts:178`），这部分没问题。

### 为什么会越玩越卡

每次回菜单再进图，贴图并不会无限增长（上限 3 张），但它让菜单+战斗+剧情叠加时的内存基线更高。手机内存吃紧时，浏览器会先变慢、掉帧，再严重就丢 WebGL 上下文。线上有 2 条 `webgl-context-lost`，都在 10 月 25 日、早于贴图去重，不能直接归因，但方向一致。

### 改法

1. `src/app.ts` 加 `clearMapAssets()`：逐个 `lease.release()` 后清空 `mapAssetHistory`。
2. 在场景 shutdown 之后调用：`src/main.ts` 的 `stopCurrent`（场景停完再释放）和返回菜单路径各一处。
3. 顺带在 `trimTextures()` 处记录一次「当前贴图键数 + 估算字节数」（按每张 `width × height × 4` 累加），先把「一张图到底多少 MB」量出来。

### 风险

从菜单直接「继续游戏」回到同一张图时要重新加载贴图，进图首帧会慢一点。可接受——现在进图本来就要加载。

### 验证

`tests/scene-assets.test.ts` 或 app 层补一条：`retainMapAssets` 三次后 `clearMapAssets()`，断言每个 lease 都被 release 过。手工：回菜单后看 `game.textures.list` 的键数是否回落。

### 预期

回菜单后地图贴图占用归零；进图时重新加载。收益大小取决于一张图的贴图量，先量再定优先级。

---

## 问题七：线上没有任何帧数据（建议第一个做）

### 代码证据

```js
// public/diagnostics.js:26
const perfEnabled = /[?&]perf(?:=|&|$)/.test(String(location.search || ''));
```

采样入口 `addFrameSample`（`:43` 附近）开头就 `if (!perfEnabled ...) return;`；`reportFrameStats`（`:58`）30 秒一条。线上 `frame-stats` **0 条**——没有人带 `?perf` 玩过，或者带了但没触发上报。

`markFrame`（`:204`）每帧只写 `phase`/`lastFrame`/`stalled`，`?perf` 下才把 `update`/`render`/`idle` 的差值写进三个 `Float64Array`（各 1800 个样本）。

### 为什么要先做

没有真机帧时间，上面前六条改完只能靠「感觉快了」。采样是唯一能把「跑一段时间变卡」变成数字的东西。

### 改法

1. 采样常开（去掉 `perfEnabled` 门控，保留 `?perf=0` 关闭）；每帧仍只写三个数组，成本是几次浮点写。
2. `reportFrameStats` 改成每 5 分钟一条（`FRAME_REPORT_MS` 30 秒 → 300 秒），窗口仍是最近 1800 帧。
3. 字段增加几样能直接看出内存压力的：`textures`（贴图键数）、`audioKeys`（音频缓存键数）、`sounds`（声音对象数）、`jsHeapMB`（`performance.memory` 有就用）。
4. 取这些值走 `setSnapshot` 同款注入：新增 `setFrameStats(provider)`，在 `main.ts` 里接 `app.game` 的 `textures.list`、`cache.audio`、`sound.sounds`。

### 风险

条目变大可能触发 12 KB 截断；字段控制在 10 个以内，数值型，不会有问题（现在最大 7.9 KB，其中大头是 state 快照）。

### 验证

本地 `npm run dev` 跑 10 分钟，看 `?perf` 与非 `?perf` 都能落地 `frame-stats`，字段齐全、间隔 5 分钟、体积正常。

### 预期

下一版上线后拿到手机上的 p50/p95/max、长帧数和内存曲线，前六条的效果可以用同一口径对比。

---

## 跨文档：剧情每句台词的全量快照

`src/domain/story-runtime.ts:303` 每推进一个剧情节点都调一次 `port.capture()`，里面是会话快照 + 整张地图实体 + 舞台快照（`src/domain/story-director.ts:107-110`、`src/rendering/story-presenter.ts:87-115`）。这条属于「剧情/存档」线，已由 `docs/session-save-economy-performance-2026-11-03.md` 单独成案（那里的问题一，带 1.61 ms/次的实测），本文不重复。

这里只补一个交叉结论：那条链路的成本和音频的内存增长是两回事，别混在一起归因——前者是 CPU 上的稳定开销，后者是内存累积。

## 已排除的怀疑

| 怀疑 | 结论 |
|---|---|
| 云存档后台轮询 | 没有。构造函数不联网，只有登录/注册/改密/上传/下载才发请求，8 秒超时 + AbortController（`src/application/cloud-save.ts:277`）。 |
| 有没有定时网络请求 | 没有。全仓网络调用只有三处：启动取内容 JSON（`src/application/content-loader.ts:63`）、GM 上报、诊断上报。 |
| 音频每次播放都漏对象 | 不漏。`play()` 时挂 `once(COMPLETE, destroy)`，播完自动销毁；只有 `stopAll()` 是例外（问题二）。 |
| localStorage 会越写越大 | 不会。全仓只有 4 个键，都是定长覆盖写：云存档 token、音频设置、显示设置、诊断队列（上限 32 条）。 |
| 诊断条目越积越大 | 不会。单条 p50 1 KB、最大 7.9 KB，队列 32 条封顶。 |
| 静态服务/nginx 拖慢 | 没证据。`deploy/nginx/catgo.online.conf` 只做 4002→4004 转发；带 `?v=` 的资源是 `immutable` 长缓存，诊断接口 `no-store`。 |
| 音频文件缺失导致重试 | 没有。13 首 BGM、170 个音效在 `public/assets/audio` 全部存在。 |
| 首次战斗预载 131 个音效太慢 | 一次性、异步、不阻塞首帧；决策已定保留（首次播放不能慢半拍）。 |
| BGM 改成流式 | 明确不做，决策记录在既有性能审查里。 |
| 每帧 `markFrame` 太重 | 不重。非 `?perf` 只写三个字段、调 3 次 `Date.now()`。 |

## 修复顺序

1. **问题七**（帧/内存采样）——半天能落地，之后每条修复都有前后对比。
2. **问题一**（音频缓存归属）——唯一确定会随游玩涨内存的音频问题。
3. **问题二**（`stopAll` 销毁）——跟问题一用同一个测试文件，顺手。
4. **问题四**（诊断合并写）。
5. **问题五**（转屏不落盘 + 状态没变不重画）。
6. **问题六**（回菜单清贴图）——先量一张图多少内存，再决定动不动。
7. **问题三**（加载开关兜底）——健壮性，随时可做。

每条单独一个提交，提交说明写清「修了什么行为 + 验证了什么」，验证结果附上问题七上线前后的数字。

## 不在本轮范围

- 贴图与渲染管线本身（另有排查）。
- A* 寻路与建场卡顿：见 `docs/ai-pathfinding-frame-cost-2026-11-03.md`。
- 剧情快照与写档：见 `docs/session-save-economy-performance-2026-11-03.md`。
- 音频流式播放、收窄 `prepareCombat` 预载范围：已有决策，不翻案。

## 怎么复核

- 代码层：`npm test -- tests/game-audio.test.ts tests/auto-save.test.ts tests/scene-assets.test.ts`。
- 桌面内存：`npm run dev`，反复过图 30 次，在 DevTools 的 Memory 面板看音频缓存键数与 JS 堆曲线是否还在单调上涨。
- 手机：`4002` 或 APK，等第七条的 `frame-stats` 落地后，用同一套操作（进图→战斗→回菜单）对比改动前后的 p95、长帧数和 `jsHeapMB`。
- 口径：改前先跑一遍基线，改后再跑一遍，两次用同一台设备、同一张图、同一段操作。
