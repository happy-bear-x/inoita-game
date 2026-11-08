# src/rendering

把 `domain` 的状态画到 Phaser 里：角色、地图、战斗表现和界面特效。

## 文件

- 角色/移动：`characters.ts`、`arcade-movement.ts`、`movement-world.ts`、`movement-interpolation.ts`、`character-visibility.ts`、`name-banner.ts`、`control-skin.ts`。
- 地图/资源：`map-layers.ts`、`map-assets.ts`、`prop-atlas.ts`、`scene-assets.ts`、`story-map-view.ts`、`story-minimap.ts`。
- 战斗表现：`combat-presenter.ts`、`combat-effects.ts`、`combat-feedback.ts`、`combat-outcomes.ts`、`combat-assets.ts`、`combat-asset-descriptors.ts`、`resident-combat-assets.ts`、`combat-visual-coverage.ts`、`buff-loop-renderer.ts`、`state-markers.ts`、`status-color.ts`、`status-hud.ts`、`overhead-status.ts`。
- 剧情/HUD/其他：`story-presenter.ts`、`hud.ts`、`action-controls.ts`、`ground-loot.ts`、`pickup-messages.ts`、`wardrobe.ts`、`outfit-pool.ts`、`wardrobe-cache.ts`、`effects.ts`、`effect-animations.ts`、`effect-colors.ts`、`blend-modes.ts`、`webgl-recovery.ts`。

## 规则



