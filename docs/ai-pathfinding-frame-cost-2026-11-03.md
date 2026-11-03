# AI 与寻路：逐问题的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。每个问题单独成案，各自带代码证据、慢的原因、改法、风险和验证方式。

## 一句话结论

不是内存泄漏。是**每干一件事的单价跟着场上人数一起涨**：寻路每走一格都要问「这个点站得住吗」，这一问要遍历全场角色；敌人每逻辑帧还要扫一遍全场候选。人数一多，同样的工作量就翻倍，于是同一帧里的固定开销把帧预算吃穿。

## 卡顿是怎么被放大的

1. 单个单位的开销随人数涨（`O(角色数)`、`O(角色数 × 仇恨表)`）。
2. 寻路预算全场共享且固定（每渲染帧 512 格），人一多，每人分的格子变少，搜索迟迟算不完。
3. 搜索没算完的单位，每逻辑帧都要走一遍"直线能不能过去"的实时判定（`straightWalkable`），又回到第 1 条。
4. 一帧超时后，补帧上限 `Math.min(delta,120)` 只补 2 个逻辑帧（逻辑帧 60ms），补不完的积压让下一帧更重，回不到 60fps。

第 2、3 条是"越玩越卡"的关键：**它让成本从"线性"变成"自我强化的正反馈"**。

## 已排除的累积型泄漏

逐项核过，都有硬上限或及时释放，不是本次原因：

| 容器 | 上限或释放时机 | 出处 |
|---|---|---|
| 仇恨表 `records` | `THREAT_CAPACITY = 256`，满了淘汰最旧 | `src/domain/combat-threat.ts` |
| 战斗任务表 `tasks` / `actions` / `flights` | 按 id 存在 Map，完成即删 | `src/domain/combat-runtime.ts:97-132` |
| 敌人清理 | `destroyEnemy` 依次摘除冷却、仇恨、目标、控制器、表现、导航、资源 | `src/scenes/world-combat.ts:644-650` |
| 召唤物 | 召唤者死亡全清，另有到期移除 | `src/scenes/world-combat.ts:621` |
| 动画 | `anims.create` 同名 key，后写覆盖前写 | `src/rendering/characters.ts:131-138` |
| 伤害数字 / 命中特效 | `effect.once('destroy', …)` 自我摘除 | `src/rendering/combat-feedback.ts:93` |
| 队友相关缓存 | 全部按队员 id 存取，离开即删 | `src/scenes/world-combat.ts:2243-2257` |
| `enemyStates` | 换图、重生、捕捉时删除或覆盖 | `src/domain/session.ts:96-101`、`:117-119`、`:556` |

## 每帧的账（后面每节都引用这组数）

- 展开预算全场共享，每渲染帧 512 格：`PATH_BUDGET_PER_RENDER_FRAME = 512`（`src/scenes/world-combat.ts:156`），每渲染帧开头重置（`:2741`）。
- 一次展开最多对 8 个邻居调 `canTraverse`；每条边按 4px 采样，直边 2 次 `canStand`、斜边 4 次（`src/domain/pathfinding.ts:28-38`）。平均每次展开约 24 次 `canStand`。
- 每次 `canStand` = 查地形 + 新建一个矩形（`collisionAt`）+ **遍历全部角色做矩形相交**（`blockedByActors`）。
- 于是每渲染帧约 1.2 万次 `canStand`；同屏 40 个角色时约 **48 万次矩形相交**，60fps 下约 2900 万次/秒。
- 同时每渲染帧产生约 2 万个临时对象、上万条 `"x,y"` 字符串。

---

# P1 站得住判定要遍历全场角色

**证据**

- `blockedByActors` 拿到 `this.actors`（`Set<NavigationActor>`）后逐个取 `shape()/enabled()/position()` 做矩形相交 —— `src/domain/navigation-world.ts:145-158`
- `canStand` = `terrainFreeAt` + `collisionAt` + `blockedByActors` —— `src/domain/navigation-world.ts:165-170`
- 每次 `collisionAt` 都新建一个 `GameRectangle` —— `src/domain/navigation-world.ts:52-55`

