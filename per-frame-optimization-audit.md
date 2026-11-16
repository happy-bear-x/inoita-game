# 每帧优化总清单（已补充代码复核）

> **2026-11-16 复核结论：多数重复遍历和临时分配确实存在，但原方案不能全部直接实施。** 第 9 节逐项区分“问题存在”和“方案合理”。尤其注意：`hasZeroHealth` 已用集合查询；静态深度已有值相同就跳过写入的保护；采样草案必须处理停步读数和角色可移动状态切换。实际帧率收益尚未测量。

> 临时复核文档。用于第二个 agent 核对“断言和当前代码是否一致”；复核完成后可删除。
> 代码以当前工作区为准（包含未提交改动）。行号是当前工作区的行号，复核时优先按符号名定位。

---

## 0. 用途与复核方式

这份文档不是最终实现说明，而是一份**待复核的优化清单**。它合并了两轮分析：

1. 7 个 agent 分块盘点“游戏每帧/每物理步/每逻辑帧做什么”。
2. 6 个 agent 专门尝试推翻第一轮断言，修正了“说太满”和“因果不对”的地方。

复核目标：

- 每条断言是否与当前代码一致。
- 触发条件是否写对：每渲染帧、每物理步、每战斗逻辑帧、事件驱动。
- 是否已有缓存、同值短路、提前返回、空间索引被忽略。
- 优化建议是否会改变游戏行为，尤其是碰撞、寻路、技能落点和战斗节奏。

复核方式建议：

- 只读代码，不修改文件，不启动浏览器、构建或测试。
- 优先按符号名定位，不按行号硬找。
- 每条给结论：`CONFIRMED`（代码证实）/ `PARTLY WRONG`（部分不符）/ `WRONG`（断言不符）/ `UNVERIFIED`（证据不足）。本次结果见第 9 节；前面的盘点作为方案背景保留，有冲突时以复核结论为准。
- 重点看“触发条件”和“是否会改变行为”，不要只看代码里有没有这个词。

### 三个时间口径

| 名称 | 多久一次 | 说明 |
|---|---|---|
| 渲染帧 | 60fps 约 16.7ms；30fps 约 33ms | 浏览器真正画一张画面 |
| 物理步 | Arcade 固定约 60 步/秒 | 游戏算移动和碰撞的小节拍；掉帧时会补步 |
| 战斗逻辑帧 | 固定 60ms，约 16.7 次/秒 | AI、Buff、冷却、动作推进、名册刷新 |

另外：启动后通常有 4 个场景在跑（音频、控制设置、正式界面、当前玩法场景），剧情演出时 5 个。

---

## 1. 已核实的事实（结论先行）

### 1.1 确认成立的核心问题

1. **物理步全量采样。** `MovementInterpolation.completeStep` 每个物理步遍历全部已登记采样点；`MovementWorld.register` 对不会动的 NPC、宝箱、门、不会动的敌人也会调用 `interpolation.register`。每个采样点先调用 `position()`（新建 `{x,y}`），再判断 `enabled()`。
2. **玩家移动时全表扫描交互目标。** `updateInteractionTarget` 在位置或修订号变化时遍历当前地图全部内容实体；没有空间索引。频率最多约每秒 60 次，不是每个渲染帧。
3. **玩家/队友每物理步扫描全部内容机关。** `blockedByContent` 每次遍历 `contentActors`；`contentActors` 不只包含火焰、路障、宝箱，也包含 NPC、门、泉水、`canMove=false` 的敌人。
4. **AI 候选没有空间索引预裁剪。** `combatants()` 由全部上阵队伍 + 全部 arena 组成；敌人接战后每次决策扫描全部候选，队友无目标时全扫，召唤物约 180ms 决策一次。每个候选还会过警戒距离、leash、阵营等后置过滤，但这些过滤不减少遍历次数。
5. **战斗名册仍有部分线性查找。** `enemySnapshot()` 使用 `find` 并重新计算属性；但 `roster.hasZeroHealth(id)` 已使用 `zeroHealth.has(id)`。候选构建也复用了角色索引与逻辑帧缓存，不能据此推导“40 只怪时，候选构建达到 O(N²)（工作量随怪物数的平方增长）”。详见第 9.3 节。
6. **每帧固定产生小对象/字符串。** 例如：`drive` 每帧新建意图和速度对象；`syncHud` 每帧拼摘要字符串；小地图玩家点每帧新建两个坐标对象和一个字符串；Buff 循环特效每帧新建 `Set`/数组/键字符串；队伍签名每可控战斗帧访问 `activeIds` getter（新建数组）并 `join`。
7. **每帧写 DOM。** 拾取提示在屏时每帧写 `transform`/`display`；即时提示可见期间每帧写透明度样式；操作按钮隐藏期间每帧复位 8 个按钮；小地图玩家点只在跨格时写，但每帧仍做投影和拼键。
8. **高频事件里做重活。** 滚动一次在部分菜单面板会调用两次 `MenuTextLayer.apply()`（第二遍只算签名，不写 DOM）；摇杆每次匹配的 `pointermove` 都 `getBoundingClientRect()`；布局编辑器拖动每次事件重算全部 9 个控件，移动模式实际解析两次。
9. **同帧重复调用。** 快捷栏在一个逻辑帧内可能先 `setCooldowns` 再 `setShortcutPage`；`activeAppearances()` 每渲染帧调用两次（第二次是增量）；`setLayerVisible('world', ...)` 正常操控帧调用两次（第二次通常同值短路）。

### 1.2 需要限定条件或改写的断言

这些是第一轮说错或说太满的地方，复核时请特别关注：

