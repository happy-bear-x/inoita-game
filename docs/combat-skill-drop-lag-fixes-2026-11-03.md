# 战斗、技能与掉落：五个卡顿来源的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。五个问题各自独立成节，每节写清代码证据、为什么越玩越慢、怎么改、风险在哪、怎么验证。

排查起点是玩家反馈的「运行一段时间后很卡」。范围是战斗（召唤、名册、状态表现）、技能（快捷栏、条件）、掉落（地面掉落）。存档与背包的相邻结论可对照 `docs/session-save-economy-performance-2026-11-03.md`，本文在问题一、问题二里只补它没覆盖的部分。

## 一句话结论

不是「每次命中多留一个容器」的泄漏：战斗表现、技能弹道、掉落视觉的对象都在销毁路径上成对回收，单场战斗的临时对象数量有上限。

真正让「越玩越卡」成立的是两件事：

1. **会话里只增不减的条目**：召唤物每次掉血都会在 `Session.enemyStates` 新建一条，召唤结束不删，同一张图里越打越多。
2. **每帧固定工作跟场上人数、刷怪点数量成正比**：名册每帧全量重建、快捷栏每帧重算、增益与状态每帧新建数组。人数和刷怪点一多，同样的帧预算被吃穿。

另外，检查点和背包各有一处「整包复制」把单次操作的单价抬高，属于尖峰，不是持续变慢。

## 问题一：检查点把已经复制过的会话再复制一遍

### 代码证据

`src/domain/session-checkpoint.ts:11–19`：

```ts
const state = session.captureState();
delete state.legendaryWeapons;
this.snapshot = structuredClone({ session: state, location, world });
```

`captureState()`（`src/domain/session.ts:348` → `:386–400`）返回的本来就是独立副本，注释（`:387–389`）明确写了「各子系统自己的 captureState() 已经返回新对象」。所以第 17 行这一次 `structuredClone` 是把刚做好的副本再整包复制一遍，纯开销。

同一次检查点里还有两处重复：

- `src/scenes/world-scene.ts:1471` 和 `:1476` 各自 `structuredClone(this.baseEntities)`，同一份地图实体复制两遍。
- `src/domain/session.ts:354` 的 `toPlaybackCheckpoint`（`src/domain/playback-checkpoint.ts:15`）又克隆一遍 `state.runtime`，而它刚在 `captureStateWith`（`:391`）被克隆过。

### 为什么越玩越卡

每次检查点的成本 = 会话体积 × 2 + 地图实体 × 2 + 运行时状态 × 2。会话体积随背包实例、地面掉落、敌人状态只增不减，所以单价随游玩时间上涨。

体感是「一存档就顿一下」，因为触发点成对出现：拔剑 `world-scene.ts:1067–1068`、住店 `:1082–1083`、进图 `:491` 和 `:494`，都是自动存档和检查点前后脚各抓一次。

### 改法

分三个提交，先保证隔离性再删克隆。

1. 先补测试，不改实现：给 `tests/checkpoint.test.ts` 加一条「捕获后逐个子系统改活状态，`peek()` 不变」——背包增删与穿脱、敌人掉血与死亡、地面掉落增删、任务推进、技能冷却、泉水/宝箱/商店访问、保底计数。现有用例只覆盖了背包、经验、技能、快捷栏。
2. 去掉 `capture()` 的外层克隆：

```ts
const state = session.captureState();
delete state.legendaryWeapons;
this.snapshot = { session: state, location, world: structuredClone(world) };
```

`world` 先保留克隆，等世界状态的隔离测试补齐再删。
3. 地图实体只克隆一次：`captureStoryScene()` 加一个可选参数，`captureStoryWorld()` 把同一个数组传给它。恢复侧本来就会再克隆（`world-scene.ts:1535`、`:329`、`:465`），共用安全。
4. `toPlaybackCheckpoint` 改成接管传入的 runtime、原地剥舞台外观，不再克隆。它目前只有 `session.ts:354` 一个调用点。

`docs/session-save-economy-performance-2026-11-03.md` 的问题五给了更激进的一步到位版（连 `world` 也直接存引用）。本文建议分两步走，先只删会话那一层。

