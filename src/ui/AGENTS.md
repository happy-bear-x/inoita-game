# src/ui

界面的布局、文本与接口层：算好矩形、断行、颜色和提示内容，交给 `src/ui/dom/` 绘制。

## 文件

- 布局：`bag-layout.ts`（背包格位）、`skill-book-layout.ts`（技能书页的图标格与右栏）、`choice-layout.ts`（选项竖排）、`control-layout.ts`（控件键位）、`item-layout.ts`（物品格与货币）、`shop-layout.ts`（商店两栏）、`quest-popup-layout.ts`（任务窗）、`description-text-layout.ts`（说明断行）、`text-layout.ts`（通用换行）、`cloud-save-layout.ts`（云存档页状态、颜色与几何）、`portrait-fit.ts`（头像等比裁剪）、`viewport.ts`（画布缩放、安全区与参考分辨率）。
- 文本与样式：`text-style.ts`（共用字体）、`text-prompt.ts`（系统键盘输入，用于存档改名）、`cloud-credentials-input.ts`（云存档页内嵌的账号/密码输入框）、`password-change-prompt.ts`（修改密码的当前/新/确认三项表单）、`dialogue-text.ts`（对白分页、断行与逐字显示）、`item-detail-lines.ts`（物品说明行）、`skill-detail-lines.ts`（技能说明行）、`item-result-details.ts`（操作结果说明）、`enhancement-odds-lines.ts`（强化结果句与混沌结果表）、`item-name-color.ts`（品质颜色与装备格边框）、`character-values.ts`（角色数值）。
- 接口与交互：`game-ui.ts`（UI 能力与视图接口）、`story-ui.ts`（剧情与菜单 UI 的接口、页面枚举和提示文案）、`story-ui-signature.ts`（菜单页面 viewModel 与显式签名）、`save-page.ts`（存档/读档页 controller）、`action-press-gate.ts`（动作按钮互斥）、`common-button.ts`（通用按钮素材）、`instant-message.ts`（屏幕提示）、`slot-frame.ts`（格子底图）。
- DOM 组件：`dom/node.ts`、`dom/surface.ts` 提供菜单图片、文本、按钮、裁剪、滚动与原生指针；`dom/volume-slider.ts` 提供音量条，`dom/character-preview.ts` 提供角色静态预览。
- DOM 文字：`dom/dom-ui.ts`（标签创建、层与坐标换算）、`dom/menu-text.ts`（菜单页、滚动与裁剪）。

## 规则