1. **“交互扫描每帧”** → 应改成：玩家/操控者位置变化后的渲染帧，最多约每秒 60 次；站着不动且修订号未变会提前返回。扫描范围是当前地图内容实体，不含玩家、队友、敌人。
2. **“敌人每 60ms 全扫”** → 只对接战/需要完整决策的敌人成立；空闲主动敌人约每 5 个逻辑帧（300ms）一次。队友只在没有焦点/黏性目标时全扫；召唤物约 180ms 决策一次。
3. **“主动敌人没目标时 filter+sort 取最近”** → 正式战斗走不到这条分支，因为正式敌人都有仇恨端口；它只在测试或无仇恨端口的调用里出现。
4. **“敌人不做内容机关检查”** → 不绝对。敌人 `terrainRecovery=false`，平时跳过；但被挤进阻挡地形时仍会调用一次 `blockedByContent`，只是不会自愈。
5. **“这些路径没有空间索引”** → 应说“这四条路径没有使用空间索引”。仓库别处有 16px 占位广相、64px 攻击落点索引、流场 16px 分桶和 Phaser Arcade RTree，只是这些循环没查。
6. **“出口检测每帧两个闭包”** → 调用处的箭头函数每帧有；`find` 里的闭包要累计走过 80 像素后才创建。`last` 坐标对象每帧新建。
7. **“打字机每帧拆整页”** → 只在有一页对白正在等待推进（包括等待玩家点击翻页）时成立；没有对白页时 `GameUI.tick` 提前返回。
8. **“即时提示每帧写文本和透明度”** → 文本有同值短路，只写一次；每帧写的是透明度样式。透明度只在最后约 240ms 每 60ms 变一档，之前一直是 1。
9. **“拾取提示最多 32 条在屏”** → 32 是“排队 + 在屏”的总上限；常态同时在屏约 20 条。
10. **“操作按钮每帧复位”** → 是 DOM 组件 `resetInput` 随显隐调用被每帧触发，不是 `WorldScene.resetInput`。按钮没被按过时 `delete dataset.pressed` 本身不产生实际变化，但数组分配和 8 次调用仍在。
11. **“滚动整页重算两遍”** → 第二遍会算整页签名和裁剪包围盒，但被签名短路，不再写 DOM。双刷新只发生在商店、强化、队伍、任务、技能书、合成等面板；背包、状态、设置、标题页只有一遍。
12. **“摇杆每次 pointermove 都写”** → 只有按住同一指针、`buttons !== 0` 且轴值变化时才写圆点和箭头；十字键模式方向没变不写。`getBoundingClientRect()` 在每次匹配的移动事件上仍会调用。
13. **“软键盘一定重新分页对白”** → 只有当前确实有对白在推进时才会；键盘输入场景通常没有对白。真正每次都会做的是 `scale.refresh()` 引发正式界面整块重建。
14. **“快捷栏双画是技能冷却导致”** → 技能冷却不在快捷页签名里。只有当前页有回复药水正在冷却时，签名才每 60ms 变一次；未变化的槽位被内部 `stateKey` 比较挡住。
15. **“activeAppearances 重复计算两遍”** → 两次调用是真的，但第二次只处理逻辑帧里新增的变化，不是全量重算。
16. **“setLayerVisible 每帧写两次 DOM”** → 正常操控帧调用两次，但第二次通常同值短路，不写 DOM。控件布局编辑时才会两次都写。
17. **`performing` 从没被设成 true** → 生产代码成立；测试夹具会手动设 true。它导致相关分支是死分支，但不能延伸成“演出时玩家能操作”：输入锁还由 `director.busy`、舞台遮挡、场景暂停等机制承担。
18. **检查点重复抓取** → 有条件，不是每次进图都发生，也不一定在“下一帧”。进图剧情接管（导演会在剧情后抓检查点）、读档停在等待战斗的现场、第一次抓取失败等情况会改变结果。第二次是完整重跑快照，不是廉价覆盖。
19. **队伍签名每帧拼** → 只在正常可控战斗帧成立；菜单、剧情、加载、阵亡时不执行。代价除字符串外，还包括 `activeIds` getter 每次新建数组并过滤槽位。

### 1.3 明确不是“每帧”的（不要误改）

- 特效池、伤害数字、命中闪光、震屏：命中事件触发，有池子和上限。
- 技能动作、弹道、技能判定：60ms 逻辑帧的动作事件，不是每渲染帧遍历所有技能。
- 冷却倒计时：施放时写绝对截止帧，查询时比较，不每帧递减。
- 敌人死亡、奖励、掉落生成、任务击杀统计：死亡结算事件一次完成。
- A*：条件触发，共享 512 节点/渲染帧预算。
- 流场：同一目标 200ms 内至少 3 个请求才建，目标移动 16px 或 800ms 无请求才重算，最多 4 张。
- 自动存档：默认 300 秒一次，带去抖和最小间隔。
- 诊断心跳：60 秒一次；明显掉帧最多 5 分钟上报一次。
- 云存档：只在打开页面、上传、下载或用户确认时请求。
- 菜单整页重建、存档缩略图、存档行更新：事件触发。
- 剧情等待、对白、选项、并行、切幕：定时器、Promise、`animationcomplete` 事件驱动。
- 地图绘制、小地图任务点/交互点重建：进图或状态签名变化时做一次。
- 键盘和触摸输入：事件改共享状态，场景每帧只读一次摇杆轴。
- 物理碰撞回调：只在两个物理体接触时执行。
- 相机跟随：项目只开始/结束，之后由 Phaser 每帧推进。
- 已落地掉落：只有仍在飞行的掉落每帧推进。
- 界面层没有自己的 `requestAnimationFrame` 自循环，也没有常驻 `setInterval`。

---

## 2. 总清单（按优先级）

### 第一批：先做，风险低

#### 1. 物理步只给“会动的人”记位置，并且不再每步造坐标

- **现状**：`MovementWorld.register` 对静态内容实体也调用 `interpolation.register`；`completeStep` 对每个采样点先 `position()` 新建 `{x,y}`，再判断 `enabled()`。
- **怎么改**：
  1. 注册时只有 `movable` 为真的角色才进插值采样表。
  2. 给 `MovementBody` 加 `footPositionInto(out)`；`MovementInterpolation` 的采样接口加 `positionInto(out)`。
  3. `completeStep` 只用一个共用临时坐标；位置没变时让 `previous` 收敛到 `current`，并从 `moving` 移除，保证显示坐标查询也读到停步后的当前位置。
  4. 禁用角色仍用共用坐标同步一次位置，避免重新显示时滑一段。
- **好处**：每物理步少遍历大量静态 NPC/宝箱/门；采样层从“每人一个新对象”接近 0 个新对象；减少 GC 抖动。
- **证据**：`src/rendering/movement-world.ts` 的 `register`；`src/rendering/movement-interpolation.ts` 的 `completeStep`；`src/rendering/arcade-movement.ts` 的 `footPosition`。
- **触发条件**：每个 Arcade `worldstep`；物理暂停、场景关闭、无物理体时不触发。
- **风险**：如果某个静态角色被 `place` / `placeAll` 之外的代码直接改坐标，深度可能不更新。当前地图实体、剧情舞台演员、战斗敌人落位都走 `place`/`placeAll`/`placeContent`，需要复核全部直接改坐标入口。
- **验证**：`tests/movement.test.ts`、`tests/movement-world.test.ts`、`tests/movement-content-recovery.test.ts`；补一个“静态不进采样表、会动仍插值”的用例。

#### 2. 静态角色的深度只写一次

- **现状**：`syncDepth` 每个渲染帧遍历全部 registrations；静态角色深度不会变，但仍在循环里。
- **怎么改**：只遍历会动角色；静态角色在注册、`place`/`placeAll`/`placeContent` 落位时写一次深度。
- **好处**：每帧少遍历静态角色。当前 `syncDepth` 已比较深度是否变化，静态角色不会反复调用 `setDepth`；因此不能把收益写成“减少静态角色造成的显示列表重排”。
- **证据**：`src/rendering/movement-world.ts` 的 `syncDepth`；`placeAll` 里已有 `setDepth`。
- **风险**：静态角色若有直接改 y 的路径，深度会过期。需要复核所有直接改容器坐标的入口。
- **验证**：movement 相关测试；实机看遮挡顺序。

#### 3. 隐藏的操作按钮不要每帧复位

