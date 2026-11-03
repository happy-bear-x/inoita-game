# 会话、存档与经济：逐问题的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。每个问题单独成案，各自带代码证据、慢的原因、改法、风险和验证方式。

排查范围是玩家反馈的「运行一段时间后很卡」在这三块里的表现：会话（剧情运行时与通知）、存档（快照、检查点、写盘）、经济（金币、掉落、背包实例）。

## 一句话结论

不是内存泄漏，也不是每帧计算太重。是**「抓快照」这件事的单价跟着存档体积一起涨**：剧情每走一句台词、每次进图、每次自动存档，都要把整个游戏状态完整复制一遍；而存档里有两样只增不减的东西（背包实例、跨地图保留的地面掉落），于是玩得越久，复制一份的成本越高，卡顿越明显。

写档还有一笔独立的浪费：每次覆盖旧档，都要把整份旧档重新解析一遍，只为读一个自定义名字。

## 三个子系统各自的判断

| 子系统 | 判断 |
|---|---|
| 会话 | 每次变化通知（`emit`）本身很便宜，后期一次 0.06–0.25 ms，不是「越玩越卡」的来源。但剧情每走一个节点抓一次全量快照，这项开销随存档变大。 |
| 存档 | 主要成本在「复制整份状态」和「写盘时重读旧档」。存档体积会随探索地图数、背包件数增长。 |
| 经济 | 金币、商店库存、宝箱、泉水、保底计数都有内容上限，不是问题。真正无界的是**地面掉落**：每张图最多留 64 件，但换图不清理，所有图的掉落都进存档。 |

## 测量方法与基线

- 环境：Node 24，Mac 桌面，真实 `public/content` 内容，用 `tests/helpers/story-playthrough.ts` 的 `playthrough()` 无头启动（启动约 211 ms），localStorage 用内存实现替代。
- 手机还没有正式数据；按经验同操作大约慢 5–10 倍，结论以趋势和相对值为主。
- 测量脚本放在 `/tmp/measure-*.mts`，是临时文件，不在仓库里。复测时用同一套脚本、同一口径。
- 注意：`4003` 是 Vite 开发服务器，性能和 `4002`（打包产物）/APK 不是一回事，手机结论只能基于 `4002` 或 APK 上的 `?perf` 数据。

### 后期存档里，一次快照各部分的成本

造出一个「后期」状态：500 条已完成事件、400 个旗标、150 个选择、300 种背包物品、40 张地图各 30 件地面掉落。

| 快照内容 | 每次耗时 | 上限 |
|---|---|---|
| 地面掉落（1200 件） | 0.77 ms | 无全局上限 |
| 背包（300 件） | 0.60 ms | 图鉴 996 件 |
| 任务簿（505 条） | 0.25 ms | 固定 |
| 剧情世界 | 0.03 ms | 按内容 id 有界 |
| 剧情运行时 | 0.03 ms | 随完成事件缓慢增长 |
| 一次完整快照 | 1.61 ms | — |

背包满图鉴（996 件）时，单是 `bag.entries` 就要 1.39 ms，一次完整快照 1.66 ms；存档 280.8 KB。

### 地面掉落是线性增长的那一项

| 掉落总数 | 一次快照 | 序列化后大小 |
|---|---|---|
| 320 件 | 0.41 ms | 41.3 KB |
| 1600 件 | 1.04 ms | 209.5 KB |
| 4160 件 | 2.76 ms | 547.7 KB |
| 9280 件 | 6.03 ms | 1224.7 KB |

全游戏 416 张地图，理论上单张图 64 件、总量可以堆到两万多件。

### 写一次档的时间去哪了

743.1 KB 的档，覆盖写入一次 2.19 ms：

| 步骤 | 耗时 | 占比 |
|---|---|---|
| 复制整份会话状态 | 3.65 ms（含前面各子系统） | 主要成本 |
| 把旧档整份解析一遍 | 1.40 ms | 约 64% 的写盘时间 |
| 序列化新档 | 0.77 ms | — |

（一次完整写档的成本是「复制 + 解析 + 序列化 + 写 storage」四段叠加；上面的 2.19 ms 是 `write()` 内部，不含调用方先做的 `captureSaveGame`。）

### 剧情每句台词的成本

