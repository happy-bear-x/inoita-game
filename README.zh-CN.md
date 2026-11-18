[English](README.md) | **简体中文**

# 艾诺迪亚4重制版

基于《艾诺迪亚4》的同人重制版，使用 Phaser 4.2.1 和 TypeScript 开发。电脑和手机浏览器都能直接运行，也可以打包成独立的 Android 应用。仓库里有游戏源码、剧情与任务内容、素材、测试和构建工具。

这是非商业同人作品，不是官方游戏。原版游戏的素材，以及从原版剧情派生的文本，版权归原权利方所有，详见[许可证](#许可证)。

## 游戏内容

- 剧情演出、任务、对白和选择
- 实时战斗和队伍 AI
- 地图、移动和战斗特效
- 带账号登录的云存档
- 自带 Chromium、支持热更新的 Android 应用
- 用于测试任务和游戏状态的 GM 调试模式

## 环境要求

- Node.js 24 或更高版本
- npm

## 快速开始

```bash
npm ci
npm run dev
```

浏览器打开 http://localhost:4003/ 。

`npm run dev` 的代码从源码直接加载，内容按和生产构建相同的规则编译。

## 本地预览构建产物

```bash
npm run build
npm run serve
```

浏览器打开 http://127.0.0.1:4004/ 。

`npm run build` 会先校验内容，再把游戏构建到 `dist/`。`npm run serve` 直接读取磁盘上的 `dist/`，所以重新构建后刷新页面就能看到新内容，不需要重启服务。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发服务，端口 4003。 |
| `npm run build` | 校验内容，构建到 `dist/`，并裁剪未使用的素材。 |
| `npm run serve` | 提供构建好的 `dist/` 目录，端口 4004。 |
| `npm run deploy` | 类型检查、构建，并核对线上正在提供的是不是这次构建。 |
| `npm run typecheck` | 只做 TypeScript 类型检查。 |
| `npm test -- tests/combat.test.ts` | 先做类型检查，再运行指定测试文件。 |
| `npm run test:all` | 运行全量单元测试。 |
| `npm run validate:content` | 校验内容、校验器和素材引用。 |
| `npm run test:standalone` | 验收全新安装、类型检查和构建。 |
| `npm run apk` | 打包 Android 安装包。 |
| `npm run verify:apk` | 校验 APK 产物。 |
| `npm run update:key` | 首次生成热更新签名密钥。 |
| `npm run verify:update` | 核对 APK 基线与线上更新清单的差量。 |

## 目录结构

```text
src/                游戏源码
  application/      能力接口、内容加载、存档与音频装配
  domain/           战斗、剧情、任务、背包、存档等纯规则
  rendering/        Phaser 世界、战斗、特效与角色表现
  scenes/           地图、剧情舞台与菜单
  ui/               菜单、HUD、对话、DOM 组件与界面逻辑
  debug/            GM 调试动作层
public/             随游戏发布的运行时静态资源
  content/          剧情、任务、地图、战斗、物品、音频等内容 JSON
  assets/           运行时图集页、地图、音频和未进图集的独立图片
asset-source/       图集生成与内容去重的源图（进 Git，不随游戏发布）
asset-archive/      构建裁剪出的运行时旧图副本（不进 Git）
tests/              单元测试与独立构建验收
tools/              构建、校验、静态服务、APK 打包
docs/               架构、剧情创作、部署、热更新、调试与诊断说明
android/            Android 自带 Chromium 156 的壳
.agents/skills/     随仓库提供的 Phaser 4 开发技能
```

## 内容与素材

- `public/content/campaign.json` 保存剧情、任务、事件和角色摆放。
- `public/content/world.json`、`public/content/maps/`、`public/content/battle.json` 等文件保存地图和战斗数据。
- `public/assets/` 保存运行时加载的图集页、地图、音频和未进图集的独立图片。内容 JSON 或图集映射会指向这些文件。
- `asset-source/` 保存角色、特效、界面、道具和图标的源图。图集生成、内容去重和逐像素测试只从这里读，这个目录不随游戏发布。
- 内容字段的写法和校验规则见[剧情与任务创作](docs/story-content.md)。
- 改动内容、校验器或素材引用后运行 `npm run validate:content`；构建时还会再校验一次。

素材和内容随游戏版本管理，不依赖仓库外的数据。新增素材时按现有目录和命名规则放置，并确认内容校验与构建通过。

## 开发文档

| 要做的工作 | 从哪里开始 |
|---|---|
| 先弄懂各模块怎么协作 | [模块原理入门](docs/module-guide.md) |
| 改功能、规则或生命周期 | [架构与修改入口](docs/architecture.md) → 对应源码与测试 |
| 写对白、任务、事件或地图条件 | [剧情与任务创作](docs/story-content.md) → `public/content/campaign.json` |
| 改音乐、环境音与音效 | [音频说明](docs/audio.md) → `public/content/audio.json` |
| 调试游戏或任务 | [GM 调试模式](docs/debugging.md) |
| 部署与缓存 | [打包服务与部署](docs/deployment.md) |
| 安卓热更新与分发 | [热更新](docs/live-update.md) |
| 收集手机端报错 | [诊断说明](docs/diagnostics.md) |

## 界面与调试

屏幕界面由 DOM、CSS 和 SVG 组件负责；地图、角色和战斗由 Phaser 绘制。

- `?gm`：本次会话打开 GM 调试模式，标题页出现「调试」入口。
- GM 面板包含状态、人物、道具和剧情四个子页；浏览器里也可以调用 `globalThis.gm` 执行同一套调试动作。

## Phaser 技能

仓库自带 28 个 Phaser 4 开发技能，位于 `.agents/skills/`，Claude Code 通过 `.claude/skills` 符号链接读取。技能覆盖场景、动画、物理、相机、瓦片地图、输入、文本、粒子、滤镜、缩放与 Phaser 4 新特性。

实现功能时按这个顺序找解法：

1. Phaser 内置 API；
2. 项目内对应的 Phaser 技能；
3. Phaser 4.2.1 官方文档。

引擎版本以 `package.json` 为准。

## 测试

默认选择与改动直接相关的 `tests/*.test.ts`，可以一次传多个文件。单元测试验证规则和轻量替身；内容校验验证文件和引用。二者都不能替代真机画面、音频和长时间内存占用验收。

按项目约定，不主动启动浏览器自动化；界面和真机效果由维护者验收。只有明确要求时才使用浏览器。

## Android 应用与热更新

`npm run apk` 会把 `dist/` 打进 `android/` 里的 Android 外壳。这个外壳自带 Chromium 156，所以应用不依赖设备上的 WebView。构建需要本机有 JDK 25，并使用 Gradle 9.7.1、AGP 9.4、Android SDK 37 和 build-tools 37.0.0；首次运行会自动下载 Android SDK 与 Gradle，并在用户目录生成签名密钥。`android/keystore.properties`、构建缓存和产物都不会进入仓库。当前 APK 约 337MB，只发 arm64-v8a。

热更新是指应用直接下载新的网页代码和内容，不需要重新安装 APK。`npm run build` 会生成并签名 `dist/update/` 里的更新清单。首次打包前运行 `npm run update:key`，私钥保存在 `~/.config/inoita/update-signing.pem`，必须单独备份；公钥 `android/update-public-key.txt` 随仓库提交。第一次 APK 之后，改网页层代码或内容只需重新构建和部署，不用重发约 337MB 的 APK。引擎或 Chromium 版本升级仍然必须发 APK。细则见[热更新](docs/live-update.md)。

## 特别感谢

感谢 kj 的反馈与验证。

## 许可证

本仓库的源代码（`src/`、`tests/`、`tools/` 等）采用 [MIT License](LICENSE)。

`public/assets/` 与 `asset-source/` 中的图片、音频等素材，以及 `public/content/` 中派生自原版游戏的剧情、任务和文本，版权归原权利方所有，不包含在 MIT 许可范围内，仅用于学习与研究。

## 版权

游戏素材与派生内容的版权归原权利方所有，本项目用于学习与研究。