**为什么慢**

这是**唯一的 `O(角色数)` 项**，而且被调用的次数最多（每渲染帧上万次）。40 人 = 每次约 40 次矩形相交，全场每帧就是几十万次。人数翻倍，这一项直接翻倍——这正是"人越多越卡"的来源。

**方案**

把「人物占位」预计算成一张格子表，查询从"遍历人"变成"查一个字节"：

1. 按寻路网格（8px）或更细（4px）建一张 `Uint8Array`，记录每格被谁占着（存角色下标 +1，0 表示空）。
2. 每个逻辑帧（不是渲染帧）重建一次：清空上一帧写过的格子（只清写过的，不做整表 fill），再把每个角色的碰撞盒按 4px 判定半径**膨胀**后写入覆盖的格子。
3. `canStand` 只查这张表。

**关键点**：不能用"圆心落在格子里"近似，否则和现在的逐点判定不等价。必须按角色碰撞盒 + 4px 半径算出要涂的格子范围，保证"点到矩形距离 ≤ 4px"的格子都被涂上。

**风险**

- 中。判定改错会出现"能穿人""卡住不动"，所以必须配一条逐点对比测试（见下）。
- 格子尺寸 4px 时，全图约 200×230 ≈ 4.6 万格，`Uint8Array` 46KB，重建遍历每个角色的覆盖格，代价是 `O(角色数 × 每角色格数)`，比现在的 `O(查询次数 × 角色数)` 小两三个数量级。

**验证**

- 单元测试：随机撒 N 个角色和 M 个采样点，新旧两种判定逐点比对，要求 100% 一致（`tests/` 下新增，N=40、M=2000）。
- 手测：走进怪堆、被围、卡墙角，确认不会穿模。

**收益**

每渲染帧省掉约 48 万次矩形相交（40 人时），并且把这一项从"随人数涨"变成常数。

---

# P2 冻结快照每次重寻路都深复制整张地图

**证据**

- `captureStandability(actor)` 每次都 `{...this.terrain, blocked:[...this.terrain.blocked]}`，再遍历全部角色建 `occupied` 数组 —— `src/domain/navigation-world.ts:107-122`
- 敌人每次发起/重发搜索都调它 —— `src/domain/enemy-ai.ts:386-396`（`searchQuery` 里的 `port.navigationSnapshot?.()`）
- 行走路线也调 —— `src/domain/walk-route.ts:43-61`

**为什么慢**

`blocked` 最大约 2800 个布尔值，每个敌人每次重寻路复制一遍。不是为了省时间，反而制造垃圾：这些数组活不过一次搜索。

**方案**

快照不再复制数组，改成"引用 + 版本号"：

- 地形数据（`terrain.blocked`）在整张地图生命周期内不变，直接引用，不复制。
- 人物占位改成引用 P1 的格子表版本号（`navigationEpoch`）。搜索期间不动它，搜索开始时记下版本号即可。

**风险**

低。语义不变（快照本来就是"搜索期间冻结"），只是不再物理复制。

**验证**

- 现有寻路相关单元测试全绿。
- 加一条断言：一次搜索期间快照的 `blocked` 与地图数据是同一个引用。

**收益**

每次重寻路少一次 2800 元素的数组复制 + 一次 `occupied` 数组构建。

---

# P3 A\* 内层每帧产生两万个临时对象和上万条字符串

**证据**

- 每次展开都新建邻居表：`[[0,-1],[-1,0],[1,0],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]].map(...)` —— `src/domain/pathfinding.ts:86-90`
- 对角检查再新建两个点对象 —— `:93`
- `canTraverse` 每步新建 `point` 和 `previous` 两个对象 —— `:28-38`
- 缓存键是浮点字符串 `` `${point.x},${point.y}` `` —— `:44-48`
- 节点键也是字符串 —— `:62`；节点对象入堆时新建 —— `:97`