开场演出共 11 个剧情节点，每个节点抓一次基线，合计 4.3 ms、平均 0.39 ms（headless 只测到会话部分，真实游戏还要加上世界场景与舞台的复制）。

后期同一份状态下，光会话部分每个节点约 1.6 ms，再加上赋值时的校验 0.98 ms，约 2.6 ms。手机上按 5–10 倍算，一句台词一顿。

---

## 问题一：剧情每走一句台词，就整份复制一遍游戏状态

### 代码证据

`src/domain/story-runtime.ts:303`，每执行一个节点先抓回滚基线：

```ts
const baseline = this.port.capture(); this.active = { baseline, context };
```

这份基线由导演实现，`src/domain/story-director.ts:106-109`：

```ts
capture: () => {
  this.session.runtimeState = this.runtime.snapshot();
  return { session: this.session.captureState(), world: this.world?.capture(), stage: this.presentation?.getStageState?.() };
},
```

`src/domain/session.ts:386-399` 的 `captureStateWith()` 把每个子系统都拷一遍，而每个子系统的 `captureState()` 都是无条件深拷贝：

- `src/domain/bag.ts:169-174` → `snapshot()` 在 `:192-194` 用 `structuredClone` 复制全部实例，而且每次还跑 `verifyBagState` 自检。
- `src/domain/ground-loot.ts:29` 把整张掉落表 `structuredClone`。
- `src/domain/quest-book.ts:260-263` 把 505 条任务状态 `structuredClone`。
- `src/domain/story-world.ts:219-221` 把实体、旗标、选择、遭遇整份拷贝。
- 世界那半边 `src/scenes/world-scene.ts:1476`：`combat.captureState()` + `structuredClone(this.baseEntities)` + 逐个角色 `captureStoryScene()` + 音频状态。

### 为什么越玩越卡

基线的大小由背包件数、地面掉落总数、剧情世界条目决定，这三样只增不减。每句台词抓一次，成本就跟着存档一起涨。

代码里已经有更便宜的做法：`src/domain/session.ts:363-366` 的 `captureBatchBaseline` 用 `questBook.checkpoint()`（`src/domain/quest-book.ts:267-269`，只拷容器、不拷条目，条目按不可变共享），只是剧情基线没走这条路。

### 改法

1. 给地面掉落、背包、任务簿、剧情世界各加「修订号 + 快照缓存」：修订号（每次修改自增的计数）没变，`captureState()` 直接返回上一次那份。四个类都已经有修订号（`GroundLootStore.revision`、`Bag.revision`、`QuestBook.version`、`StoryWorldState.revision` 在 `src/domain/story-world.ts:84`），不用新造机制。
2. 定一条硬约定：`captureState()` 返回的**顶层对象可改、里面的子树只读**。现在唯一违反的是 `src/domain/session.ts:352-353` 的 `delete state.questBook.debugPins`（改的是子树），要改成先浅拷贝 `questBook` 再删。`src/domain/session-checkpoint.ts:14-16` 的 `delete state.legendaryWeapons` 只改顶层，安全。
3. 背包自检 `verifyBagState` 只在缓存未命中时跑，别每次快照都验。
4. 第二步再考虑把任务簿换成 `checkpoint()` 式的 O(1) 容器拷贝；那要动回滚恢复路径，单独做。

### 风险

下游有人原地改子树，会把缓存污染成「上一次的状态」。用两条测试锁死：改快照不影响会话本身；没改动时两次快照结果一致。

### 验证

`npm test -- tests/session.test.ts`、`tests/story-runtime.test.ts`、`tests/story-scene-capture.test.ts`、`tests/save-game.test.ts`；再用同一套测量脚本复测完整快照耗时。

### 预期

晚期一次完整快照 1.61 ms → 0.3 ms 量级；每句台词 2.6 ms → 约 1.2 ms。

---

## 问题二：写一次档，把整份旧档重新读一遍

### 代码证据

`src/domain/save-game.ts:244`：

```ts
const summary=game.summary.name===undefined?this.existingName(ref):undefined;
```

`existingName`（`:263-266`）调 `inspect(ref)`（`:176-194`），而 `inspect` 第一件事就是 `JSON.parse(raw)`——把整份旧档解析一遍，只为拿 `summary.name` 一个字段。

紧接着 `:246` 写完还执行 `this.summaryCache.delete(key)`，把唯一能省掉下次解析的缓存删掉了。

