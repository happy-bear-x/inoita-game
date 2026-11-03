# 剧情、任务与演出：四个卡顿来源的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。四个问题各自独立成节，每节写清代码证据、为什么越玩越慢、怎么改、风险在哪、怎么验证。

排查起点是玩家反馈的「运行一段时间后很卡」。范围限定在剧情、任务、演出这条线，不涉及战斗数值、寻路和网络。

## 一句话结论

不是内存泄漏，也不是每帧算得太重。是**「复制整份游戏状态」这件事被放在了剧情主路径上，而状态本身随进度只增不减**：

- 剧情每推进一个节点，整份状态被复制五次，合计约 542 KB。
- 每开演一幕，整张地图和全部角色被拆掉重建一次。
- 每个节点还把「走过的所有地图」的演出快照克隆两轮。
- 每个剧情事件完成，整份存档序列化后同步写进 localStorage。

这四件事都不随帧率发生，而是随剧情推进发生。所以表现成「玩得越久越卡」，而不是「一开始就卡」。

## 与已有文档的分工

`docs/session-save-economy-performance-2026-11-03.md` 已经覆盖了 domain 层的快照成本，路线是**给各子系统加快照缓存**（修订号没变就复用上一次的快照），让一次全量快照从 1.61 ms 降到 0.3 ms 量级。

那份文档解决的是「抓得便宜」。本文的问题一解决的是「**根本不用抓**」——剧情节点的回滚基线本来就不需要包含会话状态。两条路线不冲突：本文的方案对存档和检查点没帮助，那份文档的方案对剧情节点也不再需要，但要先做完本文的问题一，那份文档的收益才对得上账。

本文的问题二、三、四，那份文档没有覆盖。

## 测量方法

- 环境：Node 24，Mac 桌面，真实 `public/content`（505 个任务、593 个事件、693 段脚本、3635 个节点），用 `src/debug/headless-story.ts` 的 `createHeadlessStory` 在 Node 里跑纯逻辑。
- 测量脚本是临时文件，不在仓库里。复测时用同一套口径：按真实触发顺序放 200 个事件，每放一个就量一次节点耗时和快照体积。
- 手机还没有正式数据。按经验同操作大约慢 5–10 倍，本文的结论以趋势和相对值为主。
- 注意：4003 是 Vite 开发服务器，性能和 4002（打包产物）或 APK 不是一回事。手机结论只能基于 4002 或 APK 上的 `?perf` 数据。

### 节点耗时的实测曲线

| 已完成事件数 | 单节点耗时 | 一份会话快照 |
|---|---|---|
| 0 | 0.35 ms | 48 KB |
| 60 | 0.68 ms | 91 KB |
| 120 | 1.49 ms | 159 KB |
| 160 | 1.73 ms | 190 KB |

首尾差 4.9 倍，曲线还在涨。

### 那 1.73 ms 花在哪

`node --cpu-prof` 采样 160 个事件、5945 个样本：

| 函数 | 占比 |
|---|---|
| `structuredClone` | **83.1%** |
| `prepareRestore`（`story-runtime.ts:125`） | 1.7% |
| `commit`（测脚本自己的） | 1.1% |
| `prepareRuntime`（`session.ts:327`） | 1.0% |
| `getWorldChanges`（测脚本里的对应实现） | 1.0% |
| 其余（含 GC 1.2%） | 都 ≤ 0.5% |

也就是说，这一段的开销有八成以上就是「复制对象」本身。

### 190 KB 快照里装了什么

| 部分 | 体积 | 占比 | 怎么长起来的 |
|---|---|---|---|
| 任务簿（505 条） | 45 KB | 24% | 固定，不随时间变 |
| 剧情世界 | 67 KB | 35% | 越探索越大 |
| 剧情运行时 | 69 KB | 36% | 每完成一个事件加一条 |
| 其他（回执、背包等） | 9 KB | 5% | 缓慢 |

剧情世界里最大的一块是旗标（约 28 KB），其次是实体记录（19 KB）和遭遇记录（17 KB）。

---

## 问题一：剧情每推进一个节点，整份状态复制五次

### 代码证据

`StoryRuntime.execute`（`src/domain/story-runtime.ts:293-369`）每处理一个节点，会依次发生：

| # | 位置 | 复制什么 | 约多少 |
|---|---|---|---|
| 1 | `story-runtime.ts:303` → `story-director.ts:108` | `this.session.runtimeState = this.runtime.snapshot()`，即 `story-runtime.ts:123` 的 `clone(this.state)` | 69 KB |
| 2 | 同上，`this.session.captureState()` | 整个会话，内部 `runtime: structuredClone(this.runtimeSnapshot)` 又复制一份运行时 | 190 KB |
| 3 | `story-runtime.ts:307` | `const next = clone(this.state)`，改状态前先复制一份 | 69 KB |
| 4 | `story-runtime.ts:292` | `this.port.commit(clone(commit))`，提交包里带着整份运行时快照 | 69 KB |
| 5 | `session.ts:951` | `captureBatchBaseline()`，提交命令的原子性保险 | 145 KB |