- **现状**：`syncHud` 每帧设置显隐；按钮隐藏时 `DomActionControls.visible(false)` 调用 `resetInput`，每次新建 8 元素数组并逐个 `DomButton.reset()`。
- **怎么改**：记录上一次显隐；只在“从显示变隐藏”时复位一次。
- **好处**：剧情、菜单、锁输入期间少做无用功；少建每帧数组。
- **证据**：`src/scenes/world-scene.ts` 的 `syncHud`；`src/ui/dom/action-controls.ts` 的 `visible/resetInput`；`src/ui/dom/components.ts` 的 `reset`。
- **风险**：如果有别的路径只改单个按钮按下状态、不改显隐，仍需单独复位；需要复核。
- **验证**：DOM 按钮相关测试；实机看隐藏/恢复后按钮是否卡住。

#### 4. 屏幕即时提示的透明度只在变化时写

- **现状**：提示可见期间每帧 `setStyle({opacity})`；透明度每 60ms 才变一档，且前约 1560ms 一直是 1。
- **怎么改**：缓存上次写入的 alpha 字符串，相同就跳过。
- **好处**：少写 DOM style；手机少一点样式重算。
- **证据**：`src/scenes/formal-ui-scene.ts` 的 `syncInstantMessage`；`src/ui/dom/dom-ui.ts` 的 `setStyle` 无同值检查。
- **风险**：只影响一个标签，收益小；不要为此改文本写入逻辑。
- **验证**：实机看提示淡出是否正常。

#### 5. 队伍签名只在队伍变化时算

- **现状**：`WorldCombat.update` 每可控战斗帧执行 `activeIds.join('|') !== partySignature`；`activeIds` getter 每次新建数组并过滤槽位。`nextPartySyncAt` 只在失败时更新。
- **怎么改**：给队伍加版本号（上阵/离队/切换时递增）；版本未变就不拼；缓存 `activeIds`。
- **好处**：每帧少一个字符串、两个数组和过滤。
- **证据**：`src/scenes/world-combat.ts` 的 `update` 和 `syncAllies`；`src/domain/party.ts` 的 `activeIds`。
- **触发条件**：只在本帧可控、未阵亡、世界未被完全遮挡时执行。
- **风险**：要保证所有队伍变化入口都推进版本号；漏一个会导致队友不同步。复核 `Party` 的所有 mutation 入口。
- **验证**：队伍同步相关测试；实机换人、离队、阵亡、复活。

#### 6. 顺手修两个小疑点

- **`performing` 死分支**：生产代码只把它设为 `false`，从未设为 `true`。要么接上“演出中”的写入，要么删掉相关判断。它当前不影响输入锁（还有 `director.busy`、舞台遮挡等），但会误导后续维护。
- **检查点重复抓取**：进图时先 `captureCheckpoint()`，随后又把 `checkpointPending` 设回 true；抓取内部已把它设回 false。条件满足时会再抓一次完整快照。把顺序改对，或明确注释“需要下一次刷新”。
- **好处**：少一条假路径，少一次进图完整快照。
- **风险**：要先确认第二次抓取是不是有意设计（代码没有注释或测试说明）。

---

### 第二批：收益更大，改动中等

#### 7. 对白打字机缓存整页，等待点击时不重拆

- **现状**：`GameUI.tick` 在 `pending` 非空时每帧调用 `typedIndex(this.page)`；该函数把整页文字拆成字符数组、偏移数组并 join 新字符串。等待玩家点击翻页时仍会执行。
- **怎么改**：每页只拆一次并缓存；只在 24ms 累加器到点、且尚未全部显示时推进；只更新新显示的那几个 run。
- **好处**：长对白、彩色字多时减少 GC 和卡顿。
- **证据**：`src/ui/game-ui.ts` 的 `tick`；`src/domain/text-markup.ts` 的 `typedIndex`；`src/ui/dialogue-text.ts` 的 `revealedRuns`。
- **触发条件**：对白页挂起期间；无对白时 `tick` 提前返回。
- **风险**：缓存必须随换页、窗口重排、字号变化失效；复核 `reflowDialogue` 和 `renderPage` 的调用点。
- **验证**：对白相关测试；实机看换页、彩色字、缩放。

#### 8. 拾取提示位置没变就不写网页

- **现状**：`PickupMessages` 的 `postupdate` 每帧对每条活动提示重算投影并写 `style.transform`、`display`；位置没变也写。
- **怎么改**：缓存上次屏幕位置和 `visible` 值，变了才写。
- **好处**：战斗掉落多时减少 DOM 写入和字符串分配。
- **证据**：`src/rendering/pickup-messages.ts` 的 `update/position`。
- **触发条件**：有在屏提示时；`active` 为空时只空循环。
- **风险**：相机缩放、画框尺寸变化时要让缓存失效；复核 resize 路径。
- **验证**：拾取提示相关测试；实机看跟手、边缘避让。

#### 9. 小地图玩家点直接比较格子坐标

- **现状**：每帧 `project` 新建两个坐标对象并拼 `x|y`，只为了判断是否跨格。
- **怎么改**：直接比较投影后的整数格子坐标；跨格才写 `left/top`。
- **好处**：站立时不再每帧造两个对象和一个字符串。
- **证据**：`src/ui/dom/minimap.ts` 的 `updatePlayer`。
- **触发条件**：正常操控且小地图存在时；不可控/演出时不调用。
- **验证**：小地图相关测试；实机看跨格。

#### 10. 剧情遭遇完成检查降频

- **现状**：`WorldScene.update` 每帧调用 `completedStoryEncounters()`；内部 `filter` 活动遭遇并逐生成点读血量，产生新数组和对象。
- **怎么改**：放到战斗逻辑帧（60ms）或敌人数/遭遇版本变化时检查；不要每张画面都查。
- **好处**：去掉每帧筛选和小对象。
- **证据**：`src/scenes/world-scene.ts` 的 `update`；`src/domain/world-enemies.ts` 的 `completedEncounters`。
- **触发条件**：可操作且导演不忙时；没有遭遇时只产生空数组。
- **风险**：延迟最多 60ms 接剧情，通常可接受；复核“战斗结束必须立刻接剧情”的需求。
- **验证**：剧情遭遇相关测试；实机打通一场任务怪。

#### 11. 交互目标只查附近

- **现状**：玩家/操控者位置或修订号变化时，遍历当前地图全部 `this.characters`（NPC、宝箱、泉水、门），无空间索引；最多约每秒 60 次。
- **怎么改**：按 16px 或 32px 格子分桶；只查操控者附近几格；保留现有位置/修订号缓存。
- **好处**：地图越大、NPC/宝箱越多，越省；走路时不全表扫。
- **证据**：`src/scenes/world-scene.ts` 的 `updateInteractionTarget`。
- **风险**：交互范围比桶小/大时要留缓冲；复核 `nearInteractive` 的距离和商店柜台间距。
- **验证**：交互相关测试；实机看任务 NPC、宝箱、商店。

#### 12. 火焰/宝箱/门也只查附近

