# 正式版异常核查报告（2026-11-17）

## 1. 范围与口径

- 代码分支：`release/formal-save-baseline`，HEAD `c7ad5362`，`SAVE_FORMAT = 1`。
- 日志来源：`.diagnostics/` 生产诊断日志。
- 时间窗口：2026-11-16 00:00 至 2026-11-17 13:16（+09:00）。
- 只统计 `build.game === 'v1.0.10'`：过滤后 49,390 条、143 个诊断会话。
- 已清理：删除了 5 个轮转文件中 24 条早于 2026-11-16 00:00 的记录；复查为 0 条。正在写入的活动文件未动。
- 按用户要求排除：网络失败、旧版本（v1.0.7～v1.0.9）、帧率问题、更新失败，以及内容版本不一致这类部署/版本问题。
- 日志来自生产 `v1.0.10`（`main` 构建）；本报告对照正式版分支代码，结论中标注该问题在正式版分支是否仍存在。

## 2. 结论摘要

真正需要处理的游戏运行问题有 4 个：2 个确认 bug、1 个异常处理缺陷、1 个高概率竞态。

| 优先级 | 问题 | 结论 |
| --- | --- | --- |
| P0 | `event-158` 剧情走位目标 `(136,216)` 落在阻挡格 | 确认内容坐标错误，会卡住剧情 |
| P1 | `Missing animation: effects-atlas:24` | 确认代码 bug：把纹理键当动画键播放，魔法宝石飞行停在首帧 |
| P1 | iOS `AudioContext.resume()` 拒绝未捕获 | 确认异常处理缺陷：声音可能起不来 |
| P2 | `Texture key already in use` 重复纹理键 | 高概率竞态：取消加载后的迟到文件与新同键加载重叠 |

QQ 内置 WebView 不支持 WebGL、UC 浏览器 `navigator.vibrate` 赋值错误，按产品决定不处理，归入“浏览器兼容限制”；UC 明确不加提示，QQ 也不做专门提示。

技能书跨职业校验不适用：当前内容只产出不绑定具体技能的通用技能书，以及随机解锁一门技能的封印书；日志里的 2 次跨职业错误来自旧档或调试数据。正式版只读格式 1，旧档不会进入。

修复进度（2026-11-17）：3.1 `event-158` 已修（提交 `020d4ee6`）；3.2 `effects-atlas:24` 已修（提交 `ec1413e2`）；3.3 iOS 音频已修（提交 `a4760b49`）。其余 1 个待修：3.4 纹理重复竞态。

其余高频日志主要是噪声或设计状态，不建议当 bug 修：

- Android 转屏/切后台导致的 WebGL 上下文丢失，恢复链路有效，不是纹理泄漏。
- `Cannot pause non-running Scene`：重复暂停/迟到入队，无玩法影响。
- `session-recovered`：诊断误报，不是可靠的崩溃证据。
- `map-enemies-empty`：剧情主动清场，不是刷怪配置漏了。
- `story-silent-entry-missing`：素材预取未完成计数，不是缺文件。
- `placement-blocked: settle-check`、剧情执行预算：各 1 次，未复现。
- `人物状态已改变`：异步外观/技能刷新的可忽略竞态。
- `save-refused-no-survivor`：规则内正常；`save-repaired-stale-quest-item` 只存在于旧 `main`，正式版分支不会再产生。

## 3. 需要修的问题

### 3.1 `event-158` 剧情走位目标落在阻挡格（P0）

