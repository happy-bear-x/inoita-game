# 性能修复方案（待拍板）

日期：2026-11-04
状态：**A/B/C/D/E/G 已实施并提交；F 只做内容缓存与地图历史，音频按决定跳过；特效图集懒加载与共享战斗租约拆分留待下期。**
基线提交：`388e234`（本文行号以此为准）

## 怎么读这份文档

这次核查把「运行越久越卡」拆成了七个问题，每个问题独立给方案。每份方案都有多个选项，**推荐项不是决定**，需要你在文末的决策清单里拍板。

判断依据分两类，不要混在一起看：

- **每帧固定重活**：解释「一直卡」，也会随等级、技能数、队友数、场上实体数变重，所以体感像「越玩越卡」。
- **随时间增长的数据**：解释「同一张图待久了也变慢」，包括只增不减的记录、只进不出的缓存、越来越重的存档快照。

先给结论：**卡顿主因不在 Phaser 渲染，而在每帧重复计算和重复分配。** 今天的优化集中在剧情快照、存档和菜单重绘，没有触达战斗与地图的每帧链路，所以体感没有变化。

---

## 一、总览

| 编号 | 问题 | 推荐路线 | 预期收益 | 风险 | 工作量 |
|---|---|---|---|---|---|
| A | 每逻辑帧重建技能表、每渲染帧重算快捷栏 | 版本号签名 + 读取时惰性校验 | 高：稳态不再 `structuredClone`，每秒少掉约 800–1100 次克隆（估算） | 中：缓存键漏输入会读到旧表 | 中 |
| B | 每帧扫描 593 条剧情事件、每次通知重刷整图与 HUD | 静态索引 + 脏签名早退 | 中高：单帧事件扫描从 593 条降到单图个位数 | 中：索引失效会漏触发 | 中 |
| C | 战斗逻辑帧的临时数组、候选扫描、线性仇恨查询 | 低风险缓存/索引，AI 节流留作测量后的开关 | 中高：候选成本从平方级降到线性 | 中：索敌与手感回归 | 中 |
| D | 可破坏物记录只增、召唤物伤害标记不清 | 按 id 覆盖 + 清理死亡状态 + `destroyEnemy` 删除 | 中：止住同图缓慢增长，顺带修「打碎后不再出怪」 | 低：旧档清理语义需确认 | 小 |
| E | 技能素材补载租约只增、每次受击算两遍签名 | 两级版本门控 + 只补 delta + 失败退避 | 中：受击热路径降为常数，租约不再整包抬高 | 低到中：渲染资源生命周期 | 中 |
| F | 音频解码缓存、内容解析缓存、地图纹理高水位 | 收窄预载 + 字节 LRU + 会话边界清理 + 拆分共享租约 | 中高：内存水位与 GC 压力 | 中：首次音效延迟、换图重载 | 中到大 |
| G | 自动存档与剧情导演每次全量复制 | 按子系统 revision 缓存快照；导演未变时跳过 | 中：存档单价从 O(总进度) 降到 O(脏切片) | 中：版本号漏 bump 会静默存旧数据 | 中 |

---

## 二、决策清单

下面每一项都标了推荐。你只需要回复「采纳推荐」或指出要改的编号。

### 第一组：改动深度

| 编号 | 决策 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D1 | 技能缓存做到哪一层 | ①只缓存 `partyPassives`；②连技能表和 `skillForMember` 一起缓存 | **②** | ①投入小但每逻辑帧仍重建技能数组；②稳态几乎零重建 |
| D2 | 是否允许在 domain 层加版本号 | ①只在场景层算签名；②加 `groupModifierVersion`、`conditions.revision`、`encounterRevision` 等 | **②** | ①回归面小但 HUD/导演收益有限；②需要保证每个 mutation 点都 bump |
| D3 | 自动存档主方案 | ①`requestIdleCallback` 调度；②按 revision 缓存快照；③降低存档频率 | **②** | ①在持续渲染的游戏里常拿不到时间片，且不减少单次成本；②改动多但治本；③会放大崩溃丢进度 |
| D4 | 是否新增运行时 revision（choice/receipt/enemy/encounter） | ①加；②不加，继续每次全量复制 | **①** | 不加则 G 的收益只剩一半 |
| D5 | 是否先加测量埋点 | ①加 capture/write 耗时、字节数、缓存命中计数；②直接改 | **①** | 没有基线就无法判断哪项真的有效 |

### 第二组：行为与手感

| 编号 | 决策 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D6 | 敌人 AI 是否降低决策频率 | ①先只做索引，保持 60ms；②同时加 180ms 决策闸门；③250ms | **①，测量后再考虑②** | ②能再省 3–4 倍候选扫描，但转火/起手最多延迟一个周期；180ms 与现有追击寻路、召唤物 AI 同频 |
| D7 | 名册刷新是否改为逻辑帧/事件驱动 | ①接受最多约 60ms 的生成延迟；②保持每渲染帧 | **①** | 这会把「每渲染帧全量扫生成点」降为每逻辑帧一次 |
| D8 | 飞行物方向不变时是否只平移、不重播动画 | ①接受；②保持每步重建 | **①** | 视觉上方向不变时没有区别；换方向仍切 clip |
| D9 | 地图触发是否严格每渲染帧 | ①只在移动或脏状态时重算，静止不动跳过；②保持每帧 | **①** | ②时序完全不变但分配仍在；①静止时省掉全部扫描 |

