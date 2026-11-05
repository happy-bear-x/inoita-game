# 热更新（Android WebView）

APK 把 Vite 构建的 `dist/`（当前约 230MB、1.25 万个文件）打进 assets，WebView 通过 `WebViewAssetLoader` 从 `https://appassets.androidplatform.net/` 读取。没有热更新时，改一句剧情或一行代码都要重新打约 230MB 的包发给玩家重装。

离线是硬前提：游戏必须断网可玩，所以继续把整包打进 APK，热更只做增量覆盖。不采用「壳直接加载远端 URL」的方案。

当前没有已安装用户。第一个公开分发的 APK 必须包含完整更新器；在这之前，服务地址、`SHELL_VERSION` 和公钥契约可以一次定对，不需要兼容旧壳。

状态：已实施。构建、签名和 APK 校验命令见「实施顺序与验收」；真机上的下载、续传、切换和回退由用户验收。

## 决定

- **离线优先**。启动先用本地版本，检查更新在后台进行；检查失败会自动重试，下载或启动失败会给玩家明确提示，不阻塞进游戏。
- **第一个公开包就带更新器**。现在没有历史安装量，这是唯一一次可以无成本改壳契约的窗口。
- **自己实现，不引入框架**。壳只做 WebView 宿主；核心机制是版本清单、逐文件哈希、原子切换、启动失败回退。
- **按文件增量，不整包下载**。`bundles/` 约 2.6MB，`content/` 约 28MB，`assets/` 196MB；修 Phaser 代码通常只动入口 bundle。
- **页面来源不变**。更新目录挂在 origin 根，页面仍然是 `https://appassets.androidplatform.net/`，localStorage 存档、设置和云存档登录态不受影响。
- **更新源就是同一份 `dist/`**。网页版和 APK 热更共用一次构建、一次部署。
- **壳保持薄**。游戏逻辑、内容、素材都在网页层；原生只留 WebView 宿主和更新器。新增原生能力必须走 APK，所以要克制。

## 前置：服务地址统一

热更地址沿用仓库的服务地址约定，但 Android 侧目前还没接上，必须先补齐：

- `android/app/build.gradle` 仍在硬编码诊断和云存档地址；`MainActivity` 注入的是 `__inoitaDiagnosticsEndpoint` / `__inoitaCloudEndpoint`；页面端 `src/application/endpoints.ts` 和 `public/diagnostics.js` 只读 `__inoitaEndpoints`。按当前代码重新打包，云存档会拿到空基址。
- Phase 0 先做统一：Gradle 从 `config/endpoints.json` 读取服务根地址，`MainActivity` 在页面脚本前注入 `globalThis.__inoitaEndpoints = {version:1, cloudBase, diagnosticsReport}`，页面不再读别的地址变量。
- 热更检查地址 = `androidRelease.serverBaseUrl + "/update/latest.json"`，默认 `https://catgo.online:4002/update/latest.json`。
- 只新增 `BuildConfig.UPDATE_BASE_URL` 一个地址，不引入第二套页面全局变量。
- 热更下载走原生 `HttpURLConnection`，不受浏览器同源限制，不需要 CORS。云存档和诊断的 CORS 规则不变。
- debug 包默认不做热更：`androidDebug` 指向本地 4003，Vite 没有 `/update` 目录；壳用 `BuildConfig.DEBUG` 跳过。真机自测用发布包加 `--channel staging`。

## 自测通道

- 构建同时生成两个指针：`dist/update/latest.json`（正式）和 `dist/update/latest-staging.json`（自测）。两者都签名，指向同一份 `<buildId>.json`。
- 客户端按 `BuildConfig.UPDATE_CHANNEL` 选择指针，默认 `stable`；`npm run apk -- --channel staging` 打自测包。
- 这个通道用于在真机上验证检查、下载、切换、回退链路，不隔离内容。要让自测内容不影响将来玩家，需要另起一套静态服务并把自测包的 `UPDATE_BASE_URL` 指过去；当前没有玩家，先不做。玩家出现后再补 promote 或独立 staging 服务。

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

`latest.json`（约 200 字节）：