- 现象：`berkel-capital` 地图，玩家在 `(360,216)` 把 `quest-102` 置为完成后触发剧情，走位到 `(136,216)` 失败，连续报 3 次；重新读档后在同一节点又报 1 次。
- 证据：`public/content/campaign.json` 的 `event-158` 要求 player 走到 `(136,216)`；该点在 `berkel-capital` 第 8 列第 13 行，`blocked=true`；声明的预览图 `kiyan-s-room` 同一点也是墙。
- 根因：动态地图舞台（`mapFromWorld:true`）使用固定坐标。`src/rendering/story-presenter.ts:495` 的 `walk` 与 `src/domain/walk-route.ts:74-80` 只在到达目标格时算成功；目标格本身阻挡就永久判不可达。`src/application/story-performance-validation.ts:46` 对 `mapFromWorld` 跳过寻路校验，所以构建期没拦住。
- 建议：
  1. 内容侧把首段 `walk` 改为不移动（`retainPlayerPosition` 已保留现场），或改成玩家附近可达点。
  2. 代码侧对动态地图走位失败退到 `NavigationWorld.nearest` 的可站点并记诊断，避免整段剧情中断。
  3. 校验侧按触发落点地图（`quest-102` 的 `alternates`）补跑走位检查。
- 正式版分支状态：已修（提交 `020d4ee6`）：去掉固定走位，并为动态地图走位加最近可站点兜底。

### 3.2 `effects-atlas:24` 缺失动画（P1，确认 bug）

- 现象：过滤后约 3.36k 条、66 个会话，消息只有 `Missing animation: effects-atlas:24`。
- 证据：`effects-atlas:24` 是真实图集页（`src/generated/effect-atlas.ts`、`public/assets/effect-atlas/effects-24.json`）。唯一把纹理键当动画键的代码是 `src/rendering/ground-loot.ts:46`：`sprite.play({key:sprite.texture.key,...})`。飞行精灵的纹理键就是页键（`src/rendering/effects.ts:103-104`），而真正的动画键是 `文件#页#clip:帧数:帧率`（`effects.ts:19-22`），从不等同于页键。只有 `mana-gem` 定义了 `pickup.hitDrop`，四个方向的 `mana-gem-drop/*.png` 全部映射到第 24 页，和日志对应。
- 影响：Phaser 在动画不存在时先停掉当前播放再警告，魔法宝石飞行动画实际停在首帧。
- 建议：播放已有动画，不要用纹理键。可在 `ground-loot.ts` 取 `sprite.anims.currentAnim?.key` 后 `play({key,startFrame,repeat:-1})`，或在 `effects.ts` 暴露 `seekEffect(sprite, elapsedMs)` 用 `setProgress` 同步进度；顺带把当前 `repeat:0` 改为飞行期间循环。
- 验证：`npm test -- tests/ground-loot-presentation.test.ts tests/effect-atlas.test.ts`，并补一条“飞行精灵播放的动画键在 AnimationManager 中存在、不产生 Missing animation”的断言。
- 正式版分支状态：已修（提交 `ec1413e2`）：改为重播 `sprite.anims.currentAnim.key`，飞行期间循环，并按已飞时间取模计算起始帧。
- 补充核查（2026-11-17）：日志里所有 `Missing animation` 只有 `effects-atlas:24` 一种；代码搜索确认 `ground-loot.ts` 是唯一把纹理键当动画键的入口。其他特效、伤害数字和角色动画都使用真实动画键，或先 `anims.create` 再播放；`stale-effect-animation`、`effect-texture-missing` 均为 0。因此没有证据表明其他特效帧正在丢失。

### 3.3 iOS 音频 `resume()` 拒绝未捕获（P1）

- 现象：iOS Safari 4 个会话、5 条 `unhandled-rejection`，错误为 `InvalidStateError: Failed to start the audio device`；发生在 `hidden`/`visible`/转屏前后。
- 根因：`src/main.ts:1140-1143` 的 `void sound.context.resume()` 没有 catch；Phaser `onGameVisible`（dist `phaser.esm.js:226919-226931`）在 `VISIBLE` 后 100ms 执行 `suspend(); resume();` 也没有 catch。页面再次隐藏、没有用户手势或音频会话被系统占用时，Safari 拒绝 resume。
- 建议：所有 `resume()` 接 `.catch(()=>{})`；只在 `!document.hidden` 且确有用户触摸时重试；ready 后移除 Phaser 的 `VISIBLE` 处理器，用带 catch 的自己的可见/触摸恢复；连续失败提示“点屏幕恢复声音”。
- 正式版分支状态：已修（提交 `a4760b49`）：新增 `resumeAudioContext` 接住同步/异步拒绝，只在可见、未锁、未运行时恢复；`ready` 后摘掉 Phaser 的 `VISIBLE` 处理器；首次失败记录 `audio-resume-failed` 诊断。