### 第三组：数据与存档

| 编号 | 决策 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D10 | 可破坏物同槽位旧怪仍存活时再次打碎 | ①覆盖为全新出怪；②保留旧怪、忽略新记录 | **①** | ①符合「槽位重生」语义；②玩家看不到第二只怪，但掉落已发 |
| D11 | 旧档里重复/永久死亡的 `breakable:` 记录怎么处理 | ①读档时惰性清理，不改 `SAVE_FORMAT`；②升到 43 并写迁移 | **①** | ①无迁移成本，下次读档自愈；②可审计，但多一版迁移与旧档测试 |
| D12 | 技能补载失败的重试策略 | ①无限退避（1s→30s）；②5 次后停止，只在签名变化或重进地图时再试 | **②** | 资源缺失通常是内容问题，无限重试只耗电；②更保守 |
| D13 | 玩家技能签名是否包含完整装备 | ①只含版本号；②含 `actor.id` + 完整装备 JSON | **②** | ①更便宜，但可能漏掉未走版本号的外观变化 |
| D14 | 自动存档定时器是否从 5 分钟改到 10 分钟 | ①改；②先不改，测量后再定 | **②** | 在单次成本没降下来之前，降频只是拿进度安全换时间 |

### 第四组：内存预算

| 编号 | 决策 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D15 | 低端机音效解码预算 | ①48MB；②64MB；③按设备自适应 | **③，低端 48MB / 桌面 64MB** | 48MB 会淘汰少量稀有音效，重播需重新解码 |
| D16 | BGM 保留数量 | ①保留 1 首；②保留 0 首 | **①** | 0 省约 22.6MB，但回切地图要重新解码 |
| D17 | 地图素材历史 | ①3→2；②3→1 | **①** | 1 再省约 4MB，但回退地图必重载 |
| D18 | 是否做「特效图集按技能/按页懒加载」 | ①本期做；②下一期单独做 | **②** | 这是最大的单项内存收益，也是最大改造量，建议单独排期 |
| D19 | 内容解析缓存怎么处理 | ①回菜单/新会话清空地图与 pose；②做热路径 LRU | **①** | 实测全量常驻只有约 10–20MB，不值得给换图关键路径加重新解析 |

全部采纳推荐时，建议按「阶段 0→1→2→3」推进；任一项改选，我会在实施前重新核对依赖。

---

## 三、详细方案

### 方案 A：技能表与快捷栏的每帧重算

**结论**：不要改成纯事件驱动。采用「版本号 + 签名惰性校验的分层缓存」，事件只负责推进 revision，读取时自己比版本。同时删掉逻辑帧里重复的那次快捷栏刷新。

**已核实证据**

- `WorldCombat.update` 每逻辑帧（60ms）对每个非操控存活队友调用 `syncAiSkills`（`src/scenes/world-combat.ts:2828`、`:1987`）。
- `partySkillsFor`（`:1911`）每次 `configuration.draft()`，有 loadout 时直接 `structuredClone`（`src/domain/skill-configuration.ts:33`）；再 `costumeRecipe`、`skillClips`，每个已学技能调 `skillManaCost`。
- `skillManaCost`（`:1638`）调两次 `actorAttribute`；没命中 temporary 缓存时走 `partyPassives`（`:1616`），后者再来一次 `draft()` 克隆、装备扫描、`memberCombatModifiers`。
- `WorldScene.update` 每渲染帧无条件调用 `refreshShortcutPage`（`src/scenes/world-scene.ts:1842`），六个槽位逐个 `shortcutSlot` → `skillManaCost`；`world-combat.ts:2820` 的逻辑帧里还会再调一次。
- 估算：3 名队友、8 个已学技能时，每逻辑帧约 50–70 次克隆/分配，约 800–1100 次/秒。这是按调用路径推算的数量级，不是实测值。

**候选方案**

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| A1 逐帧 memo | 按 `combatTick` 去重同帧内的重复调用 | 去掉 2–3 倍重复 | 跨帧仍每次克隆 |
| A2 版本签名惰性缓存 | passives、技能表、`skillForMember` 分层缓存，读取时比版本号 | 稳态零重建、零克隆；HUD 与 AI 共用 | 漏一个输入就读旧表 |
| A3 事件驱动主动失效 | 订阅技能/装备/队伍/条件变化，变化时重算 | 稳态检查最少 | 现有 `party.changed` 在每次掉血时都触发；buff 到期、读档、切人等失效源容易漏 |

**评审结论**（双向钢人 + 互补专家）

读取次数远多于失效次数（每逻辑帧 × 每技能 vs 技能/装备偶尔变化），所以惰性缓存的收益确定。纯事件驱动的最大问题是失效源不完整：现有队伍通知在血量、法力变化时也会发，必须先按版本过滤，等于又回到签名缓存，还多背了订阅顺序风险。**推荐 A2。**

**推荐实施步骤**