```json
{"schema":1,"buildId":"9f2c…","builtAt":"2026-11-01T08:44:31.053Z",
 "manifest":"update/9f2c….json","manifestSha256":"<64位hex>","minShell":1}
```

`<buildId>.json`（被签名的就是这份文件的原始字节）：

```json
{"schema":1,"buildId":"9f2c…","assetVersion":"…","contentVersion":"…",
 "files":[{"p":"index.html","h":"a1b2c3d4e5f60718","s":1285}, …]}
```

- `buildId` = 对所有 `(路径, 文件指纹, 大小)` 排序后做 SHA-256，取前 16 位；只由内容决定，重新构建不会变。
- 单个文件的指纹 = SHA-256(`相对路径 + NUL + 内容 + NUL`)，取前 16 位，与 `hashTree` 的拼法一致。
- **清单只放由内容决定的字段**。`builtAt`、`minShell`、`manifestSha256` 放在 `latest.json` 里。这样同一个 `buildId` 永远对应同一份清单字节，`<buildId>.json` 标 `immutable` 才不会出现「同一个网址、两种内容」。
- 清单排除 `.build-meta.json` 和 `update/**`，避免自己引用自己。
- 两个指针和清单的 `.sig` 都是 base64(ECDSA P-256 DER)，签同名文件的原始字节。指针必须签名，否则旧指针可以被重放；重放还会被客户端拿 `builtAt` 和本地已安装版本比较挡住。
- APK 里打进同一份 `assets/update/`，它同时充当基线：壳读 APK 内的 `latest.json` 拿 buildId/builtAt，读 `<buildId>.json` 拿文件集合，不需要单独的 baseline 文件。

## 手机端存储与状态

```text
filesDir/update/
  builds/<buildId>/…               完整可用的更新版本
  builds/<buildId>/.manifest.json  该版本清单副本
  staging/<buildId>/…              下载中的文件（.part 续传）
SharedPreferences "inoita-update"
  active, previous, failedBuildId, activeBuiltAt, activeChannel
```

- `active` 为空表示当前用 APK 自带资源。
- 只保留 `active`、`previous` 两个版本目录，其余启动时清理。
- **APK 重装后要对账**：APK 自带基线比本地 `active` 新时，丢弃本地 `active`，以 APK 基线为准；否则保留本地 `active`。不能无条件信任任何一方。第一版没有已安装用户，首次启动 `active` 就是空的；这条规则从第一次壳升级开始生效。
- **启动时先解析清单，再加载页面**。`UpdateManager.initialize()` 在后台线程读取当前版本清单（`active` 的本地副本，或 APK 内的基线），构建不可变路径快照，完成后才 `loadUrl`。清单读不出来时用「只读 APK」的快照降级并记日志，不能把所有请求都判 404。

## 客户端流程

1. `MainActivity.onCreate` 先完成 `UpdateManager.initialize()`，再创建 WebView，加载当前 `active`（没有就用 APK 资源）；`loadUrl` 的 `?v=` 用当前 buildId，不用 `VERSION_CODE`。
2. 冷启动在后台检查；失败后 30 秒重试，最多 3 次；回到前台时距离上次检查超过 6 小时再查一次：
   - 按 `UPDATE_CHANNEL` 取 `latest.json` 或 `latest-staging.json` 及其 `.sig`，验签。连接超时 4 秒、读取超时 8 秒，禁用缓存。
   - buildId 与当前一致 → 结束，不显示任何界面。
