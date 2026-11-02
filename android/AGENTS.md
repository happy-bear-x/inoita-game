# android

Android WebView 壳：把 Vite 构建出的 `dist/` 原样打进 APK，提供本地页面、键盘输入与诊断上报。

## 文件

- 根目录：`build.gradle` 声明 Android 插件，`settings.gradle` 配置模块与仓库，`gradle.properties` 放 Gradle 参数，`gradlew`、`gradlew.bat` 是包装器脚本。
- `app/build.gradle`：应用配置、`assets.srcDirs` 指向 `../dist`、从 `config/endpoints.json` 派生调试/发布地址与签名。
- `app/src/main/AndroidManifest.xml` 与 `app/src/main/java/io/github/sunflower9264/inoita/MainActivity.java`：前者是清单、权限与横屏 Activity 配置，后者是 WebView 宿主，处理资源加载、全屏与键盘事件。
- `app/src/main/java/io/github/sunflower9264/inoita/Update*.java`：热更新器。`UpdateManager` 管检查、下载和启动回退；`UpdateManifest` 解析并验签指针/清单；`UpdateHttp` 固定 host、处理 gzip 与 Range；`UpdateInstaller` 做差量、硬链接和版本切换；`UpdateState` 管 SharedPreferences 与版本目录；`UpdatePathHandler` 按清单加载页面资源。
- `update-public-key.txt`：热更清单验签公钥（base64 SPKI DER），由 `npm run update:key` 生成；缺失时 Gradle 写空字符串，热更检查自动跳过。
- `app/src/main/res/values/{colors,strings,styles}.xml` 与 `app/src/main/res/xml/network_security_config.xml`：颜色、字符串、主题和明文流量白名单。

## 规则

- WebView 通过 `assets.srcDirs` 直接读取 `../dist`，打包 APK 前先在仓库根目录运行 `npm run build`。
- API 地址分开发与部署：Gradle 读取 `config/endpoints.json` 的 `androidRelease.serverBaseUrl`，派生云存档 `/__cloud`、诊断 `/__diagnostics/report` 和热更根地址，不在 Gradle、Java 或页面里另写域名。
- 页面脚本运行前注入 `globalThis.__inoitaEndpoints = {version:1, cloudBase, diagnosticsReport}`；document-start 不可用时在 `onPageStarted` 补注入。原生桥只提供 `report()`、`markBootOk()` 和 `buildInfo()`，不传地址。页面只读 `__inoitaEndpoints`。
- 明文只允许本机 `127.0.0.1` 与 `localhost`（`adb reverse` 调试）；release 的服务地址必须是 HTTPS。
- 热更通道默认 `stable`，`-PupdateChannel=staging` 选择 `latest-staging.json`；debug 包跳过检查。
- 启动时先完成 `UpdateManager.initialize()`（读清单、发布不可变路径快照），再创建 WebView；加载地址带 `?v=<buildId>`。清单不可用时降级为只读 APK 资源。
- 版本目录固定为 `filesDir/update/builds/<buildId>` 与 `filesDir/update/staging/<buildId>`，SharedPreferences 用 `inoita-update`。只保留 active 和 previous 两个完整版本。
- 回退只发生在「新版本重建 WebView 后、标题页调用 `markBootOk()` 前」的 45 秒窗口；正常游玩时 `onRenderProcessGone` 只重建 WebView。
- 热更新沿用宿主注入的地址，热更新包不写 API 域名。更新下载由原生 `HttpURLConnection` 发起，不受浏览器同源限制，不需要 CORS；页面请求云存档和诊断仍按同源或宿主注入处理。
- keystore、`keystore.properties` 与 Android SDK 位于仓库外，只在本机配置。
- 清单、资源或 Java 改动后用 `npm run apk` 重新打包，再用 `npm run verify:apk` 校验产物。

## 验证

```bash
npm test -- tests/endpoints.test.ts
npm run apk
npm run verify:apk
```