1. `src/domain/party.ts`：给 `PartyRoster.groupModifiers` 加 `groupModifierVersion`，只在成员增删、升级、读档时加一，绝不在掉血/回蓝时加。
2. `src/scenes/world-combat.ts`：新增 `passivesCache`。键包含成员 id、classId、`configuration.version`、`bag.revision`、`lowHealth` 布尔（`health <= maxHealth*30%`）、`stealthed`、`groupModifierVersion`、成长值。
3. 同文件：新增 `skillTableCache`。键包含 id、classId、`configuration.version`、`bag.revision`；只缓存 action/level/clips，**不缓存 `manaCost`**。
4. 同文件：`syncAiSkills` 命中缓存时只更新 `manaCost` 与 `frequency`，这两项仍按当前法力每帧算，但只剩算术。
5. 同文件：删除逻辑帧里的 `refreshShortcutPage()`（`:2820`），保留渲染帧那一次，避免同帧重复。
6. `src/domain/battle.ts`：为 `skillForMember`/`skillForGrowth` 加按成员的 memo；佣兵的 `spread` 是第二个主要分配源。
7. `src/scenes/world-scene.ts`：`refreshShortcutPage` 先算槽位签名，签名不变就不进 `skillHud.setPage`。
8. 失效点：读档、检查点恢复、关图、成员移除时显式清空两级缓存。

**避免陈旧**：开发模式每隔若干逻辑帧做一次「缓存值 vs 全量重算」差分断言，不一致立即报错；生产不跑。

**验证**

```bash
npm run typecheck
npm test -- tests/combat-conditions.test.ts tests/combat-resource-capacity.test.ts tests/party-ai.test.ts tests/combat-skill-assets.test.ts
```

新增缓存用例：连续 N 帧 `draft` 只调用一次；学技能、换装、潜行、血量跨阈值、读档后各失效一次；缓存蓝耗与旧路径逐值一致。

---

### 方案 B：地图事件扫描与通知驱动的整图刷新

**结论**：进图/剧情投影时按地图与角色预建纯数据索引，保留原有触发顺序和占用表语义；同时给整图刷新和 HUD 加脏签名早退。不做动态空间索引。

**已核实证据**

- `afterMovement` 挂在 POST_UPDATE，每渲染帧执行（`src/scenes/world-scene.ts:1862`）。region 分支遍历全部 593 条事件（region 178 条），near 分支每次新建 `filter` 数组（near 92 条），并对每条做 `characters.find`。
- `updateInteractionTarget`（`:1792`）每渲染帧调用 `this.app.session.refresh()`。当前内容的 71 个条件引用全部是任务引用，事件/选择/标记/世界变量输入为 0，所以 `refresh()` 目前几乎立即返回；但这是一条每帧路径，以后内容加入事件或世界变量条件就会变贵。
- `refreshState`（`:938`）每次 session 通知遍历全部角色，逐个 `session.visible`、`setVisible`、`setEnabled`、`glyph.setText`。
- `session.visible`（`src/domain/session.ts:857`）即使实体没有条件，也会先构造 `conditionContext()`。
- `StatusHud.refresh`（`src/ui/phaser/status-hud.ts:178`）每次通知都取 `party.snapshot()`、`conditions.snapshot()`，逐成员刷新。

**候选方案**

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| B1 按逻辑帧/条件节流 | 保留全量扫描，降到每 60ms 一次 | 改动最小 | 触发最多延迟 60ms；分配仍在 |
| B2 静态索引 + 签名早退 | 进图时按 map/角色预建索引；通知刷新加签名 | 每帧 593→单图≤11；near 按角色 O(1) | 索引失效会漏触发 |
| B3 动态空间索引 | 四叉树 | 单图 region 只有个位数，收益接近零 | 过度设计 |

**评审结论**

支持索引的最强理由是内容不可变，region 天然按 map 分组，near 只与当前地图角色有关；索引能完整保留 campaign 顺序与条件实时求值。支持节流的最强理由是每帧 593 次简单判断可能不到 0.1ms，真正贵的是通知重绘。双方共同承认：**索引的风险在于失效逻辑，而不在查询本身**。因此推荐 B2，但索引写成纯函数、可单测，并先用固定走位脚本证明触发序列完全一致。

**推荐实施步骤**

1. 新增 `src/domain/story-trigger-index.ts`（纯模块）：按 `campaign + mapId + characters` 生成 `regionEvents`、`nearCandidates`、`charactersByActor`，保持 campaign 原顺序。
2. `src/scenes/world-scene.ts`：在进图和 `projectStoryEntities` 结束后重建索引；用 campaign 引用、characters 引用、map.id 做懒惰失效键。
3. `afterMovement`：改遍历索引，删除每帧 `filter`；`besideAt` 用角色索引查找，仍检查 `container.visible`；条件仍在每次访问时实时求值。
4. `updateInteractionTarget`：删除每帧 `session.refresh()`，所有变更入口本来就会 `emit`；再加一层「受控角色/坐标/任务版本/世界版本/宝箱版本」签名，静止且签名不变时直接返回。
5. `refreshState`：保留装备、任务完成提示等必须执行的步骤；把整图角色循环和小地图重建放到签名之后。
6. `src/domain/session.ts - visible`：没有 `condition` 时直接返回 `storyWorld.visible`，不构造 `conditionContext`。
7. `StatusHud.refresh`：先算头部签名（七项数值、队伍 revision、条件 revision、成员状态），不变时不取快照、不刷新面板。

**验证**

```bash
npm run typecheck
npm test -- tests/story-trigger-occupancy.test.ts tests/story-trigger-regions.test.ts tests/story-doorway-trigger.test.ts tests/story-exit-gates.test.ts tests/story-playthrough-rewards.test.ts tests/status-hud.test.ts tests/party.test.ts tests/session.test.ts
```