同一个类里就有 `peek()`（`:150-166`），它按「原始字符串」缓存摘要，命中时零解析——但 `write` 不走它。

### 改法

1. `write()` 写完以后，用刚写进去的摘要回填 `summaryCache`（存新 raw + summary），而不是删掉。
2. 覆盖旧档时改用 `peek()` 取名字，缓存命中就完全不解析。
3. `rename()` 和 `writeRaw()` 同样回填缓存，三条写路径保持一致。

### 风险

缓存和磁盘不一致（例如外部工具改了 localStorage）。`peek` 本来就是拿 raw 字符串比对，不一致会自然失效，和现在的行为一致。

### 验证

`npm test -- tests/save-game.test.ts`、`tests/title-save-entry.test.ts`、`tests/cloud-save.test.ts`；复测写档耗时。

### 预期

743 KB 的档，写一次 2.19 ms → 约 0.8 ms。

---

## 问题三：内部同步状态，却每次做读档级校验

### 代码证据

`src/domain/session.ts:325-327`：

```ts
set runtimeState(value: StoryRuntimeSnapshot) {
  const next=this.prepareRuntime(value);this.validateStoryLinks(this.storyWorld.captureState(),next);this.runtimeSnapshot=next;
}
```

这个 setter 被导演在每个剧情节点调用一次（`src/domain/story-director.ts:107`），回放结束时再调一次（`:119`）。

`validateStoryLinks`（`src/domain/session.ts:470-484`）每次先 `this.storyWorld.captureState()` 拷一遍世界，再遍历运行中的遭遇，还要在 `campaign.scripts[...].nodes` 里线性找节点。实测后期一次 **0.98 ms**。

这项校验本来是给读档、检查点恢复、调试跳转防篡改用的，这三处已经各自有校验（`src/domain/session.ts:491`、`:949`），挂在最热的赋值上属于重复劳动。

### 改法

1. setter 只做 `prepareRuntime`，不再校验。
2. 校验留在 `restoreState`、应用存档计划、调试跳转三个边界（现在本来就有）。
3. 如需兜底，在「事件完成」这个低频点加一次显式断言，而不是每节点。

### 风险

内部生成的快照如果引用了不存在的节点，会晚一点才炸。用 `tests/story-runtime.test.ts`、`tests/story-debug*.test.ts` 兜底。

### 预期

每句台词省约 1 ms（晚期）。

---

## 问题四：地面掉落只限单图，不限总量，而且换图不清理

### 代码证据

`src/domain/ground-loot.ts`：

- `:5` `const MAX_GROUND_DROPS_PER_MAP = 64;`——只是**每张图**的上限。
- `:43` 只在 `add()` 时调 `prune(map)`；`:48-52` 的淘汰也只看当前这张图。
- `:29` 快照把整张表（所有地图的掉落）`structuredClone`。
- 掉落只有在被玩家拾取时才 `untrack`，换图、切场景都不清理；源码注释写明这是刻意的（掉落要跨场景保留）。

### 为什么越玩越卡

掉落总数随探索地图数线性增长，而每次快照都要复制全部掉落。4160 件时一次快照 2.76 ms，9280 件时 6.03 ms。

### 改法

1. 加全局上限（建议 256～512 件），超了按「最早生成」淘汰；和现有的单图 64 件上限并存。
2. `captureState` 不写 `flight` 字段（`addFlying` 在 `:69-71` 写进去的落地动画），它是临时表现，存档不需要。
3. 可选：按章节或地图访问世代（`storyWorld.visit`）清理很久没回去的图。

### 风险

玩家回旧图可能看不到遗留掉落。这需要产品确认：如果「掉落跨场景保留」是刻意设计，就只做全局上限，不做过期清理。上限本身不违背跨场景保留，只限制总量。

### 验证

`npm test -- tests/ground-loot-auto.test.ts`、`tests/world-story-loot.test.ts`；复测存档体积与快照耗时。

### 预期

存档体积不再随探索地图数线性涨；最坏情况快照成本从几毫秒降到零点几毫秒。

---

## 问题五：检查点把已经拷过的东西再整包拷一遍

### 代码证据

`src/domain/session-checkpoint.ts:14-17`：

```ts
const state=session.captureState();
delete state.legendaryWeapons;
this.snapshot=structuredClone({session:state,location,world});
```