3. 有更新 → 下载清单和 `.sig`，依次校验：清单不超过 16MB；`sha256(raw)` 等于指针里的 `manifestSha256`；buildId 一致；签名通过；指针里的 `minShell ≤ BuildConfig.SHELL_VERSION`；指针里的 `builtAt` 比已安装的新。检查阶段的失败会记录并自动重试；下载失败会给玩家「重试/稍后」。
4. 计算差量。清单是唯一权威：文件指纹等于 APK 基线 → 用 APK 里的；等于 `active` 目录 → 硬链接过来；否则下载。
5. 弹原生对话框：「发现新版本，需要下载 X MB（N 个文件）」[立即更新] [稍后]。选稍后则本进程内不再提示，下次冷启动会重新检查；如果这个 buildId 曾经启动失败，24 小时内不提示，之后允许重试。
6. 选立即更新 → 模态进度框（可取消）。3 个线程下载，逐个写 `.part`、算 SHA-256、校验通过再改名；已有 `.part` 用 `Range` 续传。磁盘空间按 `缺失总量 × 1.25 + 16MB` 检查。
7. 全部文件下载并校验完成 → 记录 `readyBuildId`，保留 staging，弹「更新已准备好，重启后生效」[立即重启] [稍后]；下载和应用拆开。立即重启 → 写完成标记 → `staging/<buildId>` 原子改名为 `builds/<buildId>` → 更新 `previous` / `active` → 销毁并重建 WebView。选稍后或直接杀进程 → 下次冷启动 `initialize()` 时自动应用。
8. 取消 → 保留 staging 供下次续传，继续用旧版本。下载失败 → 保留 staging，弹出「更新失败」并提供重试；不再静默关闭进度框。

**传输编码必须写死：**

- 指针和清单允许 gzip：请求带 `Accept-Encoding: gzip`，拿到后先解压，再按原始字节验 `manifestSha256` 和签名。清单约 1.18MB，gzip 后约 170KB，值得省。
- **单个文件一律用 `Accept-Encoding: identity`**。服务端会对大于 1KB 的可压缩文件自动 gzip；如果下载器带了 gzip，算出来的 SHA-256 和清单里的原始文件指纹对不上，`Range` 续传的字节偏移也会错位。
- 清单里的 `s` 是原始文件大小；校验时以解压后的字节为准。

## 加载优先级

把 `MainActivity` 里 `/` 的 `AssetsPathHandler` 换成自定义 `PathHandler`，内部持有原来的 handler 做兜底。

**清单是权威**：运行时快照持有当前版本清单里的路径集合，请求的路径不在清单里就直接 404，即使 APK 里有同名文件也不回退。否则新版本删掉的文件会被 APK 里的旧副本「复活」。

```text
请求 /content/campaign.json?v=…
  → 路径不在当前清单 → 404
  → builds/<active>/content/campaign.json 存在 → 从文件返回
  → 否则交给 AssetsPathHandler（APK 自带资源）
```

实现要点：

- 路径按段解码后拒绝 `.`、`..`、反斜杠、NUL、以点开头的段；`canonicalPath` 必须落在 `builds/<active>/` 之下。
- 按扩展名推断 MIME，JSON/JS/HTML 带 `charset=utf-8`。
- 响应头要跟 `AssetsPathHandler` 保持一致，尤其是 `Access-Control-Allow-Origin: *`，否则模块脚本或 `fetch` 的行为可能和现在不同。
- 响应头缓存规则：`bundles/` 一年 `immutable`；`index.html`、`diagnostics.js` 用 `no-store`，防止 WebView 缓存旧入口；其余 `no-cache`。
- 不实现 Range 读取，和现在的 `AssetsPathHandler` 行为一致（音频由 Phaser 整文件解码，目前可用）。下载器的 Range 是原生 HTTP 请求，走服务端 `serve-built.ts`，与这里的读取无关。
- 保留 `/__diagnostics/` 处理器和 `shouldOverrideUrlLoading` 的 host 限制；更新下载走原生，不经过 WebView。
- PathHandler 在 WebView 的 IO 线程读不可变快照，不碰可变状态。快照在 `initialize()` 完成后才发布；在此之前不创建 WebView。

## 回滚

只保护「新版本根本起不来」这一种情况：

- 应用下载版本、重建 WebView 时记 `pendingBoot`；`onRenderProcessGone` 也通知 Manager。
- **只有 `pendingBoot` 为真、且还没收到 `markBootOk` 时，`onRenderProcessGone` 才触发回退。** 正常游玩时系统回收渲染进程只重建 WebView，不能碰 `active` / `previous`，更不能删除版本目录。
- 网页侧在标题页资源加载完成时调一次 `InotiaNative.markBootOk()`（`src/scenes/menu-scene.ts:111`，模块级 once，因为回菜单会重新 create）。
- 看门狗 90 秒（慢设备上 45 秒偏紧）；等待期间显示原生「正在启动」提示。超时或期间渲染进程崩溃：`active = previous`（没有 previous 就回到 APK 基线），删除坏版本目录，记下 `failedBuildId` 和失败时间（24 小时冷却），重建 WebView，弹出「新版本启动失败，已回到上一版」并提供重试。启动耗时写入 `lastBootMs`，后续可按真机数据再调。
- 收到 `markBootOk` 后提交并清理旧目录，不再回退。