**为什么慢**

每条边 4~10 个对象，每次展开 8 条边，512 次展开 ≈ **每渲染帧 2 万个对象**，外加 `standability` 表里上万条字符串键。这些全部立刻变成垃圾，GC 频繁触发，表现是"一顿一顿"的周期性掉帧——和"越玩越卡"的手感高度吻合。

**方案**

分两小步，第一步纯去垃圾、行为完全等价：

1. **邻居表提到模块级常量**，展开时复用，不再 `.map`。
2. **`canTraverse` 不建对象**：改成传数字 `(fromX,fromY,toX,toY, canStand)`，或用两个模块级暂存对象。`canStand` 的回调签名也改成收 `(x,y)` 而不是对象。
3. **`standability` 缓存换成按格索引**：网格尺寸已知，用 `Int8Array(width*height)`，索引 `gy*width+gx`。命中判断从"字符串哈希"变成"数组下标"，也不再产生字符串。
4. 节点对象也换成下标 + 平行数组（`costs: Float32Array`、`parent: Int32Array`），彻底不建对象。

**风险**

- 第 1、2 步：低，纯等价改写。
- 第 3、4 步：中。要小心 `costs` 的"同一节点多次入堆、靠比较跳过过期项"逻辑（`src/domain/pathfinding.ts` 里 `current.cost!==costs.get(current.key)` 那段）在改成数组后仍然成立。

**验证**

- 新增等价性测试：固定若干起点/终点/地图，新旧实现返回的路径**逐点相同**（不是"差不多"）。
- 手测：长距离寻路（跨图对角）不卡。

**收益**

每渲染帧少 2 万个对象、上万条字符串。这一项大概率能把 GC 引起的周期性顿帧消掉。

---

# P4 寻路预算全场共享且固定，人一多就集体卡在"搜索中"

**证据**

- 预算对象：`new PathBudget(PATH_BUDGET_PER_RENDER_FRAME)`，512 格/渲染帧 —— `src/scenes/world-combat.ts:156`、`:206`
- 每渲染帧开头 `pathBudget.reset()` —— `:2741`
- 所有敌人和队友从同一个预算里 `take()`，先到先得 —— `src/domain/enemy-ai.ts:404-425`、`src/domain/party-ai.ts:339-351`、`src/domain/walk-route.ts:64-87`
- 路径为空时一次要 1024 格（`HOLD_SEARCH_CAP`），比整份预算还大 —— `src/domain/enemy-ai.ts:62`

**为什么慢**

这不是"每次调用更贵"，而是**设计上的饥饿**：10 个单位同时寻路，第一个就可能吃掉 512 格里的大部分，后面的排队；搜索拖得越久，越多的单位停在没有路径的状态，于是每逻辑帧都去跑"直线能不能过去"（P5），成本又回来了。**这是"越玩越卡"的正反馈来源。**

**方案**

三选一或组合，需要拍板（见文末）：

- **A. 按人头分预算**：`take()` 改成"每人每帧最多 N 格"（比如每人 64），总量再设上限。保证所有人都在推进，不会有人被饿死。
- **B. 排队制**：维护一个待搜索队列，每帧取前 K 个，给足预算算完再换下一个。同屏只有一个人在算，单帧最坏情况可控。
- **C. 首帧给足**：搜索的第一帧给较大预算（如 256），之后每帧给小额。让常见的中短距离搜索一帧出结果，避免长时间停在"搜索中"。

我倾向 **A + C**：A 消除饥饿，C 让常见情况一帧结束。

**风险**

中。改预算分配会影响寻路完成的时机，进而影响敌人走位节奏。需要手测"怪多时是否会挤在一起、是否会绕远路"。

**验证**

- 已有 AI 行为测试全绿。
- 手测：拉 20 个怪，观察所有怪都在动、没有长时间站桩。

**收益**

