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
- `animation-debug-scene.ts`：`?animation-debug` 进入的动画调试场景。
- `ui-debug-scene.ts`：`?ui-debug` 进入的面板调试场景。

## 规则

- 场景只驱动生命周期、转发输入、调度下层模块；判定和数值规则写进 `src/domain/`，具体绘制交给 `src/rendering/` 与 `src/ui/phaser/`。
- 击杀奖励结算、召唤生命周期和交互决策在 `src/domain/`：场景只收集输入、播放表现、决定落点并执行 domain 返回的动作/奖励清单。
- `WorldScene.interact()` 把附近目标、朝向、任务槽和商店状态交给 `domain/interaction.ts` 的 `resolveInteraction`；选目标的 `updateInteractionTarget` 留在场景。
- 有商店的 NPC 无论有没有招呼语，都算可交互目标；交互优先级仍由 `resolveInteraction` 决定。
- 掉落落点用 `lootLanding` 避开地图进出口；不要把物品图标落在门洞上。
- 伙伴外观按需加载：队伍面板预览只准备 `idle-south`，进战斗开场再补全套；使用勇士徽章招募后由招募确认或队伍面板调用 `preparePartyMember`，不要为了省事把全部伙伴重新塞回常驻包。
- **地图内学会新技能后要补素材。** 进图和开战的素材计划只覆盖当时已学的技能；玩家或伙伴升级、学新技能、换武器后，`WorldCombat` 用 `scheduleSkillAssetRefresh` 按签名补载新增技能的特效、姿态和召唤物。签名不变不重复加载，补载租约到关闭地图时统一释放。
- `captureStoryScene` 与剧情舞台快照共享演员外观引用，只复制必要的外壳字段；开发/测试模式下外观是冻结的，原地修改会直接报错。
- 喝泉水的回血回蓝和技能点结算调用 `domain/springs.ts` 的 `applySpringRecovery`、`grantSpringSkillPoint`；正面状态按存活上阵队员逐个施加，负面或攻防混合状态只给当前操控者。
- **任务目标完成提示走 `showInstant`。** 只在任务簿版本变化时对比状态，只提示 `completion: 'all'` 的可见任务进入待交付；对话/剧情任务已有任务窗，不重复提示。
- 场景键从 `SCENE_KEYS`（`src/application/scene-keys.ts`）取，构造、查找、启动都用它，不写裸字符串。
- 新增场景在 `src/main.ts` 注册，并接上对应模式与 URL 参数的启动分支。
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
