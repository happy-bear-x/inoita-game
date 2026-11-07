# src/scenes

Phaser 场景层：驱动生命周期、转发输入，把 domain、rendering、ui 的能力接起来。游戏规则不属于这里。

## 文件

- `world-scene.ts`：主世界，负责地图加载、角色移动、镜头与地图内交互。
- `world-combat.ts`：世界内战斗的装配与更新，把战斗规则接到场景表现。
- `story-stage-scene.ts`：剧情舞台，承接对白、选项和演出期间的输入锁定。
- `menu-scene.ts`：标题与主菜单，含存档槽、云存档账号/改密页与覆盖确认。
- `story-class-scene.ts`：新游戏的职业选择与角色预览。
- `formal-ui-scene.ts`：正式 UI 场景，承载 HUD、背包装备、商店等菜单面板。
- `audio-scene.ts`：音频设置页；跨场景常驻，切换场景不打断播放。
- `controls-scene.ts`：操作设置页，键位与控件布局。

## 规则

- `WorldCombat` 把地图的 `captureStandability` 接给敌人和佣兵的寻路器。一次搜索共用一份占位，走动时再由 `movement.canStand` 检查下一步。

- 场景只驱动生命周期、转发输入、调度下层模块；判定和数值规则写进 `src/domain/`，世界绘制交给 `src/rendering/`，屏幕界面绘制与输入交给 `src/ui/dom/`。
- 世界小地图由 `StoryMinimap` 连接 DOM 组件和场景显隐；地图关闭时释放组件，地形与图标通过 DOM 资源预载准备。
- 击杀奖励结算、召唤生命周期和交互决策在 `src/domain/`：场景只收集输入、播放表现、决定落点并执行 domain 返回的动作/奖励清单。
- `WorldScene.interact()` 把附近目标、任务槽和商店状态交给 `domain/interaction.ts` 的 `resolveInteraction`；选目标的 `updateInteractionTarget` 只按距离挑最近的一个，交互前场景把角色转向目标，朝向不参与能否交互的判定。
- 有商店的 NPC 无论有没有招呼语，都算可交互目标；交互优先级仍由 `resolveInteraction` 决定。
- 掉落落点用 `lootLanding` 避开地图进出口；不要把物品图标落在门洞上。
- 舞台 `CREATE` 完成时始终交付 `onReady` 生命周期通知；等待画面的请求可独立取消，补画和收尾复用同一次启动。舞台衣柜准备接收画面取消信号，共用合成只在最后一个请求取消后中止。
- 世界与舞台的 `Wardrobe` 使用 `StoryContext.outfits` 共用合成外观；场景关闭只释放自己的使用权，跨图不重复生成同一套动作。
- 伙伴外观按需加载：队伍面板预览只准备 `idle-south`，进战斗开场再补全套；使用勇士徽章招募后由招募确认或队伍面板调用 `preparePartyMember`，不要为了省事把全部伙伴重新塞回常驻包。
- **地图内学会新技能后要补素材。** 进图和开战的素材计划只覆盖当时已学的技能；玩家或伙伴升级、学新技能、换武器后，`WorldCombat` 用 `scheduleSkillAssetRefresh` 按签名补载新增技能的特效、姿态和召唤物。先用 `playerSkillGateNow`/`allySkillGateNow` 只比版本号，签名变化时才用 `missingSceneAssets` 加载增量；补载租约按 owner 分组，伙伴离队和关闭地图时释放。失败按 owner 退避（1s→30s，最多 5 次）。
- **每帧读取的技能数据按版本复用。** `partyPassives`、`partySkillsFor`、`equipmentRecovery`、`combatProcs` 用技能版本、背包修订、生命阈值、潜行和组队光环版本缓存；`syncAiSkills` 每逻辑帧只更新蓝耗与频率。新增会影响这些结果的输入时，同步加进缓存键并在读档/成员移除时清空。
- **地图触发用索引。** 进图和剧情投影后调用 `rebuildTriggerIndex`；`afterMovement` 只遍历本图的 region/near 候选，条件仍在判定时实时求值。新增会改变地图身份或角色集合的路径要重建索引。
- **整图刷新和交互目标按签名早退。** `refreshStateSignature` 与 `interactionSignature` 覆盖地图、角色身份与外观、任务/世界/宝箱/古剑版本、操控者；新增可见性或标记输入时同步加进签名。任务投影由查询入口自己刷新，场景层不每帧强制 `session.refresh()`。
- **任务标记按当前任务状态补建。** 任务可能在本图游玩中变为可接取；`refreshState` 对缺标记且有任务状态的角色补建头顶标记，不要只在 `createActor` 时判断一次。同一轮只取一次 `session.marker` 结果，同时用于头顶标记和小地图。
- **战斗候选和名册按逻辑帧复用。** `combatants()` 在同一逻辑帧内共享快照，帧结束清空；名册刷新放在逻辑帧，最多晚约 60ms 生成。
- `captureStoryScene` 与剧情舞台快照共享演员外观引用，只复制必要的外壳字段；开发/测试模式下外观是冻结的，原地修改会直接报错。
- 喝泉水的回血回蓝和技能点结算调用 `domain/springs.ts` 的 `applySpringRecovery`、`grantSpringSkillPoint`；正面状态按存活上阵队员逐个施加，负面或攻防混合状态只给当前操控者。
- **任务目标完成提示走 `showInstant`。** 只在任务簿版本变化时对比状态，只提示 `completion: 'all'` 的可见任务进入待交付；对话/剧情任务已有任务窗，不重复提示。
- 场景键从 `SCENE_KEYS`（`src/application/scene-keys.ts`）取，构造、查找、启动都用它，不写裸字符串。
- 新增场景在 `src/main.ts` 注册，并接上对应的模式。
- **GM 面板的文字也走 DOM。** 游戏内 GM 面板用 `MenuTextLayer` 或 `MenuTextWriter` 输出文字；按钮只留共用皮肤和命中区，角色头顶的调试标签用 `worldToScreen` 跟随相机。
- 跨场景状态通过 `src/application/ports.ts` 的能力接口传递，不挂全局变量或模块级可变状态。
- 云存档页从存档槽页右上角进入，返回和 Escape 都回存档槽页；忙碌时只禁用云操作，返回始终可用，离开页面 abort 请求。账号/密码框直接盖在面板对应行上，输入框有焦点时场景键盘处理器让路；确认框、改名和修改密码表单打开时隐藏输入覆盖层。
- 云存档续期只在打开云页时检查：token 剩余不足 7 天才发 `/__cloud/refresh`，不在游戏循环或后台定时。
- 云存档错误只写页面状态行，不调用 `ui.error()`；场景 `shutdown` 时 abort 云请求并把待确认 Promise 落地。
- 场景键盘只桥接一次：`FormalUiScene` 把原始 `keydown` 交给 `app.inputRouter`，其他场景只注册自己的作用域，不再各挂一份 `keydown`。`MenuScene`、`StoryClassScene` 用 `menu` 作用域；`WorldScene` 的摇杆和快捷位用 `world` 作用域。场景 `shutdown` 时注销作用域。
- 场景 `shutdown` 时解绑输入、计时器和 tween，避免重启后重复触发。
- 标题页资源加载完成后调用 `notifyBootReady()`（`application/live-update.ts`，模块级 once）。热更新壳靠这个信号提交新版本；漏掉会被当成启动失败而回退。

## 验证

```bash
npm run typecheck
npm test -- tests/scene-assets.test.ts
```
