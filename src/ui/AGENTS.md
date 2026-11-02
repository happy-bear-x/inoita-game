# src/ui

界面的布局、文本与接口层：算好矩形、断行、颜色和提示内容，交给 `src/ui/phaser/` 绘制。

## 文件

- 布局：`bag-layout.ts`（背包格位）、`skill-book-layout.ts`（技能书页的图标格与右栏）、`choice-layout.ts`（选项竖排）、`control-layout.ts`（控件键位）、`item-layout.ts`（物品格与货币）、`shop-layout.ts`（商店两栏）、`quest-popup-layout.ts`（任务窗）、`description-text-layout.ts`（说明断行）、`text-layout.ts`（通用换行）、`cloud-save-layout.ts`（云存档页状态、颜色与几何）、`viewport.ts`（画布缩放、安全区与参考分辨率）。
- 文本与样式：`text-style.ts`（共用字体）、`text-prompt.ts`（系统键盘输入，用于存档改名）、`cloud-credentials-input.ts`（云存档页内嵌的账号/密码输入框）、`password-change-prompt.ts`（修改密码的当前/新/确认三项表单）、`dialogue-text.ts`（对白分页、断行与逐字显示）、`item-detail-lines.ts`（物品说明行）、`skill-detail-lines.ts`（技能说明行）、`item-result-details.ts`（操作结果说明）、`enhancement-odds-lines.ts`（强化结果句与混沌结果表）、`item-name-color.ts`（品质颜色与装备格边框）、`character-values.ts`（角色数值）。
- 接口与交互：`game-ui.ts`（UI 能力与视图接口）、`story-ui.ts`（剧情与菜单 UI 的接口、页面枚举和提示文案）、`action-press-gate.ts`（动作按钮互斥）、`common-button.ts`（通用按钮素材）、`instant-message.ts`（屏幕提示）、`slot-frame.ts`（格子底图）。

## 规则

- 本目录只做布局、断行、格式化和提示内容；实际绘制在 `src/ui/phaser/`。
- 这里不运行时导入 `phaser`；需要 Phaser 类型时用 `import type`，写法参考 `story-ui.ts`。
- 文本宽度、换行、选项高度和滚动范围在进入 Phaser 前算完，绘制层只按结果摆放。
- 控件尺寸从 `control-layout.ts` 的 `CONTROL_SIZES` 取；D-pad 视觉与布局用 `moveDpad` 274×274，摇杆用 `move` 210×210。
- 用户调过的控件大小按控件位置保存成倍率（`scale`，0.6–2.0），解析时与屏幕适配缩放分开乘。倍率跟着 `slot-0`…`slot-5` 这些位置走，切换技能组或换成技能/物品内容都不改变它。
- 字体、字号和颜色取 `text-style.ts`，新面板不再另建一套字体栈。
- 说明面板底部动作 1–3 个排一横排；4 个用 2×2，5–6 个用 3×2，几何由 `descriptionActionLayout` 统一给出。
- 新增面板先在这里补几何和文本函数，再在 `src/ui/phaser/` 实现绘制。
- 云存档页的状态颜色和面板几何从 `cloud-save-layout.ts` 取；账号/密码输入用 `cloud-credentials-input.ts` 的内嵌输入框，直接定位在面板对应行上，不用独立弹层。存档改名继续用 `TextPrompt`。
- **强化结果先写人话。** 普通卷轴写成「当前 +N：X% 到 +N+1，Y% 到 +N+2」；混沌卷轴写成三行结果表。概率文案统一由 `enhancement-odds-lines.ts` 生成，面板只负责画。
- **菜单子页面保留底层。** 强化台、合成台、技能书这类从菜单进入的子页面用 `page` 渲染在 `body` 上；`surface`/`body` 继续可见，只把说明层让位，不要隐藏整层再铺纯黑遮罩。
- **技能书页复用技能目录的图标语言。** 左框按技能目录页的 75×75 图标格排本职业全部技能（4×4 一屏放下），可用技能挂技能书角标、不可用压暗；右框显示等级变化与下一级数值预览，确认后才消耗技能书。
- **一次操作只重绘一次。** 子页面打开期间（如 `page==='forge'`）`bind` 的会话订阅跳过整页重绘；动作完成后由子页面面板的 `changed` 统一重绘一次。
- **说明面板动作行用文字按钮。** `renderItemDetail` 的动作统一走 `v.button(label, ...)` 的共用按钮皮肤；不再给动作塞 `item-equip`/`item-discard` 这类烘焙图。
- **阵亡面板的「读取存档」复用菜单的读档页。** 打开时暂时收起阵亡面板并让出 `defeat` 锁，读档页关闭后恢复同一个面板；不要另写一套存档列表。

## 验证

```bash
npm run typecheck
npm test -- tests/bag-layout.test.ts tests/choice-layout.test.ts
```