### 3.4 `Texture key already in use` 重复纹理键（P2，高概率竞态）

- 现象：过滤后约 390 条、45 个会话（统计期间日志仍在增长）。按纹理族分：地图 ground/canopy 157 条（66 个不同键）、`characters-atlas` 页 120 条、技能图标 90 条、特效页 24 条（`effects-atlas:14/15/19`）。平台以 Android APK 和 iOS Safari 为主。
- 证据：报错栈为 Phaser `TextureManager.addImage → checkKey`（`node_modules/phaser/src/textures/TextureManager.js:273`）；项目通过 `loadSceneAssets` 的 `scene.load.image/atlas` 发起加载（`src/rendering/scene-assets.ts:212-217`）。约一半报错发生在 `story-entry-prefetch`、`map-enter` 后 5 秒内；有 5 次连续突发正好各含一整套 24 个键，和一次进图计划的完整资源集吻合。
- 根因：Phaser Loader 不保证随 JS 取消而停止在途文件（`scene-assets.ts:226-230`）。取消后新请求立即取得租约并开始加载（`scene-assets.ts:183-184`）；旧文件晚到时，`addtexture` 对账只检查“有没有租约”（`scene-assets.ts:62-66`），而新请求在下载前就已持有租约，于是旧纹理被保留，新文件随后写入同键就触发 `checkKey`。加载队列按纹理库串行（`scene-assets.ts:14-15,192-220`），不是普通同帧并发。
- 建议：优先让剧情预取换目标时“停止等待但不中止底层加载”，完成后无主再释放；或在取消时按纹理库登记待结算键，新请求在 `needed` 检查前等待这些键落定；或给每代加载用独立临时纹理键，完成后再收敛。回归测试放在 `tests/scene-assets.test.ts`：第一个请求 pending → 取消 → 第二个同键请求开始 → 旧文件先 `addtexture` → 新文件完成，断言不出现重复写键且只保留一张纹理。现有 `tests/scene-assets.test.ts:181-195` 没覆盖“新请求仍在下载”的窗口。
- 正式版分支状态：相关加载/生命周期文件未改，仍存在。

## 4. 噪声、设计状态或可忽略

### 4.1 Android WebGL 上下文丢失

- 6 次真实丢失（另有 1 条同事件记录），4 个 Android APK 会话；5 次约 1 秒恢复，1 次页面已退后台、无恢复记录。
- 每次丢失紧跟 `visibility: visible`/转屏，之前有 `pagehide`、`session-end` 或 `hidden`；丢失前帧率 54–61，无掉帧；纹理数 252–423、估算 309–383 MB，多次丢失时为 423→415→422，无单调增长，回菜单后 450→130。
- 结论：Android 退后台时销毁 GPU 上下文，回前台重建，Phaser 正常派发 `RESTORE_WEBGL`。高常驻纹理 + 3× 采样提高触发概率，但不是泄漏。
- 可选改进：丢失超过 1 秒加“画面恢复中”遮罩；低端机评估默认 2×。恢复逻辑在 `src/rendering/webgl-recovery.ts:24,57`、`outfit-pool.ts:63`。

### 4.2 `Cannot pause non-running Scene`

- 241 条（world 176、menu 55、story-stage 8、story-class-select 2），快照复查 248 条；约三分之二发生时 `state.suspended=true`。
- 根因：`src/main.ts:1172-1180` 的守卫是 `isActive() || isPaused()`，暂停已暂停的场景会重复入队；`sync()` 被 visibilitychange、resize、orientationchange、visualViewport、pageshow 多次触发。少数是隐藏后场景随即 shutdown 的迟到暂停。
- 结论：Phaser 只警告并返回，不改变游戏状态，属噪声级时序问题。建议暂停只允许 `sys.isActive()`，恢复只允许 `sys.isPaused()`，`pausePressure` 同样加守卫。