合计约 542 KB / 节点。

第 5 次是提交路径自带的（`applyStoryCommands` 在 `session.ts:947-982`），失败时会自己回滚，**这一条不用动**。

第 1、2 次是「节点失败要能回到上一帧」的基线。第 3 次是「改状态前先留原件」。第 4 次是「防止下游改提交包」。

### 为什么能删

演出阶段（`present`，`story-director.ts:349-376`）只调对白、选择、演出动作，**不改会话状态**。真正改会话的唯一入口是提交时的 `applyStoryCommands`，而它自己已经有保险。

更直接的证据：`story-director.ts:120-126` 的 `rollback` 只恢复世界和舞台，`recover()`（297-309）读 `recovery.world` 和 `recovery.stage`，**从头到尾没用过 `recovery.session`**。那份会话基线抓了、存了、但回滚时没读。

还有一处佐证：项目里已经用过同样的减法。`session.ts:363-366` 的 `captureBatchBaseline` 就是「跳过 505 条任务、只抓会变的部分」，注释写在 `session.ts:357-362`，说这样省掉了一笔固定开销。剧情基线只是没走这条路。

### 改法

**第一步：节点基线不再带会话。**

`story-director.ts:106-109` 的 `capture` 改成只留两样：

```ts
capture: () => ({ world: this.world?.capture(), stage: this.presentation?.getStageState?.() }),
```

同时删掉 `story-director.ts:108` 那行 `this.session.runtimeState = this.runtime.snapshot()`。`rollback`（120-126）相应只恢复世界和舞台。

**第二步：状态更新改成只复制变化的那层。**

`story-runtime.ts:307` 的整包复制换成手写浅拷贝：顶层换新对象，`runs` 换新数组但元素共用，只给被改的那一个 run 建新对象；`completedEvents`、`handledOccurrences` 这类只追加的数组用 `[...old, item]`。

同样处理 `snapshot()`（123 行）——它现在每次都整份克隆，但调用方（`story-director.ts:140/141/156/190`、`world-scene.ts:354/557/593/624/707`）都只读。改成「顶层新对象、内部数组按需复制」即可。

`publish()`（292 行）只深拷贝 `commands`，`checkpoint` 直接传引用——它在 `execute` 里刚被造出来，没有别人持有。

**第三步：加断言和基准。**

`capture` 时记下任务簿版本、背包修订号、剧情世界访问序号；`rollback` 时对一遍，不一致就在开发模式报警。这防的是「将来有人加了会改会话的演出动作」。

基准脚本放 `tools/bench-story-runtime.ts`，挂 `npm run bench:story`，输出每节点耗时、快照体积、以及 `structuredClone` 调用次数。同类基准可参考 `tools/` 下已有的校验脚本组织方式。

### 风险

最大风险是第一步：万一将来有演出动作偷偷改会话，回滚会漏掉那部分。

所以第三步的断言要和第一步同批提交，不能留到以后。事件级的完整回滚点在提交路径上（`session.ts:951`）仍然存在，这层保险没丢。

### 预期

每次节点从约 542 KB 降到约 145 KB，后期单节点从 1.73 ms 降到 0.1 ms 量级。

按一局 300 个节点算，节省的总时间约 0.5 秒——单看不多，但它是**随进度增长的那部分**，也是演出开演前那一下「顿」的主要来源。

### 验证

```bash
npm run typecheck
npm test -- tests/story-runtime.test.ts
npm test -- tests/story-director-core.test.ts
npm test -- tests/story-commit.test.ts
```

再加一个断言测试：演出阶段结束后，会话的任务簿版本、背包修订号必须和进入时一致。

---

## 问题二：每开演一幕，整张地图和全部角色拆掉重建

### 代码证据

`StoryStageScene.showStage`（`src/scenes/story-stage-scene.ts:117-199`）是所有换幕的唯一入口。它每次都会：

- 168 行：`nextLayers = drawStoryMap(this, map)` —— **无条件重建所有图层对象**
- 169 行：`nextMovement = new MovementWorld(this, new NavigationWorld(map))` —— 重建导航
- 170 行：`nextCharacters = drawStoryCharacters(this, actors, appearances)` —— 重建全部角色
- 190 行：`this.releaseStage(true)` —— 把旧的一整套销毁

只有地图**数据**是同图复用的（124 行 `this.map?.id === stage.map ? this.map : await this.app.content.map(...)`）。画出来的东西全部重来。

也就是说，下一幕哪怕还是同一张图、同一批人，只是站位变了，也是「全拆全建」。

