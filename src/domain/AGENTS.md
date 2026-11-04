# src/domain

游戏规则的家：会话、剧情、战斗、物品、导航和存档都在这里，全部是纯 TypeScript。

## 文件

- 会话/剧情：`session.ts`、`story-director.ts`、`story-runtime.ts`、`story-graph.ts`、`story-condition.ts`、`story-scene.ts`、`story-script.ts`、`campaign.ts`、`scene-plan.ts`，以及同前缀的 `story-*.ts`、`scene-*.ts`。
- 战斗：`combat-*.ts`、`battle.ts`、`action-*.ts`、`attack-*.ts`、`buff-*.ts`、`skill-*.ts`、`enemy-*.ts`；击杀奖励结算在 `combat-rewards.ts`。
- 物品/背包：`items.ts`、`inventory.ts`、`bag.ts`、`drops.ts`、`loot-pity.ts`、`ground-loot.ts`、`crafting.ts`、`enhancement.ts`、`equipment-*.ts`、`shop.ts`、`money.ts`（金额拆分与显示文本）。
- 队伍/召唤：`party*.ts`、`companion-progression.ts`、`friendly-summon-ai.ts`、`summon-*.ts`；召唤物的归属分组、顶替、寿命与退场在 `summon-lifecycle.ts`。
- 导航/地图：`navigation.ts`、`navigation-world.ts`、`pathfinding.ts`、`path-budget.ts`、`walk-route.ts`、`map-placement.ts`、`minimap.ts`。
- 存档/状态：`save-game.ts`、`cloud-save.ts`（云存档账号、密码、槽位与锁定规则）、`state-application.ts`、`key-bindings.ts`、`control-skin.ts`、`legendary-weapon.ts`（拔剑判定、奖励与已拔状态）、`inns.ts`（旅店休息费用与恢复）。
- 任务/文本：`quest-*.ts`、`menu-panels.ts`、`text-markup.ts`、`description-text.ts`；世界交互判定在 `interaction.ts`；其余文件按前缀或符号搜索，例如 `combat-runtime.ts`、`story-entry.ts`。

## 规则

- 本目录保持零 Phaser 依赖，也不 import `application`、`ui`、`rendering`、`scenes`、`debug`。
- 新规则写成纯函数或状态迁移，由 `application` 负责适配 Phaser、浏览器和磁盘。
- 击杀奖励结算（经验、普通/景物/付费道具/任务掉落、套装首杀与装备/黄装/紫装保底记录）在 `combat-rewards.ts` 算完；场景只负责播放表现、选择落点并写回会话。随机源由调用方传入，固定随机源即可在纯 Node 下复现。
- 召唤物的分组、同主人顶替、寿命和退场规则在 `summon-lifecycle.ts`；场景保留 visual、物理体和名册实例，`WorldCombatState` 的序列化仍由 `combat-snapshot.ts` 负责。召唤物移除时清理会话里的血量/法力条目，检查点恢复重建同一批召唤物的路径保留这些条目。
- 世界交互按宝箱 → 泉水 → 任务槽 → 服务 NPC → 商店 → 普通剧情的顺序在 `interaction.ts` 的 `resolveInteraction` 判定；场景只提供附近目标、朝向、任务槽和商店状态，并按返回的动作执行。
- 金额一律以铜币存储；对玩家展示时用 `money.ts` 的 `moneyText` 或 `splitMoney`，不要直接把裸数字写成「金币」。
- `SAVE_FORMAT` 当前是 41；改存档结构或校验口径时把它加一，并在 `src/application/saved-game.ts` 补迁移和旧档测试。升级链覆盖的旧档正常读取；比升级链更早的档案显示为空槽。
- 保留道具（原版付费道具）由 `items.ts` 的 `reservedItems` 标记，普通掉落、商店、合成和任务奖励继续过滤；只有 `drops.ts` 的 `reservedDrops` 独立通道可以发放。一次性领取记录和解锁保底在会话状态 `reservedDrops` 里；旧档只补空状态和已经拥有的一次性道具领取记录，不清理已有物品。
- 同 id 物品只有在目录 `stackable` 为真、且实例没有强化、宝石、词条或绑定技能时才合并。读档时把旧档里分散的同 id 实例收拢成一条：数量相加，保留一条实例，并更新全部页与分类袋的格位引用。
- 存档和检查点只在队伍至少一人活着时记录；读旧档发现全队 0 血时，先把上阵队伍恢复到满状态再进世界。
- 古老武器把地图等级 0 兜底成 1（体验版偏离原版“除零必失败”）。
- 进图落点常贴着回程出口；出口要等角色累计走过 80 像素才重新武装，避免贴门一步就弹回上一张图。
- 恢复泉水的回血、回蓝按每名存活的上阵队员自己的上限结算，数值夹到上限；正面状态同样给所有存活上阵队员。药水病、药效减半、技能封印和攻升防降的疯癫只给喝下泉水的人。技能点只给主角；出怪与队伍组成无关。
- 组队技能 122「被选择的英雄」在基础拔剑奖励后额外掷一次 uniqueBonus/1000；命中把普通装备或空手失败升级为唯一物品，已经是唯一物品则不重复判定。
- 剧情、任务、事件 ID 是存档引用，只新增不改名；要改名就配套迁移。
- 云存档的账号/密码/槽位校验和锁定时长只在 `cloud-save.ts` 写一份，服务端复用同一份规则；云端保存不改 `SAVE_FORMAT`。
- 单元测试写在 `tests/*.test.ts`。

## 验证

- `npm test -- tests/session.test.ts` 覆盖会话与剧情状态；`npm test -- tests/save-game.test.ts` 覆盖存档结构与格式号。