- **现状**：玩家/队友每个物理步 `settleStep` 调用 `blockedByContent`，遍历全部 `contentActors`；集合包含 NPC、门、泉水、`canMove=false` 敌人。
- **怎么改**：把内容机关按 16px 分桶；只查脚点/身体附近几格；桶内再精确相交。
- **好处**：机关多的地图，每步成本不再随机关总数增长。
- **证据**：`src/rendering/arcade-movement.ts` 的 `settleStep`；`src/domain/navigation-world.ts` 的 `blockedByContent`。
- **触发条件**：玩家/队友/可移动友方召唤物每个物理步；敌人平时跳过，被挤进阻挡地形时查一次。
- **风险**：机关会消失/移动/换外观，桶要随注册、注销、位置变化更新；复核 `refreshActor`。
- **验证**：`tests/movement-content-recovery.test.ts`、`tests/movement-world.test.ts`。

#### 13. 战斗名册和候选用 Map 和分桶

- **现状**：`combatants()` = 上阵队伍 + arena，并按逻辑帧和状态版本复用候选。`roster.hasZeroHealth` 已用集合查询，角色查找也有索引；`enemySnapshot` 仍是 `find` 加重新计算属性。AI 决策仍可能扫描全部候选，但“候选构建因 `hasZeroHealth` 而平方级增长”的推导不成立。
- **怎么改**：
  1. 名册加 `Map<id, enemy>`，删除/生成/恢复时同步维护；`enemySnapshot` 和血蓝写入直接取，`hasZeroHealth` 沿用现有集合查询。
  2. 敌人属性快照按逻辑帧/版本缓存，别每次重算。
  3. 候选加 16/32px 分桶；AI 先取附近格，再按警戒/leash/阵营过滤。
- **好处**：名册索引可减少属性读取与写入时的查找；按现有选敌规则限定候选可减少部分 AI 扫描。不能承诺整个 40 怪压测不再平方级增长，全图警戒等规则也不能裁成只查附近。
- **证据**：`src/scenes/world-combat.ts` 的 `combatants`；`src/domain/enemy-roster.ts` 的 `hasZeroHealth`、`enemySnapshot`；`src/domain/enemy-ai.ts`、`party-ai.ts`、`friendly-summon-ai.ts`。
- **触发条件**：战斗逻辑帧；敌人接战 60ms、空闲约 300ms、召唤物约 180ms。
- **风险**：候选过滤还包含幽灵、同队、死亡单、阵营、leash 等语义，分桶只能预筛，不能替代最终过滤；复核所有过滤条件。
- **验证**：战斗 AI、名册、召唤相关测试；压测 40 只怪。

#### 14. Buff 特效复用容器

- **现状**：`BuffLoopRenderer.sync` 每个带持续特效的角色每帧新建 `Set`、`expected` 数组和 `buff:effect` 键字符串；帧龄没变也分配。
- **怎么改**：复用 `Set`/数组；键改成数字 id 或缓存字符串；只有状态版本变化时重建。
- **好处**：Buff 多时少造垃圾。
- **证据**：`src/rendering/buff-loop-renderer.ts`。
- **触发条件**：角色有非空 `frames` 且视觉活跃时；`frames` 为空会提前返回。
- **风险**：复用的容器不能跨角色共享；要注意暂停/恢复、显隐、素材迟到。
- **验证**：`tests/buff-loop-renderer.test.ts`。

#### 15. 快捷栏同一逻辑帧只画一次

- **现状**：`WorldCombat.update` 在逻辑帧推进后调用 `refreshSkillCooldowns`（`setCooldowns`）；同一帧回到 `WorldScene.update`，`refreshShortcutPageIfTickChanged` 可能再调用 `setShortcutPage`。只有当前页有回复药水冷却时签名才每 60ms 变；未变槽位被内部 `stateKey` 挡住。
- **怎么改**：把冷却和快捷页数据合并成一次“数据到齐后统一 paint”；保留现有状态比较。
- **好处**：少一次遍历 6 个快捷位和字符串拼接。
- **证据**：`src/scenes/world-combat.ts`、`src/scenes/world-scene.ts`、`src/ui/dom/action-controls.ts`、`src/ui/dom/cooldown.ts`。
- **风险**：要保证绘制顺序不改变 HUD 读数；复核 `skillHud` 与 `controls` 两条路径。
- **验证**：快捷栏/冷却相关测试；实机看药水冷却和技能冷却。

#### 16. 滚动和布局拖动合并到每帧一次

- **现状**：滚动一次在部分面板会调用两次 `MenuTextLayer.apply()`；第二遍只算签名/包围盒，不写 DOM。布局编辑器移动模式每次拖动事件解析全部 9 个控件两次；缩放模式每次事件完整 `layout()`。两者都没有 rAF 合并。
- **怎么改**：滚动/拖动事件先记录，合并到每帧一次；去掉重复的刷新入口；拖动期间缓存画框矩形。
- **好处**：菜单滚动和调布局更顺，少做重复计算和布局读取。
- **证据**：`src/ui/dom/surface.ts`、`src/ui/story-ui.ts`、`src/ui/dom/menu-text.ts`、`src/ui/phaser/control-layout-editor.ts`。
- **触发条件**：菜单滚动、拖拽、布局编辑期间。
- **风险**：滚动必须跟手；合并到每帧不能引入明显延迟。复核 `onScroll` 和 `addScrollListener` 的语义差异。
- **验证**：菜单/滚动/布局编辑器相关测试；实机拖拽。

---

### 第三批：大改，先别动

#### 17. 移动体自己的脚点和碰撞盒缓存

- **现状**：会动单位每个物理步调用 `footPosition()` 新建点；`settleStep` 再取一次；`constrain` 每次子步新建候选点；`actor.shape()` 每次调用新建碰撞盒对象（含 `mirroredCollision` 副本）。
- **怎么改**：复用每步脚点；`stepStart` 用每 body 固定对象；`shape()` 缓存并在 flip/collision 变化时失效；`settleStep` 只在需要时分配。
- **好处**：物理步的临时对象再降一大截。
- **风险**：`stepStart` 要被 `settleStep` 使用，不能和其他逻辑共享；形状缓存要覆盖换装、翻转、碰撞盒变化。改动在移动核心，先等第一、二批稳定。
- **验证**：movement 全套测试；实机看卡墙、换装、翻转。

#### 18. 统一碰撞查询

- **现状**：地形格子、实体碰撞盒、内容机关、Phaser 物理体各自参与判定，卡墙补丁和特殊分支多。
- **怎么改**：做一个“能不能站 / 能不能过 / 能不能落”的统一查询和空间索引；所有移动、寻路、落点、卡墙检查走同一入口。是否改成格子制或 Tilemap，另开方案。
- **好处**：规则少一套，bug 少一类；长期可维护性更好。
- **风险**：大工程，牵涉移动、寻路、技能、剧情、测试；不要和性能优化混在一起做。
- **建议**：先写“碰撞契约”，再决定是否重构。

---

## 3. 第一项的实现草案（物理步采样）

### 3.1 当前调用链

1. `MovementWorld` 在 `worldstep` 事件调用 `settleStep`。
2. `settleStep` 遍历全部 registrations，对启用的 body 调用 `body.settleStep()`。
3. 然后调用 `interpolation.completeStep(delta * 1000 * timeScale)`。
4. `completeStep` 遍历 `samples`：`sample.position()` 新建点；更新 `previous/current`；维护 `moving`。
5. `PRE_RENDER` 的 `apply()` 只遍历 `moving`；`RENDER` 的 `restore()` 只遍历 `restoredPositions`。