把"越玩越卡"的正反馈切断：人均推进速度不再随人数下降。

---

# P5 搜索没算完时，每逻辑帧跑一遍"直线能不能过去"

**证据**

- `navigate()` 里：搜索未完成且没有路径时，每逻辑帧调 `straightWalkable` —— `src/domain/enemy-ai.ts:362-366`
- `straightWalkable` 按 8px 步进，每步调一次实时 `canStand` —— `:377-385`

**为什么慢**

一次 300px 的直线就是 38 次 `canStand`，每次又是 `O(角色数)`。20 个敌人同时卡在搜索中，每逻辑帧就是 760 次实时判定——和 P1 叠加，成本直接翻倍。而且这条直线**每帧重算一遍，结果几乎不变**。

**方案**

1. 优先复用 P1 的格子表：`straightWalkable` 里查表，成本降到常数。
2. 在格子表落地前，先做**结果缓存**：同一对 `(起点格, 终点格)` 在一次搜索周期内只算一次；起点移动超过一格才重算。

**风险**

低。只影响"要不要提前切直线走"的判定时机。

**验证**

- 手测：敌人追人时不会明显迟钝，也不会隔墙扑过来。
- 单元测试：同一对起终点连续调用两次，第二次不产生新的 `canStand` 调用（用计数器断言）。

**收益**

20 个敌人时，每逻辑帧省约 700 次 `O(角色数)` 判定。

---

# P6 敌人每逻辑帧扫描全场候选，并逐个查仇恨表

**证据**

- `tick()` 里对每个候选调 `this.port.threat.has(candidate.id)` —— `src/domain/enemy-ai.ts:252-260`
- `port.candidates()` 每次调用重建全场角色数组 —— `src/scenes/world-combat.ts:741-745`
- `has()` 走 `ledger.score()` 线性扫描（表上限 256）—— `src/domain/combat-threat-system.ts:142`

**为什么慢**

每个敌人每逻辑帧：建一次 `O(角色数)` 的数组，然后对每个候选做一次线性查找。20 个敌人 × 40 个候选 × 最多 256 条账目 ≈ **每逻辑帧 20 万次字符串比较**，每秒 300 万次以上。这还没算数组和对象分配。

**方案**

1. **仇恨表加索引**：`ThreatLedger` 内部维护 `Map<ownerId, Map<sourceId, entry>>`，`has`/`score` 变成两次哈希，`O(1)`。淘汰时同步删索引。
2. **候选数组每逻辑帧只建一次**：宿主在逻辑帧开头算一次，通过 `port.candidates()` 返回同一个数组（见 P7）。
3. **先筛后查**：把便宜的 `inAwareness` / `canTargetCombatant` 判断提到 `threat.has` 之前（现在 `has` 在前），能过滤掉绝大多数候选。

**风险**

低到中。索引要保证和 `records` 数组一致，否则会出现"明明有仇恨却选不到目标"。

**验证**

- 现有仇恨表单元测试全绿，另加一条：索引与数组内容在 1000 次随机增删后完全一致。
- 手测：拉怪、假死、脱战，确认仇恨正常。

**收益**

每逻辑帧省约 20 万次字符串比较。

---

# P7 每逻辑帧重建全场角色对象

**证据**

- `combatants()` 每次调用 `activeParty.map(...)+arena.map(...)` 新建数组 —— `src/scenes/world-combat.ts:741-745`
- `combatant(id)` 每次新建 `{id,team,position,bounds,states,facing}`，其中 `states` 又是一次 `activeStates()` 分配 —— `:2455-2465`
- `threatActor(id)` 每次新建 `CombatThreatActor`，内含 `roster.enemySnapshot` 的 `Object.freeze({...})` —— `:762-777`
- 仇恨系统的 `actors()` 还会把全场角色 `flatMap` 再建一遍 —— `:749-750`

**为什么慢**