这条边界是安全的：存档格式升级只发生在玩家点存档槽之后（`src/application/saved-game.ts:196-225`），那时标题页早已加载成功、已经提交。回退发生时不可能有被升级过的存档。

## 签名与密钥

- ECDSA P-256。Node 用 `crypto.sign('sha256', bytes, { key, dsaEncoding: 'der' })`；Android 用 `Signature.getInstance("SHA256withECDSA")` 加 `X509EncodedKeySpec` 验签。
- 私钥放在仓库外：`~/.config/inoita/update-signing.pem`，权限 600。
- 公钥 SPKI DER 转 base64，写进仓库的 `android/update-public-key.txt`，Gradle 读成 `BuildConfig.UPDATE_PUBLIC_KEY`。
- 首次 `npm run apk` 或显式 `npm run update:key` 时生成。**备份的最后期限是首次公开分发**：在那之前私钥丢了只需重新生成，没有客户端会不认；在那之后，老客户端永远不信任新清单，只能让玩家重装 APK。
- 清单字节只由内容决定，所以同一个 `buildId` 永远对应同一份清单；签名每次可能不同，但同一份清单的任何有效签名都能验过，`.sig` 同样可以标 `immutable`。`latest.json` 承载 `builtAt`、`minShell` 这些会变的字段，用 `no-store`。
- `npm run build` 有私钥就签，没有就跳过并警告；`npm run deploy` 和 `npm run apk` 要求两个指针和清单的 `.sig` 都存在且能验证，否则直接失败。

## 改动清单

### Phase 0 · 服务地址统一（前置）

- 修改 `android/app/build.gradle`：从 `config/endpoints.json` 读取服务根地址，派生现有的诊断和云存档地址；热更用的 `UPDATE_BASE_URL` 等字段留到 Phase 1 再加载，避免和密钥生成互相依赖。
- 修改 `MainActivity.java`：注入 `__inoitaEndpoints`，删掉旧的 `__inoitaDiagnosticsEndpoint` / `__inoitaCloudEndpoint` 注入。
- 验证：`npm run apk`、`npm run verify:apk`，真机上确认云存档和诊断仍走 `https://catgo.online:4002`。

### 构建侧（tools/）

- 新增 `tools/update-manifest.ts`：逐文件遍历与排序、路径白名单、清单与 buildId 生成、分离签名与验签、客户端差量计算（供验收脚本和测试复用）。
- 新增 `tools/update-key.ts`：生成或读取密钥，写出 `android/update-public-key.txt`；`npm run update:key` 入口打印备份提醒。
- 修改 `tools/build-version.ts`：导出 `filesUnder`（或 `walkFiles`）和 `sha256File`，供清单生成复用。
- 修改 `tools/build.mjs`：在 `validateContent(output)` 之后、原子替换 `dist/` 之前生成清单和两个指针并签名。
- 修改 `tools/serve-built.ts`：`cachePolicyFor` 增加 `/update/` 规则——`latest.json`、`latest-staging.json` 及其签名用 `no-store`，`<buildId>.json`、`.sig` 用一年 `immutable`。
- 修改 `tools/deploy.ts`：核对线上 `latest.json` 的 buildId 与 `manifestSha256` 等于本地，并拉清单验签；存在 `latest-staging.json` 时一并核对。
- 修改 `tools/verify-apk.mjs`：确认 APK 内有 `assets/update/latest.json`、`latest-staging.json`、对应 `<buildId>.json` 和 `.sig`；解包后与 `dist` 同名文件逐字节一致；按清单校验 APK 资源哈希。
- 修改 `tools/build-apk.mjs`：Gradle 之前调用 `ensureUpdateKey()`；支持 `--channel staging`；分发新 APK 时提醒递增 `versionCode`。
- 新增 `tools/verify-update.ts`：读取指定 APK 的基线清单，拉线上指针和清单，验签并打印差量文件数与字节数；覆盖路径穿越、签名被篡改、缺文件三种失败。挂 `npm run verify:update`。
- 新增 `tests/update-manifest.test.ts`：同一文件树重建得到同一个 buildId 和完全相同的清单字节；补充 `tests/serve-built.test.ts` 的 `/update/` 缓存头、gzip 与 identity 行为。