### 3.2 建议改动

> **复核约束：**以下伪代码已修正停步分支。仅在首次注册时判断 `movable` 仍不完整；重复注册会切换角色的可移动状态，必须同步维护采样成员和深度更新成员。详见第 9.2 节。

1. `MovementWorld.register`：
   - 只有 `movable` 为真时调用 `this.interpolation.register(...)`。
   - 静态角色仍然 `navigation.register`、`physics.world.add`、`group.add`，碰撞不变。
   - 静态角色在注册/落位时设置一次深度。
2. `MovementBody`：
   - 新增 `footPositionInto(out: Point): Point`，写入 `out` 并返回。
   - `footPosition()` 保持原样，内部调用 `footPositionInto({x:0,y:0})`，兼容现有调用。
3. `MovementInterpolation`：
   - `MotionSample` 新增 `positionInto(out: Point): Point`；`register` 时保存。
   - `completeStep` 使用一个共用 `scratch = {x:0,y:0}`。
   - 伪代码：

```ts
const scratch = { x: 0, y: 0 };
for (const [visual, sample] of this.samples) {
  sample.positionInto(scratch);
  const x = scratch.x, y = scratch.y;
  if (!sample.enabled()) {
    sample.previous.x = sample.current.x = x;
    sample.previous.y = sample.current.y = y;
    this.moving.delete(visual);
    continue;
  }
  if (x === sample.current.x && y === sample.current.y) {
    // position() 也会读取 previous；停步后必须收敛到当前点。
    sample.previous.x = x;
    sample.previous.y = y;
    this.moving.delete(visual);
    continue;
  }
  sample.previous.x = sample.current.x;
  sample.previous.y = sample.current.y;
  sample.current.x = x;
  sample.current.y = y;
  this.moving.add(visual);
}
```

### 3.3 边界情况

- **第一次采样**：`register` 已把 `previous/current/saved` 初始化到当前脚点。
- **角色停下**：位置不变的那一步从 `moving` 移除；`apply` 不再插值，直接使用当前位置。
- **角色重新移动**：第一步位置变化时 `previous = 上一次 current`，插值从原位开始，不会跳。
- **禁用/重新启用**：禁用时仍同步 `previous/current` 到当前脚点；`setEnabled` 还会 `interpolation.reset`，避免重新显示滑一段。
- **瞬移/落位**：`place`/`placeAll`/`placeContent` 调用 `interpolation.reset`，静态和动态都会清理 `moving`/`restoredPositions`。
- **静态角色被直接改坐标**：没有采样，插值不会移动它；如果直接改容器 y，深度可能过期。所有现有落位都走 place 系列，复核是否有例外。

### 3.4 测试建议

- `tests/movement.test.ts`：现有插值/追赶/重置用例。
- `tests/movement-world.test.ts`：注册、碰撞、放置、深度。
- `tests/movement-content-recovery.test.ts`：内容机关卡住自愈。
- 新增用例：
  1. 注册一个 `movable=false` 的静态角色，断言 `samples` 不包含它。
  2. 注册一个 `movable=true` 的角色，推进一步并改坐标，断言插值位置正确。
  3. 位置不变时，断言 `moving` 不包含它，且不会新建坐标（可通过注入计数验证）。
  4. 禁用→启用后，断言不产生滑步。

---

## 4. 不要动的部分

- 不改 Phaser 物理体大小、碰撞盒形状、脚点偏移。
- 不改 `terrainFree`、`constrainTerrain`、`blockedByContent` 的判定语义。
- 不改 `settleStep` 的卡墙/内容回退逻辑（第一、二批不动）。
- 不改战斗逻辑帧 60ms、A* 512 节点预算、流场 3 请求/200ms 门槛。
- 不改特效池、伤害数字池、冷却绝对截止帧。
- 不改剧情触发、存档、云存档。
- 不在性能改动里顺手重写碰撞架构。

---

## 5. 已知不确定点

1. `performing` 是暂时没接上，还是已经不需要？代码没有注释；测试会手动设 true。
2. 进图检查点重复抓取是否是有意“先抓一次、空闲后再刷一次”？没有注释或测试说明。
3. `movable` 是否等价于“需要插值”的完整判据？当前所有会随物理步改变位置的演员都是 `movable=true`，静态内容都是 `false`；未来新增会移动但不该插值的单位需要重新评估。
4. 静态角色是否存在 `place` 系列之外的直接坐标写入？当前 grep 未发现剧情舞台直接改 `container.x/y`，但复核应覆盖全部入口。
5. 快捷栏两次 `paint` 是否能在不改变 HUD 顺序的前提下合并？需要看 `controls` 和 `skillHud` 的更新时序。
6. 滚动合并到 rAF 后，跟手程度是否可接受？需要实机体验。
7. 网格分桶的尺寸（16/32px）和交互/机关范围是否匹配？需要按 `nearInteractive`、碰撞盒大小和商店柜台间距校准。

---

## 6. 复核清单

以下问题已逐项核查，答案与限制见第 9 节；勾选表示核查完成，不表示原方案全部通过。

- [x] `MovementWorld.register` 是否真的对静态角色也调用 `interpolation.register`？所有调用点的 `movable` 参数是什么？
- [x] `completeStep` 是否真的先 `position()` 再 `enabled()`？`position()` 是否每次新建对象？
- [x] 把 `movable=false` 的角色排除出插值表，是否会影响任何画面/剧情/战斗表现？
- [x] 静态角色是否全部通过 `place`/`placeAll`/`placeContent` 落位？有没有直接改 `container.x/y` 的路径？
- [x] `syncDepth` 是否只影响深度？静态角色深度是否已在落位时写对？
- [x] `performing` 在生产代码中是否真的只写 `false`？测试里的 true 是否只用于夹具？
- [x] 检查点重复抓取是否真的会发生？哪些条件会阻止第二次？
- [x] 队伍签名是否只在可控战斗帧执行？`activeIds` getter 是否每次新建数组？
- [x] 交互扫描、AI 候选扫描、内容机关扫描的触发条件和频率是否与文档一致？
- [x] 第一批 1-6 项是否有任何一项会改变碰撞、寻路、技能落点或战斗节奏？
- [x] 第二批 7-16 项的缓存/分桶方案是否遗漏了失效条件（换页、缩放、注册/注销、状态变化）？
- [x] 第三批 17-18 是否应该继续延后？

---

## 7. 验收命令

按改动范围选择：

```bash
npm test -- tests/movement.test.ts tests/movement-world.test.ts tests/movement-content-recovery.test.ts
npm run typecheck
```

如果改了快捷栏、Buff、AI、名册，再补对应测试。按项目规则，验证不主动启动浏览器；界面和实机效果交给用户验收。

---

## 8. 一句话总结

先做不改变行为的小范围优化；采样减少分配的方向成立，但缩小采样集合前必须补齐第 9.2 节的状态切换和停步读数约束。后面的清单按复核后的优先级逐条做，每条单独提交、单独验证。

---

## 9. 代码复核结论（2026-11-16）

