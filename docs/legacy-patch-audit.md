# 正式版遗留补丁审计与清理依据

正式版以 v1.0.10 写出的 59 格式存档为最低承接范围。可以优先清理 33～58 的升级入口；每次读档都会执行的修复集中在 3.1 的 S02～S07 和 S17～S21。已经进入 59 格式存档的历史技能点、成长基准和装备归属仍是玩家进度，不能随旧升级函数一起删除。

本清单只记录现状和后续处理依据，没有修改存档、玩法或兼容规则。清理完成后，以代码和对应规则文件维护最终行为，本清单不作为永久兼容约定。

## 1 审计基线与统计

- 基准提交：`66080233f1b38fc5a86ed8d294c2fd261d0b11ea`，审计日期：2026-11-17。
- 基准提交时全部可达历史共 **1079 条提交**，起于 [7f5578b6](https://github.com/sunflower9264/inoita-game/commit/7f5578b6)；当前 HEAD 为 1081 条（多出本审计文档与 README 改名两次提交）。扫描全部提交标题与正文，并结合相关文件历史、关键差异和当前符号调用核对候选项；不是逐条人工审阅全部提交的完整差异。
- 枚举 `src/`、`tools/`、`android/`、`public/content/` 下 **844 个**受 Git 管理的 TS、MJS、Java、JSON 文件。对 `src/` TypeScript 做语法结构扫描，检查恢复函数中的缺省值、迁移与清理调用，再读取候选实现。另外解析了 435 份内容 JSON，12 个旧道具 ID（4 个背包、7 个删除道具及独立解锁书）均未作为道具定义键或可获取引用出现；`resurrection-prayer` 仅作为 18 处地面贴图的共用路径出现在字符串值里。工具及 Android 结合引用和提交检查；枚举数不代表逐文件完成语义证明。
- 当前 `SAVE_FORMAT = 59`，接受旧格式 33～58，共 **27 种可读格式、26 步迁移**。其中 **6 步只改格式号，20 步实际修改数据**。
- 下文共 **65 个审计单元**。同一机制的多次修订合并记录；26 步迁移包含在 S01 内，不与单元数相加。此数是本次确认和待确认项目的数量，不是“全仓库所有 bug 修复”的数量。2026-11-17 复核补入了 18 个读档、装备、平台和本机偏好漏项，并把 4 个混写单元拆出读档部分，共 65 个单元。

| 判定 | 数量 | 含义 |
| --- | ---: | --- |
| A 条件清理 | 19 | 以承接 59 为前提，具备退出方向；仍需完成该项列出的数据与入口验证 |
| B 保留 | 29 | 当前玩法、持久数据或资源生命周期仍使用，停止旧格式兼容不能作为删除理由 |
| C 收拢 | 12 | 缺省值或适配散在恢复流程；应先明确写入契约，再决定统一入口或严格校验 |
| D 待确认 | 5 | 删除条件尚无充分证据，单独列出需要补充的验证 |

“59 格式存档”指原始 JSON 的 `format` 为 59。v1.0.10 的云上传、改名等操作可以保留旧格式原文，不能把“曾经由 v1.0.10 打开过”当作已经转换。按本次目标，33～58 的原始档不再属于正式版必须承接的范围；本次没有替玩家转换或删除它们。

## 2 存档升级链

唯一集中升级入口是 [saved-game.ts](../src/application/saved-game.ts) 的 `SAVE_UPGRADES` / `upgradeSavedGame`；版本接纳由 [save-game.ts](../src/domain/save-game.ts) 的 `LEGACY_SAVE_FORMATS` / `saveFormatStatus` 管理。下表提交是该步骤首次进入当前文件历史的依据。

| 迁移 | 当前实际处理 | 引入提交 | 停读 59 以前格式后的处理 |
| --- | --- | --- | --- |
| 33→34 | 剧情运行时版本 1→2；丢弃缺少新舞台字段的旧快照 | [e27ef73a](https://github.com/sunflower9264/inoita-game/commit/e27ef73a) | 删除步骤及专用旧类型 |
| 34→35 | 对技能快捷栏去重 | [b2970691](https://github.com/sunflower9264/inoita-game/commit/b2970691) | 删除步骤，保留当前快捷栏规则 E06 |
| 35→36 | 隐藏重复世界演员；丢弃含重复演员的舞台快照 | [9ba9e40c](https://github.com/sunflower9264/inoita-game/commit/9ba9e40c) | 删除迁移专用检测与隐藏函数；当前人物投影另查 |
| 36→37 | 只改版本号，改变的是新档写法 | [c5e6774e](https://github.com/sunflower9264/inoita-game/commit/c5e6774e) | 删除步骤 |
| 37→38 | 旧掉落保底转为三类计数；旧 rarePlusMisses 转 uniqueMisses | [c3336b61](https://github.com/sunflower9264/inoita-game/commit/c3336b61) | 删除步骤和专用旧计数类型，保留当前保底玩法 |
| 38→39 | 补空的古老武器领取记录 | [b580709a](https://github.com/sunflower9264/inoita-game/commit/b580709a) | 删除步骤，保留领取状态 |
| 39→40 | 修复 event-115 对神殿大厅 7 个固定恶灵生成点的永久删除与抑制标记 | [97bbb725](https://github.com/sunflower9264/inoita-game/commit/97bbb725) | 删除该场景专用迁移、固定 ID 表及仅供它使用的辅助函数 |
| 40→41 | 补空的保留道具领取与保底记录 | [585352c8](https://github.com/sunflower9264/inoita-game/commit/585352c8) | 删除步骤，保留当前掉落记录 |
| 41→42 | 删除旧自动反击和受击计数字段 | [58657846](https://github.com/sunflower9264/inoita-game/commit/58657846) | 删除步骤和专用旧类型 |
| 42→43 | 只改版本号；截图是可选字段 | [2b962de1](https://github.com/sunflower9264/inoita-game/commit/2b962de1) | 删除步骤，截图空缺的界面行为可保留 |
| 43→44 | 清掉 9 条废案任务的任务簿、运行名单、奖励记录与追踪 | [17ccb979](https://github.com/sunflower9264/inoita-game/commit/17ccb979) | 删除步骤及 REMOVED_QUESTS 表 |
| 44→45 | 为所有物品实例补未锁定状态 | [de90eaf6](https://github.com/sunflower9264/inoita-game/commit/de90eaf6) | 删除步骤，保留手动锁定功能 |
| 45→46 | 为全部队伍成员记录旧成长基准和空的手动能力分配（只有佣兵消费这些值） | [e4fea344](https://github.com/sunflower9264/inoita-game/commit/e4fea344) | 删除步骤，保留已经写入的成长基准 N02 |
| 46→47 | 补剧情动作保持标记；按固定事件恢复主角及跟随者显隐 | [1ff5fca4](https://github.com/sunflower9264/inoita-game/commit/1ff5fca4) | 删除递归扫描与事件白名单；保留正常动作恢复 |
| 47→48 | 只改版本号；新增的是地图人物引用校验 | [89a111c8](https://github.com/sunflower9264/inoita-game/commit/89a111c8) | 删除步骤，保留引用校验 |
| 48→49 | 只改版本号；新档不再重复保存敌人外观 | [9b509bc2](https://github.com/sunflower9264/inoita-game/commit/9b509bc2) | 删除步骤，旧外观字段另查读取入口 |
| 49→50 | 只改版本号；新增的是地图敌人引用校验 | [4e935c8c](https://github.com/sunflower9264/inoita-game/commit/4e935c8c) | 删除步骤，保留引用校验 |
| 50→51 | 各成员保底逐项取最大值，改为全队一份 | [4fa2601f](https://github.com/sunflower9264/inoita-game/commit/4fa2601f) | 删除步骤，保留共享保底与既有进度 |
| 51→52 | 为成员补空的技能书等级表 | [500c3893](https://github.com/sunflower9264/inoita-game/commit/500c3893) | 删除步骤，字段是否可缺省见 S10 |
| 52→53 | 为成员补空的技能解锁表 | [b9ea068f](https://github.com/sunflower9264/inoita-game/commit/b9ea068f) | 删除步骤，保留现有解锁语义 |
| 53→54 | 补空的剧情伙伴退役装备表 | [26f2e514](https://github.com/sunflower9264/inoita-game/commit/26f2e514) | 删除步骤，保留装备实例归属 E02 |
| 54→55 | 只改版本号；旧主角姿态按地图缺省 | [31ee6930](https://github.com/sunflower9264/inoita-game/commit/31ee6930) | 删除步骤，姿态缺省契约见 S12 |
| 55→56 | 自动技能成长转手动分配；拆出技能书等级，补足历史点数预算 | [808b4b4d](https://github.com/sunflower9264/inoita-game/commit/808b4b4d) | 删除 migrateMercenarySkills，保留已经保存的补点 N01 |
| 56→57 | 合并佣兵成员与旧书的技能解锁资格为共享记录，清理独立解锁书引用 | [718e6b64](https://github.com/sunflower9264/inoita-game/commit/718e6b64) | 删除 migrateSharedSkillUnlocks；保留共享资格 E04 |
| 57→58 | 从正常死亡期限推导画面外提前复活期限 | [fec73e09](https://github.com/sunflower9264/inoita-game/commit/fec73e09) | 删除步骤，保留新刷新机制 W03 |
| 58→59 | 清理未穿戴的剧情专属装备、格位、退役引用、快捷栏和地面残留 | [debdcf87](https://github.com/sunflower9264/inoita-game/commit/debdcf87) | 删除 migrateStoryEquipmentInventory；保留当前装备限制 E03 |

S01 的退出还要同步处理本地槽位、云端上传下载的格式分类、旧格式测试、`SavedGameContent` 中仅供迁移读取的依赖，以及规则文件和长期文档中的旧范围说明。除各级 `AGENTS.md` 外，`docs/module-guide.md` 和 `docs/architecture.md` 曾把当前格式写成 44、56，已在本次复核中改成 59；`docs/cloud-save.md` 和 `docs/story-content.md` 仍描述旧格式读取，退出时要一起改。不能只删表、留下仍宣称可读的版本列表。35→36 的重复演员收敛和 48→49 的旧敌人外观读取分别见 S22、S23。

## 3 当前代码中的审计清单

表中的测试是后续清理的验证入口，不表示本次运行过。符号名用于准确定位；提交可用 `git show <提交> -- <文件>` 检查。A 项仅是有条件的清理候选，没有宣称相关 59 格式数据已经实测为零。

**先分清当前规则和读档修补。** 同一个机制常有两层：

1. **产生新数据时执行的规则**：正常入包、正常写档、正常战斗时执行的校验、合并、上限和拒绝非法状态。这是当前玩法或 bug 修复本身，保留。
2. **读档/恢复时对已写进存档的数据做事后改写**：补字段、去重、收拢实例、删除残留、重算派生值。这才是遗留补丁的清理对象。

判断方法：问“新游戏、正常入包、正常写档时，这个分支会不会执行？”会，就是当前规则；只有读回旧档才会命中的，才是读档修补。

例如同类物品堆叠：E05 的同 ID 堆叠键和入包合并规则要保留；S03 在每次恢复时把旧档里分散的同 ID 实例收拢成一条，才是要删的读档改写。E06 的正常设置去重与 S24 的读档写入去重、S13 的正常结算防重与 S25 的旧轮次裁剪、S14 的生成时覆盖与 S26 的恢复时去重、S16 的运行期限长与 S27 的恢复时裁剪，都按同一方法拆开。B 项如果包含会改写玩家旧数据的读档分支，应拆成 B（规则）+ A（修补），不能整项保留。

### 3.1 读档与恢复

| 编号与判定 | 位置与历史依据 | 当前触发与处理建议 | 验证入口 |
| --- | --- | --- | --- |
| S01 A | [application/saved-game.ts](../src/application/saved-game.ts)：SAVE_UPGRADES / upgradeSavedGame；上表 26 步 | 仅 format 非 59 时升级。停止接纳 33～58 后整体退出；保留未来正式版承接 59 的能力 | saved-game、save-game、cloud-save-sync |
| S02 A | 同文件：migrateLegacyItems；[e57430e8](https://github.com/sunflower9264/inoita-game/commit/e57430e8)、[8b58a047](https://github.com/sunflower9264/inoita-game/commit/8b58a047)、[a8dbb035](https://github.com/sunflower9264/inoita-game/commit/a8dbb035)、[ef6bc9a8](https://github.com/sunflower9264/inoita-game/commit/ef6bc9a8) | **59 也扫描**。4 种旧背包替换为药水/灵药，5 种骰子、洗点道具、复活圣文共 7 个 ID 删除；涉及实例、格位、快捷栏、奖励记录、地面和货架。货架分支只过滤 7 个删除 ID，4 种背包替换不处理货架。确认 59 写入及正常内容不再产生这些 ID 后退出 | saved-game、reserved-items |
| S03 A | [domain/save-game.ts](../src/domain/save-game.ts)：restoreSaveGame → [domain/bag.ts](../src/domain/bag.ts)：mergeStackedInstances / mergeStackableInstances；[ada233c0](https://github.com/sunflower9264/inoita-game/commit/ada233c0)、[de07e527](https://github.com/sunflower9264/inoita-game/commit/de07e527) | **每次恢复都先拍背包快照再检查重复**。旧实例收拢与正常入包叠加分开；确认正常写入不会产生可合并的重复实例后删除读档收拢，保留 E05 | bag-stacking、save-game |
| S04 A | [application/saved-game.ts](../src/application/saved-game.ts)：repairStaleFishcake；[03ad5176](https://github.com/sunflower9264/inoita-game/commit/03ad5176) | **59 也执行**。quest-252 已接取时清理鲤鱼饼，覆盖背包、快捷栏关联处理和地面；根因是 event-312 多余 item-drop，内容已修正。覆盖该任务前后 59 存档再退出 | saved-game、content |
| S05 A | 同文件：prepareSavedGame → `Session.seedReservedClaims`；[585352c8](https://github.com/sunflower9264/inoita-game/commit/585352c8) | **每次读档扫描背包、整份物品目录与已学配方**，补旧领取记录。先证明新获取入口都登记领取状态，且 59 的领取表完整；否则迁到唯一读取入口一次补齐，不能直接删防重复领取语义 | reserved-items、saved-game |
| S06 A | 同文件：prepareSavedGame 的 !hasLivingMember 分支；[a8dbb035](https://github.com/sunflower9264/inoita-game/commit/a8dbb035) | **59 也检查并给上阵队伍恢复满状态**（`PartyRoster.recover` 只取主角和 `activeIds.slice(1)`，预备队不恢复）。旧全灭档补救可退出；需保留活队员切换控制与禁止全灭写档的规则 | saved-game、save-game、auto-save |
| S07 A | [domain/combat-snapshot.ts](../src/domain/combat-snapshot.ts)：pruneOrphanSummons / prepareCombatRestore；[ce762948](https://github.com/sunflower9264/inoita-game/commit/ce762948) | **59 与战斗恢复也执行**。删孤儿召唤及子树、分组、状态和仇恨。正常主人离场已同步移除子树。只有存档存在 `world.world` 战斗快照时 `prepareSavedGame` 才调用；若证明 59 生产路径无孤儿，可用严格引用校验替代修复，保留正常子树清理。焦点目标与派生缓存的恢复处理见 S19 | combat-snapshot、world-enemies、summon-lifecycle |
| S08 C | [application/saved-game.ts](../src/application/saved-game.ts)：prepareSavedGame 的 world.scene 条件；[e27ef73a](https://github.com/sunflower9264/inoita-game/commit/e27ef73a) | 缺快照时按位置与世界重投影。先列出 59 正常写入、调试和无画面剧情路径是否仍允许缺 scene，再收紧；单凭注释提到 33 不足以删除 | saved-game、title-save-entry |
| S09 C | [domain/session.ts](../src/domain/session.ts)：restoreUnchecked / restoreReservedDrops；[c3336b61](https://github.com/sunflower9264/inoita-game/commit/c3336b61) 调整 lootPity 默认版本，[585352c8](https://github.com/sunflower9264/inoita-game/commit/585352c8) 新增 reservedDrops；combatClock、cooldowns、frenzyAnimations、partyItemChance 和 restoreUnchecked 本身在当前历史中追溯到初始提交 [7f5578b6](https://github.com/sunflower9264/inoita-game/commit/7f5578b6) | combatClock、cooldowns、frenzyAnimations、lootPity、reservedDrops、partyItemChance、legendaryWeapons 等分别补默认值。恢复还服务检查点和事务回滚；统一必填/可选契约后收拢，不逐个机械删 ??。`legendaryWeapons` 可整段缺失，38→39 迁移为旧档补空，59 写档是否总带该字段需确认 | session、save-game、session-snapshot-cache |
| S10 C | [domain/party.ts](../src/domain/party.ts)：CompanionMember.restoreState / PartyRoster.restoreState；[e4fea344](https://github.com/sunflower9264/inoita-game/commit/e4fea344)、[500c3893](https://github.com/sunflower9264/inoita-game/commit/500c3893)、[b9ea068f](https://github.com/sunflower9264/inoita-game/commit/b9ea068f)、[718e6b64](https://github.com/sunflower9264/inoita-game/commit/718e6b64) | 成长基准、能力分配、技能书、个人/共享解锁分别缺省。59 写入已具有这些状态，但领域快照的可选声明和调用者还需统一。`Bag.writeState` 仍保留 `retiredEquipment??[]` 读档兜底，见 E02 | party、mercenary-skills、saved-game、bag |
| S11 C | [domain/combat-conditions.ts](../src/domain/combat-conditions.ts)：restoreState；[domain/enemy-ai.ts](../src/domain/enemy-ai.ts)：restoreState；字段在当前历史中追溯到初始提交 [7f5578b6](https://github.com/sunflower9264/inoita-game/commit/7f5578b6)；[73bd2d32](https://github.com/sunflower9264/inoita-game/commit/73bd2d32) 改的是 resourceCapacityInputs 的类型与性能路径，[940f38a1](https://github.com/sunflower9264/inoita-game/commit/940f38a1) 改的是一次性技能记账时机 | 战斗容量缓存、帧余数、交战标记、一次性技能消耗表可缺省。派生缓存可以重建，一次性技能记录是玩法数据；两者先分开定义 | combat-snapshot、combat-condition-frames、enemy-ai |
| S12 C | [domain/story-world.ts](../src/domain/story-world.ts)：restoreState；[rendering/story-presenter.ts](../src/rendering/story-presenter.ts)：restoreStage；stage.scenes 缺省和 restoreStage 本身追溯到初始提交 [7f5578b6](https://github.com/sunflower9264/inoita-game/commit/7f5578b6)；[31ee6930](https://github.com/sunflower9264/inoita-game/commit/31ee6930) 新增的是 town-pose 动作处理，姿态缺省实际在 [scenes/world-scene.ts](../src/scenes/world-scene.ts) 的 `playerTownPose ?? map.townPose`，54→55 只升格式号 | partyBuffs、enemyRemovals、appearances、enemyLocations、舞台 scenes 和姿态缺省。明确正式存档与临时舞台各自契约后收拢 | story-world、story-stage-isolation、saved-game |
| S13 B | [domain/session.ts](../src/domain/session.ts)：正常结算的奖励防重与周期上限；[1bd2075e](https://github.com/sunflower9264/inoita-game/commit/1bd2075e) | **正常结算**按任务周期防重复，只读最新一张收据。这是奖励规则，保留。读档时丢弃旧轮次的裁剪见 S25；事务回滚也复用同一恢复函数，拆分时要保留回滚正确性 | session-quest-core、save-game |
| S14 B | [domain/chests.ts](../src/domain/chests.ts)：生成记录覆盖；[74ca8d41](https://github.com/sunflower9264/inoita-game/commit/74ca8d41) | **可破坏物生成时**先删同 ID 再写入，保证同一槽位只有一条记录；泉水出怪仍直接追加，靠出怪后立即清空泉水。这是当前生成规则，保留。读档时去重和 `consumed??[]` 补空见 S26 | chests、breakable-drops |
| S15 A | [domain/session.ts](../src/domain/session.ts)：pruneBreakableEnemyStates；[74ca8d41](https://github.com/sunflower9264/inoita-game/commit/74ca8d41) | **读档时删除**永久死亡的 `breakable:` 记录和生成记录；chest/spring 保留。对象寿命规则本身保留；先证明 59 的死亡结算和回滚路径会持续清掉这些记录，再把读档清理退出，不能连寿命规则一起删 | chests、world-enemies、saved-game |
| S16 B | [domain/story-world.ts](../src/domain/story-world.ts)：正常运行时的完成遭遇上限；[fab7c60d](https://github.com/sunflower9264/inoita-game/commit/fab7c60d) | **正常运行期**已完成遭遇最多保留 64 条，活动遭遇保留。这是容量规则，保留。恢复时对旧档无界历史的裁剪和 `forgetPrunedEncounterEnemies` 见 S27 | story-world、session、world-enemies |
| S17 A | [domain/session.ts](../src/domain/session.ts)：restoreUnchecked 的 lootPity 成员清理；[7a2a6ac2](https://github.com/sunflower9264/inoita-game/commit/7a2a6ac2) | **每次恢复都执行**。删除非主角、且已不在队伍里的 `lootPity.members` 记录。放逐成功时已同步清理；若确认 59 写档和放逐路径不会再留下这类记录，可改为严格校验或退出 | session-cooldowns-party、session、save-game |
| S18 B | [domain/quest-book.ts](../src/domain/quest-book.ts)：prepareRestore；追溯到初始提交 [7f5578b6](https://github.com/sunflower9264/inoita-game/commit/7f5578b6) | **每次恢复都执行**。把当前内容目录中存在、但存档里缺失的任务补成初始进度。内容更新新增任务时仍需，保留；如要收紧，先证明正式版不再新增任务，或改由内容版本迁移处理 | session-quest-core、saved-game、content |
| S19 C | [domain/combat-snapshot.ts](../src/domain/combat-snapshot.ts)：prepareCombatRestore 的焦点与缓存处理；[scenes/world-combat.ts](../src/scenes/world-combat.ts) 的恢复入口 | 恢复时清掉指向不存在角色的 `focusTargetId`，清空 `temporary/resourceCapacities/resourceCapacityInputs` 派生缓存，并把 AI 重置为 idle。派生缓存必须重建；焦点清理属于旧数据修复，先明确写入契约再决定严格校验还是保留 | combat-snapshot、world-runtime-review、world-enemies |
| S20 B | [domain/world-enemies.ts](../src/domain/world-enemies.ts)：WorldEnemyRoster.restoreState；[8c011e3c](https://github.com/sunflower9264/inoita-game/commit/8c011e3c) | 恢复时把 `breakableRolls` 和 `sources` 重新对齐到恢复后的名册身份，避免同 key 被当成换怪、死亡结算读到构造时随机身份。恢复一致性仍需，保留 | world-enemies、save-game |
| S21 A | [scenes/world-combat.ts](../src/scenes/world-combat.ts)：恢复名册后的 setPartySize；[fdbd3042](https://github.com/sunflower9264/inoita-game/commit/fdbd3042) | **读档后按当前上阵人数重算敌人强度基准**。若确认 59 写档总写当前人数、且菜单改队伍后一定写档，可退出；否则保留为读档修正 | world-runtime-review、party、save-game |
| S22 A | [domain/story-world.ts](../src/domain/story-world.ts)：登记接管与投影过滤；35→36 迁移 [9ba9e40c](https://github.com/sunflower9264/inoita-game/commit/9ba9e40c) | **旧档重复演员由投影收敛成一个实例**，测试直接覆盖旧档重复实例。停止读取 33～58 后，先确认运行时也不会产生同角色重复实例，再决定保留收敛还是改为严格校验 | story-world、story-world-projection、saved-game |
| S23 A | [scenes/world-scene.ts](../src/scenes/world-scene.ts)：恢复舞台时读取 `actor.appearance`；[scenes/world-combat.ts](../src/scenes/world-combat.ts)：`captureStoryActors` 的 `includeEnemyAppearance`；36→37 [c5e6774e](https://github.com/sunflower9264/inoita-game/commit/c5e6774e)、48→49 [9b509bc2](https://github.com/sunflower9264/inoita-game/commit/9b509bc2) | **旧档演员外观读取**。36 版舞台快照带完整外观，48 版存档带敌人外观；新档写档会剥离。停止读取 33～58 后退出这些读取分支，保留当前外观解析路径 | saved-game、story-stage-isolation、world-assets |
| S24 A | [domain/bag.ts](../src/domain/bag.ts)：writeState 的快捷栏去重；[b2970691](https://github.com/sunflower9264/inoita-game/commit/b2970691) | **每次恢复都执行**。`writeState` 对每个快捷栏行再跑一次 `dedupeSkillShortcuts`。正常设置入口已经去重，59 写档不应产生重复；确认旧档重复只来自 34 版以前后，可退出读档调用（34→35 迁移在 S01 内单独处理） | shortcut-bar、bag、saved-game |
| S25 A | [domain/session.ts](../src/domain/session.ts)：restoreReceipts 的旧轮次裁剪；[1bd2075e](https://github.com/sunflower9264/inoita-game/commit/1bd2075e) | **每次恢复都执行**。同一任务只保留周期最新的收据，代码注释明确写的是丢弃旧存档的历史轮次。正常结算已按周期覆盖；确认 59 写档只留最新一张后，可退出读档裁剪。事务回滚复用同一函数，拆分时保留回滚路径 | session-quest-core、save-game |
| S26 A | [domain/chests.ts](../src/domain/chests.ts)：restoreState 的生成记录去重与 `consumed??[]` 补空 | **每次恢复都执行**。旧档里同一生成 ID 可能因槽位重生被追加多次，恢复时保留最后一条；`consumed` 缺失时补空。生成时已按完整 ID 覆盖；确认 59 写档不再产生重复后，可退出读档去重，只保留生成规则 | chests、breakable-drops、save-game |
| S27 A | [domain/story-world.ts](../src/domain/story-world.ts)：restoreState 的 pruneCompletedEncounters；[fab7c60d](https://github.com/sunflower9264/inoita-game/commit/fab7c60d) | **恢复时裁剪旧档无界历史**，并联动 `Session.forgetPrunedEncounterEnemies` 删除敌人状态。正常运行时的 64 条上限在 S16；确认 59 写档不会超过上限后，可退出恢复时裁剪 | story-world、session、world-enemies |

### 3.2 数值与培养

| 编号与判定 | 位置与历史依据 | 当前触发与处理建议 | 验证入口 |
| --- | --- | --- | --- |
| N01 B | [domain/companion-progression.ts](../src/domain/companion-progression.ts)：MercenarySkillPoints / points / reset / restorePoints；[808b4b4d](https://github.com/sunflower9264/inoita-game/commit/808b4b4d)、[7a0efcc3](https://github.com/sunflower9264/inoita-game/commit/7a0efcc3) | legacyBonusPoints 由旧迁移产生，但 **59 继续保存、计算、洗点后保留**。可删迁移生成函数，不能把已保存值归零；要改字段需保值转换并另升格式 | mercenary-skills、saved-game |
| N02 B | [domain/party.ts](../src/domain/party.ts)：allocationBaseLevel / statPoints / resetAttributes；[e4fea344](https://github.com/sunflower9264/inoita-game/commit/e4fea344) | 旧佣兵的自动成长基准已成为 59 持久数据；改为 1 会改变基础属性和可分配点。删除缺省分支与删除字段是两件事 | party、saved-game |
| N03 B | [domain/companion-progression.ts](../src/domain/companion-progression.ts)：restorePoints；[7a0efcc3](https://github.com/sunflower9264/inoita-game/commit/7a0efcc3) | 有技能书时按可能的加点先后顺序验证花费区间，兼顾普通分配和书本提升。是现有培养数据的合法性检查，不是单纯旧版本容错 | mercenary-skills |
| N04 B | [domain/character-stats.ts](../src/domain/character-stats.ts)、[domain/party.ts](../src/domain/party.ts) 的资源上限与 [scenes/world-scene.ts](../src/scenes/world-scene.ts) 换装同步；[b889a7cd](https://github.com/sunflower9264/inoita-game/commit/b889a7cd) | 换下加上限装备后把生命法力限制在新上限。新游戏仍会触发，保留；重复计算可另作性能整理 | party、equipment-bonus-sources |
| N05 B | [scenes/world-combat.ts](../src/scenes/world-combat.ts) 伤害结算；[2d25744b](https://github.com/sunflower9264/inoita-game/commit/2d25744b) | 先读取并更新上限，再取扣血前生命，避免越界生命放大伤害；是当前数值顺序修正 | combat-hit-resolution |

现有测试对 45→46 迁移和 N05 的“先夹紧上限再扣血”顺序没有专门用例；清理或复核这两项前先补测试。

### 3.3 背包与装备玩法

| 编号与判定 | 位置与历史依据 | 当前触发与处理建议 | 验证入口 |
| --- | --- | --- | --- |
| E01 B | [domain/bag.ts](../src/domain/bag.ts)：装备计划、提交、verifyBagState；[domain/character-stats.ts](../src/domain/character-stats.ts)：previewGemPanel / previewGemChange；[26f2e514](https://github.com/sunflower9264/inoita-game/commit/26f2e514)、[0639cfec](https://github.com/sunflower9264/inoita-game/commit/0639cfec)、[250128b9](https://github.com/sunflower9264/inoita-game/commit/250128b9) | 槽位、职业、等级、双手互斥和双持由 `equipStep` 统一验证；镶嵌预览在 `character-stats.ts`，自己重复实现了双手卸副手规则，没有调用 `equipStep`，所以不是“全部统一验证”。新档也需要这些规则。历史坏装备的兼容与当前拒绝非法装备分开 | bag、equipment-bonus-sources、character-bonus-panel |
| E02 B | [domain/bag.ts](../src/domain/bag.ts)：removeOwner / takeRetiredEquipment；[domain/party.ts](../src/domain/party.ts)：leaveStory / dismiss / 归队穿回；[26f2e514](https://github.com/sunflower9264/inoita-game/commit/26f2e514) | **只有剧情伙伴离队**时记录普通装备实例（`leaveStory` 传 `retireEquipment=true`），归队穿回；佣兵放逐直接退回装备，不记退役表。`Bag.writeState` 仍保留 `retiredEquipment??[]` 读档兜底，59 写档是否总带该字段需确认。退役表是当前数据，不随 53→54 迁移删除 | party、story-equipment、saved-game |
| E03 B | [domain/items.ts](../src/domain/items.ts)、[domain/bag.ts](../src/domain/bag.ts)、[domain/session.ts](../src/domain/session.ts) 的剧情装备入口；[9335c554](https://github.com/sunflower9264/inoita-game/commit/9335c554)、[debdcf87](https://github.com/sunflower9264/inoita-game/commit/debdcf87)、[84f6c70a](https://github.com/sunflower9264/inoita-game/commit/84f6c70a) | 普通入包拒绝、剧情直接穿戴、手动换装限制、离身销毁属于现有玩法；仅 58→59 的残留清理可退出 | story-equipment、bag、gm-actions |
| E04 B | [domain/bag.ts](../src/domain/bag.ts)：unsealSkill；[domain/party.ts](../src/domain/party.ts) 的共享技能表；[718e6b64](https://github.com/sunflower9264/inoita-game/commit/718e6b64) | 永久解锁共享给现有、候补和未来佣兵，失败时背包与队伍一起恢复。独立解锁书转换是旧迁移，当前共享规则保留 | mercenary-skill-unlocks、bag |
| E05 B | [domain/bag.ts](../src/domain/bag.ts)：stackKey / instanceStackKey / isStackableInstance 与入包；[ada233c0](https://github.com/sunflower9264/inoita-game/commit/ada233c0)、[de07e527](https://github.com/sunflower9264/inoita-game/commit/de07e527) | 同 ID 同绑定技能才能叠加，强化、宝石、词条、锁定等参与排除；当前入包规则保留，只处理 S03 的旧实例收拢 | bag-stacking、bag |
| E06 B | [domain/bag.ts](../src/domain/bag.ts)：setShortcuts → dedupeSkillShortcuts；[b2970691](https://github.com/sunflower9264/inoita-game/commit/b2970691) | **正常设置时**技能只占一格；物品仍可多格。这是当前写入规则，保留。`dedupeSkillShortcuts` 函数同时被读档和 34→35 迁移调用，但那些调用分别见 S24、S01，不能因为共享函数就整块保留或删除 | shortcut-bar、bag |
| E07 B | [domain/session.ts](../src/domain/session.ts) 任务物品剩余需求；[application/quest-item-grants.ts](../src/application/quest-item-grants.ts)；[c2011993](https://github.com/sunflower9264/inoita-game/commit/c2011993) | 运行时只有怪物掉落、地图生成点和地面拾取按任务需求封顶；`quest-item-grants.ts` 是构建期的超发校验，不限制接取发放。与特定旧物品清理 S04 分开保留 | quest-item-generation、quest-item-grants、content |
| E08 B | [domain/items.ts](../src/domain/items.ts)：blockedNormalAcquisitionIds；商店、掉落与合成消费者；[585352c8](https://github.com/sunflower9264/inoita-game/commit/585352c8)、[29347316](https://github.com/sunflower9264/inoita-game/commit/29347316)、[718e6b64](https://github.com/sunflower9264/inoita-game/commit/718e6b64) | 保留道具、剧情装备、常备药水显式放行和封印书例外属于当前获取规则。保留；不据此恢复已撤销的旧货架清空 | reserved-items、shop、crafting |
| E09 B | [domain/bag.ts](../src/domain/bag.ts)：封印盒开盒分支；[docs/drops.md](../docs/drops.md) | 旧存档里的封印盒没有来源等级 `lootLevel` 时沿用盒子原有奖励表。旧盒子仍需可开；新盒写档总带来源等级，若确认旧盒可清空再退出 | bag、drops、breakable-drops |
| E10 B | [domain/bag.ts](../src/domain/bag.ts)：unsocket 的宝石/词条数量检查 | 宝石与词条数量不一致时拒绝取宝石，服务旧档或损坏档。属于数据保护而非修补；保留，若改为严格读档校验可另作收拢 | bag、equipment-bonus-sources |

### 3.4 世界与剧情

| 编号与判定 | 位置与历史依据 | 当前触发与处理建议 | 验证入口 |
| --- | --- | --- | --- |
| W01 B | [domain/world-enemies.ts](../src/domain/world-enemies.ts)：WorldEnemyRoster.isPresent / refresh，Session 的敌人状态；[e1a2cd7f](https://github.com/sunflower9264/inoita-game/commit/e1a2cd7f)、[456a5c67](https://github.com/sunflower9264/inoita-game/commit/456a5c67) | 任务恢复敌人的生成与受击共用在场判定，捕捉与迟到命中也使用；新任务流程仍需 | world-enemies、action-dispatch-runtime |
| W02 D | [scenes/world-combat.ts](../src/scenes/world-combat.ts) 死亡统一结算、enemy-defeat-repaired 与 `reconcileZeroHealthEnemies`；[1d13f421](https://github.com/sunflower9264/inoita-game/commit/1d13f421) | 死亡不只来自最后一次直接命中。毒伤（`:2056`）和熔岩反伤（`:1738`）已经走同一 `settleHit` 死亡单；真正只在恢复/生成边界补结算的是 `reconcileZeroHealthEnemies`（`:1474`）。待确认范围应缩到直接改血、状态同步和边界恢复，不能按“bug 已修复”整段删除。`9ce2186b` 是每帧优化提交，与死亡结算无关 | combat-hit-resolution、action-dispatch-runtime |
| W03 B | [domain/session.ts](../src/domain/session.ts) 死亡期限与 [domain/world-enemies.ts](../src/domain/world-enemies.ts)；[fec73e09](https://github.com/sunflower9264/inoita-game/commit/fec73e09) | 画面外 20 秒、画面内 60 秒的普通怪刷新是新玩法；57→58 的期限推导可删，双期限及视野复核保留 | enemy-respawn、world-enemies |
| W04 D | [domain/legendary-weapon.ts](../src/domain/legendary-weapon.ts)：地图等级 Math.max(1,mapLevel)；[b580709a](https://github.com/sunflower9264/inoita-game/commit/b580709a) | 原版等级 0 地图拔剑失败，体验版按 1 处理。需决定正式版是否沿用该规则；这不是旧存档迁移 | legendary-weapon |
| W05 B | [domain/navigation-world.ts](../src/domain/navigation-world.ts) 内容机关脱困与落点搜索；[e582dab2](https://github.com/sunflower9264/inoita-game/commit/e582dab2)、[04dc4fb8](https://github.com/sunflower9264/inoita-game/commit/04dc4fb8) | 火焰等固定机关压住角色时自愈、技能落点保证可达，新档仍可能遇到。保留有限搜索和明确失败处理 | navigation-placement、target-charge |
| W06 C | [domain/actor-authority.ts](../src/domain/actor-authority.ts)：placementAuthority；[fa5c0be5](https://github.com/sunflower9264/inoita-game/commit/fa5c0be5) | 缺 authority 时从 ID 前缀推断来源。扫描内容与所有运行期构造者，确认都写显式来源后再收紧；正式内容仍可能依赖缺省解码 | story-world-projection、actor-ref |
| W07 B | [domain/actor-ref.ts](../src/domain/actor-ref.ts)：actorRefFromState；文件由 [03cb75af](https://github.com/sunflower9264/inoita-game/commit/03cb75af) 引入；[fa5c0be5](https://github.com/sunflower9264/inoita-game/commit/fa5c0be5) 新增的是 actor-authority 和快照字段，没有改 `actor-ref.ts` | 把 SceneActorState 转为演员引用，当前计划/投影仍消费；注释的“旧适配器”不代表只有旧存档调用。可统一模型，但不能无替代删除 | actor-ref、story-scene、story-world-projection |
| W08 D | [scenes/world-combat.ts](../src/scenes/world-combat.ts)：`shouldSettleFriendly` 的重叠落位；[e6f5f242](https://github.com/sunflower9264/inoita-game/commit/e6f5f242) | 旧存档带进的重叠站位在剧情收拢时按碰撞盒重新落位。只在特定收尾路径运行，不是每次读档都执行；先确认 59 新档是否还会产生重叠，再决定是否纳入清理 | world-runtime-review、party-ai |

### 3.5 平台与运行时

| 编号与判定 | 位置与历史依据 | 当前触发与处理建议 | 验证入口 |
| --- | --- | --- | --- |
| P01 D | [application/browser-compat.ts](../src/application/browser-compat.ts)；[093b3c0a](https://github.com/sunflower9264/inoita-game/commit/093b3c0a) | Chrome 80 基线的 API 补齐。APK 已内置 Chromium 156，但网页版浏览器范围尚未重新约定；先定网页最低版本并列出实际缺失 API，再决定退出项 | browser-compat；目标设备验收 |
| P02 B | [application/fullscreen.ts](../src/application/fullscreen.ts)；文件由 [7c6af1e3](https://github.com/sunflower9264/inoita-game/commit/7c6af1e3) 引入，[4b840e12](https://github.com/sunflower9264/inoita-game/commit/4b840e12) 改的是 `index.html` 内联脚本，[e3020fb6](https://github.com/sunflower9264/inoita-game/commit/e3020fb6) 增加旧壳判断 | webkit 全屏接口、不返回 Promise 的兼容，以及旧 `appassets.androidplatform.net` 壳和 `__inoitaEngine === 'cefrium'` 的“不显示网页全屏”分支，都服务 Safari/旧环境。与 APK 存档无关，保留到明确取消相应浏览器支持 | 无专用测试；Safari/旧壳全屏验收 |
| P03 C | [application/game-audio.ts](../src/application/game-audio.ts)：volumeOf / preferences；[bcbae5c5](https://github.com/sunflower9264/inoita-game/commit/bcbae5c5) | 旧布尔静音设置转 0/1，与游戏存档格式独立。音量限制在 0～1 是正常校验；可在读取本机设置时统一转换并写回，保持静音偏好 | game-audio |
| P04 B | [tools/patch-phaser.mjs](../tools/patch-phaser.mjs)；[8f4fca10](https://github.com/sunflower9264/inoita-game/commit/8f4fca10)、[c98ba780](https://github.com/sunflower9264/inoita-game/commit/c98ba780) | 动态缓冲上传补丁与绘图缓冲失败释放仍服务 Phaser 4.2.1。升级引擎并核对等价修复后才退出，不能跟旧存档兼容一起删 | phaser-framebuffer；同设备战斗帧率验收 |
| P05 B | [application/assets.ts](../src/application/assets.ts) 与人物外观缓存、加载取消入口；[9d8fe7e2](https://github.com/sunflower9264/inoita-game/commit/9d8fe7e2)、[c98ba780](https://github.com/sunflower9264/inoita-game/commit/c98ba780)、[332af2f7](https://github.com/sunflower9264/inoita-game/commit/332af2f7) | 异步取消、迟到资源释放、纹理被画面使用期间的持有登记和绘图恢复仍保护读档换图；保留生命周期规则 | world-assets、scene-assets、saved-game-loader；实际读档换图验收 |
| P06 B | [application/frame-pacing.ts](../src/application/frame-pacing.ts)、native-frame-rate.ts 与 Android 显示模式；[4df20b60](https://github.com/sunflower9264/inoita-game/commit/4df20b60)、[0479cb78](https://github.com/sunflower9264/inoita-game/commit/0479cb78)；[8365e484](https://github.com/sunflower9264/inoita-game/commit/8365e484) 只改 Android 显示模式接线 | 根据实际刷新率安排限帧，解决特定屏幕节拍问题；与存档兼容无关，保留，调整需真机对照 | frame-pacing；60/90/120Hz 设备验收 |
| P07 C | [debug/gm-actions.ts](../src/debug/gm-actions.ts) 退出旧调试状态的缺快照回退；[5b146e41](https://github.com/sunflower9264/inoita-game/commit/5b146e41) 及后续历史 | 缺进入前快照时至少退出焦点并恢复自动保存；确认持久调试标记的版本和写入路径后收拢，不把它当作玩家存档升级链 | gm-actions、debug-mark-store、debug-world |
| P08 A | [SaveMigration.java](../android/app/src/main/java/io/github/sunflower9264/inoita/SaveMigration.java)、[public/migrate.html](../public/migrate.html)、[MainActivity.java](../android/app/src/main/java/io/github/sunflower9264/inoita/MainActivity.java)：首次启动迁移；[e3020fb6](https://github.com/sunflower9264/inoita-game/commit/e3020fb6) | **旧 WebView origin 的整站 localStorage 迁移**：把 `https://appassets.androidplatform.net` 下的存档、云会话和本机偏好迁到新 origin。是否退出取决于正式版还承接哪些旧壳版本；确定最低 APK 基线后，补一次迁移覆盖率证据再删除。`SaveMigration.readBackup` 当前没有调用者，是同功能里的死代码 | 无专用测试；旧壳升级安装验收 |
| P09 A | [application/cloud-save.ts](../src/application/cloud-save.ts)：旧 origin 且无注入地址时拒绝云存档；[public/diagnostics.js](../public/diagnostics.js)：旧 origin 占位响应判断；[debug/gm-actions.ts](../src/debug/gm-actions.ts)：拒绝旧壳占位上报 | 没有 `__inoitaEndpoints` 注入的旧 WebView 壳会被这些分支当成占位或失败处理。与 P08 同一旧壳基线，基线确定后一起退出 | cloud-save、game-diagnostics、gm-actions |
| P10 C | [ui/dom/components.ts](../src/ui/dom/components.ts)：热区四向定位；[e98f205a](https://github.com/sunflower9264/inoita-game/commit/e98f205a) | 用 `top/right/bottom/left: '0'` 而不是 `inset: '0'`，兼容不支持 `inset` 简写的旧 Android WebView。先定网页最低版本，与 P01 一起收拢 | 无专用测试；旧 WebView 设备验收 |
| P11 D | [UpdateManifest.java](../android/app/src/main/java/io/github/sunflower9264/inoita/UpdateManifest.java)：`assetVersion`/`contentVersion` 缺省放行 | 允许没有素材/内容版本号的老构建清单。当前生成器总会写这两个字段，但线上是否还存在老清单需查证；确认没有后再收紧 | 无专用测试；更新清单解析验收 |
| P12 C | [application/control-settings.ts](../src/application/control-settings.ts)：旧 `moveStyle` 记录；[ui/control-layout.ts](../src/ui/control-layout.ts)：布局 v1 按 1 倍读取；[application/display-settings.ts](../src/application/display-settings.ts)：旧画面偏好缺字段 | 本机偏好的旧记录分别在读取时转换或缺省。与游戏存档格式独立；可在读取入口统一转换并写回，再决定是否保留兼容读取 | control-settings、control-layout、display-settings |
| P13 C | [application/cloud-save.ts](../src/application/cloud-save.ts)：旧会话没有 `absoluteExpiresAt`；[tools/cloud-save-store.ts](../tools/cloud-save-store.ts)：按 `createdAt` 补链起点和 90 天上限 | 旧版本本机云会话和旧 `sessions.json` 缺少绝对过期时间，服务端用创建时间补。先明确会话文件契约，再决定统一转换或保留读取兜底 | cloud-save、cloud-save-store |
| P14 B | [tools/cloud-save-store.ts](../tools/cloud-save-store.ts)：接受宽范围的旧 scrypt 参数 | 已有账号密码哈希使用旧参数生成，验证时必须继续接受；不能因为参数收紧要用户重设密码。保留到账号迁移或强制改密方案落地 | cloud-save-store、cloud-save |
| P15 A | [public/diagnostics.js](../public/diagnostics.js)：启动时把 `inotia4.diagnostics.pending.v1` 迁入 IndexedDB；[72a75452](https://github.com/sunflower9264/inoita-game/commit/72a75452) | 旧诊断待发队列的一次性迁移，成功后删除旧键。旧客户端队列清空后可以退出；先查旧版本客户端是否还会写这个键 | game-diagnostics |

上表源码位置除特别标注外相对于 `src/`；P04、P08、P09、P11、P13、P14 相对仓库根目录，`public/` 路径也按仓库根目录书写。测试名相对于 `tests/` 并带 `.test.ts`；实际存在性在文档提交前核对，设备验收单独标明。

## 4 清理顺序与验收条件

### 第一批 收窄格式入口

先把正式版读取范围、格式分类和 UI 提示统一为承接 59；检查标题继续游戏、游戏内读档、自动槽、云上传下载及 `writeRaw`。之后删除 S01 的 26 步迁移、专用类型、固定 ID 表和无其他调用的迁移函数。S22 的重复演员收敛和 S23 的 36/48 版外观读取也随旧格式入口退出；退出前确认运行时不会产生同类旧数据。若正式版需要改结构，新增 59→新格式的转换，而不是重新接回 33 起的链。

验收至少覆盖：合法 59 的本地与云端读写往返；旧格式被一致识别为过旧；未来格式不能落地；损坏存档不能改写当前会话；失败或取消读取保留原槽。旧档与空槽的界面区分需随入口调整明确，保留原始数据以便玩家选择覆盖。

### 第二批 退出每次读档的历史修复

逐项处理 S02～S07、S15、S17、S21、S24～S27；S19 里的失效焦点清理也在这里先明确写入契约。先找清当前写入者，验证“新产生的数据已满足约束”，再移除读档扫描。每个独立机制单独改、单独验证、单独提交。

验证样本至少有新档，以及从旧流程升级后重新保存的 59 档。背包样本保留不同绑定技能、锁定与强化实例；任务样本覆盖鲤鱼饼事件前后；召唤样本覆盖主人离场和子召唤。不能仅用全新空背包证明所有 59 档都不需要修复。必要时可用匿名化测试样本或只读统计补足证据，本次没有读取玩家私人存档或声称这些残留为零。

### 第三批 收拢恢复缺省值

处理 C 类（含新增的 S19、P10、P12、P13），把正式持久数据、临时检查点、事务回滚和测试构造的输入契约分清。正式数据入口做一次转换或校验，领域恢复只接收约定结构；派生缓存可重建，玩家进度字段保值。不能因删除 `??` 让正常检查点恢复抛错，也不能为了简化字段让玩家技能点或属性改变。

### 第四批 单独处理玩法与平台取舍

W02、W04、W08、P01、P11 尚待证据或产品决定；P08、P09、P15 随旧壳/旧客户端最低基线确定后退出，P14 保留到账号迁移或强制改密方案落地；其余 B 项保持现有行为。平台补丁的退出跟随引擎/浏览器基线，玩法取舍跟随正式版规则。资料扫描不能替代 APK 和手机网页的实际验收。

## 5 已撤销实现与后续检查

以下历史变化用于防止误计，不计入 43 个当前审计单元：

- [b3b70c1a](https://github.com/sunflower9264/inoita-game/commit/b3b70c1a) 加入过按保留道具名单清理旧货架；[ef6bc9a8](https://github.com/sunflower9264/inoita-game/commit/ef6bc9a8) 删除了 `ShopVisits.removeReserved` 及调用。**当前没有这项广泛旧货架清理**；S02 只针对特定删除 ID，S01 的解锁书迁移也是特定 ID。
- [ef6bc9a8](https://github.com/sunflower9264/inoita-game/commit/ef6bc9a8) 的提交文字提到撤销 infinity-bag 迁移改动，实际差异是替换目标从大药水改回 elixir；**当前替换表仍然存在**，已记入 S02，不能按提交标题判成整项消失。
- [413bde0a](https://github.com/sunflower9264/inoita-game/commit/413bde0a) 的原生诊断 HTTP 状态回传由 [39083cff](https://github.com/sunflower9264/inoita-game/commit/39083cff) 显式撤销，未计为现存清理候选。这只针对原生桥；网页 `fetch` 路径仍保留 413/400 处理。
- [09793c10](https://github.com/sunflower9264/inoita-game/commit/09793c10) 删除技能初始化卷轴及 reset-skills 用途，提交明确要求不增加旧档迁移；当前不把这项已删除功能算作遗留补丁。其正文提到的 9 个无用任务物品随后由 [577b424e](https://github.com/sunflower9264/inoita-game/commit/577b424e) 清理，材料礼盒随后由 [fdb4cce7](https://github.com/sunflower9264/inoita-game/commit/fdb4cce7) 实现；旧排查结论不能当成现状。
- 已删除的独立技能解锁书界面、逐帧性能诊断（帧间隔采样、长帧现场和 Long Task 观察）和完成的临时方案文档，不重复列作当前死代码。左上角帧率显示、交付帧数统计和刷新率限帧仍在。

### 本次文档核查与后续测试

本次检查源代码、内容引用、相关历史与现有测试位置，不执行清理、不改变运行行为。提交前核对全部条目编号、分类合计、26 步迁移及其引入提交、源码与测试路径，并运行 `git diff --check`。没有运行单元测试或启动浏览器；上文测试列表是后续实际清理时应选择的验证入口。

优先人工复核位置：[存档准备与迁移](../src/application/saved-game.ts)、[存档接纳与恢复](../src/domain/save-game.ts)、[会话恢复](../src/domain/session.ts)、[背包](../src/domain/bag.ts)、[佣兵培养](../src/domain/companion-progression.ts)、[战斗快照](../src/domain/combat-snapshot.ts)。