新增索引单测：跨图隔离、同图多 region 顺序、near 多角色取首个可见、角色移除后占用释放、条件不成立不释放占用。用同一固定走位脚本对比修改前后的触发事件序列，必须完全一致。

---

### 方案 C：战斗逻辑帧的分配与 AI 扫描

**结论**：先做低风险子集，保持 60ms 决策：每逻辑帧共享 Combatant 快照、仇恨账本加 `owner→source` 索引、条件遍历去掉中间数组、名册刷新改为失效驱动、飞行物方向不变时复用。180ms 决策闸门只作为测量后的可选开关。

**已核实证据**

- `CombatConditions.update` 每逻辑帧至少 4 次 `buffEntries()/stateEntries()`，两者都是 `[...map].flatMap(...)` 新建数组和包装对象（`src/domain/combat-conditions.ts:187-214`、`:216-227`、`:269-296`）。
- 每个 active 敌人每逻辑帧调用 `port.candidates()`（`src/domain/enemy-ai.ts:249`）；`WorldCombat.combatants()` 每次新建队伍+arena 数组和 Combatant 对象（`world-combat.ts:761`、`:2443`）。
- 仇恨查询 `score/has` 用 `records.find` 线性扫描（`src/domain/combat-threat.ts:135`）。
- `WorldEnemyRoster.refresh()` 每渲染帧重建 Set/Map 并全量遍历生成点（`world-combat.ts:2812`、`src/domain/world-enemies.ts:192`）。
- 飞行物每个逻辑帧 `removeAll(true)` 销毁子 Sprite 再重建并新建 tween（`src/rendering/combat-presenter.ts:81`、`src/rendering/effects.ts:27`）。

**候选方案**

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| C1 索引/共享快照，保持 60ms | Combatant 快照、仇恨 Map、条件直接遍历、名册 revision、飞行物复用 | 行为口径不变，候选成本从平方级降到线性 | 快照失效点多 |
| C2 180ms 决策闸门 | 只把索敌/选技降频，移动与追击不变 | 候选扫描再降 3–4 倍，改动集中可回退 | 转火/起手最多延迟一个周期 |
| C3 混合 | 先 C1，C2 留开关 | 兼顾 | 两套语义并存 |

**评审结论**

60ms 决策是设计语义：召唤物中途入场抢仇恨、隐身、嘲讽、受击转火都按帧判定。现有追击寻路本来就是 180ms 一次，召唤物 AI 也用 180ms，所以 C2 与它们同频是合理的；但 C2 不能解决条件遍历、名册刷新、飞行物分配。**推荐先做 C1 的低风险子集，C2 只在 profile 显示 80+ 战斗实体仍超预算时启用。**

**推荐实施步骤**

1. `world-combat.ts`：每逻辑帧开始惰性构建一次只读 Combatant 快照，`candidates()` 返回同一数组；位置、bounds、状态在 tick 内共享。失效点：每逻辑帧开始、增删敌人、死亡/复活、召唤入场、强制位移。
2. `src/domain/combat-threat.ts`：加 `ownerId → Map<sourceId, entry>` 索引；所有写入双写，`captureState/restoreState/decay/removeActor` 同步维护。
3. `src/domain/combat-conditions.ts`：`update`、`advanceSimulationFrames`、`refreshFrameRemainingTimes` 改为直接遍历 Map，去掉 `flatMap` 包装对象；维护帧计时节点小集合和状态总数，替代每次施加状态的全量 reduce。
4. `src/domain/world-enemies.ts`：`refresh` 改为 revision/逻辑帧驱动，缓存生成点集合；失效点：死亡冷却到期、任务状态、剧情可见性、队伍人数、读档。
5. `src/rendering/combat-presenter.ts` + `effects.ts`：方向未变时只更新位置和现有 tween；按 heading 分桶复用 Sprite，仅换向时切 clip。
6. 可选：`enemy-ai.ts` 加 `nextDecisionAt`，只节流索敌与选技；接触、仇恨新增、召唤入场、目标失效时立即唤醒。

**验证**

```bash
npm run typecheck
npm test -- tests/enemy-ai.test.ts tests/enemy-threat.test.ts tests/combat-threat-system.test.ts tests/combat-condition-frames.test.ts tests/combat-periodic.test.ts tests/combat-state-frames.test.ts tests/friendly-summon-ai.test.ts
```

补回归：召唤中途入场在一个决策周期内抢到仇恨；隐身/嘲讽/目标死亡后清目标；风筝时追击不丢目标；HP 阈值技能及时释放；仇恨快照恢复后索引与容量淘汰一致。

---

### 方案 D：只增记录与召唤物资

**结论**：可破坏物记录按完整 id 覆盖写入，并同步删掉该 id 的会话死亡状态；旧档读入时惰性清理。`dealtDamage` 在 `destroyEnemy` 统一删除。不要用索引或上限掩盖问题。

**已核实证据**

- `ChestVisits.spawnBreakableEnemies`（`src/domain/chests.ts:55-61`）无条件 `push`，id 为 `breakable:${visit}:${map}:${key}:${index}`；`enterMap`（`:38-43`）同图直接返回，不清理。
- `captureState`（`chests.ts:28`）包含 `enemies`；`Session.capturePersistentState` 收录 `chests`（`src/domain/session.ts:474`），所以记录会进存档。
- 可破坏物槽位默认 60 秒重生，同槽再次被杀会以相同 id 再 push；第一条记录死亡后写成永久死亡，后续同 id 永远无法生成。这既让数组增长，也造成「打碎后不再出怪」。
- `WorldEnemyRoster.refresh()` 每渲染帧遍历 `spawns`（含 `chests.spawns`），所以历史记录越多，每帧扫描越慢。
- `dealtDamage`（`world-combat.ts:804`）在造成伤害时 add（`:1206`），唯一 delete 在复活（`:2701`）；`destroyEnemy`（`:652`）清血量、冷却、仇恨，但没有删它。召唤物 id 全局递增，每次召唤都是新 key。