另外 165 行的 `wardrobe.prepare` 在缓存没命中时会跨帧合成（`src/rendering/wardrobe.ts` 里每个姿态之间 `setTimeout(0)` 让一帧），一个角色十个姿态就是十帧。

### 发生频率

内容里一共有 719 个换幕动作（`stage` 命令）。693 段脚本中：

- 452 段只有 1 幕
- 113 段有 2 幕以上
- 128 段没有换幕

所以主要是「每次剧情事件开演时一次」。一局下来几十到上百次。

### 改法

**第一步：地图层按地图 id 缓存。**

把 `drawStoryMap` 的结果按 `map.id` 存在场景里。同图换幕直接复用，只换图才重建。缓存上限设 2 张（当前 + 上一张），换图时淘汰旧的并调它的 `destroy()`。

**第二步：角色视觉按演员 id 复用。**

`showStage` 里对每个演员：已存在且外观签名没变，就只更新位置、朝向、可见性；不存在才创建。退出的人销毁，新进的人创建。这一层要和 `planScene` 的结果做 diff。

外观签名可以直接复用 `Wardrobe` 那套 `JSON.stringify([base.id, recipe.poses, variants])` 的算法。

**第三步：`MovementWorld` 同图复用。**

导航只和地图有关，同图不重建。

### 风险

风险主要在第二步。角色复用要处理四种情况：同一 id 换了外观、临时隐藏、旁观者、以及「世界里的敌人」和「剧情角色」共用 id 的情况（`story-stage-scene.ts:105-115` 的 `appearanceFor` 和 `isWorldEnemy`）。

判错会画出重复的人或残留的人。已有的 `assertUniqueActorInstances`（`src/domain/actor-census.ts`）可以继续当护栏，再加上「换幕后角色数量与计划一致」的断言。

### 预期

同图换幕从「全拆全建」降到「只改几个数字」，预计从十几毫秒降到一两毫秒。换图仍然是完整重建，这部分省不掉。

### 验证

```bash
npm test -- tests/story-stage-isolation.test.ts
npm test -- tests/story-stage-appearance.test.ts
npm test -- tests/story-scene.test.ts
```

---

## 问题三：每个节点都把「走过的所有地图」快照克隆两轮

### 代码证据

两处，都在每个节点提交时走一遍。

**第一处**，`StoryPresenter.getWorldChanges()`（`src/rendering/story-presenter.ts:118-140`）第一行就调 `captureStage()`。而 `captureStage()`（87-116 行）的 114 行是：

```ts
snapshot.scenes = [...this.scenes.values()]
  .filter(visited => visited.map !== snapshot.map)
  .map(visited => structuredClone(visited));
```

把**除当前地图外所有走过的地图**深拷贝一遍。

**第二处**，`committed()`（141-145 行）又调一次 `captureStage()`，然后 144 行：

```ts
this.committedScenes = new Map([...this.scenes].map(([map, scene]) => [map, structuredClone(scene)]));
```

对**所有**地图再深拷贝一遍。

两处分别在 `StoryDirector.commit()`（`story-director.ts:378` 和 `385`）里，每个节点各调一次。

### 为什么越玩越慢

`this.scenes` 是「演出访问过的地图」的累积表，146-149 行的 `rememberScene` 只加不减。演出跨的图越多，每节点的克隆量越大。

单个场景快照是几 KB 量级，比不上问题一，但它是**每节点两次、且随地图数线性增长**。

### 改法

核心一句：**这些快照是不可变值，不需要克隆。**

`syncStoryScene` 返回新对象，`this.scenes` 里的条目只会被整体替换、不会被就地修改。所以：

1. `committed()` 里的 `structuredClone` 直接去掉，存引用。
2. `captureStage()` 里 114 行的克隆去掉，`scenes` 只做浅拷贝。
3. 更彻底一点：`captureStage()` 只克隆当前地图，其他地图按需取。`getWorldChanges` 要的只是和 `committedScenes` 的 diff，diff 本身不修改数据。

如果担心下游有人就地改，可以在 `syncStoryScene` 出口加 `Object.freeze`。冻结的成本远低于每次深拷贝。

### 风险

如果有代码就地改了这些快照，会污染共享引用。

`freeze` 能在测试里立刻把这种改动炸出来，所以建议和改动同批加上，跑一轮测试确认没人踩。

### 预期

这块从「每节点两次、随地图数增长」降到基本归零。

### 验证

```bash
npm test -- tests/story-world-projection.test.ts
npm test -- tests/story-scene-capture.test.ts
npm test -- tests/story-commit.test.ts
```

---

## 问题四：每个剧情事件完成，整份存档序列化后同步写盘

### 代码证据

触发链路：