- 本目录承载布局、断行、状态和动作接口；屏幕组件的 DOM 绘制与输入在 `src/ui/dom/`。
- **头像按比例裁进框。** HUD、人物页和队员栏的头像用 `portraitFit` / `UiSurface.imageCover` 等比缩放后裁剪；背包和队伍装备页的备用人物图用 `imageContain` 完整放进预览框。
- 人物页的生命、魔法、经验三行位于立绘下方；标签、数值和百分比按对应槽位的中心线对齐，最后一行完整落在面板内。
- **画面铺满，安全区只给 UI 避让。** Android 壳用 edge-to-edge 铺满整屏；`readSafeArea()` 只用于 HUD、侧边按钮、小地图和文字的安全边，不参与画布尺寸。
- 左侧存档和菜单按钮与小地图共用安全区起点及缩放，从小地图下沿开始排；静态层容器不参与按钮排序。
- `story-ui.ts` 的长按加点与背包拖放接收窗口原生移动、松手、取消和失焦事件；正文重绘后仍能结束手势。侧边按钮按实际内容节点判断是否已创建。
- `story-ui.ts` 只在 `attach` 时向 `app.inputRouter` 注册一个 `menu` 作用域，菜单打开时独占键盘；场景不再单独订阅 `keydown`。
- **页面 controller 拥有这一页的状态和操作。** `save-page.ts` 是存档/读档页的样板：确认框、改名输入、读写请求和 Escape 分层都在 controller 里，`StoryUI` 只保留路由、生命周期、共享输入和整页重绘。后续拆 `party`、`quests`、`shop` 等页面时沿用同一方向，不重写面板绘制。
- **每个菜单页面都有显式签名。** 页面 viewModel 与签名集中在 `story-ui-signature.ts`：用 `page`、`selectedMemberId`、`bag.revision`、`questBook.version`、`party` 形状、技能版本、存档槽摘要、设置值和面板自己的 `viewModel()` 拼出来，不做对象深度哈希。新增 `Page` 必须同时在 `STORY_MENU_PAGES` 和签名分支里补上；会话通知只在该页签名变化时重绘，数据没变不重绘。
- 这里不运行时导入 `phaser`；需要 Phaser 类型时用 `import type`，写法参考 `story-ui.ts`。
- **DOM 文字统一带 `dom-label`。** `DomUi.label` 会自动补上这个类，它负责绝对定位、不换行和禁用指针事件；调用方只加自己的样式类。压在游戏画面上的文字用 `#ui-world`/`#ui-hud` 的软阴影，菜单文字站在面板底色上，不加描边。
- **滚动文字用 `clip` 交给浏览器裁边。** `MenuTextLayer` 会为同一组上下边界建一个 `overflow:hidden` 的容器，滚动只移动标签；新增可滚动面板时同时给 `scroll` 和 `clip`，不要只靠 `y` 判断显隐。
- **菜单滚动区由 `StoryUI.scroll` 统一登记。** 它建区时会给 `ScrollArea` 加一条自动刷新 DOM 文字的监听；面板的 `onScroll` 只负责记自己的偏移和状态，不要再为文字单独调用刷新，也不要在菜单页绕过 `StoryUI.scroll` 自建滚动区。
- **全屏遮罩用 `DomUi.setOccluded`。** 加载页、阵亡面板、跨图黑幕、横屏提示和挂起时，由 `uiOcclusion`（`game-ui.ts`）判断并收起 world/hud/screen 三层；加载页自己的文字放在 overlay 层。新增全屏界面时不要再让各页面各自猜显隐。
- 文本宽度、换行、选项高度和滚动范围在交给显示组件前算完，绘制层只按结果摆放。
- 快捷位显示契约由 `shortcut-view.ts` 提供，场景和控件共用技能、物品与冷却快照。
- 控件尺寸从 `control-layout.ts` 的 `CONTROL_SIZES` 取；D-pad 视觉与布局用 `moveDpad` 274×274，摇杆用 `move` 210×210。
- **长按按钮用 `UiSurface.button` 的 `hold` 选项。** 按住超过 `delayMs` 后每 `intervalMs` 执行一次，松手不再补一次点击；按钮禁用时立刻停。商店数量箭头用 350ms/80ms。
- **摇杆的指针状态必须能自愈。** 新的 `pointerdown` 接管旧指针；`pointercancel`、`gameout`、以及 `isDown=false` 的移动事件都要回中，避免丢失 `pointerup` 后一直朝某个方向走。
- 用户调过的控件大小按控件位置保存成倍率（`scale`，0.6–2.0），解析时与屏幕适配缩放分开乘。倍率跟着 `slot-0`…`slot-5` 这些位置走，切换技能组或换成技能/物品内容都不改变它。
- 字体、字号和颜色取 `text-style.ts`，新面板不再另建一套字体栈。
- 说明面板底部动作 1–3 个排一横排；4 个用 2×2，5–6 个用 3×2，几何由 `descriptionActionLayout` 统一给出。
- 新增面板先在这里补几何和文本函数，再在 `src/ui/dom/` 实现绘制与输入。
- **融合器预览按当前页签档位取色。** 混沌/深渊混沌预览的标题颜色和格子边框由页签档位决定；合成完成后的背包按实例真实档位显示。
- 云存档页的状态颜色和面板几何从 `cloud-save-layout.ts` 取；账号/密码输入用 `cloud-credentials-input.ts` 的内嵌输入框，直接定位在面板对应行上，不用独立弹层。存档改名继续用 `TextPrompt`。
- **强化结果先写人话。** 普通卷轴写成「当前 +N：X% 到 +N+1，Y% 到 +N+2」；混沌卷轴写成三行结果表。概率文案统一由 `enhancement-odds-lines.ts` 生成，面板只负责画。
- **菜单子页面保留底层。** 强化台、合成台、技能书这类从菜单进入的子页面用 `page` 渲染在 `body` 上；`surface`/`body` 继续可见，只把说明层让位，不要隐藏整层再铺纯黑遮罩。
- **技能书页复用技能目录的图标语言。** 左框只列当前可升级的技能（4×4 图标格，一屏放下），没有可升级技能时显示「暂无可升级技能」；右框显示等级变化与下一级数值预览，确认后才消耗技能书。
- **游戏内界面不写解释性文案。** 这是游戏而不是说明书：格子、按钮和页面只呈现状态与结果，用户明确要求时才加「×＝可用」这类说明文字。
- **操作结果提示走 `GameUI.showInstant`。** 泉水恢复、任务完成和菜单里的「脱离卡死」都用这一套屏幕提示；`toast` 只用于加载、准备之类的短提示。
- **一次操作只重绘一次。** 子页面打开期间（如 `page==='forge'`）`bind` 的会话订阅跳过整页重绘；动作完成后由子页面面板的 `changed` 统一重绘一次。
- 队员外观准备完成后只更新背包人物预览；已经切到其他队员或页面时忽略迟到结果。
- **整理按钮使用共用按钮皮肤。** 背包分类选中时用淡色底，侧栏与商人、合成台和强化台共用绘制。
- **说明面板动作行用文字按钮。** `renderItemDetail` 的动作统一走 `v.button(label, ...)` 的共用按钮皮肤；不再给动作塞 `item-equip`/`item-discard` 这类烘焙图。
- **阵亡面板的「读取存档」复用菜单的读档页。** 打开时暂时收起阵亡面板并让出 `defeat` 锁，读档页关闭后恢复同一个面板；不要另写一套存档列表。

## 验证

```bash
npm run typecheck
npm test -- tests/bag-layout.test.ts tests/choice-layout.test.ts
```
