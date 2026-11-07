# src/application

能力接口与适配层：把 `domain` 的纯规则接到 Phaser、浏览器和磁盘。

## 文件

- 端口/场景键/事件：`ports.ts`（能力接口）、`scene-keys.ts`（场景键）、`ui-events.ts`（界面事件名）、`input-router.ts`（全局键盘作用域与优先级）、`entry-loading.ts`（入口加载与继续进度）、`entry-plan.ts`（入口计划与地图资产）、`menu-images.ts`（标题与菜单图片分组）。
- 内容加载与校验：`content-loader.ts`（内容加载器与生产哨兵）、`content-validation.ts`（内容字段校验器）、`content-relations.ts`（引用关系校验）、`content-hash.ts`（规范化 JSON 与内容摘要）、`content-trust.ts`（构建期信任开关）、`story-performance-validation.ts`（剧情演出校验）、`story-reference-validation.ts`（剧情引用校验）。
- 存档/迁移/自动保存：`saved-game.ts`（存档格式与升级链）、`saved-game-loader.ts`（存档读取与取消）、`auto-save.ts`（自动保存节流与重试）、`quest-item-grants.ts`（任务物品净发放与溢出）。
- 云存档：`cloud-save.ts`（HTTP 客户端、token 存储、续期、改密与结果化错误）、`cloud-save-sync.ts`（逐槽备份/恢复、覆盖确认与部分失败）、`endpoints.ts`（云存档/诊断服务地址解析，网页同源，宿主注入）。
- 资源/版本：`assets.ts`（素材池与租约）、`asset-version.ts`（素材与内容版本号）。
- 热更新接线：`live-update.ts`（标题页启动完成信号）。
- 设置/控制：`control-settings.ts`（操作模式设置）、`control-state.ts`（操作状态与游戏模式）、`display-settings.ts`（显示偏好）、`key-bindings.ts`（键位偏好）、`fullscreen.ts`（全屏与横屏锁定）。
- Phaser/浏览器适配：`game-audio.ts`（音频适配）、`game-timing.ts`（帧时钟适配）、`game-diagnostics.ts`（诊断上报适配）、`render-options.ts`（像素渲染启动开关与真机 A/B 参数）、`browser-compat.ts`（浏览器 API 兼容补丁）。

## 规则

- 键盘输入只从场景桥接一次进 `input-router.ts`。作用域从高到低是 `text-input > modal > menu > dialogue > world`；处理器返回 `boolean` 表示是否消费。文本输入框有焦点、弹层或菜单打开时用 `exclusive` 独占，按键不会再落到世界层。按钮点击、滚动和拖拽继续走 Phaser 输入，router 不接指针。场景 `shutdown` 时注销自己注册的作用域。
- 新能力先在 `ports.ts` 定义接口，由 `src/app.ts` 在启动阶段注入实现。
- 场景通过 ports 取素材、音频和浏览器能力，加载与 API 调用留在本目录。
- 云存档是旁路能力：客户端构造不联网，只有打开云页/点击上传下载才请求；网络、token 或存储失败都结果化返回，不能抛到菜单或游戏循环。
- 云存档和诊断的服务地址只从 `endpoints.ts` 解析。环境根地址在 `config/endpoints.json`：网页固定同源（空值）；Android 调试指向 `adb reverse` 的 `127.0.0.1:4003`，发布和网页生产共用 `https://catgo.online:4002`。Android/热更新在页面脚本前注入 `__inoitaEndpoints`；页面里不再另写域名或读取别的地址变量。
- 只有 `game-audio.ts`、`game-timing.ts`、`game-diagnostics.ts` import Phaser，其余文件保持纯 TypeScript。
- 改存档结构或校验口径时，把 `src/domain/save-game.ts` 的 `SAVE_FORMAT` 加一，并在 `saved-game.ts` 的升级链补旧版到新版的迁移和旧档测试。
- 内容加载与构建共用 `content-validation.ts` 的校验器，新增内容字段先在这里定校验口径。
- 生产信任路径只取构建写出的 `content-manifest.json`：比较 `contentVersion` 与页面注入的 `__STORY_CONTENT_VERSION__`，并检查本次文件的必需顶层键；不匹配时明确失败并提示刷新/更新，不静默继续。启动时不对整份内容重算哈希。dev、Node 测试、`?gm` 和 `?validate` 继续走完整校验。
- 热更新只做旁路：标题页加载完成后调用 `notifyBootReady()`；网页版没有原生桥时静默跳过。检查、下载、切换和回退都在 Android 壳里，网页不判断版本。
- 会话边界清理：回菜单和新会话装配时调用 `ContentLoader.clearSessionCaches()` 与 `StoryApp.clearMapHistory()`；只清已完成的地图/姿势解析和历史地图租约，核心内容表保持常驻。
- 地图素材历史保留最近 2 张，预取额度单独管理。

## 验证

- `npm test -- tests/saved-game.test.ts`：存档迁移与旧档读取。
- `npm test -- tests/cloud-save-client.test.ts tests/cloud-save-sync.test.ts tests/cloud-save-offline.test.ts`：云客户端、同步与离线降级。
- `npm test -- tests/endpoints.test.ts`：环境根地址、运行时注入与非法地址降级。
- `npm test -- tests/content-loader.test.ts`：内容加载与校验。
