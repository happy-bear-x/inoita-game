# 服务地址管理

对应规则：`config/AGENTS.md`、`src/application/AGENTS.md`、`src/debug/AGENTS.md` 和 `android/AGENTS.md`。

云存档和诊断上报共用一套服务地址。目标是：网页不写域名，Android/热更新由宿主注入，环境切换只改一处。

## 决定

- **网页始终同源**：页面从哪个域名和端口打开，接口就请求到同一处。本地 4003、生产 4002 都不需要地址配置。
- **生产共用一个 HTTPS 基座**：云存档和诊断都走 `https://catgo.online:4002`。
- **Android/热更新由宿主注入**：页面脚本运行前写入 `__inoitaEndpoints`；热更新包不写 API 域名。
- **路径固定**：云存档 `/__cloud`，诊断 `/__diagnostics/report`；环境只配置服务根地址。

## 环境配置

配置文件在 `config/endpoints.json`：

```json
{
  "version": 1,
  "environments": {
    "web": { "serverBaseUrl": "" },
    "androidDebug": { "serverBaseUrl": "http://127.0.0.1:4003" },
    "androidRelease": { "serverBaseUrl": "https://catgo.online:4002" }
  }
}
```

- `web` 固定为空串，表示同源；网页不读取这个文件，也不需要注入。
- `androidDebug` 配合 USB 调试：`adb reverse tcp:4003 tcp:4003`，调试包只对本机 `127.0.0.1` 放行 HTTP。
- `androidRelease` 的云存档和诊断都由同一个根地址派生。

## 运行时对象

Android/热更新壳在页面脚本之前注入：

```js
globalThis.__inoitaEndpoints = {
  version: 1,
  cloudBase: 'https://catgo.online:4002/__cloud',
  diagnosticsReport: 'https://catgo.online:4002/__diagnostics/report'
};
```

- 必须在 `diagnostics.js` 和游戏模块运行前注入。Android 用 document-start，旧 WebView 在 `onPageStarted` 补一次。
- 页面唯一读取这个对象，不再读取其他地址全局变量。
- 对象为空或字段非法时按字段降级：网页走同源；`appassets` 页面没有显式云地址时显示“云存档暂不可用”，不向本地页面源发请求。
- 云存档地址拒绝非本机 HTTP；调试机的 `localhost/127.0.0.1` HTTP 可以。诊断地址同样规则；生产使用 HTTPS。

`src/application/endpoints.ts` 是网页侧的解析入口：

- `endpointsFromBase(base)`：把环境根地址拼成两个固定接口地址；空根地址返回同源默认。
- `resolveEndpoints(globals)`：校验并读取注入对象，供 `StoryApp`、GM 上报和测试使用。
- `cloudBaseUrl()`：传给 `CloudSaveClient` 的基址；空串让客户端走相对路径。
- `diagnosticsReportUrl()`：诊断上报地址；没有显式地址时回退 `/__diagnostics/report`。

## 本地调试

- **网页**：`npm run dev`，打开 `http://localhost:4003`。Vite 同时挂载 `/__cloud` 和 `/__diagnostics/report`，数据写在 `.cloud-save-dev/`，不需要改地址。
- **手机浏览器**：直接打开 `http://<电脑局域网 IP>:4003`，仍是网页同源模式。
- **Android USB 调试**：`adb reverse tcp:4003 tcp:4003`，调试包的服务根地址用 `http://127.0.0.1:4003`；Vite 只把云存档和诊断暴露给本机，生产接口不参与调试。
- **Android 无线调试**：用 HTTPS 隧道指向 4003，避免给 release 包放开明文。

## 热更新边界

- 热更新会话负责游戏包/页面地址；API 地址由原生宿主注入，不写进热更新包，也不从热更新清单推导。
- 热更新检查地址从 `androidRelease.serverBaseUrl` 派生：正式 `/update/latest.json`，自测 `/update/latest-staging.json`；清单和签名从同一根地址取。
- 热更新下载由原生 `HttpURLConnection` 发起，不受浏览器同源限制，不需要 CORS。云存档和诊断仍按现有规则。
- 热更新包替换后仍由宿主注入同一份地址；配置版本和游戏包版本分开。
- 热更新的产物格式、签名校验和启动回退见 [热更新（Android WebView）](live-update.md)。

## 部署

- 先更新服务端代码并重启 4004，让 `/__cloud` 真正挂上；只替换网页 `dist/` 不会改变 Node 进程里已加载的中间件。
- nginx 继续把 4002 的请求转发到 127.0.0.1:4004；生产客户端统一使用 `https://catgo.online:4002`。
- Android/热更新壳切换注入契约的改动由打包会话完成；网页端不依赖 Android 的注入。