### 9.1 范围、结论与逐项判定

核查基线为 `main` 的 `1d13f42`；开始时游戏源码没有未提交改动，本文档是未跟踪文件。通过 Serena 按符号读取实现、调用入口与引用，核查第 2 节全部 18 项及相关限制条件。本次只修改本文档，保留它供后续实施参考。

**代码能证实重复工作存在，不能单凭它断定这些工作已经造成明显掉帧。** “少创建对象”“少循环”“少调用样式赋值”是可确认的优化方向；GC（临时对象回收）停顿、浏览器实际重排次数、安卓帧率提升和各项收益排序均未实测。同值样式赋值也不等于浏览器一定重新排版。

下表“现状”评价原始问题描述；“方案”单独评价是否能按原文执行。路径相对仓库根目录，行号对应本次基线，后续优先按符号定位。

| 项目 | 现状判定 | 方案判定与实施约束 | 主要代码证据 |
|---|---|---|---|
| 1. 插值采样 | **CONFIRMED**：静态角色同样登记，先取位置再查启用，每次 `footPosition()` 都新建点。 | **原草案不完整**。复用输出坐标合理；排除静态角色必须处理重复注册和移动意图。原停步分支存在读数错误，见 9.2。 | `src/rendering/movement-world.ts:56` `register`；`movement-interpolation.ts:34` `completeStep`；`arcade-movement.ts:68` `footPosition`。 |
| 2. 静态深度 | **PARTLY WRONG**：全表遍历存在；静态对象反复标脏不存在，已有深度比较。 | 只减少遍历合理；需动态维护会移动的角色集合，注册、落位和角色替换时写深度。与第 1 项一起核对生命周期。 | `src/rendering/movement-world.ts:255` `syncDepth`；`:135` `placeContent`；`:145` `placeAll`；`characters.ts:130` `createCharacter`。 |
| 3. 隐藏按钮复位 | **CONFIRMED**：隐藏调用每次复位门控和 8 个按钮。 | 合理，缓存放在每个 `DomActionControls` 实例里；首次隐藏也要复位，保留外部主动 `resetInput()`。不要只在场景摘要里缓存，否则换图新控件可能漏隐藏。 | `src/ui/dom/action-controls.ts:153–154`；`src/ui/dom/components.ts:176` `reset`；`src/scenes/world-scene.ts:2318` `syncHud` 的重建说明。 |
| 4. 提示透明度 | **CONFIRMED**：可见时每帧调 `setStyle`，它直接赋样式。 | 合理但收益范围小。缓存随标签重建清空，保持新提示、隐藏后再显示和淡出行为。 | `src/scenes/formal-ui-scene.ts:156` `syncInstantMessage`；`src/ui/dom/dom-ui.ts:125` `setStyle`；`src/ui/instant-message.ts:23`。 |
| 5. 队伍签名 | **CONFIRMED**：可控帧反复创建两个数组并拼字符串。 | 方向合理，属于小分配优化。缓存上阵成员顺序并覆盖创建、移除、上阵、换位、预备队、读档/回滚；切换操控者不改变 `activeIds`。失败重试必须独立保留，见 9.4。 | `src/scenes/world-combat.ts:3330`、`:2379` `syncAllies`；`src/domain/party.ts:257` `activeIds`。 |
| 6. performing / 检查点 | **CONFIRMED**：生产代码没有设 `performing=true`；首次抓取后重新置待抓取也存在。 | 两件事分开处理。死字段可在核对读者与测试后清理；不要凭字段名补一个 `true`。检查点需确定保留哪个时刻的状态，不能只靠注释解释重复。见 9.5。 | `src/scenes/world-scene.ts:190`、`:288`、`:777`、`:2031`、`:2439`；测试里确有 `performing=true`。 |
| 7. 对白打字机 | **CONFIRMED**：等待点击时仍先执行 `typedIndex` 才判断显示完毕。 | 缓存当前页的可见文字/长度合理；先做这一层即可。“只改新增的文字片段”是后续独立优化。保留控制码、换行、代理对字符和点击补全文字的语义；换页、重排时失效。 | `src/ui/game-ui.ts:163` `tick`、`:202` `reflowDialogue`；`src/domain/text-markup.ts:92`；`src/ui/dialogue-text.ts:93`。 |
| 8. 拾取提示 | **CONFIRMED**：每条活动提示每帧投影并写两项样式。 | 比较最终屏幕坐标与显隐后再写合理。不能只比较人物位置：镜头、缩放、边缘避让和提示自身上浮都会改变结果。投影仍需执行；只有坐标相同时才省掉字符串和写入。 | `src/rendering/pickup-messages.ts:78` `show`、`:109` `position`、`:122` `update`。 |
| 9. 小地图点 | **CONFIRMED**：每次生成投影点与字符串，已有跨格才写的保护。 | 合理但收益小。只把字符串键改成两个数字仍会保留投影对象；要达到原文“无两个对象”的目标，还需直接计算数值或复用输出对象。布局变化和点节点重建时重置缓存。 | `src/ui/dom/minimap.ts:72` `project`、`:84` `updatePlayer`。 |
| 10. 遭遇完成检查 | **CONFIRMED**：可控且导演空闲时每渲染帧过滤活动遭遇，逐生成点读取状态。 | 优先按状态变化重新判断。若只按 60ms 时钟判断，会漏掉暂停期间的状态变化，至少还要在恢复控制、读档、遭遇变化和死亡结算后失效。通过规则允许后才能接受延迟。 | `src/scenes/world-scene.ts:2441`；`src/domain/world-enemies.ts:204` `completedEncounters`。 |
| 11. 附近交互 | **CONFIRMED**：位置或相关修订变化才全扫，已有缓存，无附近查询。 | 分桶合理，但按碰撞盒覆盖范围登记，保留宝箱/古剑 24px、柜台距离、最近距离、优先级和完全相同时的原列表顺序。固定“附近几格”不足以覆盖大实体。 | `src/scenes/world-scene.ts:2382` `updateInteractionTarget`，尤其 `:2411–2418`。 |
| 12. 内容机关 | **CONFIRMED**：`blockedByContent` 逐个读取内容实体；命中时提前返回，并非每次必读完整表。 | 方向合理，需索引整个碰撞盒。注册/注销/用途变化之外，落位、翻转、外观碰撞盒变化也要更新；显隐、ghost 和阵营继续实时过滤。`refreshActor` 目前只改集合成员，不能直接当位置索引刷新。 | `src/domain/navigation-world.ts:139`、`:233`；`src/rendering/arcade-movement.ts:109` `settleStep`。 |
| 13. 名册与 AI 候选 | **PARTLY WRONG**：属性快照线性查找、AI 扫描成立；`hasZeroHealth` 线性查找及据此推导的候选构建平方级成本不成立。 | 拆成名册索引、属性缓存、AI 查询三个改动。不能只按逻辑帧缓存当前血蓝；不能用统一附近半径替换所有候选。见 9.3。 | `src/domain/enemy-roster.ts:51`、`:67`；`src/domain/combat-actor-lookup.ts:4`；`src/scenes/world-combat.ts:920`；三个 AI 控制器。 |
| 14. Buff 持续特效 | **CONFIRMED**：非空特效列表会反复分配 Set、数组、键；已有帧龄和层序比较。 | 复用临时容器合理。只在状态版本变化时重建“有哪些特效”可行，动画帧仍需随 `frameAge` 推进；还要检测视觉对象替换、被销毁的特效、图层顺序与资源就绪。见 9.6。 | `src/rendering/buff-loop-renderer.ts:17` `sync`。 |
| 15. 快捷栏重复刷新 | **CONFIRMED**：一个渲染帧推进战斗后，可能先 `setCooldowns` 再 `setShortcutPage`；内部有状态比较。 | 合并数据提交合理，收益主要是省小循环与签名。必须同时覆盖触摸栏与键盘 HUD，以及换人、换页、背包等事件即时刷新；不能把所有刷新都拖到战斗时钟推进后。 | `src/scenes/world-combat.ts:3366`；`src/scenes/world-scene.ts:1245`、`:1267`、`:2008`；`src/ui/dom/action-controls.ts:99–100`。 |
| 16. 滚动/拖动 | **CONFIRMED**：部分面板滚动有两次文字刷新入口；移动拖动解析布局两次，缩放调完整布局。 | 先删同一次事件的重复刷新，再考虑每帧合并。保留滚动回调中的偏移保存、隐藏详情等行为；拖动结束前提交最后坐标，取消/销毁时清掉待处理任务。无需先加入一套常驻帧循环。 | `src/ui/dom/surface.ts:147`；`src/ui/story-ui.ts:873`；`src/ui/dom/menu-text.ts:331`；`src/ui/phaser/control-layout-editor.ts:208`、`:343`；`src/ui/control-layout.ts:179`。 |
| 17. 移动临时对象 | **CONFIRMED**：脚点、约束子步、形状查询存在分配；有静止内容体提前返回。 | 继续放后面。输出对象复用与形状缓存分开做，`stepStart` 要独立保存；形状缓存覆盖外观替换、碰撞盒和翻转。不能复用正在被路径搜索快照持有的可变对象。 | `src/rendering/arcade-movement.ts:68`、`:76`、`:109`；`src/rendering/movement-world.ts:67`；`src/domain/navigation-world.ts:493`。 |
| 18. 统一碰撞查询 | **UNVERIFIED（收益）**：多类判定存在，但这本身不能证明架构有缺陷或统一后更快。 | 延后合理。脚点地形、整盒落位、内容障碍和动态单位分离有不同规则；先列各入口契约及行为用例，再讨论共享实现，不把不同规则强行合成同一种阻挡判定。 | `MovementBody.update/settleStep`、`MovementWorld.placeAll`、`NavigationWorld.blockedByContent` 及 `src/domain/AGENTS.md` 的位移/落位约束。 |