### Android 壳（android/）

- `app/build.gradle`：新增 `UPDATE_BASE_URL`（从 `config/endpoints.json` 的 `androidRelease.serverBaseUrl` 拼出）、`UPDATE_CHANNEL`（默认 `stable`）、`SHELL_VERSION`（整数，首次为 1，改 JS 桥时手动加一）、`UPDATE_PUBLIC_KEY`（读 `android/update-public-key.txt`）。
- 新增 `UpdateState.java`：SharedPreferences 读写 active/previous/failedBuildId/activeBuiltAt/activeChannel，负责选版与对账。
- 新增 `UpdateManifest.java`：解析与校验清单（schema、路径、大小、重复项）。
- 新增 `UpdateHttp.java`：固定 host、禁止重定向、超时、大小上限、Range 续传；指针/清单允许 gzip，单文件请求强制 identity。
- 新增 `UpdateInstaller.java`：差量、硬链接、staging、逐文件哈希、原子改名、磁盘检查、清理。
- 新增 `UpdateManager.java`：进程级单例，初始化时构建不可变快照，单线程检查、3 个线程下载。
- 新增 `UpdatePathHandler.java`：清单权威、磁盘优先、AssetManager 兜底、MIME、404、与 `AssetsPathHandler` 一致的响应头。
- 修改 `MainActivity.java`：接入 Manager；初始化完成后加载；加载地址用 buildId；启动检查与弹窗/进度；重建 WebView；启动看门狗；`onRenderProcessGone` 的回退边界；桥新增 `markBootOk()`、`buildInfo()`。
- `res/values/strings.xml`：新增对话框与提示文案。
- 不新增 `ACCESS_NETWORK_STATE`：下载不按网络类型限制，玩家在弹窗里看到大小后自行决定。

### 网页层（尽量少改）

- 新增 `src/application/live-update.ts`：`notifyBootReady()`（模块级 once，检测 `globalThis.InotiaNative?.markBootOk`）和 `nativeBuildInfo()`。
- 修改 `src/scenes/menu-scene.ts:111`：`ui.menuLoaded(); render(); syncLifecycle?.();` 之后调用 `notifyBootReady()`。
- 可选：`src/ui/phaser/gm-panel.ts:160-179` 状态页显示当前 buildId、上一版，并提供「检查更新」按钮。这项放最后。

### 文档与规则

- 同步 `docs/deployment.md`（`/update/` 缓存与部署核对）、`docs/endpoints.md`（热更边界补实现方式）、根 `AGENTS.md`、`tools/AGENTS.md`、`android/AGENTS.md`、`src/application/AGENTS.md`、`README.md`。

## 实施顺序与验收

### Phase 0 · 服务地址统一

```bash
npm run typecheck
npm test -- tests/endpoints.test.ts
npm run apk
npm run verify:apk
```

真机上确认云存档和诊断请求走 `https://catgo.online:4002`，不再打到 `appassets` 本地源。

### Phase 1 · 构建与服务端

产物与校验先跑通，客户端还没接。

```bash
npm run typecheck
npm test -- tests/update-manifest.test.ts tests/serve-built.test.ts
npm run validate:content
npm run update:key        # 首次；按输出备份私钥
npm run build
npm run deploy            # 核对线上 latest/manifest/签名
curl -sI https://catgo.online:4002/update/latest.json   # 应为 no-store
```

验收点：

- 同一份内容连续构建两次，`buildId` 和 `<buildId>.json` 的字节完全一致。
- `latest.json` 的 `manifestSha256` 与清单原始字节一致；`.sig` 能验通过。
- 清单请求带 gzip 时能解压后再验哈希；单文件请求用 identity 时哈希与清单一致。

