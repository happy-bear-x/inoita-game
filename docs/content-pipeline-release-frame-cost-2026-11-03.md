# 内容管线、世界每帧与发布链路：逐问题的代码级方案（2026-11-03）

## 一句话结论

这三块我都按代码路径量过了，**没有一项能解释「越玩越卡」**：全部内容解析后只常驻 8.5 MB，世界每帧的固定扫描 4.7 µs，发布链路的缓存和压缩是对的。真正的主因在另外两份文档里——寻路的单价随人数涨（`docs/ai-pathfinding-frame-cost-2026-11-03.md`），快照的单价随存档体积涨（`docs/session-save-economy-performance-2026-11-03.md`）。

这份文档的价值是**把这三块从怀疑名单里划掉**，并留下两组仍然是真问题的东西：一条诊断能力缺口（线上没有任何帧数据），一条能顺手做的小修（内容解析结果不回收）。

## 与已有文档的分工

| 文档 | 覆盖 |
|---|---|
| `ai-pathfinding-frame-cost-2026-11-03.md` | 寻路、敌人 AI、补帧 |
| `session-save-economy-performance-2026-11-03.md` | 快照、存档写入、掉落增长 |
| `story-performance-plan-2026-11-03.md` | 剧情节点、舞台重建 |
| `menu-hud-input-frame-cost-2026-11-03.md` | 菜单、HUD、输入 |
| `asset-texture-memory-plan-2026-11-03.md` | 纹理与素材常驻 |
| **本文** | **内容加载与内存、世界每帧固定开销、发布链路** |

本文不重复上面五份的结论；凡是与它们重叠的位置，只标「见某文档」。

## 测量方法与基线

桌面 Node 24，直接读 `public/content` 的真实文件测 `JSON.parse`；每帧扫描用真实 `campaign.json` 的 593 条事件跑 2 万次循环取均值；存档用真实会话对象测 `captureState` 与序列化。全部是桌面数字，手机按 3–5 倍估。

| 项目 | 实测 |
|---|---|
| 13 个内容文件全量解析 | 约 46 ms（campaign 15.1 / wardrobe 9.9 / battle 8.8 / world 4.2 / character-stats 3.1 / shops 2.0 / items 1.2） |
| 416 张地图全量解析 | 17 ms，常驻堆 **8.5 MB**（平均每张 20 KB） |
| 世界每帧两趟事件扫描 + 建数组 | **4.7 µs/帧** |
| 新存档 `captureState` | 47 756 字符，0.26 ms；加 `JSON.stringify` 0.37 ms |

## 问题一：解析过的内容永不释放（真问题，但很小）

### 代码证据

`src/application/content-loader.ts:25` 的 `requests` 表保存每一次成功的请求；成功时只把 `finished` 置真，**不删除**（`:70-80`）。只有失败（`:78`）或「等待者归零且还没完成」的中途取消（`:90-93`）才 `delete`。所以每张逛过的地图、每套用过的动作，解析结果一直挂在表上。

### 量级

416 张全逛完 = 8.5 MB。相对一个手机 WebView 的堆是小头，作用是让大回收更频繁一点，不是卡顿主因。

### 改法（可选，低优先）

给 `content/maps/` 加「只留最近 3–5 张」的上限：命中旧键时从表里删掉，下次进图重新解析（20 KB、约 0.1 ms）。`content/wardrobe/*` 的动作文件同理，但它的缓存已经是按需加载，先不动。

### 风险

低。表里删掉只是让下次重新解析；已经拿到对象引用的调用方不受影响。注意不要把 `campaign/world/battle` 这类一次性的键也纳入上限——它们本来就只取一次。

### 验证

`tests/content-loader.test.ts` 补一条「超过上限后旧键被回收、再取一次仍能拿到同一内容」；跑 `npm test -- tests/content-loader.test.ts`。

### 建议

**先不做**。等上面两份主因文档的改动落地、`?perf` 有数据后再看堆曲线。

## 问题二：启动时一次性解析 33 MB（不是「越玩越卡」）

### 代码证据

`src/main.ts:233` 的 `prepareStory` 用一次 `Promise.all` 拉 13 个内容文件；生产构建 `trusted=true` 时只 `JSON.parse`，不跑语义校验（`main.ts:110`）。

### 量级

桌面 46 ms；手机按 3–5 倍估约 150–250 ms，落在加载页里，不进游戏循环。它影响「第一次进图要等多久」，不影响「玩十分钟后卡不卡」。

### 改法

**不做**。真要优化，唯一有效的是把 `wardrobe` 与 `battle` 的 `JSON.parse` 挪到首个空闲帧——但这两个对象在进世界第一帧就要用（外观合成、战斗名册），挪走等于把等待搬到别处。

## 问题三：世界每帧的固定开销（实测不构成问题，建议不做）

四笔开销，全部与人数无关、与游玩时长无关：

1. `src/scenes/world-scene.ts:1814` 每帧遍历 593 条 `campaign.events` 找区域触发；
2. `:1829-1830` 每帧 `filter` 出 92 条近身触发，新建一个数组；
3. `:1705`、`:823` 每帧各拼一个摘要字符串；`src/ui/phaser/computer-skill-hud.ts:73` 收到后又拼一遍同样的字符串；
4. `:1733` 每帧调 `session.refresh()`——因为 505 个任务的条件全为空，它只比三个版本号就返回，是空转。

合计 **4.7 µs/帧**，占 60 帧预算的万分之三。改它们要碰进图索引和触发语义，回归面远大于收益。

### 如果将来一定要做