**候选方案**

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| D1 写入覆盖 + 删死亡状态 | 同 id 先删旧记录，再写新记录；旧档读入去重并丢永久死亡 | 数组上界=当前图可破坏槽数；同时修重生 bug | 同槽旧怪仍存活时的替换语义要定 |
| D2 增量索引/上限 | 内部 Map，只遍历活跃 id，超限淘汰 | 每帧 O(活跃) | 不修永久死亡 bug，只推迟卡顿；淘汰可能丢活怪 |
| D3 死亡即删 | 敌人死亡时删对应 `breakable:` 记录 | 数组只含活怪 | 前缀判定脆，其他移除路径仍会漏 |

**评审结论**

A 的最强理由是「id 复用 + 状态按 id 永生化」才是本质，记录条数只是症状；覆盖写入让「一条记录 = 槽位当前占用」，一次解决遍历量、重生和存档膨胀。B 的最强理由是只增记录本来是宝箱/泉水/遭遇的设计前提，增量索引不改语义。B 最难回答的是：它不修玩家真正感知的「打碎后不再出怪」。**推荐 D1。**

**推荐实施步骤**

1. `src/domain/chests.ts - spawnBreakableEnemies`：写入前按完整 id 删除同 id 旧记录，返回被移除的 id；`revisionValue` 只加一次。
2. `src/domain/session.ts`：新增包装，对每个被移除 id 调 `forgetEnemyVitals(id)`；删除时机是新记录写入瞬间。
3. `src/domain/session.ts - restoreState`：按 id 去重保留最后一条；删除 `breakable:` 前缀且 `deadUntil==='permanent'` 的记录及对应状态；`chest:`/`spring:` 的永久死亡必须保留，否则宝箱怪读档后可重复刷。
4. `src/scenes/world-combat.ts - destroyEnemy`：加 `this.dealtDamage.delete(enemy.key)`；玩家/伙伴的 id 不额外删。
5. `src/domain/world-enemies.ts - refresh`：移除生成点时同步清理 `sources`，避免只增。

**验证**

```bash
npm run typecheck
npm test -- tests/chests.test.ts tests/breakable-drops.test.ts tests/saved-game.test.ts tests/world-enemies.test.ts
```

补用例：同槽连续两次生成只留一条，首条死亡后第二条可生成；旧档重复 id + permanent 状态读入后自愈；`chest:`/`spring:` 不受影响；召唤物移除后 `dealtDamage` 无该 key。

---

### 方案 E：技能素材补载

**结论**：采用「增量补载 + 关图统一释放」。两级版本门控把签名成本降到常数级，只加载 `missingSceneAssets` 的 delta，失败按目标退避；不引入「替换旧租约 + 定时释放」的启发式方案。

**已核实证据**

- `start` 同时订阅 hero 与 session（`world-combat.ts:2321`）；英雄每次 `setHealth/setMana` 通知，Session 又 emit，所以一次受击至少触发两次 `scheduleSkillAssetRefresh`（`onHeroChanged:2582`、`onPartyChanged:2568`）。
- 每次调度都算签名：`learnedSkillIds` 内部 `draft()` 是 `structuredClone`（`skill-configuration.ts:33`），再 sort、`equipmentItems`、`JSON.stringify`。签名没变时，还要为每个上阵伙伴再算一遍。
- 变化时用整份 `playerCombatAssets`/`partyMemberCombatAssets` 加载，成功后把 lease push 进 `extraSkillLeases`；旧 lease 不释放，直到 `destroy()`（`:2901`）。
- 失败时签名不推进，catch 只 warn；下一次任意 hero/session 通知立即重试整包，没有退避。
- `await` 后只检查 `closed`，不复查成员是否仍上阵；`syncAllies` 有正确复查（`:2018-2022`）。
- 渲染安全方面：在播特效生成时自己持有租约到销毁（`src/rendering/combat-effects.ts:19`），所以「旧租约保留到关图」不会让在播特效丢图。`missingSceneAssets` 已导出（`src/rendering/scene-assets.ts:92`），可以只算缺失项。

**候选方案**

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| E1 全量 + 最新租约替换 | 每 owner 保存最新 lease，新载成功后延迟释放旧 lease | 内存有界 | 固定延迟无法证明所有渲染对象都不再引用纹理 |
| E2 全量 + 关图释放 | 只加门控、单飞、失败退避 | 改动小，渲染零风险 | 每次变更仍整包抬高引用计数，纹理只减缓增长 |
| E3 增量 + 关图释放 | 门控后算语义签名，只载缺失项，按 owner 记录 delta lease | 只持有真正新增的纹理；切回旧装备 delta 为空 | 旧装备特效保留到关图 |

**评审结论**

关键变量是「是否整包租约」，不是「是否延迟释放」。整包会让每次变更为全部键加一，还可能让引用计数大于 1，阻塞缺帧重建；改成 delta 后，保留的恰好是后续仍要用的技能素材，保留即正确。立即释放旧租约的风险在于无法证明所有 sprite/clip 都已停止引用。**推荐 E3。**

