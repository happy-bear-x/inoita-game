# src/domain

游戏规则的家：会话、剧情、战斗、物品、导航和存档都在这里，全部是纯 TypeScript。

## 文件

- 会话/剧情：`session.ts`、`story-director.ts`、`story-runtime.ts`、`story-graph.ts`、`story-condition.ts`、`story-scene.ts`、`story-script.ts`、`campaign.ts`、`scene-plan.ts`，以及同前缀的 `story-*.ts`、`scene-*.ts`；开发/测试模式开关与快照冻结在 `dev-mode.ts`，存档检查点的写时复制在 `playback-checkpoint.ts`。
- 战斗：`combat-*.ts`、`battle.ts`、`action-*.ts`、`attack-*.ts`、`buff-*.ts`、`skill-*.ts`、`enemy-*.ts`；击杀奖励结算在 `combat-rewards.ts`。
- 物品/背包：`items.ts`、`inventory.ts`、`bag.ts`、`drops.ts`、`loot-pity.ts`、`ground-loot.ts`、`crafting.ts`、`enhancement.ts`、`equipment-*.ts`、`shop.ts`、`money.ts`（金额拆分与显示文本）。
- 队伍/召唤：`party*.ts`、`companion-progression.ts`、`friendly-summon-ai.ts`、`summon-*.ts`；召唤物的归属分组、顶替、寿命与退场在 `summon-lifecycle.ts`。
- 导航/地图：`navigation.ts`、`navigation-world.ts`、`pathfinding.ts`、`path-budget.ts`、`walk-route.ts`、`map-placement.ts`、`minimap.ts`。
- 存档/状态：`save-game.ts`、`cloud-save.ts`（云存档账号、密码、槽位与锁定规则）、`state-application.ts`、`key-bindings.ts`、`control-skin.ts`、`legendary-weapon.ts`（拔剑判定、奖励与已拔状态）、`inns.ts`（旅店休息费用与恢复）。
- 任务/文本：`quest-*.ts`、`menu-panels.ts`、`text-markup.ts`、`description-text.ts`；世界交互判定在 `interaction.ts`；其余文件按前缀或符号搜索，例如 `combat-runtime.ts`、`story-entry.ts`。

## 规则

- 剧情播放器、检查点校验和预演按同一内容对象共享一份冻结脚本及节点、事件索引；任务定义沿用 `QuestBook` 的共享只读索引。每个执行器独立保存游标、队列和回滚状态，内容更新使用新的对象身份。

- 佣兵绕到敌人侧面前先检查起点和侧翼附近的可站网格；整片被挡就直接按攻击范围接敌。场景内每名佣兵每次最多搜索 48 个节点，未完成的路线下次继续。
- 固定或暂时不能移动的敌人检查技能可达性时，每次最多领取 128 个共享寻路节点；预算耗尽保留搜索与目标，确认没有路径后才回家。目标、位置、范围或行为生命周期改变时重新搜索。