### 4.3 `session-recovered` 是诊断误报

- 15 条、15 个会话；`previousKind` 为 visibility 5、unhandled-rejection 2、combat-end 2、start-phase 1、checkpoint 1、map-exit 1（快照口径）。
- 多条 `previousTime` 比恢复时间早数小时甚至约 15 小时；同一旧会话在 `previousTime` 后仍有 save/visibility 记录。可见的最后记录多为 `visibility: hidden`；没有恢复事件紧邻 `window-error` 或 `webgl-context-lost`。两条 unhandled-rejection 只是音频设备启动失败。
- 根因：`public/diagnostics.js:285-320` 的 `lastOtherSession` 只扫描 IndexedDB 仍存留的记录，而上传成功会删除记录；`session-end` 上传后也被删，下次启动就可能找不到并误报；`:427-432` 据此写恢复事件。
- 建议：用不会被上传删除的“正常退出”标记（pagehide 已写 `SESSION_END_KEY`）判定，只有标记缺失才记恢复；或把字段改名为 `lastRetainedKind`。

### 4.4 `map-enemies-empty` 是剧情主动清场

- `shadow-warehouse`（heroLevel 28/101）与 `secret-sanctum`（heroLevel 23）均 `tiers=[]`、`spawns=0`。
- `public/content/campaign.json` 的 `event-157` 把仓库两种怪永久设为不可用；`event-89` 移除神殿全部 `enemy-cursed-creature-2`。两张图本身各有 10 和 6 个生成点；`world-enemies.ts:46` 因无 `tierLevel` 返回全部，`recordEmptyDiagnostic` 在 `:417-424` 记录空图。
- 结论：剧情主动清场或禁用，不是等级过滤，也不是地图漏配；当时活动任务不要求击杀这些怪。建议诊断区分“剧情不可用”和“配置为空”。

### 4.5 `story-silent-entry-missing` 是预取计数

- 126 条、28 个会话；多数 `missing=0`；`shadow-forest-west` 常为 14，`shadow-forest-east` 常为 3，`shadow-hall` 为 26。
- `src/scenes/world-scene.ts:653-657` 只在静默跨图时记录 `missingSceneAssets(...).length`；`src/rendering/scene-assets.ts:144` 按纹理和帧缺口统计。上述地图没有随后的内容加载失败，只有重复纹理警告。
- 结论：`missing` 是预取尚未完成的素材数量，不是内容缺失；静默入口随后会等待预取并补载。建议把 `missing>0` 记为预取滞后事件而非入口缺失。

### 4.6 其他单条或低置信度记录

- `placement-blocked: settle-check` 1 条：两人落点重叠的软约束，`blocked` 为空数组表示每个人单独合法但互相压住；代码保留现场继续演出。诊断可补记冲突双方。
- 剧情连续节点超过执行预算 1 条：`story-runtime.ts:397` 的 1000 步上限；当前 693 个脚本单脚本最多 21 节点、无环，静态不可复现，更像旧格式存档遗留的 run 游标或跳过流程运行态异常。建议在抛错处带 `run.script`、`cursor`、`eventId`、`stack`。
- `skill-asset-refresh-failed: 人物状态已改变` 5 条、2 个会话：玩家换装/学技能使背包修订号或技能版本在异步合成期间变化，旧结果被主动丢弃；重试 1s→30s、最多 5 次，`attempts:1`，属保护而非资源加载失败，可忽略。
- `texture-retained` 3 条：`texture-lifecycle.ts:95-104` 在释放时发现画面仍引用纹理就记录并排队，帧后复查，引用消失再删；是退役队列的正常工作记录。
- `Script error.` 1 条：macOS Safari，`file` 为空、`error` 为 null，跨域脚本被浏览器脱敏，无法归因，判为平台噪声。

