# 热更新（Android 自带 Chromium）

APK 把 Vite 构建的 `dist/`（当前约 113MB、4200 多个文件）打进 assets，页面由 Cefrium 内置的 Chromium 156 打开。页面不再使用设备自带的 WebView，也不再通过 `WebViewAssetLoader` 读取 APK 资源，而是从 App 内的 `http://127.0.0.1:47653` 本地服务加载。

离线是硬前提：游戏必须断网可玩，所以整包打进 APK，热更只做增量覆盖。不采用「壳直接加载远端 URL」的方案。

状态：已实施。构建、签名和 APK 校验命令见「验证」；真机上的下载、续传、切换和回退由用户验收。

## 决定

- **离线优先**。启动先用本地版本，检查更新在后台进行；检查失败自动重试，下载或启动失败给玩家明确提示，不阻塞进游戏。
- **自带引擎**。`com.cefrium:cefrium-sdk` 内置 Chromium 156；引擎版本由 APK 决定，热更换不了 Chromium。升级引擎必须发新 APK。
- **本地 HTTP 服务**。`LocalAssetServer` 只监听 `127.0.0.1:47653`，按 `UpdateManager` 的版本快照送文件；页面、云存档、诊断和原生端点同源。
- **按文件增量，不整包下载**。`bundles/` 约 2.6MB，`content/` 约 27MB，`assets/` 约 113MB（已裁剪未引用素材）；修 Phaser 代码通常只动入口 bundle。
- **页面 origin 固定**。新 origin 是 `http://127.0.0.1:47653`，端口写死是为了让 `localStorage` 一直落在同一个 origin。
- **更新源就是同一份 `dist/`**。网页版和 APK 热更共用一次构建、一次部署。
- **壳保持薄**。游戏逻辑、内容、素材都在网页层；原生只留 Cefrium 宿主、本地资源服务和更新器。

## 页面来源与存档迁移

- 旧壳的页面 origin 是 `https://appassets.androidplatform.net`；新壳是 `http://127.0.0.1:47653`。浏览器把它们当成两个网站，旧 `localStorage` 不会自动出现。
- 首次启动时 `SaveMigration` 创建一个隐藏的系统 WebView，加载 APK 里的 `migrate.html`，把旧 origin 的 `localStorage` 导出到 `filesDir/migration-localstorage.json`。
- `LocalAssetServer` 在 `index.html` 的 `<head>` 最前面插入 `/__native/bootstrap.js`。这个脚本在模块脚本之前把迁移数据写进新 origin，并定义 `__inoitaEndpoints`、`__inoitaBuildInfo` 和 `window.InotiaNative`。
- 迁移完成后调用 `/__native/migration-done`，之后不再注入；避免用旧备份覆盖玩家后来产生的新存档。

## 服务端产物

每次 `npm run build` 在 `dist/` 里额外生成：

```text
dist/update/
  latest.json              正式指针，no-store
  latest.json.sig          指针签名
  latest-staging.json      自测指针，no-store
  latest-staging.json.sig  自测指针签名
  <buildId>.json           逐文件清单，immutable
  <buildId>.json.sig       清单签名
```

`latest.json` 示例：

```json
{"schema":1,"buildId":"40f12df90ecdba05","builtAt":"2026-11-08T…",
 "manifest":"update/40f12df90ecdba05.json","manifestSha256":"<64位hex>","minShell":2}
```

`minShell` 必须是 `2`：新壳 `SHELL_VERSION=2`；旧 WebView 壳（1）会跳过这份清单，需要重装 APK。

## 客户端流程

1. `MainActivity.onCreate` 先做一次存档迁移，再 `UpdateManager.initialize()`；初始化完成后启动 `LocalAssetServer`，创建 `CefriumBrowser`，加载 `http://127.0.0.1:47653/index.html?v=<buildId>`。
2. 冷启动后台检查；失败后 30 秒重试，最多 3 次；重试用尽后弹「检查更新失败」并允许手动重试；回前台且距上次检查超过 6 小时再查。
3. 按 `UPDATE_CHANNEL` 取 `latest.json` 或 `latest-staging.json` 及 `.sig`，验签；连接超时 4 秒、读取超时 8 秒，禁用缓存。
4. buildId 与当前一致 → 结束，不显示界面。
5. 有更新 → 下载清单并校验：清单不超过 16MB；`sha256(raw)` 等于指针的 `manifestSha256`；buildId 一致；签名通过；`minShell ≤ SHELL_VERSION`；`builtAt` 比已安装的新。
6. 计算差量。清单是唯一权威：文件指纹等于 APK 基线 → 用 APK 里的；等于 `active` 目录 → 硬链接；否则下载。单个硬链接失败只改为下载该文件，不中止整次更新。
7. 弹「发现新版本，需要下载 X MB（N 个文件）」[立即更新] [稍后]。下载中可取消，3 线程、`.part` + SHA-256、`Range` 续传；磁盘按 `缺失总量 × 1.25 + 16MB` 检查。
8. 下载并校验完成 → 记录 `readyBuildId`，弹「更新已准备好，重启后生效」。立即重启才切 active；选稍后或杀进程则在下次冷启动 `initialize()` 时自动应用。
9. 切 active 后关闭并重建 `CefriumBrowser`，本地服务继续从新的 active 快照读文件；加载地址带新 buildId。

## 本地资源服务

`LocalAssetServer` 取代旧的 `WebViewAssetLoader` / `PathHandler`：