### 9.2 采样方案的两个必要修正

**一是停步后所有坐标读者都必须看到当前点。** 原第 3.2 节在坐标没变时直接移出 `moving` 并 `continue`，留下旧 `previous`。但 `MovementInterpolation.position()` 不检查 `moving`，仍用 `previous/current` 算显示坐标。于是角色本体停在当前位置，选中圈和拾取提示仍可能读取上一步的位置。

用纯 Node 小探针检查了“从 x=0 走到 x=10，再保持 x=10 一步”的情况：现实现返回 **10**；原草案在插值比例为 0 时返回 **0**。这是可复现的方案回退，不是帧率推测。第 3.2 节已补上停步时 `previous=current`；真实实现还必须保留原方法开头的 `stepMs` 和 `remainingMs` 更新。也可以让 `position()` 在不属于 `moving` 时返回当前点，但那是另一套需要验证的完整方案。

**二是 `movable` 不是首次登记后永远不变。** `MovementWorld.register` 已有对象分支会 `setMovable` 后直接返回。`StoryStageScene.ensureActors`（`src/scenes/story-stage-scene.ts:233–274`）会按最新剧情绑定重新登记同一个视觉对象。只在新建分支里写 `if (movable) interpolation.register(...)`，会漏掉静态转可移动，也无法清掉可移动转静态的采样。

已核对登记入口：正式世界主角为 true，地图内容为 false；队友为 true；敌人与友方召唤物取 `definition.behavior.canMove`；舞台演员取当前是否被剧情绑定，且会重复登记。移动体 `update` 本身还允许 `movable=false` 但有 `intention` 时移动；`StoryPresenter.walk` 通过 `walkTo` 写移动意图。因此实现时应把“角色会通过哪些入口移动”作为完整约束，不能仅凭初始布尔值推断终身静止。

创建角色以及 `place`/`placeAll`/`placeContent` 都会设置深度；未发现生产角色容器在这些移动机制之外直接赋 `container.x/y` 的业务路径。搜索到的其他 `container.setPosition` 属于伤害数字和头顶状态。**这只能排除一种风险，不能替代对物理移动、剧情绑定切换和移动意图的检查。**

最小行为验证应包含：静止后的 `displayPosition` 与角色一致；静态→动态→静态切换；剧情行走；暂停/启用；瞬移后不拖尾；上下移动时遮挡正确。原文只断言私有 `samples`/`moving` 集合的用例不足以覆盖这些回退。复用坐标也只消除采样的点对象，不能承诺整个物理步零分配。

### 9.3 名册和 AI：真实成本及方案边界

`EnemyRoster.hasZeroHealth` 直接查 `Set`；`combatActor` 按数组身份复用 `Map`；`combatants()` 按 `combatTick + conditions.revision` 复用数组。**第 13 项中“为每个敌人线性查死亡状态，导致构建候选 O(N²)”这一具体断言为 WRONG。** 多个 AI 各自遍历候选仍可能带来平方级工作量，但那是另一个调用链，不能混作已证实的构建成本。

`enemySnapshot` 的 `find + calculateEnemy + Object.freeze` 确实每次执行；`setEnemyHealth`、`setEnemyMana` 也有 `find`。增加名册索引合理，但必须同步 `placeEnemy`、`restoreEnemy`、`removeEnemy` 和整份 `restoreState`。缓存建议把相对稳定的派生属性与当前血蓝分开：属性键需含定义、等级、精英标记、队伍人数、玩家/场景等级与召唤覆盖属性；血蓝必须反映本逻辑帧中前一次命中的结果。只用 `combatTick` 缓存完整快照会在同一帧连续命中/治疗时读旧值。

AI 分桶是范围预筛，必须保留以下规则：

- 敌人存在 `engagement='map-wide'`（全图警戒）。`needsFrame()` 对它始终返回真，因此“空闲敌人都是 300ms 一次”也不成立；警戒判定还对距离除以 8 后向下取整，查询边界应覆盖原判定接受的全部位置。
- 敌人完整决策才遍历候选；`EnemyController.tick` 在接近、攻击、回家等路径可能提前返回。“接战后每 60ms 必扫一遍”不成立。
- 队友 `withinLeash` 同时允许“自身攻击距离内”或“队长周围范围内”的目标；不是只有自身附近一圈。`nearestThreatTarget` 还从完整候选收集友方 ID，用来判断敌人是否正在打队友。若把候选一并裁小，可能连受攻击的队友身份都丢掉。
- 友方召唤物以主人为中心判断 128px 协战范围和 192px 已承诺目标范围，并维护主人目标、集火目标和当前目标优先级。按召唤物自身位置查几个桶会改变选敌结果。
- 保留原候选顺序及距离相等时的选取规则。不要把 AI 专用附近查询直接替换掉技能、表现和治疗等共用的全量 `combatants()` 接口。