- 本目录只读取 `domain` 状态并绘制，规则变化和存档写入留在 `domain` 与 `application`。
- `Hud.watchVisibility` 将所属场景的暂停、睡眠与恢复状态传给 DOM 状态栏；组件关闭时注销监听，场景销毁时统一隐藏。
- 拾取提示用当前镜头投影位置，并与任务标记共用同一帧的画框、画布测量。
- 静态地图物件按镜头当前世界视野跳过屏幕外绘制，并在边缘保留 64 像素；镜头旋转、震动或视野无效时画完整地图，保持物件本身的显隐和原有深度。
- 屏幕状态栏与小地图的图片由 DOM 资源池持有；地图贴图计划只为头顶血条保留 `overhead-frame` 和 `overhead-leader`。
- **正式游玩只长期保留通用战斗反馈。** `residentCombatAssets` 的 `feedbackOnly` 覆盖命中、结果和状态反馈；当前地图与施法者分别持有角色、装备、已学技能及召唤物的完整清单。构建期省略该选项，用职业、伙伴、技能集合做覆盖校验。
- 地图和对白先加载演员的待机、行走与快照当前动作；剧情姿态和特效在实际执行前加载，跳过不等待画面，补画按快照恢复所需动作。敌人战斗素材仍覆盖其技能与递归召唤物。
- 角色图片按像素和切帧共用；全局动画另按帧数、帧率和循环方式登记，图片最后释放时清掉引用它的全部动画。
- **合成外观按游戏会话共用。** `OutfitPool` 按基础外观、配方和动作集合复用纹理与在途合成；`Wardrobe` 只持有场景使用权，关闭场景释放使用权。缓存上限 8 套，正在使用或准备中的结果受保护；换会话清理旧池。缓存持有原始部件贴图，图形上下文恢复后仍可重绘。
- `OutfitPool` 独立持有已加载的动作姿势；合成期间按池生命周期保留，清理时释放，不写回跨会话共用的衣柜目录。
- **衣柜预览只合成 `idle-south`。** 队伍面板选中成员时只准备预览需要的姿势，上阵/进战斗再补全套；伙伴外观走 `wardrobe-cache.ts` 的全局 LRU（上限 8 套），切换成员不会无上限堆积。
- **剧情舞台快照共享演员外观引用。** `story-presenter` 只复制演员外壳，外观对象按引用共享；开发/测试模式冻结外观，任何原地改外观都会立刻报错。不要为了“保险”恢复逐角色深拷贝。
- **舞台快照按抓取时的真实画面生成。** 镜头滚动、角色位置、可见性和动画帧/播放状态都可能在没有替换逻辑舞台的情况下变化；`captureStage` 每次都要从当前 Scene 读取，不能只按逻辑状态缓存整份快照。
- **跳过剧情只推进逻辑舞台。** 首次切入跳过前先抓取当前实际坐标和镜头；舞台启动、地图与演员素材准备期间也能取消画面等待，迟到结果按取消信号和版本检查清理。跳过信号中止后，`StoryPresenter` 只改逻辑快照（舞台解析、演员坐标与显隐），不重建地图和角色；选择或任务弹窗之前由 `flushStage` 按逻辑快照补画一次。`flushStage` 必须走正常舞台加载，缺的贴图、角色和衣柜资源当场补齐；新增演出动作时要同时决定它在跳过路径里改哪些逻辑状态。
- **队伍单位被内容机关压住时要能自愈。** 火焰、路障、宝箱这类不会自己移动的 `content` 实体算落位障碍；移动自愈、GM 脱困和强制位移都要按整盒避开所有角色，不能只看地形。
- 位置平滑只搬动最近两个物理步坐标不同的角色，静止对象跳过绘制前后的坐标写入；采样点独立保存并复用，瞬移、移除与重新启用时清理移动名单。
- **强制位移只接受整个身体站得住的落点。** 脚点可站但身体压墙的兜底会制造卡墙，不要恢复；找不到落点时由技能层朝目标方向退到最远可站点。
- 动画名用游戏概念：`walk-east`、`idle-south`，不拼接帧号或方向偏移。
- 受击闪光结束后重新应用当前状态颜色；没有状态颜色时关闭颜色滤镜。图层、逻辑帧或状态未变也要恢复。
- 角色切动作按图层位置复用 Sprite，只增删数量变化的部分；每次接手仍换新 `layers` 数组，旧动作按数组身份判断能否收尾。切换清理旧动作的完成监听，保留潜行透明度、状态色和连续行走进度。
- 每个角色 Sprite 最多缓存一套本地动作序列，纹理、帧序或时长变化时替换；普通源纹理保留到缓存释放，合成外观继续由 `OutfitPool` 管理。换外观与销毁时清掉局部动画和使用权。
- 沿用现有纹理、depth、filter 的组织方式；Phaser 4 写法以 `.agents/skills/` 和 4.2.1 文档为准。
- **飞行物方向不变时只更新位置。** `renderFlight` 在 heading 未变时不要 `removeAll` 重画特效层；只有换向才切 clip。纵坐标对应的 depth 没变时跳过写入，水平飞行不重复触发显示列表排序。
- **技能资源按使用者持有完整清单。** `loadSceneAssets` 内部只下载缺失项，调用方登记全部所需资源；新清单准备成功且仍对应当前技能与装备时，先安装新使用权再释放旧清单，离队和关图释放对应使用者。
- 职业人物贴图保留基础动作与已学技能四向动画；敌人和召唤物按普攻连段、技能自定义动作及指令动作准备，递归包含伙伴成长和追击动作中的召唤物。
- **特效图集动画按全局 AnimationManager 记账。** Phaser 的 `anims`/`textures` 是全游戏共用；纹理最后一个租约释放时，必须按全局动画表删掉所有引用其 Frame 的特效动画。播放前发现帧已失效要删掉重建（`effects.ts`），不能直接播旧动画。
- **贴图齐全时直接取得使用权。** `loadSceneAssets` 按纹理与帧完整性先检查，全部齐全或空列表时不进入写入队列；只有缺项或修复残帧才排队。
- **取消的加载要按纹理库对账。** Phaser 的 Loader 不保证在场景关闭时中止在途文件；`loadSceneAssets` 中止时把本批 key 记为待核对，晚到的 `addtexture` 如果没有新租约接管就立即删除，避免无主纹理。
- 性能敏感的改动先在 4002/APK 上实测基线，再决定是否新增对象或逐帧逻辑。
- **特殊怪只在原版的位置标记。** 小地图按全图已生成的 `specialRank` 非零怪物画星标，精英和 Boss 共用 `minimap-special`；选中特殊目标时顶部面板在血条下方画三星。地图角色头顶不加常驻 Boss 图标。

## 验证

- `npm run typecheck`：类型检查覆盖本目录。
- `npm test -- tests/buff-loop-renderer.test.ts`：状态图标循环表现。
- `npm test -- tests/movement-content-recovery.test.ts`：内容机关压住队伍单位后的自愈。
- `npm test -- tests/state-markers.test.ts`：眩晕/睡眠状态标记的创建与销毁。
- `npm test -- tests/story-skip.test.ts tests/story-stage-isolation.test.ts`：跳过剧情不重建舞台，选择与任务弹窗前按逻辑快照补画。

- 特效容器持有当前动画贴图到销毁；转向飞弹另持有全部方向。循环效果缺图时保留逻辑状态，素材到齐后重建，按当前帧龄显示。
