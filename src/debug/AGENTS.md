# src/debug

调试能力层：GM 动作与调试开关。Node 与浏览器共用这里的实现。

## 文件

- `gm-actions.ts`：GM 动作的唯一实现，面板、`globalThis.gm` 和控制台都调它。
- `gm-mode.ts`：GM 模式开关的本地持久化，默认关闭。

## 规则

- GM 动作只在 `gm-actions.ts` 实现一次；Phaser 面板、控制台和测试都调用同一入口，不各写一份。
- 任务调试页显示全部任务组，按 `campaign.quests` 的故事顺序混排主线和支线；`quest-catalog.ts` 负责顺序和状态投影，`quest-jump.ts` 负责前置/接取条件与起点规划，`gm-actions.ts` 只编排流程。
- 调试期间 `QuestBook.forcedAvailable` 让目标任务保持可接取，`forcedProgress` 钉住接取条件里要求 ready/active 的前置任务；两者都不进入状态快照或存档，回到跳转前、保留进度和会话关闭时用 `clearDebugOverrides()` 一起清空。
- 起点状态由任务自己的完成方式决定：`completion: 'talk'` 的零目标任务只能从 `ready` 开始，规划结果归一成 `ready`，目的地取 `places.ready`；应用计划时先放成可接取，再走真实的 `quest accept` 命令，让任务簿自己写 ready、周期、运行池和接取物品。内部任务放成锁定，接取命令带 `source: 'script'`。
- 目的地上发布者/交付者的 placement 条件要一起补进计划。像卓拉德在影营地需要 `quest-npc-located-npc-40` flag，漏补时任务虽然到了待交付，NPC 却不会出现。
- 接取脚本舞台 cast 引用的世界实体也要补：`worldEntityId` 优先，没有时按舞台地图的 `characterId`/`actor` 找 placement；再到剧本里找同图（必要时同坐标）的 `world place` 命令，重放该节点的 `world` + `flag` 命令。世界登记在别的地图或已移除时同样要重放；条件要求目标任务已完成的事件属于未来，不能当来源。`mapFromWorld` 用目的地/当前地图，所以舞台切图（如 quest-153 的 `event-44` 在 leap-gate-district、目的地却是 kamuran-wilderness）也覆盖。只重放世界状态，不重放任务、物品和队伍命令，也不播上游演出；只有 `flag`/`always` 类摆放找不到来源时才写 `plan.warnings`。
- 打开调试任务时，把所有 `source: 'start'` 事件写入 `completedEvents`，任何调试现场都已经过了游戏开场，换图不能再触发起始事件。
- 调试运行期间用 `StoryDirector.setAutomaticEventFilter` 只放行目标任务相关的自动事件；相关集合由 `questFocusEventIds` 从接取事件、`interactionEvent`、接取/完成脚本、其他引用目标任务 ID 的剧本，以及完成事件条件里的前置任务生产事件反向展开得出。显式 `trigger` / `script` 不受过滤影响；回到跳转前、保留进度、启动异常和 `dispose()` 时清除过滤。
- 调试起点补齐目标任务和条件任务的 `handoverItems`；否则接取/完成脚本会在交付物检查处中断。
- `forcedProgress` 只在自动刷新里优先；正式任务命令（accept/complete/script-ready/script-complete/reset）会先撤掉该任务的钉住，避免把刚完成的正式状态改回 ready。
- 保留进度时先挡住触发，清 override 并 emit，再结束调试、刷新回滚检查点、移除事件过滤并补一次自动存档；这样保留后的进度才是新的回滚点，也不会补演正式剧情。
- 跳转前保存 `session.captureState()`、`WorldScene.captureStoryWorld()` 和 `SessionCheckpoint.peek()`；进入调试后暂停自动存档，返回时恢复这三份状态，不能把调试现场写进自动槽。
- 开始跳转期间用 `StoryDirector.holdTriggers()` 挡住设置过程中的任务变化自动开演；传送/接取剧情结束后再释放。不要用 `busy` 代替触发保持。解除保持后由事件过滤保证只播放目标任务的剧情。
- 状态页「完成任务」遇到等待中的剧情战斗时，先按正常击败记录目标并让导演结算遭遇，由剧情事件结算战斗并接取后续任务；当前任务与战斗无关时先结算战斗，不直接完成无关任务。
- 调试道具列表按物品定义过滤仅地面拾取和剧情人物专属装备；可穿戴装备不按当前角色职业筛选，保留调试时给其他职业发放的能力。按物品 ID 直接发放同样校验剧情专属装备限制。
- 人物页的「技能全满」调用 `maxSkills`：主角拉满本职业技能（未学的也学会）；佣兵学会本职业全部技能，并升到该技能伙伴成长表的最高等级（没有伙伴成长表时用普通表长度）。不扣技能点、不改变角色等级，执行后发一次会话通知。
- GM 的诊断上报地址从 `application/endpoints.ts` 取，不在 `gm-actions.ts` 里写默认域名。
- 本目录不导入 Phaser，保持能在 Node 下直接运行和测试。

## 验证

```bash
npm run typecheck
npm test -- tests/gm-scene.test.ts tests/gm-actions.test.ts tests/gm-quest-jump.test.ts tests/quest-catalog.test.ts tests/quest-jump.test.ts tests/story-director-event-filter.test.ts
```

- 会话关闭时调用 `GmActions.dispose()`，释放本局操作日志引用。
- `tests/gm-complete-golem.test.ts` 覆盖状态页完成任务先结算石魔遭遇、推进后续任务，以及旧路径已卡住时优先结算等待战斗且不误完成无关任务。