### Phase 2 · Android 客户端

壳接入检查、下载、加载优先级、回滚、标题页启动信号。

```bash
npm run apk
npm run verify:apk
npm run verify:update -- --apk apk-out/Inotia-4-1.0.0.apk --url https://catgo.online:4002
```

手装一次 APK 后验证：

1. 改一句剧情 → `npm run deploy` → 重开游戏看到更新弹窗 → 下载后自动重载并看到新剧情。
2. 存档槽仍在。
3. 关掉服务端再启动，能离线进游戏。
4. 下载中杀进程再启动，能续传。
5. 用一个缺文件的坏清单，确认自动回退且不再反复提示该版本。
6. 正常游玩时手动触发 `onRenderProcessGone`（或让系统回收），确认只重建 WebView，不回退、不删版本目录。
7. 清单损坏或被截断时，确认用 APK 基线降级启动，而不是白屏。
8. 自测包（`--channel staging`）能走 `latest-staging.json` 完成一次更新。

### Phase 3 · 打磨与文档

进度框、失败提示、GM 面板信息、更新状态上报、独立 staging 服务（有玩家后再做）、文档与各目录 `AGENTS.md` 同步。

## 风险与边界

- **第一个公开包必须带更新器**。现在没有已安装用户，这是唯一一次可以无成本改壳契约的窗口；从第一个公开包开始，公钥和壳契约冻结，改一次就要发新 APK。
- **私钥丢失 = 更新链断掉**。首次公开分发前丢了只需重新生成；之后只能发新 APK 让玩家重装。必须备份 `~/.config/inoita/update-signing.pem`。
- **频繁更新意味着更新链会被反复使用**。坏版本不能靠把网站换回旧构建来撤回，只能发布修好的新构建；`builtAt` 只增不减。
- **发布窗口竞态**：下载途中正好 `npm run deploy`，旧清单文件随 `dist/` 一起消失，客户端会 404。客户端中止、保留 staging、下次启动重试，不会装出半个坏版本。
- **回滚范围有限**：只处理启动失败。已经进过标题页的版本不会自动回退，避免碰到已升级的存档。失败版本记入 `failedBuildId`，不会反复弹窗。
- **大改动仍要重装**：Java、权限、Gradle、新增原生桥方法都只能走 APK。`SHELL_VERSION` / `minShell` 就是为这种情况准备的闸门；新 APK 的 `versionCode` 必须递增。
- **不支持降级**：`builtAt` 只增不减。要撤回线上版本时，部署一个内容正确的新构建，而不是把站点换回旧构建。
- **存储**：应用总占用约为 APK 230MB + 当前版本 230MB；staging 只额外占用缺失文件。安装前按 `缺失总量 × 1.25 + 16MB` 检查剩余空间，空间不足时明确提示，而不是装到一半失败。
- **清单体积**：约 1.18MB，gzip 后约 170KB，只在确实有更新时下载；常规剧情改动约 1–3MB，修 Phaser 代码约 2.6MB。
- **首次检查开销**：每次冷启动一个几百字节的请求；失败后 30 秒重试，最多 3 次，不阻塞进游戏。前台恢复时 6 小时间隔检查。
- **更新状态持久化**：最近检查时间/结果、待处理 buildId、已就绪 buildId、下载失败原因、启动失败 buildId 和时间、启动耗时都写进 SharedPreferences；Activity 重建或进程被杀后能恢复提示和重试，不再只存在内存弹窗里。
- **下载与应用分开**：下载完成只标记 ready，不立刻切 active；玩家可以立即重启，也可以下次冷启动自动应用。冷启动应用仍走 `pendingBoot` / `markBootOk` 回退窗口；已就绪版本的 `builtAt` 不高于当前版本或 `buildId` 相同时直接丢弃，避免装上新 APK 后又被旧网页包降级。
- **更新生命周期上报**：检查结果、发现更新、开始下载、下载完成、切换版本、启动成功和回退都通过原生诊断桥写入 `kind=update-*` 的事件，细节带 buildId、文件数、失败原因和 `buildInfo`。