- 会连续修改会话的入口用 `Session.batchNotifications`：它只把多次修改的通知合并成一次，失败不回滚。需要“要么全成、要么全退”的入口用 `Session.atomic(operation, touched)`，按 `touched` 声明实际会碰到的子系统懒抓快照；嵌套调用并入外层，失败只恢复这些子系统并丢弃待发通知，不给通知批次套整份会话快照。
- 剧情运行时快照不可变：`StoryRuntime` 的写入只替换数组和对象，`snapshot()` 直接返回引用，不做整份深拷贝。内部检查点走 `adoptTrusted`（版本、数组、ID 和重复的廉价检查；开发/测试模式再全量校验），读档、检查点恢复、GM 跳转和云存档走 `prepareRestore`。开发/测试模式用 `dev-mode.ts` 的 `freezeSnapshot` 冻结快照，生产热路径不冻结。
- `StoryDirector.onSkipProgress` 只报告跳过请求、最终逻辑提交、世界就绪、交还操作权与必须停下的确认；计时和日志由应用层接入。
- 跳过剧情只影响表现：`StoryDirector.prepare` 跳过时不预取舞台整图，但立绘和音效仍预取；`choice` 和 `quest-popup` 之前调用 `presentation.flushStage`，先把逻辑舞台画出来再弹窗。任务、物品、标记、传送和检查点仍按原顺序提交。
- 本目录保持零 Phaser 依赖，也不 import `application`、`ui`、`rendering`、`scenes`、`debug`。
- 新规则写成纯函数或状态迁移，由 `application` 负责适配 Phaser、浏览器和磁盘。
- 击杀奖励结算（经验、普通/景物/付费道具/任务掉落、套装首杀与装备/黄装/紫装保底记录）在 `combat-rewards.ts` 算完；场景只负责播放表现、选择落点并写回会话。随机源由调用方传入，固定随机源即可在纯 Node 下复现。
- 召唤物的分组、同主人顶替、寿命和退场规则在 `summon-lifecycle.ts`；场景保留 visual、物理体和名册实例，`WorldCombatState` 的序列化仍由 `combat-snapshot.ts` 负责。召唤物移除时清理会话里的血量/法力条目，检查点恢复重建同一批召唤物的路径保留这些条目。
- 世界交互按宝箱 → 泉水 → 任务槽 → 服务 NPC → 商店 → 普通剧情的顺序在 `interaction.ts` 的 `resolveInteraction` 判定；场景只提供附近目标、任务槽和商店状态，并按返回的动作执行。朝向只用于交互前的转身表现，不参与能否交互的判定。
- 佣兵只打软集火目标和正在攻击玩家/队友的敌人，不主动接附近没交战的敌人；同一目标至少保持 2 秒，目标离操控角色超过 200px 且不在攻击距离内就放弃。追击同一目标时按上阵槽位分到目标两侧：槽位 0 一侧、槽位 1 另一侧，锚点取仍能攻击的最远点；侧翼锚点不可达或目标过近时退回普通攻击范围目标。战斗中没目标时直接回到跟随。跟随按现有攻击距离和治疗技能推断前排/后排/辅助站位；离操控角色超过 240px 或卡住 2 秒时传送到队长身边。自动施法仍使用现有技能、频率、蓝耗和冷却，只把保命/辅助技能排到输出技能之前尝试。
- 寻路的地形在整图生命周期内只读共享。佣兵跟随和追敌时，每次搜索只取一次人物占位，按 16 像素网格查附近的角色，再用 `overlapsAt` 判断是否相撞。沿路线迈步前仍查实时占位。搜索预算按发起者公平分配，避免队伍 AI 先领走整帧预算、后续单位饿死；没有技能时不要算 `reachableNow`。
- 技能位移的落点必须整个身体站得住，并与施法者处于同一块地形连通区域；目标附近找不到时朝目标方向退到最远可站点，原地也站不住才取消。可走性复核只把地形和内容实体当障碍，敌我单位会移动，不算永久隔断。
- 不会自己移动的内容机关（火焰、路障、宝箱）由 `NavigationActor.content` 标记；卡住自愈只处理这类实体，队伍单位与敌人的贴身接触仍交给物理分离，不能每帧把角色传走。
- 内容机关独立登记；注册用途变化时调用 `NavigationWorld.refreshActor`，注销时同步移除。机关位置、显隐与碰撞盒在查询时读取当前值。
- 背包的 `remove`/`consume` 直接操作目标容器并增量维护计数，不复制全部散装实例、不重建整张计数表；可堆叠、强化、宝石、词条和绑定技能的合并规则保持不变。
- 金额一律以铜币存储；对玩家展示时用 `money.ts` 的 `moneyText` 或 `splitMoney`，不要直接把裸数字写成「金币」。
- `SAVE_FORMAT` 当前是 42；改存档结构或校验口径时把它加一，并在 `src/application/saved-game.ts` 补迁移和旧档测试。升级链覆盖的旧档正常读取；比升级链更早的档案显示为空槽。
- 保留道具（原版付费道具）由 `items.ts` 的 `reservedItems` 标记，普通掉落和商店继续过滤；任务奖励可以发放配方书，其他保留道具仍拒绝。配方书配方在学会后可在融合器合成（结果仍是保留道具），未学会的配方和结果为保留道具的常备配方仍隐藏；原版配方表本来就常驻的三条药水配方（再生药水（特大）、元气恢复药水、卓越灵药）用 `allowReservedResult` 显式放行，可以正常合成；`drops.ts` 的 `reservedDrops` 与融合器任务奖励是配方书的两个获取来源。一次性领取记录和解锁保底在会话状态 `reservedDrops` 里；旧档只补空状态和已经拥有的一次性道具领取记录，不清理已有物品。
- 剧情人物装备由 `items.ts` 的 `storyEquipment` 标记；普通掉落、商店、合成、任务奖励、初始物品和商人货架统一用 `blockedNormalAcquisitionIds` 过滤，保留掉落通道继续只用 `reservedAcquisitionIds`。剧情 `equip`/`item-give` 可以使用这些装备，`item-drop` 不允许。
- 敌人的 `specialRank` 直接来自原版怪物记录分类（0 普通，1/2/3 特殊怪），只决定小地图星标和目标面板三星；掉落分层 `threat` 不是显示分类，不要拿它代替。
- 同 id 物品只有在目录 `stackable` 为真、且实例没有强化、宝石、词条或绑定技能时才合并。读档时把旧档里分散的同 id 实例收拢成一条：数量相加，保留一条实例，并更新全部页与分类袋的格位引用。
- 存档和检查点只在队伍至少一人活着时记录；读旧档发现全队 0 血时，先把上阵队伍恢复到满状态再进世界。
- 古老武器把地图等级 0 兜底成 1（体验版偏离原版“除零必失败”）。
- 普通地面掉落不跨图：进入另一张地图时清掉其他地图的非任务掉落；`category` 为 `quest` 的物品（含剧情 `item-drop`）留在原图，任务生成点自己的掉落仍由 `QuestItemGenerators` 清理。
- 地面掉落只推进仍在飞行的对象。`collectNearby` 接收可拾取条件版本后，位置、掉落版本和接收条件都未改变时跳过扫描；背包、队员或资源变化必须更新该条件版本，落地与恢复自动使掉落检查失效。
- 进图落点常贴着回程出口；出口要等角色累计走过 80 像素才重新武装，避免贴门一步就弹回上一张图。
- 恢复泉水的回血、回蓝按每名存活的上阵队员自己的上限结算，数值夹到上限；正面状态同样给所有存活上阵队员。药水病、药效减半、技能封印和攻升防降的疯癫只给喝下泉水的人。技能点只给主角；出怪与队伍组成无关。
- 组队技能 122「被选择的英雄」在基础拔剑奖励后额外掷一次 uniqueBonus/1000；命中把普通装备或空手失败升级为唯一物品，已经是唯一物品则不重复判定。
- 选择事件按选择标识的写入次数判断：同一个选项再次被选中也算一次新的发生，不能只比较选择值；一次选择只执行一条选择事件，新的选择作为下一次发生排队。
- 剧情、任务、事件 ID 是存档引用，只新增不改名；要改名就配套迁移。
- 云存档的账号/密码/槽位校验和锁定时长只在 `cloud-save.ts` 写一份，服务端复用同一份规则；云端保存不改 `SAVE_FORMAT`。
- 缓存失效用只读修订号：`PartyRoster.groupModifierVersion`、`CombatConditions.revision`、`Session.choiceWriteRevision`/`receiptRevision`/`enemyRevision`、`StoryWorld.encounterRevision`、`LegendaryWeapons.revision`。新增 mutation 入口时同步推进对应修订号；这些字段不写入存档。
- 自动存档的持久快照按子系统版本复用深拷贝（`captureStateWith(..., true)`）；读档/回滚时清空缓存。`captureState()` 的检查点路径保持每次新克隆。
- 任务奖励收据（结算时写下的一次奖励记录）每个任务只保留周期最新的一张；写入和读档恢复都按任务取最新周期，旧存档里同一任务的旧轮次在恢复时丢弃。防重复结算看周期有没有前进。
- 可破坏物生成记录按完整 id 覆盖；旧档读入时去重，并清理已永久死亡且不会再生成的 `breakable:` 记录，`chest:`/`spring:` 的永久死亡记录保留。
- 仇恨账本以 owner→source 索引为准，记录数组只用于快照与容量淘汰；增删必须同时维护两边。
- 剧情世界的进行中遭遇以 `StoryWorldState` 的 active 索引为准，`encounters` 表只用于历史、快照和完整状态查询；新增、结算和整份恢复必须同时维护索引，每帧读取只走索引。
- 地图敌人生成点索引按投影复用；任务、剧情、生成资格或名册身份变化及复活期限到达后才重新计算增删。`Session.enemySpawnRevision` 只跟踪死亡期限与恢复/回滚，血量和法力变化继续推进存档用的 `enemyRevision`，不会触发生成扫描。
- 人物页大立绘按来源取图：主角和剧情同伴用 `character.portraits` 的 252×271 立绘，佣兵用 `character.classPortraits` 的职业 252×271 立绘；小头像统一用 `party-class-*` 或 `character-party-*`。`memberArt` 是唯一入口。
- 单元测试写在 `tests/*.test.ts`。

## 验证

- `npm test -- tests/session.test.ts` 覆盖会话与剧情状态；`npm test -- tests/save-game.test.ts` 覆盖存档结构与格式号。

- 放逐成功时同步删除该成员的掉落保底计数；移入预备队保持计数。恢复存档后按名册保留主角和仍拥有成员的计数。

- `CombatController.basicAttackRange` 读取已解析普攻的接近距离；换装备通过 `setBasicAttack` 更新，决策查询只叠加实时射程加成。