- 只绑定 `127.0.0.1:47653`，不监听局域网。
- `UpdateManager.snapshot()` 是权威：路径不在当前清单 → 404，即使 APK 里有同名旧文件也不回退，避免删除的文件「复活」。
- 清单里有、但 active 目录没有 → 回退到 APK 自带资源。
- 清单不可用 → 只读 APK 资源降级启动。
- 路径按段解码后拒绝 `.`、`..`、反斜杠、NUL、隐藏段和空段；MIME 与缓存头沿用旧口径：`bundles/` 一年 `immutable`；`index.html`、`diagnostics.js` 用 `no-store`；其余 `no-cache`。
- `index.html` 响应时在 `<head>` 最前面插入 `/__native/bootstrap.js`；不要改成 `loadUrl` 之后注入，否则模块脚本已经先跑了。
- `/__native/report`、`/__native/boot-ok`、`/__native/build-info`、`/__native/migration-done` 由 `LocalAssetServer` 处理；`/__cloud`、`/__diagnostics/report` 反向代理到 `config/endpoints.json` 派生出的 HTTPS 地址，页面不需要 CORS。
- `window.InotiaNative` 是兼容层：`report()` 走 `/__native/report`，`markBootOk()` 走 `/__native/boot-ok`，`buildInfo()` 读 `__inoitaBuildInfo`。页面代码继续按原接口调用。

## 回滚

只保护「新版本根本起不来」这一种情况：

- 应用下载版本、重建 `CefriumBrowser` 时记 `pendingBoot`；`onRenderProcessTerminated` 也通知 Manager。
- **只有 `pendingBoot` 为真、且还没收到 `markBootOk` 时，渲染进程终止才触发回退。** 正常游玩时引擎回收渲染进程只重建浏览器，不能碰 `active` / `previous`，更不能删除版本目录。
- 网页侧在标题页资源加载完成时调一次 `InotiaNative.markBootOk()`（`src/scenes/menu-scene.ts`，模块级 once）。
- 看门狗 90 秒；等待期间显示原生「正在启动」提示。超时或期间渲染进程崩溃：`active = previous`（没有 previous 就回到 APK 基线），删除坏版本目录，记 `failedBuildId` 和失败时间（24 小时冷却），重建浏览器，弹「新版本启动失败，已回到上一版」并提供重试。启动耗时写入 `lastBootMs`。
- 收到 `markBootOk` 后提交并清理旧目录，不再回退。
- 存档格式升级只发生在玩家点存档槽之后；回退发生时不可能有被升级过的存档。

## 签名与密钥

- ECDSA P-256。Node 用 `crypto.sign('sha256', bytes, { key, dsaEncoding: 'der' })`；Android 用 `Signature.getInstance("SHA256withECDSA")` 加 `X509EncodedKeySpec` 验签。
- 私钥在 `~/.config/inoita/update-signing.pem`，公钥写 `android/update-public-key.txt`；私钥丢失后老客户端只能重装 APK。
- `buildId` 只由文件内容决定；`builtAt`、`minShell` 只放指针，清单保持字节稳定。

## 构建与工具链

- `npm run apk` 默认先跑 `npm run build`，再调用 Gradle。
- 必需工具链：JDK 25、Gradle 9.7.1、AGP 9.4、Android SDK 37（`platforms;android-37.0`）、build-tools 37.0.0。
- `tools/build-apk.mjs` 优先使用 `~/.local/jdk-25`；低于 JDK 25 直接失败。
- APK 只发 `arm64-v8a`；Cefrium 原生库通过 `useLegacyPackaging` 解压到磁盘。
- `verify-apk.mjs` 检查 Cefrium 类、arm64 原生库、16 KB 页对齐；Cefrium 自带的 `icudtl.dat`、`*.pak`、`stored-locales/`、`cefrium/` 不参与和 `dist` 的逐文件对比。

## 验证

```bash
npm run build
npm run apk
npm run verify:apk
npm run verify:update -- --apk apk-out/Inotia-4-2.0.1.apk --url https://catgo.online:4002
```

手装一次 APK 后验证：

1. 改一句剧情 → `npm run deploy` → 重开游戏看到更新弹窗 → 下载后重载并看到新剧情。
2. 旧档仍在；首次从 1.0.3 升级时，旧 `localStorage` 能迁移到新 origin。
3. 关掉服务端再启动，能离线进游戏。
4. 下载中杀进程再启动，能续传。
5. 用一个缺文件的坏清单，确认自动回退且不再反复提示该版本。
6. 正常游玩时触发渲染进程终止，确认只重建浏览器，不回退、不删版本目录。
7. 清单损坏或被截断时，确认用 APK 基线降级启动，而不是白屏。
8. 自测包（`--channel staging`）能走 `latest-staging.json` 完成一次更新。

## 风险与边界

- **引擎升级必须发 APK**。Chromium 是原生库，热更只换网页内容。
- **第一个 Cefrium 包要重装**。`minShell=2` 会拦住旧 WebView 壳的自动更新；旧用户必须安装 2.0.0 APK。
- **旧壳无法自动迁移到新壳**。换引擎不是热更能完成的；需要在发布说明里让玩家安装新 APK。
- **私钥丢失 = 更新链断掉**。必须备份 `~/.config/inoita/update-signing.pem`。
- **不支持降级**。`builtAt` 只增不减；撤回线上版本要部署一个内容正确的新构建。
- **存储**：APK 约 293MB + 当前版本约 113MB；staging 只额外占用缺失文件。
- **端口固定**：`127.0.0.1:47653` 被其他应用占用时，新壳会弹错误并退出；不要改成随机端口，否则 `localStorage` 存档会换 origin。
- **本地 HTTP 服务**只用于本机，不开放局域网；明文白名单只放行 `127.0.0.1` 和 `localhost`。
- **发布窗口竞态**：下载途中正好 `npm run deploy`，旧清单文件会随 `dist/` 消失；客户端中止、保留 staging、下次启动重试，不会装出半个坏版本。