`port.candidates()` 被每个敌人每逻辑帧调一次，等于**每逻辑帧把全场角色对象重建 N 次**。40 人、20 个敌人时是 800 个对象/逻辑帧，17 逻辑帧/秒 ≈ 每秒 1.3 万个对象——又是一份持续 GC 压力。

**方案**

改成"每逻辑帧建一次、所有人共用"：

1. 宿主在逻辑帧开头（`updateEnemies` 之前）算一次 `combatantSnapshot` 和 `threatActorSnapshot`，放到字段里。
2. `port.candidates()` / `port.actor(id)` 返回快照里的元素。
3. 快照内元素**复用对象**，每帧只刷新字段（`position` 等），不再 `new`。
4. `roster.enemySnapshot` 的 `Object.freeze` 去掉（或改成按 `key+level` 缓存），它本来就是每帧重建的临时值。

**风险**

中。对象被复用后，**谁都不能长期持有它**——如果有代码把 `combatant` 存到别处，会读到下一帧的数据。必须先全仓搜一遍 `combatants(` / `combatant(` 的赋值处确认都是"用完即丢"。

**验证**

- 类型检查 + 现有战斗测试全绿。
- 手测：多目标切换、召唤物、嘲讽，确认目标不串。

**收益**

每逻辑帧少 800 个对象，每秒少 1.3 万次分配。

---

# P8 `nextWaypoint()` 被重复调用

**证据**

- 敌人：`if(this.nextWaypoint()){this.port.followPath(this.nextWaypoint); ...}` —— `src/domain/enemy-ai.ts:368`，一个表达式里调两次
- 敌人漫游：`if(this.nextWaypoint()&&...)` —— `:443`
- 队友：条件里一次、判断里一次、执行里再一次 —— `src/domain/party-ai.ts:309`、`:315`
- 行走路线：每帧 `canTraverse` 调两次 —— `src/domain/walk-route.ts:108`、`:115`

**为什么慢**

`nextWaypoint()` 不便宜：内部调 `combatStateCapabilities`（每次新建 `Set` + 对象，见 P9）、`port.actor()` 两次、`while(...)this.path.shift()`（`O(n)` 搬移），最后还做一次实时 `canTraverse`（`O(角色数)`）。队友一个逻辑帧最多调 3 次，等于把这份成本直接乘 3。

**方案**

纯机械改写：每个逻辑帧算一次，存局部变量，后面复用。

```ts
const waypoint = this.nextWaypoint();
if (waypoint) { this.port.followPath(waypoint); ... }
```

**风险**

极低。行为完全等价（同一帧内路径不会变）。

**验证**

- 现有 AI 测试全绿。
- 可选：在 `nextWaypoint` 里打断言，确认每帧每人只进一次。

**收益**

队友 AI 的这部分成本直接降到三分之一。

---

# P9 状态能力查询每次新建 `Set` 和对象

**证据**

- `combatStateCapabilities(states, hostile)` 先 `new Set(states)` 再 `return {...}` —— `src/domain/combat-state.ts:14-21`
- 调用点：`src/domain/enemy-ai.ts:222`、`:333`、`:347`、`:428`、`:438`，`src/domain/party-ai.ts:283`、`:374`，`src/domain/combat-threat-system.ts:53`、`:139`

**为什么慢**

每个调用点都是**同一个角色、同一组状态**反复问。每逻辑帧每角色 2~5 次，每次 2 个对象。40 个角色 ≈ 每逻辑帧 400 个对象。

**方案**

按"状态组合"缓存：状态集合很少变，用排序后的状态键拼一个字符串当缓存键，命中就返回同一个对象。或者更简单——`combatStateCapabilities` 内部把 `Set` 换成手写 `includes` 循环（状态最多两三个，`Set` 反而更贵）。

**风险**

低。返回对象被复用后不能改（现在是只读的，没问题）。

**验证**

现有战斗测试全绿。

**收益**

每逻辑帧少几百个对象。

---

# P10 战斗任务表每逻辑帧全量排序