### 风险

- 各子系统 `captureState()` 是否真的都返回新对象，目前只有注释和抽查支撑。隔离测试补齐前不要删外层克隆。
- `restore()`（`session-checkpoint.ts:20–25`）必须保住深拷贝：`tests/checkpoint.test.ts` 要求快照可以连续回滚两次，不能被消费。

### 验证

```bash
npm test -- tests/checkpoint.test.ts tests/checkpoint-scene-state.test.ts tests/checkpoint-defeat-ui.test.ts tests/auto-save.test.ts tests/save-game.test.ts tests/session.test.ts
npm run typecheck
```

实机（按规则不主动开浏览器）带 `?perf` 看拔剑、住店时的 `long100` 是否下降；要更细的对照，临时在 `capture()` 和 `capturePersistentState()` 里加 `console.time`，验完删掉。

### 预期

每次检查点少一次整包会话克隆和一次地图实体克隆，捕获成本约减半。不改存档格式、不改玩法数值、不改触发频率。

## 问题二：背包 `remove()` 为了删几件，把整包物品深拷贝一遍

### 代码证据

`src/domain/bag.ts:327–333`：

```ts
for (const entry of this.entries.filter(entry=>entry.item===item)) {
  const used = Math.min(quantity, entry.quantity);
  this.consume(entry.id, used);
  quantity -= used;
  if (!quantity) break;
}
```

`entries`（`:235`）是 `orderedIds().map(id => copy(...))`，**每一件实例都复制一次**，只为拿它的 id 和数量。`orderedIds()`（`:232–233`）本身还要把五个袋 `filter` 后拼接。

`add()`（`:302–313`）每次叠加也都扫一遍：`orderedIds().map(id=>this.instances.get(id)!).find(...)`。这里只是多分配一个引用数组，不做深拷贝，优先级低。

### 为什么越玩越卡

背包越大，`remove()` 越慢。用一瓶药、交一个任务物品、卖一件东西都会走它，后期背包几百件时，一次操作要复制几百个实例。这类操作集中在拾取和商店，画面里表现为一次小卡顿。

### 改法

只改 `remove()`，直接按顺序读引用：

```ts
for (const id of this.orderedIds()) {
  const entry = this.instances.get(id)!;
  if (entry.item !== item) continue;
  const used = Math.min(quantity, entry.quantity);
  this.consume(id, used);
  quantity -= used;
  if (!quantity) break;
}
```

顺序语义不变（仍是五个袋从前到后、先扣最早的）。`add()` 的索引优化先不做：它现在只多一次线性扫描和一个临时数组，还没有到「必须改」的程度。

### 风险

- 「从最早的开始扣」的顺序要保持，任务与商店测试依赖它。
- 穿在身上的实例不在 `orderedIds()` 里，现有行为就是不会被扣，别顺手改掉。
- 带技能、强化、宝石的实例不参与叠加，`holdsInstanceState` 的判断不要动。

### 验证

```bash
npm test -- tests/bag.test.ts tests/bag-stacking.test.ts tests/bag-layout.test.ts tests/session-quest-core.test.ts
npm run typecheck
```

### 预期

`remove()` 从「每件实例深拷贝一次」降到「按 id 读引用」，背包几百件时单次操作从毫秒级降到微秒级。

## 问题三：每帧固定工作跟人数、刷怪点数量成正比

### 3a 名册每渲染帧全量重建

`src/scenes/world-combat.ts:2770` 每渲染帧调 `this.roster.refresh()`。`src/domain/world-enemies.ts:192–219` 的 `refresh()` 没有「没变就跳过」：每次新建 `active`/`current`/`present` 三个集合，遍历场上敌人，再遍历**整张图的全部刷怪点**，对每个点调：

- `session.canSpawnEnemy(...)`（`:550–557`）：要做任务状态、剧情可见性判断，到期时还会删状态（有副作用）。
- `session.enemyVitals(...)`（`session.ts:538–541`）：每次新建一个对象，带 capture 时再复制一层。

开销 = 刷怪点数量 × 每秒 60 帧，跟玩家打没打架无关。

