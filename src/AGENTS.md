# src

游戏源码的家：`app.ts` 负责装配，`main.ts` 创建 Phaser 游戏并注册场景。

## 文件

- `app.ts`：启动装配；按阶段接 ports、UI 和状态，场景与界面通过 `application/ports.ts` 的能力接口取依赖。
- `main.ts`：Phaser 游戏配置与场景注册；新会话创建共用外观池，回标题或换会话释放；4003 开发页接入跳过耗时摘要。
- 开发服务启动时由 `main.ts` 装配慢帧采样。4003 开发网页在同一帧摘要附上内存数据，切换记录共用同一游玩编号和诊断接口。
- `game.css`：页面与画布的样式。
- `scenes/`：地图、剧情舞台、菜单和调试场景，编排生命周期；`debug/`：GM 动作与剧情跳转；`generated/`：构建生成的图集描述。
- `domain/`：内容类型、会话状态、剧情调度、通行与战斗规则。
- `application/`：内容加载、存档、设置和浏览器能力适配。
- `rendering/`：角色、地图、战斗和特效的绘制；`ui/`：布局计算，`ui/phaser/` 负责面板绘制。

## 规则

- 依赖方向固定：`domain`、`debug` 是纯 TypeScript，不 import Phaser 和上层目录；`application` 大多是纯逻辑，只有 `application/game-audio.ts`、`application/game-timing.ts`、`application/game-diagnostics.ts` 三个 Phaser 适配器。
- 场景只编排生命周期；绘制归 `rendering`，布局计算归 `ui`，面板绘制归 `ui/phaser`。
- 手机系统键盘只影响 DOM 输入框，不改变游戏画布尺寸。`main.ts` 的 `visualViewport` 重排在输入框聚焦时只跟随位置偏移（`fitViewport({keepSize:true})`），不按键盘缩小后的可视区重算尺寸；云存档输入框挂在 `#game-frame` 内，与画布共用坐标系。
- iOS 弹出键盘会让窗口短暂失焦。`main.ts` 在启动后接管 `window.onblur/onfocus` 并关闭 Phaser 的 `pauseOnBlur`：输入框聚焦期间的失焦不能暂停游戏循环或音频，真正的页面切走由 `visibilitychange` 驱动。
- 玩法规则只在 `domain` 写一份，`application` 负责把它接到 Phaser 和浏览器。
- 实现顺序：Phaser 4 内置 API → `.agents/skills/` 技能 → Phaser 4.2.1 官方文档，全程按 v4 API 写。
- 内置优先：移动和碰撞用 Arcade Physics（`this.physics`），镜头跟随用 `this.cameras.main.startFollow()`，逐帧动画用 `this.anims`；不要自己写循环。
- Phaser 4 的渲染管线是 render node，FX/mask 用 filter，tint 和纹理坐标与 v3 不同；不要套 v3 写法。
- 代码用游戏语义命名：`pos = { x: -rec.u_5, ... }` 写成 `worldPosition = { x: -rec.tileX, ... }`；位运算封装成 `getTileIndex(cell)` / `isFlippedHorizontally(cell)`；`0x2484` 这类索引在解码时算成 `transparentIndex`；地图调色板在导出阶段展开成 `world.tilePalette`。

## 验证

- `npm run typecheck` 覆盖整个 `src`；按改动另跑 `npm test -- tests/session.test.ts`。