**证据**

- `step(frame)` 里 `[...this.tasks.values()].filter(t=>t.dueFrame<=frame).sort(...)` —— `src/domain/combat-runtime.ts:121-131`
- 外面还套了一层 `while`，任务里再调度就再排一次 —— 同一段
- 一个弹道每飞一步就调度一条新任务 —— `:134-163`

**为什么慢**

即使一个任务都不到期，也要把整张表展开成数组、过滤、排序。在途弹道越多，表越大。逻辑帧每秒 17 次，这是纯浪费。

**方案**

改成按到期帧分桶：`Map<dueFrame, Task[]>`，`step(frame)` 只取 `frame` 这一桶；没有桶就 `O(1)` 返回。任务完成即从桶里删。

**风险**

低。要保证"同一帧多个任务的执行顺序"与现在的 `dueFrame` 升序 + `id` 升序一致。

**验证**

现有战斗流程测试全绿；另加一条顺序断言。

**收益**

每逻辑帧省一次全表展开 + 排序。

---

# P11 战斗时钟补帧没有上限

**证据**

- `CombatClock.advance` 的 `while` 循环没有帧数上限 —— `src/domain/combat-clock.ts:13-23`
- 唯一的上限来自调用方 `Math.min(delta,120)` —— `src/scenes/world-scene.ts:1831-1847`
- 逻辑帧固定 60ms —— `src/domain/battle.ts:492`

**为什么慢**

上限 120ms ÷ 60ms = 最多补 2 个逻辑帧。一帧卡住 200ms，只补 2 帧，剩下 80ms 的积压被丢掉（或累积）。如果每帧都在补 2 帧，逻辑时间永远追不上真实时间，游戏看起来就是"慢动作 + 低帧率"，而且**不会自己恢复**。

**方案**

改成"每渲染帧最多补 N 个逻辑帧 + 超时丢弃积压"：

- 超出上限时，把积压清零而不是排队，宁可让世界慢半拍，也不让它雪崩。
- 或者动态降逻辑帧率：卡顿时把 60ms 拉到 80~100ms，减少每帧工作量。

**风险**

中。影响手感（攻击节奏、冷却时间）。需要拍板（见文末）。

**验证**

手测：故意制造卡顿（拉一大群怪），确认帧率能自己恢复。

**收益**

让"一次卡顿"不会变成"永久低帧率"。

---

# P12 每渲染帧重建状态数组

**证据**

- `activeStates(actorId)` 每次 `[...keys()]` 新建数组 —— `src/domain/combat-conditions.ts:286`
- 每渲染帧对每个角色调一次 —— `src/scenes/world-combat.ts:2810`（状态标记同步）

**为什么慢**

人数 × 60fps 个数组。40 人时每秒 2400 个，量不大，但属于"每帧固定开销"，顺手能省。

**方案**

在 `activeStates` 里缓存：状态没变就返回上一次的数组（状态变更时置脏）。

**风险**

极低。

**验证**

现有测试全绿。

**收益**

每秒少 2400 个数组。

---

# P13 `path.shift()` 反复搬移数组

**证据**

- `while(this.path.length && 距离<=阈值) this.path.shift()` —— `src/domain/enemy-ai.ts:349`、`:432`
- 搜索结果又要 `slice` 出一份新数组 —— `:423`；队友同样 —— `src/domain/party-ai.ts:369`
- 队友与行走路线也 `shift` —— `src/domain/party-ai.ts:382`、`src/domain/walk-route.ts:103`

**为什么慢**

`shift()` 每次把后面所有元素往前挪一格。路径长 100 时，一个逻辑帧挪 100 次。单次很小，但它是"每帧每人"的固定项。

**方案**

加一个 `pathIndex` 游标，取点时读 `path[pathIndex++]`，走完再整体丢掉；`slice` 也只在需要时做。

**风险**

低。要小心所有读 `this.path[0]` 的地方同步改成读游标。

**验证**