`captureState()` 返回的本来就是独立副本，`delete` 只改这个新对象的顶层键，没有共享风险。多出来的那次 `structuredClone` 是纯开销，它发生在每次进图的检查点上（`src/scenes/world-scene.ts:1438`）。

### 改法

去掉 `structuredClone`，直接存 `{session:state,location,world}`。恢复时（`src/domain/session-checkpoint.ts:22`）保留深拷贝，保证快照本身不被消费方改掉。

这项依赖问题一的「只读约定」，所以排在它后面。

### 预期

进图检查点成本约减半。

---

## 问题六：每次会话通知都在克隆运行时状态、新建小表

### 代码证据

`src/domain/session.ts:322`：

```ts
get runtimeState():StoryRuntimeSnapshot {return structuredClone(this.runtimeSnapshot);}
```

这个 getter 每次都深拷贝整个剧情运行时（完成事件、runs、处理过的发生）。而 `src/domain/story-director.ts:190` 在**每次会话通知**里都调它：

```ts
const completedEvents = new Set(this.session.runtimeState.completedEvents);
```

再加上 `:181-182` 每次通知都新建 `choiceValues()`、`encounterStatuses()` 两张 Map。

后期实测每次通知 0.06–0.25 ms，随完成事件数缓慢增长。

### 改法

1. 新增只读访问器（例如 `completedEventIds()`），`observeChanges` 改用它，不再走会克隆的 getter。
2. choices/encounters 的比较按 `storyWorld.revision` 门控，没变就跳过。

### 风险

getter 的克隆现在起着「防止外部改内部状态」的作用。换访问器前先确认调用点都只读：`src/scenes/world-scene.ts:352`、`:549`、`:585`、`:631`，`src/domain/story-director.ts:140`、`:190`，`src/debug/` 下若干处。

---

## 已排除的怀疑

逐项核过，都不是本次原因：

| 怀疑点 | 结论 |
|---|---|
| 每帧新建界面对象不销毁 | 没有。剧情状态条、血条、小地图图标都在销毁时退订，`src/rendering/overhead-status.ts:31-32`、`src/ui/phaser/status-hud.ts:271`、`src/scenes/world-scene.ts:218/236`。 |
| 菜单每次会话通知都重画 | 没有。`src/ui/story-ui.ts:182` 先用 `sessionDataSignature()` 比较（只读背包修订号、金币、等级、队伍形状），没变就跳过。 |
| 小地图标记重复叠加 | 没有。`src/rendering/story-minimap.ts` 用任务签名门控，移除的图标 `icon.destroy()`。 |
| 任务标记每次通知都重算 505 条 | 没有。按任务版本号为键缓存（`npcQuestSlot`/`markerActor`）。 |
| 背包计数每次通知都重算 | 没有。`Bag.counts` 按修订号缓存。 |
| 商店、宝箱、泉水、保底数据泄漏 | 没有。都按内容 id 存在 Map/Set 里，有上界。 |
| 自动存档写入失败后无限重试 | 没有。`src/application/auto-save.ts` 写失败只 `console.warn`，不会再排重试。 |

## 修复顺序

1. **问题四**（掉落加总量上限）——数据源头，改完后面几步的基数都小。
2. **问题一**（快照缓存 + 只读约定）——收益最大；问题五依赖它的约定。
3. **问题三**（setter 不校验）——独立、改动小。
4. **问题二**（写档缓存）——独立、改动小。
5. **问题五**（检查点去重）——依赖第 2 步。
6. **问题六**（通知零碎分配）——收尾优化。

每步单独一个提交，先复测基线再改，改完再测，改前改后的数字写进提交说明。

## 不在本轮范围

- 客户端诊断日志里唯一一次 6.7 秒冻结发生在进图建场（`shadow-forest-west`，被 `world-map` 锁持有），当时背包只有 25 件、存档很小，属于换图链路，不是本条链路。
- 渲染与 GPU 相关的问题不混进来。

## 怎么复核

- 桌面复现：`npm run dev` 后用 `?perf` 看帧时间；后期档跑剧情、进图、手动存档各一次，对比 P95 和长帧数。
- 手机复现：`4002` 或 APK 上带 `?perf`，同样的操作各来一遍。
- 数值复测：临时测量脚本针对 `captureState`、`captureSaveGame`、`write` 三段分别计时，口径与上文一致。