**推荐实施步骤**

1. `world-combat.ts`：`extraSkillLeases` 改为 `Map<ownerId, AssetLease[]>`；新增廉价 gate（玩家用 `classId|actor.id|skills.version|skills.resetVersion|hero.bag.revision`，伙伴用 `classId|definition.actor|skills.version|level`）和失败退避表。
2. `scheduleSkillAssetRefresh`：先比 gate，不变直接返回；变了再算语义签名（玩家含 sorted 已学技能 + 装备 JSON，伙伴含 sorted 已学技能）。
3. `refreshSkillAssets`：每个目标独立 try/catch；完整计划先过 `missingSceneAssets`，空 delta 只推进签名；成功 lease 追加到该 owner 组。
4. `await` 后复查：玩家重算签名并核对 `classId/actor.id`；伙伴核对 `party.get(id)===member`、仍在上阵、签名仍等于捕获值；不满足就释放并跳过。
5. 失败退避：按 owner 记录尝试次数和下次时间，1s 起步、30s 封顶、加抖动；成功或期望签名变化时清零；`closed` 后不再布防。
6. 释放：delta lease 保留到 `destroy`/场景 shutdown；伙伴离队后延迟约 2 秒释放该组，同 id 回流则取消；`destroy` 保持「先清战斗特效，再释放租约」的顺序。

**验证**

```bash
npm run typecheck
npm test -- tests/combat-skill-assets.test.ts tests/scene-assets.test.ts tests/world-runtime-review.test.ts tests/world-effects.test.ts tests/world-combat-roster-sync.test.ts tests/party-combat.test.ts tests/session.test.ts
```

补用例：学新技能只载 delta，重复受击不再 load；换武器后旧特效仍可播、切回旧武器 delta 为空；伙伴加载中离队不落 lease；失败后 10 次通知不重试；关图每个 lease 只释放一次；在播特效跨刷新仍存在。

---

### 方案 F：音频、内容与纹理缓存

**结论**：音频用「收窄预载 + 全局字节 LRU + 会话边界清空」；内容缓存实测只有约 10–20MB，保持常驻、只在回菜单/新会话清空；纹理优先拆出玩家/共享战斗租约并把地图历史降到 2，而不是单纯 3→1。真正的大头是特效图集。

**已核实证据**

`npm run report:assets` 的实测输出：

- 磁盘 168.2MB，唯一内容 116.2MB；重复 1918 组、6658 个多余文件，磁盘重复 52.1MB，**解码重复约 2114.2MB**。
- 重复大头是同一张图按方向存了多份，例如 `battle-effects/hellsword-swing` 的 default/east/south 四份、`enemy-dragon-alexander-1` 的技能按方向各一份。
- 音频：`prepareCombat`（`src/application/game-audio.ts:183`）每战预载去重后 131/170 个 `se`；全部 `se` 解码约 64.5MB，BGM 单曲平均约 22.6MB，`MUSIC_CACHE_RETENTION=1`。`se:*` 没有任何淘汰路径。
- 内容：`ContentLoader.requests` 成功请求只置 `finished`，不删除（`src/application/content-loader.ts:127`）；416 张地图源文件 6.5MB，244 个 pose 单条约 29KB；全量常驻约 10–20MB。
- 纹理：`app.ts` 历史最多 3 张 + 预取 1 + 剧情预取 2，最多 6 个地图租约；每图完整贴图均值约 3.7MB、最高 15.7MB。特效图集 13 页，解码约 146.1MB；`hellsword-swing` 6 页约 75.1MB。

**候选方案**

音频：

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| F-A1 全局字节 LRU | 记录最近使用和解码字节，按预算淘汰 | 严格封顶 | 可能淘汰刚预载未播放的音效 |
| F-A2 收窄预载 + 整批释放 | 只预载本战敌人/武器/技能，战后释放 | 降低战斗入口峰值 | 不解决懒加载后的永久驻留 |
| F-A3 混合（推荐） | 收窄预载 + 全局 LRU + 会话边界清空 | 峰值和稳态都受控 | 需要「预载世代」避免未播先淘汰 |

内容：

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| F-B1 地图/pose LRU | 热路径设容量 | 理论上界 | 收益只有数 MB，却给换图加重新解析 |
| F-B2 保持常驻 | 维持现状 | 零切换抖动 | 跨会话单调增长 |
| F-B3 常驻 + 会话边界清理（推荐） | 回菜单/新游戏清 map/pose | 消除跨会话累积 | 重开游戏首次进图略慢 |

纹理：

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| F-C1 历史 3→2/1 | 只改容量 | 省 1–2 张图 | 回退地图重载；不释放特效图集 |
| F-C2 拆分玩家/共享战斗租约 | 地图租约只含地图专属 | 地图裁剪不再钉住大图集页 | 首次进图、技能补载生命周期要重接 |
| F-C3 C2 + 历史 2 + 预算（推荐） | 结构性降低高水位 | 最大 | 换图可能触发重载 |

**评审结论**

音频：纯 LRU 不减少战斗入口解码尖峰，纯整批释放又遗留懒加载缓存并让常见命中音反复解码。三方会诊的共识是「当前战斗集和常见命中音固定不可淘汰，其余按预算淘汰」。推荐 F-A3。