### 3b 快捷栏每帧重算

`src/scenes/world-scene.ts:1779` 每渲染帧调 `refreshShortcutPage()`；战斗里 `world-combat.ts:2778` 每逻辑帧又调一次。函数体（`world-scene.ts:808–827`）每次建 6 个 slot 对象、拼签名字符串。冷却期间签名每帧都变，于是 `controls.setShortcutPage` 每帧都跑，连带 `paint()` 重画冷却扇形。

### 3c 两个表现同步每帧新建集合

`syncBuffLoops()`（`world-combat.ts:2726–2737`）每次新建 `ids` Set，遍历全队和全场；`syncStateMarkers()`（`:2803–2813`）每次新建 `combatants` 数组和 `seen` Set。都是短命对象，每秒数百个，主要贡献 GC 压力。

### 3d 条件推进每帧新建数组

`src/domain/combat-conditions.ts:188–210` 的 `update()` 每个逻辑帧重建 `buffEntries()`/`stateEntries()` 数组（内部 `[...map].flatMap(...)`），大部分时候场上根本没几个 buff。

### 改法（事件驱动，不用定时轮询）

1. **名册改成「版本 + 到期时间」双条件**：
   - `WorldEnemyRoster` 记住上次重建的键（就是 `world-enemies.ts:118` 那五个 revision 拼起来的字符串）和 `nextRespawnAt`（上次重建时，所有「已死但会复活」的刷怪点里最早的 `deadUntil`）。
   - `refresh()` 开头：键没变、且 `session.gameTimeMs < nextRespawnAt`，直接返回共享的空结果。
   - 键变了、或时间跨过 `nextRespawnAt`，才做现在的全量重建；重建时顺手算出新的 `nextRespawnAt`。
   - 每帧只多一次字符串比较和一个数字比较；不设定时器、不做固定间隔扫描；复活仍然在到期的那一帧精确出现。
2. **快捷栏**：删掉 `world-scene.ts:1779` 的每渲染帧调用，改由三个入口驱动——`refreshSkillCooldowns`（本来就按战斗 tick 调，`:1424`）、`refreshState`（会话通知）、`refreshLoadout`。战斗里保留 `world-combat.ts:2778` 的逻辑帧调用。
3. **两个表现同步**：把 `ids`/`combatants`/`seen` 提成类字段，每帧 `clear()` 或 `length=0` 后复用。
4. **条件推进**：给 `CombatConditions` 加两个计数（带剩余时间的 buff 数、状态数），在增删时维护；`update()` 开头计数为 0 就直接走空推进，不再建数组。
5. 召唤倒计时循环（`world-combat.ts` 里的 `[...this.arena]`）换成按下标遍历复用数组，顺手清理。

### 风险

- 名册方案最大的风险是「键漏了某个影响刷怪的输入」：只要有一个会改变「该不该出现」的 revision 没进键，怪就不会出现。要逐个确认 `storyWorld.revision`、`chests.revision`、任务版本、`questSpawnIds.size`、`breakableRevision` 之外，是否还有别的入口（例如剧情 `place` 的可见性变化有没有自增版本）。
- `canSpawnEnemy` 有副作用（到期时删状态）。改成「跳过重建」后，到期那一刻必须真的重建一次，`nextRespawnAt` 要算准，不能用「大约」。
- 快捷栏少一帧刷新，物品可用状态最多晚一个逻辑帧。要是不接受，就把 `mana` 和冷却剩余加进缓存键，仍然不每帧建对象。

### 验证

```bash
npm test -- tests/world-combat-roster-sync.test.ts tests/combat-conditions.test.ts tests/combat-conditions-potion-save.test.ts tests/enemy-threat.test.ts
npm run typecheck
```

给名册补两条用例：连续调两次 `refresh()`，第二次返回空且不重建；怪物 `deadUntil` 到期后第一次 `refresh()` 恰好加入一次。

## 问题四：每召一次召唤物，会话里多留一条敌人状态

### 代码证据