## 5. 按规则排除的类别

以下问题不计入“游戏运行 bug”：

- 网络/加载失败：
  - `content-load-error` 155 条，其中 `Failed to fetch` 126 条、超时 23 条；`common-preload-error` 46 条；`slow-resources` 44 条。
  - 被点名的音频和菜单图全部存在、路径正确，生产地址均 200；失败按网络/解码/大图超时处理，不是缺图。
- 旧版本：
  - v1.0.7～v1.0.9 的记录全部排除；`(152,120)` 的 2 次道路不可达只属于 v1.0.9。
- 帧率：
  - `performance-low-fps` 165 条（v1.0.10）；按用户要求排除。仅记录：`minFps<30` 的会话里 Android APK 占多数，`maxFrameMs>100` 也以 Android APK 为主；后续若要单独做性能专项，可从这条线索继续。
- 更新失败：
  - 11 条（全量口径，来源没有可用 game 版本）：timeout 6、cancelled 2、read timeout 1、`index.html` 校验失败 1、HTTP 404 1；按规则排除。
- 内容版本与页面不一致：
  - 全量 72 条、快照 49 条，来自 `src/application/content-loader.ts:161`；属部署/版本问题，按规则排除。
- 浏览器兼容限制（产品决定不处理）：
  - QQ 内置 WebView 不支持 WebGL，新页面白屏；不增加预检/降级，也不做专门提示。
  - UC 浏览器下 Phaser 4.2.1 给只读的 `navigator.vibrate` 赋值抛错；日志显示报错后没有后续游戏事件，等同启动中断。不打补丁，也不加提示。
- 旧功能残留：
  - 绑定具体职业技能的独立技能书已移除；当前只有不绑定技能的通用技能书和随机解锁的封印书。日志中的 2 次“请选择本职业的技能”来自旧档或调试数据，正式版只读格式 1，不会再触发。
- 存档相关：
  - `save-refused-no-survivor` 1 条：全员阵亡不能存档，规则内正常。
  - `save-repaired-stale-quest-item` 1 条：只存在于旧 `main`；正式版分支 `SAVE_FORMAT=1` 且已删除该修复，不会再产生。

## 6. 建议修复顺序

1. `event-158` 内容坐标/动态地图走位校验（P0，已修）。
2. `ground-loot.ts:46` 播放正确动画键（P1，已修）。
3. iOS 音频 `resume()` catch（P1，已修）。
4. 纹理重复竞态（P2，待修；先补回归测试，再调整取消/租约策略）。
5. 可选项：WebGL 丢失遮罩/低端机 2×、暂停守卫、`session-recovered` 判定修正、空图诊断区分剧情清场。

## 7. 验证入口

- 纹理/动画：`npm test -- tests/scene-assets.test.ts tests/ground-loot-presentation.test.ts tests/effect-atlas.test.ts tests/texture-lifecycle.test.ts`
- 剧情/寻路：`npm run validate:content`、`npm test -- tests/movement-world.test.ts tests/story-performance.test.ts`
- 刷怪/世界：`npm test -- tests/world-enemies.test.ts`
- 渲染/平台：`npm run typecheck`、`npm test -- tests/phaser-framebuffer.test.ts tests/combat-feedback.test.ts`
- 诊断/暂停：`npm test -- tests/game-diagnostics.test.ts`
- 真机验收：iOS（切后台/转屏/来电后的声音）、安卓 APK（后台/转屏 WebGL 恢复）、`berkel-capital` 的 `quest-102 → completed` 剧情走位。
- 浏览器兼容限制：QQ 内置 WebView 和 UC 均不修；UC 明确不加任何提示。

## 8. 附注

- 本报告基于 `release/formal-save-baseline` 代码审查；线上当前运行 `main` 的构建（`SAVE_FORMAT=59`），本报告没有部署正式版分支。
- 日志计数是核查时快照；统计期间仍在写入，后续数字会继续增长。
- 报告不包含用户或会话 ID。