内容：实测证伪了「解析树很大」的前提，热路径 LRU 不值得，推荐 F-B3。

纹理：3→1 只省几 MB，真正的问题是共享战斗图集被每个地图租约重复持有；拆分租约才能让地图历史不再钉住 146MB 级特效页。推荐 F-C3，但特效图集按技能/按页懒加载（D18）单独排期。

**推荐实施步骤**

1. `game-audio.ts - prepareCombat`：改为接收本战敌人/召唤物 id，保留武器音效和参战技能，去掉全部敌人的无条件预载。
2. 同文件：记录 `se` 的最近使用、解码字节、预载世代；命中时 touch。
3. 同文件：新增 `trimEffects`，按「未播放旧预载 → LRU → 大体积」淘汰，跳过正在播放；低端 48MB/96 key，桌面 64MB/128 key。
4. 同文件：回菜单/新会话只清 `se:`，保留当前 BGM。
5. `content-loader.ts`：标记 map/pose 可淘汰；`main.ts` 回菜单/新会话调用 `clearSessionCaches()`，只清 map/pose，不清 campaign/battle 等核心表。
6. `src/app.ts`：地图历史 3→2、故事预取 2→1；新增 `clearMapHistory()`。
7. `map-assets.ts` 与 `world-combat.ts`：把玩家/共享战斗素材从地图计划里拆出来，改成独立 lease。

**验证**

```bash
npm run report:assets
npm run typecheck
npm test -- tests/content-loader.test.ts tests/scene-assets.test.ts
npm run test:content-build
```

浏览器 `?perf` 跑 90 分钟：`[...game.cache.audio.getKeys()].filter(k=>k.startsWith('se:')).length`；解码 MB 按 `AudioBuffer.length * numberOfChannels * 4` 求和；`game.renderer.info.memory.textures`；换图耗时；90 分钟内 FPS 是否持续下滑。

判定线建议：`se` 解码 ≤48MB、key ≤96、纹理解码峰值比基线下降 ≥30%、换图 P95 退化 ≤10%。

---

### 方案 G：存档快照与剧情导演通知

**结论**：以「按子系统 revision 的持久化快照缓存」为主，配合导演用 revision/引用门控的 O(1) 快路径；不把 `capture+write` 放进 idle 当主方案，事件驱动频率也不降低。

**已核实证据**

- `AutoSaver.flush` 在 setTimeout 回调里同步 `capture()+write()`（`src/application/auto-save.ts:58-90`）；`capture` 深拷贝整份会话，`write` 再 `JSON.stringify` 并同步 `localStorage.setItem`。
- `Session.capturePersistentState`（`session.ts:468-476`）每次克隆 receipts、敌人状态、背包 captureState；这些数据随进度增长。
- `StoryDirector.observeChanges`（`story-director.ts:173-222`）：任务和背包已按版本门控，但每次 emit 仍 `new Set(completedEvents)`、复制 choiceWrites、重建 encounterStatuses。
- `Session.emit`（`session.ts:727-730`）先 `refresh()` 再同步通知；战斗中掉血/回蓝/施法都会 emit。

**候选方案**

| 方案 | 做法 | 收益 | 风险 |
|---|---|---|---|
| G1 idle 调度 | `requestIdleCallback` + 超时兜底 | 改动小，把尖峰挪出触发帧 | 持续渲染时 idle 预算可能接近 0；延迟 capture 可能读到错代状态；`setItem` 仍同步 |
| G2 revision 快照缓存 | 按 questBook/bag/storyWorld/chests/敌人/收据的版本缓存克隆 | 单价从 O(总进度) 降到 O(脏切片)，后台写更快 | 漏 bump 一处就静默存旧数据 |
| G3 降频/裁剪 | 定时器 5→10 分钟，或裁掉永久死亡敌人/收据 | 实现最便宜 | 放大崩溃丢进度；裁剪会改重生与奖励幂等语义 |

**评审结论**

G1 只改「何时做」，不改「做多少」，且 idle 在低端机不可靠；G2 能复用项目已有的 `bag.revision`、`questBook.version`、`storyWorld.revision`、`restoreRevision`，而且 `captureState` 本来每次返回克隆，天然可缓存；难点是失效纪律。**推荐 G2 为主，G1 仅作为二期可选的非后台写调度，G3 只在测量后微调。**

**推荐实施步骤**

1. `session.ts`：新增运行时计数器 `choiceWriteRevision`、`receiptRevision`、`enemyRevision`，在所有 mutation 点递增，restore/rollback 时重置；它们不持久化。
2. `story-world.ts`：encounters 增加 `encounterRevision`，`encounterStatuses()` 按版本缓存不可变结果。
3. `session.ts - captureStateWith`：按版本缓存 questBook、storyWorld、bag（校验只在脏时做）、receipts、enemies、chests、groundLoot；体积小且不随小时增长的字段继续每次抓取。
4. `story-director.ts - observeChanges`：choice 看 `choiceWriteRevision`，encounter 看 `encounterRevision`，completedEvents 看数组引用；未变时跳过扫描和 observed 表复制。
5. `auto-save.ts`：保持 `flushForBackground` 同步；`flush` 仍同步 capture+write。只有在测量显示写耗时超过 16ms 后，才评估「同步 capture + idle write」。
6. `save-game.ts`：不改结构、不升 `SAVE_FORMAT`、不做分片 JSON，保持单 key 全量记录和云存档语义。

