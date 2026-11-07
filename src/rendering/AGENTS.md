# src/rendering

把 `domain` 的状态画到 Phaser 里：角色、地图、战斗表现和界面特效。

## 文件

- 角色/移动：`characters.ts`、`arcade-movement.ts`、`movement-world.ts`、`movement-interpolation.ts`、`character-visibility.ts`、`name-banner.ts`、`control-skin.ts`。
- 地图/资源：`map-layers.ts`、`map-assets.ts`、`prop-atlas.ts`、`scene-assets.ts`、`story-map-view.ts`、`story-minimap.ts`。
- 战斗表现：`combat-presenter.ts`、`combat-effects.ts`、`combat-feedback.ts`、`combat-outcomes.ts`、`combat-assets.ts`、`combat-asset-descriptors.ts`、`resident-combat-assets.ts`、`combat-visual-coverage.ts`、`buff-loop-renderer.ts`、`state-markers.ts`、`status-color.ts`、`status-hud.ts`、`overhead-status.ts`。
- 剧情/HUD/其他：`story-presenter.ts`、`hud.ts`、`action-controls.ts`、`ground-loot.ts`、`pickup-messages.ts`、`wardrobe.ts`、`outfit-pool.ts`、`wardrobe-cache.ts`、`effects.ts`、`effect-animations.ts`、`effect-colors.ts`、`blend-modes.ts`、`webgl-recovery.ts`。

## 规则

- 开发页内存采样按纹理库实际增删计大小。地图、预取与长期战斗资源的租约登记持有者；运行时合成的外观登记 `outfit-pool`，地图贴图登记其创建场景。

- 拾取提示把坐标换算和文字定位计入开发服务的头顶文字耗时。

- 本目录只读取 `domain` 状态并绘制，规则变化和存档写入留在 `domain` 与 `application`。
- **常驻战斗包按当前进度收窄。** `residentCombatAssets` 运行时只装当前主角职业、已拥有伙伴的外观和已学技能；未拥有伙伴和未学技能按需加载。构建期省略这些集合表示“覆盖全量”，用于 `combat-visual-coverage` 校验。新增常驻内容时保持这个收窄口径。
- **合成外观按游戏会话共用。** `OutfitPool` 按基础外观、配方和动作集合复用纹理与在途合成；`Wardrobe` 只持有场景使用权，关闭场景释放使用权。缓存上限 8 套，正在使用或准备中的结果受保护；换会话清理旧池。缓存持有原始部件贴图，图形上下文恢复后仍可重绘。
- **衣柜预览只合成 `idle-south`。** 队伍面板选中成员时只准备预览需要的姿势，上阵/进战斗再补全套；伙伴外观走 `wardrobe-cache.ts` 的全局 LRU（上限 8 套），切换成员不会无上限堆积。
- **剧情舞台快照共享演员外观引用。** `story-presenter` 只复制演员外壳，外观对象按引用共享；开发/测试模式冻结外观，任何原地改外观都会立刻报错。不要为了“保险”恢复逐角色深拷贝。
- **舞台快照按抓取时的真实画面生成。** 镜头滚动、角色位置、可见性和动画帧/播放状态都可能在没有替换逻辑舞台的情况下变化；`captureStage` 每次都要从当前 Scene 读取，不能只按逻辑状态缓存整份快照。
- **跳过剧情只推进逻辑舞台。** 首次切入跳过前先抓取当前实际坐标和镜头；舞台启动、地图与演员素材准备期间也能取消画面等待，迟到结果按取消信号和版本检查清理。跳过信号中止后，`StoryPresenter` 只改逻辑快照（舞台解析、演员坐标与显隐），不重建地图和角色；选择或任务弹窗之前由 `flushStage` 按逻辑快照补画一次。`flushStage` 必须走正常舞台加载，缺的贴图、角色和衣柜资源当场补齐；新增演出动作时要同时决定它在跳过路径里改哪些逻辑状态。
- **队伍单位被内容机关压住时要能自愈。** 火焰、路障、宝箱这类不会自己移动的 `content` 实体算落位障碍；移动自愈、GM 脱困和强制位移都要按整盒避开所有角色，不能只看地形。
- **强制位移只接受整个身体站得住的落点。** 脚点可站但身体压墙的兜底会制造卡墙，不要恢复；找不到落点时由技能层朝目标方向退到最远可站点。
- 动画名用游戏概念：`walk-east`、`idle-south`，不拼接帧号或方向偏移。
- 沿用现有纹理、depth、filter 的组织方式；Phaser 4 写法以 `.agents/skills/` 和 4.2.1 文档为准。
- **飞行物方向不变时只更新位置。** `renderFlight` 在 heading 未变时不要 `removeAll` 重画特效层；只有换向才切 clip。
- **技能补载只加载缺失项。** 用 `missingSceneAssets` 过滤增量；战斗特效自持租约到销毁，补载租约按 owner 持有并在离队/关图时释放。
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
