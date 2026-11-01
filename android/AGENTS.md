# android

Android WebView 壳：把 Vite 构建出的 `dist/` 原样打进 APK，提供本地页面、键盘输入与诊断上报。

## 文件

- 根目录：`build.gradle` 声明 Android 插件，`settings.gradle` 配置模块与仓库，`gradle.properties` 放 Gradle 参数，`gradlew`、`gradlew.bat` 是包装器脚本。
- `app/build.gradle`：应用配置、`assets.srcDirs` 指向 `../dist`、从 `config/endpoints.json` 派生调试/发布地址与签名。
- `app/src/main/AndroidManifest.xml` 与 `app/src/main/java/io/github/sunflower9264/inoita/MainActivity.java`：前者是清单、权限与横屏 Activity 配置，后者是 WebView 宿主，处理资源加载、全屏与键盘事件。
- `app/src/main/res/values/{colors,strings,styles}.xml` 与 `app/src/main/res/xml/network_security_config.xml`：颜色、字符串、主题和明文流量白名单。

## 规则

- WebView 通过 `assets.srcDirs` 直接读取 `../dist`，打包 APK 前先在仓库根目录运行 `npm run build`。
- API 地址分开发与部署：`androidDebug` 从 `config/endpoints.json` 取 `http://127.0.0.1:4003`，配合 `adb reverse tcp:4003 tcp:4003`；`androidRelease` 取 `https://catgo.online:4002`。云存档拼 `/__cloud`，诊断拼 `/__diagnostics/report`，不在 Gradle、Java 或页面里另写域名。
- 页面脚本运行前注入 `globalThis.__inoitaEndpoints = {version:1, cloudBase, diagnosticsReport}`；document-start 不可用时在 `onPageStarted` 补注入，原生桥兜底返回同一对象。页面只读这个对象，不读其他地址变量。
- 明文只允许 debug 包的 `127.0.0.1`；`app/src/main/res/xml/network_security_config.xml` 的放行地址与调试包一致，release 必须 HTTPS 且不允许明文。
- 热更新沿用宿主注入的地址，热更新包不写 API 域名；热更新页面 origin 与 API 不同域时，服务端 CORS 要放行该 origin。
- keystore、`keystore.properties` 与 Android SDK 位于仓库外，只在本机配置。
- 清单、资源或 Java 改动后用 `npm run apk` 重新打包，再用 `npm run verify:apk` 校验产物。

## 验证

```bash
npm test -- tests/endpoints.test.ts
npm run apk
npm run verify:apk
```