**验证**

```bash
npm run typecheck
npm test -- tests/auto-save.test.ts tests/story-director-quest-observe.test.ts tests/session.test.ts tests/save-game.test.ts tests/saved-game.test.ts
```

补用例：连续无变化 emit 不触发导演扫描；事件/选择/遭遇变化各触发一次；同选项连选两次仍算两次；缓存后修改实时状态不污染已捕获快照；restore/rollback 后下一次 capture 必须反映恢复态。

---

## 四、交叉依赖与实施顺序

### 交叉依赖

- **A 与 C** 都会碰 `combat-conditions.ts` 和队伍/条件版本号。先做一次版本号基础设施（A 的 `groupModifierVersion`、B/C 的 `conditions.revision`），再分别接缓存。
- **D 与 G** 都会碰敌人状态。D 删除 `breakable:` 状态时要 bump G 的 `enemyRevision`，否则存档缓存会保留已删数据。
- **E 与 F** 都会碰战斗素材租约。先做 E 的 delta 租约，再做 F 的共享租约拆分，避免两次改同一段生命周期。
- **B 与 G** 都会给 `storyWorld` 加 revision。合并为一次改动，避免两个版本号含义重叠。

### 建议阶段

**阶段 0：测量（不改行为）**

- 加 dev-only 计数器：`draft` 调用数、`partyPassives` 调用数、`afterMovement` 耗时、`capture`/`write` 耗时、`se` 解码字节、纹理解码字节。
- 在 4002 或 APK 用 `?perf` 跑 10 分钟、30 分钟、90 分钟各一次基线。
- 跑 `npm run report:assets` 存档基线。

**阶段 1：低风险、直接见效**

- A：技能表与 passives 惰性缓存，删除逻辑帧重复的快捷栏刷新。
- D：可破坏物记录覆盖 + 召唤物伤害标记清理。
- E：两级门控 + delta 补载 + 失败退避。

**阶段 2：中等改动**

- B：地图事件索引 + 整图刷新签名 + HUD 签名。
- C：Combatant 快照、仇恨索引、条件遍历、名册失效驱动、飞行物复用。
- G：revision 快照缓存 + 导演快路径。

**阶段 3：内存与可选优化**

- F：音频收窄预载 + LRU + 会话清理；内容会话边界清理；地图历史 2。
- 可选：F 的共享战斗租约拆分；D18 特效图集按技能/按页懒加载；C 的 180ms AI 闸门；G 的 idle 写调度。

每阶段结束后跑该阶段相关测试，并用 `?perf` 对比阶段前的基线。如果某个阶段的收益低于预期，先停在该阶段复盘，不要继续叠加。

---

## 五、验证与验收

### 命令

```bash
npm run typecheck
npm test -- tests/<相关用例>.test.ts
npm run report:assets
npm run test:content-build   # 只有改动素材/内容构建时
```

### 观测指标

- `?perf` 每 30 秒上报：p50/p95/max 帧时间、update p95、render p95、50ms/100ms 长帧数。
- 长局稳定性：10 分钟、30 分钟、90 分钟三个时间点的 p95 与长帧数不应持续抬升。
- 内存：强制 GC 后的 `performance.memory.usedJSHeapSize`；`game.renderer.info.memory.textures`；`cache.audio` 的 key 数与解码字节。
- 存档：单次 `capture` 与 `write` 耗时、存档字节数。
- 策略：不主动启动浏览器，实际手感与设备表现由你在 4002 或 APK 上验收。

### 建议验收线

- 帧时间 p95 比基线下降 ≥20%，长帧（>100ms）数量下降 ≥30%。
- 90 分钟内堆和纹理数量不再单调上涨。
- `se` 解码 ≤48MB，`cache.audio` key ≤96。
- 换图 P95 退化 ≤10%，剧情触发序列与改动前完全一致。

---

## 六、本次不做的范围

- **不升级 Phaser，也不改渲染器。** 当前瓶颈在 JS 每帧计算和分配，GPU 不是瓶颈。
- **不改存档结构。** 除非你选择 D11 的显式迁移，否则 `SAVE_FORMAT` 保持 42。
- **不做增量 JSON 序列化。** 会破坏单 key 存档与云存档 `readRaw` 语义。
- **不裁剪永久死亡敌人或任务收据。** 会改重生与奖励幂等语义。
- **不做素材内容去重。** `report:assets` 显示约 2114MB 解码重复，最大来源是同一张图按方向存多份。这是目前看到的最大单项内存杠杆，但要改构建产物和内容引用，建议另立项目，不混进这次修复。

---

## 七、核查可信度说明

- 所有 `文件:行号` 都回到当前提交核对过；其中两处修正了初步报告：
  - `updateInteractionTarget` 每帧调用 `session.refresh()` 属实，但当前内容的条件输入全是任务引用，事件/选择/标记/世界变量输入为 0，所以目前几乎立即返回；它是隐患，不是当下的主因。
  - 技能补载「立即释放旧租约会让在播特效丢图」这一担心不成立：战斗特效自己持有租约到销毁。真正需要谨慎的是其他未审计的 sprite/clip 路径。
- 收益数字里，只有 `report:assets` 的体积与重复解码是实测；每秒 800–1100 次克隆、候选扫描平方级等是按调用路径推算的数量级，实施前应以阶段 0 的计数器为准。
- 本轮没有修改任何代码，只新增了这份文档。