- 召唤物走 `summonFactory`（`world-combat.ts:617–642`），`roster.placeEnemy` 生成唯一键 `enemy-N`（`src/domain/enemy-roster.ts:24–27`）。
- 它掉血时 `world-enemies.ts:217–221` 的 `setEnemyHealth` 会 `session.setEnemyVitals(key,...)`；而 `setEnemyVitals`（`session.ts:547–549`）对不存在的键会**新建条目**。
- 删除路径只有三条：换图时 `enterMap`（`session.ts:90–112`）清非 permanent、`resetMapEnemies`（`:113–121`）、以及 `canSpawnEnemy` 复活到期时删（`:550–557`）。召唤物的键不在刷怪表里，第三条永远不触发。
- `dealtDamage`（`world-combat.ts:785`）同理：`:1233` 每次伤害把施法者 id 加进去，只有角色复活（`:2659`）才删，召唤物被移除时不清。

### 为什么越玩越卡

同一张图里，每召唤一次、每次掉血，`Session.enemyStates` 就多一条，直到换图才清。这些条目会被每次检查点、每次自动存档的 `structuredClone` 带上，图待得越久、召唤用得越多，抓快照越慢。

### 改法

1. `Session` 加 `forgetEnemy(id)`：`this.enemyStates.delete(id)`，不发通知（现有 `setEnemyVitals` 也不发）。
2. `removeEnemyVisual`（`world-combat.ts:1894–1907`）里，敌人 `summonedBy !== undefined` 时调 `this.session.forgetEnemy(key)`，并 `this.dealtDamage.delete(key)`。
3. `clearEnemies` 清场时对召唤物同样处理。

普通刷怪点保持原样：它们靠 `deadUntil` 做复活，不能删。

### 风险

- 检查点捕获时如果召唤物还活着，它的状态本来就会进快照；移除时删掉不影响已存快照。
- 确认没有别处依赖「召唤物移除后还能读到它的血量」（例如战后结算）。目前只看到 `removeEnemyVisual` 之后没人再读。

### 验证

```bash
npm test -- tests/session.test.ts tests/world-combat-roster-sync.test.ts tests/story-enemy-handoff.test.ts
npm run typecheck
```

补一条 session 级用例：给未知 key 写血、`forgetEnemy` 后 `enemyVitals` 为空。

## 问题五：地面掉落每渲染帧建一个空数组

### 代码证据

`src/domain/ground-loot.ts:73–79` 的 `advance()` 每渲染帧调 `onMap(map)`（`:63–68`），后者每次扫 `byMap` 新建数组。绝大多数时候没有飞行中的掉落，这个数组是纯分配。

### 为什么越玩越卡

单次成本很小，但它是每帧固定支出，且跟掉落总量成正比。掉得越多，扫描越长；同时它每秒制造一个短命数组，增加 GC 压力。

### 改法

维护 `flyingByMap: Map<mapId, number>`（或每个图一个 Set），在 `add`、落地、`collect`、`prune` 时增减；`advance()` 计数为 0 直接返回，不为 0 时直接遍历 `byMap.get(map)`，不建数组。

### 风险

计数要在所有移除路径上同步减少（拾取、淘汰、换图），漏一条就会永远认为「有东西在飞」。这条最小，建议最后做。

### 验证

```bash
npm test -- tests/ground-loot-auto.test.ts tests/ground-loot-presentation.test.ts
npm run typecheck
```

## 建议的执行顺序

1. 问题四（最小、纯收益，先落地）
2. 问题一（感知最强，但要先补隔离测试）
3. 问题三（最大头，风险也最高，单独一个提交）
4. 问题二（只改 `remove` 那一段）
5. 问题五

每个独立改动单独提交，提交说明写清修复行为和验证结果。

## 需要拍板的点

1. 问题一的 `world` 那份克隆，这轮删还是留？建议先留，等世界状态隔离测试补齐。
2. 问题三的名册「版本 + 到期时间」方案是否采用？这是替代 500ms 轮询的设计。
3. 问题二只修 `remove` 的深拷贝、`add` 的索引先不做，是否可行？
4. 问题四删除召唤物状态时，是否连 `dealtDamage` 一起清？建议一起清。