按地图建一次 `region`/`near` 索引（进图时建，换图时重建），`afterMovement` 只读当前图那几条。改动约 30 行，收益仍是微秒级。**等 `?perf` 显示 update 阶段是瓶颈再回来。**

## 问题四：发布链路（查过了，不是卡顿原因）

- `deploy/nginx/catgo.online.conf`：4002 终止 TLS 后整站转发到 127.0.0.1:4004，不做压缩、不做缓存——这层没有可优化项。
- `tools/serve-built.ts:59-73`：`/bundles/` 与带当前版本的 `/assets/`、`/content/` 回一年 `immutable`；`/update/latest*.json` 回 `no-store`；其余 `no-cache`。带版本的 URL 由 `src/application/asset-version.ts` 注入，内容更新靠 `contentVersion` 变。
- 压缩：`tools/serve-built.ts:326-328` 对可压缩类型按 `Accept-Encoding` 现压并缓存。`campaign.json` 9.6 MB 传输时约 1–2 MB。
- `dist/` 222 MB 是磁盘体积，不是首屏体积：进图只取当前图的两层图集与 13 个内容文件。

结论：链路正确，没有「越跑越慢」的机制。

## 问题五：自动存档的调度（与 session 文档分工）

快照本身的单价见 `session-save-economy-performance-2026-11-03.md`；这里只管**什么时候写**。

### 代码证据

`src/application/auto-save.ts:64-77` 的 `flush()` 在计时器回调里同步做完 `capture()`（71）和 `write()`（75），一次都不让路；`write()` 里又套着 `existingName` → `inspect` → `JSON.parse` 整份旧档（`src/domain/save-game.ts:244`、`:183`）和 `localStorage.setItem`（`:246`）。五个触发点都走这条同步链：进图（`src/scenes/world-scene.ts:494`）、任务变化（`:1067`、`:1082`）、剧情完成（`src/main.ts:432`）、每 5 分钟（`DEFAULT_INTERVAL_MS=300_000`）、切后台（`src/main.ts:674`）。

### 改法

1. `AutoSaver.flush()` 把「capture + write」包进 `requestIdleCallback(cb, {timeout: 500})`；回调里先用 `deadline.timeRemaining()` 判断是否还够，不够就 `retry()`。
2. `flushForBackground()` 保持同步——页面要走了，不能等空闲。
3. 环境没有 `requestIdleCallback`（Safari 老版本）时退化成 `setTimeout(cb, 0)`。
4. 进图那次（`world-scene.ts:494`）不删，但让它走同一条空闲链，不和场景重建抢同一帧。

### 风险

`requestIdleCallback` 在持续掉帧时可能一直不触发，靠 500 ms 的 `timeout` 兜底；最坏情况是存档晚半秒，可接受。`locked()` 与 `minGapMs` 的现有判断不要动。

### 验证

`tests/auto-save.test.ts` 补两条：空闲回调被调用前不会执行 `write`；`timeout` 到点必写。跑 `npm test -- tests/auto-save.test.ts`。

## 真正该补的一件事：线上帧数据

`public/diagnostics.js` 的帧采样只在 URL 带 `?perf` 时写入，`.diagnostics/client-errors.jsonl` 里 `frame-stats` 一直是 **0 条**。上面六份文档的所有数字都是桌面微基准，没有一份是玩家机器上的真实帧分布。

### 方案

把帧采样改成默认开，保留最近 3 分钟（180 秒 × 60 帧 ≈ 10800 个采样点，按现有 30 秒窗口滚动，内存约 1–2 MB）；导出仍走 `storyDiagnostics.export()`，不自动上传。有它之后，「改哪一条最值」就不用再猜。

### 风险

低。`FrameSamples` 已是环形窗口；默认开只影响常驻内存，不影响帧率。

## 六份文档的收益排序建议

按「单价随进度增长的幅度 × 触发频率」排：

1. **寻路与 AI**（`ai-pathfinding`）：512 节点/帧 × 每格十余次可站判定 × 每次遍历全场角色——唯一真正随人数放大的一项。
2. **快照复制**（`story-performance` + `session-save-economy`）：每句台词 5 次整份复制、每次自动存档 1 次捕获 + 1 次旧档解析 + 1 次同步写入。
3. **剧情舞台重建**（`story-performance`）：每开演一幕拆掉整张地图和全部角色。
4. **菜单任务页整页重画**（`menu-hud-input`）：单价 × 通知频率，菜单开着时最明显。
5. **纹理常驻**（`asset-texture-memory`）：255 MB 的佣兵外观白占显存，叠 boss 时顶到移动端预算。
6. **内容缓存**（本文问题一）：8.5 MB，可不动。

## 本文明确不做

- 不重排 `afterMovement` 的扫描顺序，不建事件索引；
- 不把内容解析改成并行 worker；
- 不动发布链路的缓存与压缩策略；
- 不改 `SAVE_FORMAT`（保持 41）。

## 按本文可以直接开工的两项

| 顺序 | 改动 | 文件 | 工作量 | 收益 |
|---|---|---|---|---|
| 1 | 存档写入挪到空闲帧 | `src/application/auto-save.ts` | 半天 | 每次自动存档少卡一帧 |
| 2 | 帧统计默认采集、留 3 分钟 | `public/diagnostics.js` | 半天 | 之后所有排查不用再猜 |
| 3 | 内容解析结果限最近 3–5 张 | `src/application/content-loader.ts` | 半天 | 省 8.5 MB 上限，可延后 |

两项都做，收益仍然是「少一次卡顿」级别；**要解决「越玩越卡」，必须动寻路和快照复制**，见开头两份文档。