1. `src/main.ts:432`：`director.onEventCompleted = () => autoSaver?.request()`
2. `src/application/auto-save.ts`：节流 1200 ms、最小间隔 2000 ms，到点后 `try { this.ports.write(game); }`（75 行和 91 行）
3. `src/ui/story-ui.ts:695-701` `captureSaveRecord()`：`this.app.captureSaveWorld?.()` + `captureSaveGame(...)`
4. `src/domain/save-game.ts:110-113`：`session.capturePersistentState()`，内部是 `session.ts:350` 的全量捕获
5. `src/domain/save-game.ts` 的 `SaveSlots.write`：`JSON.stringify(record)` + `this.storage.setItem(key, ...)`

最后一步是**同步写 localStorage**。存档内容随进度增长（晚期会话快照 190 KB，JSON 文本 300 KB 以上），主线程要停下来做序列化加写盘。

### 为什么越玩越卡

存档变大，每次序列化和写入都更久；而触发点又很密——一个任务流程常常连着好几个事件，节流只保证 2 秒内最多一次，保证不了「一次剧情里只写一次」。

### 改法

分三层，按风险从低到高：

**第一层（改动最小）**：把自动存档的触发从「每个事件完成」改成「任务状态变化或切换地图」。

`StoryDirector.observeChanges`（`story-director.ts:163-208`）里已经能拿到任务版本变化，用它当触发点就够。事件完成时只记一个「脏」标记，等下一个真正的检查点再写。

**第二层**：写盘移出当前帧。用 `queueMicrotask` 或空闲回调，让当前这一帧先画完。再进一步可以把存储从 localStorage 换成 IndexedDB（异步），但那是独立的一步，要先确认 Android WebView 的兼容性。

**第三层（不建议现在做）**：存档改增量格式。这会动 `SAVE_FORMAT` 和 `src/application/saved-game.ts` 的迁移链，收益不如前两层直接。

### 风险

第二层要小心：写盘延后期间如果玩家直接关页面，可能丢最后一次进度。

兜底方案是保留「切后台时立即写」和「退出到菜单时立即写」，这两个时机本来就是强制的。

### 预期

第一层能砍掉大部分写入次数；第二层让剩下那几次不再卡住当帧。

### 验证

```bash
npm test -- tests/save-game.test.ts
npm test -- tests/saved-game.test.ts
npm test -- tests/story-commit.test.ts
```

---

## 已确认不是问题的

这些也查过，附证据，免得重复怀疑：

| 怀疑对象 | 结论 | 证据 |
|---|---|---|
| 每帧的任务和事件查询 | 不是 | `canInteract` 每次 4.9 µs，扫全部 593 个事件 4.7 µs，比节点开销低三个数量级 |
| 任务状态变化时的观察 | 不是 | `observeChanges` 从 0.12 ms 涨到 0.24 ms，可以忽略 |
| 音频、纹理、事件监听泄漏 | 不是 | 都有上限或成对清理，没找到越积越多的路径 |
| 地图的 color-dodge 混合层 | 不是 | 416 张地图里只有 3 张有这一层，每张 320×240 |
| 每帧的界面签名比对 | 不是 | `syncHud`、`refreshShortcutPage` 都有摘要短路，签名没变就不写 |
| 战斗系统重建 | 不是 | `WorldCombat.destroy()` 退订干净，没有累积 |
| 诊断日志里那次 6.7 秒卡死 | 旧版本 | 伴随的报错来自 `world-map-markers.ts` 和 `world-map-scene.ts`，这两个文件在当前代码里已经不存在 |

---

## 修复顺序

1. **问题一**：收益最大，改动集中在两个文件（`story-runtime.ts`、`story-director.ts`），测试覆盖也最全。
2. **问题三**：和问题一同一次提交最合适——都是删克隆，而且它本身就嵌在提交路径里。
3. **问题二**：改动面最大，要碰舞台场景和角色绘制，单独一轮。
4. **问题四**：涉及存档兼容，放最后，先只做第一层的触发点调整。

每一条都「改完、跑测试、单独提交」，出问题能单独回退。

`docs/session-save-economy-performance-2026-11-03.md` 里那套快照缓存，建议排在本文问题一之后做——因为问题一做完之后，剧情节点不再需要全量快照，那套缓存只需要服务存档和检查点，范围更小。

## 怎么复核

本文的数字都可以重跑：

1. 用 `src/debug/headless-story.ts` 的 `createHeadlessStory` 在 Node 里加载真实内容。
2. 按真实触发顺序放 200 个事件，每放一个量一次耗时和快照体积。
3. 用 `node --cpu-prof` 采样，看 `structuredClone` 的占比。

改完之后同样的脚本应该看到：单节点耗时不再随事件数增长、`structuredClone` 占比降到 10% 以下、快照体积降到 145 KB 量级。