现有 AI 测试全绿；手测寻路跟随不抖。

**收益**

去掉每逻辑帧的数组搬移。

---

# 修复顺序（按"根因 → 表面"排）

| 顺序 | 问题 | 理由 | 风险 |
|---|---|---|---|
| 1 | P1 占位格子表 | 唯一的 `O(角色数)` 项，砍掉它，后面几项成本一起降 | 中 |
| 2 | P8 / P9 重复调用与分配 | 纯机械、零风险、立刻见效 | 极低 |
| 3 | P3 A\* 去分配 | 消掉周期性顿帧 | 低→中 |
| 4 | P6 仇恨索引 + P7 快照复用 | 去掉每逻辑帧的 `O(角色数 × 256)` | 中 |
| 5 | P4 预算分配 | 切断正反馈（治"越玩越卡"） | 中 |
| 6 | P5 / P2 / P10 / P12 / P13 | 顺手清理 | 低 |
| 7 | P11 补帧策略 | 兜底，需要拍板 | 中 |

前两步做完就能明显感觉到变化；P1 是分水岭。

---

# 需要拍板的两件事

1. **P1 的格子表要不要同时给"行走判定"用？**
   用：全项目只有一套判定标准，`straightWalkable`、`canReach` 都变常数，收益最大；但要保证与精确几何判定等价，测试要写扎实。
   不用：只给寻路内部用，落位/传送仍走精确算法，改动面小但两套标准并存。

2. **P11 补帧怎么处理？**
   丢弃积压：卡顿时世界变慢但帧率能恢复；保留积压：时间准确但可能一直卡。我倾向丢弃积压。

---

# 验收标准

- 40 个角色同屏、10 个同时寻路的场景，单帧 `update` 时间从当前水平降到 **8ms 以内**。
- 连续跑 10 分钟，帧率不随时间下降（证明不是累积型问题）。
- 视觉上：不会穿人、不会卡住不动、不会隔墙扑人。

# 附：本文引用的关键位置

| 内容 | 位置 |
|---|---|
| 寻路预算 512 / 每渲染帧重置 | `src/scenes/world-combat.ts:156`、`:206`、`:2741` |
| A\* 核心与字符串键缓存 | `src/domain/pathfinding.ts:28-38`、`:41-104`（缓存 `:44`、键 `:62`、邻居 `:86-90`、对角 `:93`、节点 `:97`） |
| 地形查询 | `src/domain/navigation-world.ts:39-44`、`src/domain/navigation.ts:28-41` |
| 人物占位遍历 | `src/domain/navigation-world.ts:145-158` |
| 可站判定入口 | `src/domain/navigation-world.ts:165-170` |
| 冻结快照与 blocked 拷贝 | `src/domain/navigation-world.ts:107-122` |
| 敌方 AI 每逻辑帧扫候选 | `src/domain/enemy-ai.ts:252-260` |
| 未算完时的直线判定 | `src/domain/enemy-ai.ts:362-366`、`:377-385` |
| `nextWaypoint` 重复调用 | `src/domain/enemy-ai.ts:368`、`:443`；`src/domain/party-ai.ts:309`、`:315`；`src/domain/walk-route.ts:108`、`:115` |
| 状态能力分配 | `src/domain/combat-state.ts:14-21` |
| 仇恨表与 `has` | `src/domain/combat-threat.ts`（上限 256）、`src/domain/combat-threat-system.ts:142` |
| 全场角色对象重建 | `src/scenes/world-combat.ts:741-745`、`:2455-2465`、`:762-777`、`:749-750` |
| 战斗任务全量排序 | `src/domain/combat-runtime.ts:121-131` |
| 补帧与逻辑帧 | `src/scenes/world-scene.ts:1831-1847`、`src/domain/combat-clock.ts:13-23`、`src/domain/battle.ts:492` |
| 状态数组每帧重建 | `src/domain/combat-conditions.ts:286`、`src/scenes/world-combat.ts:2810` |