因此名册索引可以先做；属性缓存需明确失效条件；AI 分桶应按三种控制器分别设计查询契约，不宜作为一个“中等风险”的统一改动直接落地。

### 9.4 队伍与遭遇缓存的失效条件

队伍版本应表示**上阵 ID 和顺序变化**。`create/remove/deploy/reserve/restoreState` 是直接改槽位的入口，招募、剧情入队/离队通过这些入口处理。现有 `groupModifierVersion` 不适合直接替代：`deploy/reserve` 没有推进它，而装备等变化又会推进它。缓存数组需保持只读使用，避免把原来“每次返回新数组”的隔离行为悄悄改成共享可修改数组。

`syncAllies` 会在资源加载失败或加载期间技能变化时清空 `partySignature`，并设置 100/1000ms 后重试；这时队伍成员可能完全没变。改成版本判断后，仍需保留显式“待同步/重试”状态。切换操控者已有 `controlledId !== syncedControlledId` 路径，不能用成员版本代替它。

遭遇完成判断读取的不是单纯“敌人血量为零”，而是 `deadUntil !== undefined && !capture`。应在死亡结算、捕获、遭遇增删和恢复状态时使缓存失效，并保留导演忙时暂缓、恢复空闲后继续交付结果的行为。现有活动遭遇索引已经避免遍历全部历史遭遇；本项优化的是活动集合的重复过滤。

### 9.5 performing 与检查点的处理结论

生产代码 `performing` 只有初始值和 `init` 重置为 false，测试中的 true 是人工夹具。**死字段事实成立，但“补上 true”不是无害修复**：读者会影响输入、显隐、战斗暂停和检查点。若清理，应一起核对 `canControl`、舞台遮挡、导演忙碌状态与相关测试，单独提交，不和采样优化捆绑。

检查点重复在以下条件下成立：进图时没有检查点、首次 `captureCheckpoint()` 成功，随后 `checkpointPending` 被设回 true；后续可控制、没有演出、导演空闲、战斗允许抓取，并且内部各项条件继续满足。第二次会再次 `settleForSnapshot` 并捕获完整状态，不只是覆盖标记。

压力模式、调试暂停保存、世界未就绪、无人存活、已有检查点且剧情正等待战斗结果、首次捕获失败，以及剧情接管期间重新抓取等都会影响结果。代码可以证明存在重复路径，**不能证明第二个时间点的快照一定多余**。合理修改是先确定“立即兜底”与“恢复控制后基线”是否都需要；若只需一次，则仅在首次未成功时保留待重试。用同一个方法封装顺序，避免再次出现抓取成功后无条件置回 true。

### 9.6 其他结论的补充与限制

- **Buff 缓存分两层。** 特效成员列表可以等状态变化再重建；帧龄变化、人物层序变化、特效被销毁和资源后来就绪仍需处理。当前代码已跳过相同帧的 `setCurrentFrame` 和正确层序的重排，复用容器主要省分配。临时 Set/数组若一次 `sync` 用完、不会被保存且不可重入，也可以清空后跨角色复用；原文“不能跨角色共享”过于绝对，不能共享的是会被各角色长期持有的可变结果。
- **交互频率没有代码硬限 60 次。** `afterMovement` 在 `POST_UPDATE` 调用，位置/修订没变就返回；60Hz 物理移动下通常至多约 60 次位置驱动扫描，另外还存在交互事件和状态修订驱动的扫描。分桶优化需继续保留这层缓存。
- **拾取提示约 20 条是常规连续播放估算。** 32 是排队加活动总上限，120ms 间隔和 2400ms 动画支持约 20 的估算；暂停等时序会改变分布，20 不是硬上限。
- **摇杆布局读取成立，但需限定事件。** 持有同一指针且 `buttons !== 0` 才调用 `local()` 读矩形。读矩形并不自动证明发生强制同步布局；缓存矩形要覆盖画框变化、模式切换和拖动期间的页面偏移。
- **软键盘路径已有事件合并。** `main.ts:101–112` 通过一次待执行的动画帧回调合并 resize/scroll，并在输入聚焦时保持画布尺寸；回调内仍调用 `scale.refresh()`、对白重排和 DOM 布局。正式 UI 的 resize 处理确实清签名并重建，适合按实际尺寸/位置变化进一步区分；不能把所有键盘事件当成画布尺寸变化，也不能直接删掉必要的位置跟随。
- **出口闭包的限制只适用于已设置进入保护的出口检测。** `ExitTrigger.update` 在 `guarded` 分支走满 80px 才创建 `find` 回调；非 guarded 分支每次调用都执行 `find`。本轮确认两种实现都存在，因此原描述应带上 guarded 前提。
- **第 1.3 节用来排除错误优化方向，不能理解成整套系统完全不逐帧工作。** 例如特效创建由命中事件触发，但动画/补间仍推进；自动保存 300 秒是周期请求，进图等事件也会请求；相机开始跟随是事件，跟随本身逐帧运行。活动遭遇、候选快照、表现缓存等现有保护应保留。
- `activeAppearances()` 两次调用与 `setLayerVisible('world', ...)` 两次调用不等于重算/写入两次：前者利用状态缓存，后者有值比较。本轮没有发现需要仅为调用次数重构它们的依据。

### 9.7 实施顺序与验证记录

建议先做第 3、4、7、9 项，以及第 16 项中删除重复刷新入口的部分；这些范围小、行为边界清楚。第 1 项先做输出坐标复用，再处理采样成员切换和第 2 项深度遍历；第 5 项补足重试状态后再做。第 11、12、13 项的空间查询需要先固定选择范围、索引更新与同距离顺序。第 6 项单列行为清理，第 17、18 项继续延后。这个顺序依据改动风险与代码成本，不代表已测得的帧率收益排名。

本次验证：

- 已逐项读取上述生产符号与关键调用链，检查现有缓存、提前返回、重复登记和状态恢复入口。
- 已运行无浏览器的 Node 最小探针，确认停步场景下现实现显示坐标为 10、原采样草案为 0；未产生临时文件。
- 只改 Markdown，因此未跑类型检查、游戏测试或构建；没有启动浏览器、服务器、部署或 APK 验收。18 项建议均未实施到游戏代码。
- 第 6 节的 12 个问题已在本节回答；“核查完成”不表示方案全部通过。实机收益、滚动手感、窗口变化效果以及统一碰撞架构的收益仍为 **UNVERIFIED**。

后续实施第 1 项时，除原列 movement 用例，还应覆盖 `tests/target-focus-world.test.ts` 与剧情舞台移动相关用例，重点检查“角色停下后选中圈和提示不回到旧位置”“同一演员改为可移动后仍平滑移动”。
