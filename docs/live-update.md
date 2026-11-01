# 热更新（Android WebView）

APK 把 Vite 构建的 `dist/`（243MB、12,438 个文件）打进 assets，WebView 通过 `WebViewAssetLoader` 从 `https://appassets.androidplatform.net/` 读取。没有热更新时，改一句剧情或一行代码都要重新打 240MB 的包发给玩家重装。这份文档是「网页层可远程更新」的实施方案。

状态：方案已定，尚未实施。实施后把每节的「计划」改成实际行为，并补上命令与接口。

## 决定

- **自己实现，不引入框架**。CodePush 随 App Center 于 2025 年 3 月下线，Capgo / Appflow 绑定 Capacitor，而本项目的壳只有 300 多行 Java。采用 CodePush 一类方案的核心机制：版本清单、逐文件哈希、原子切换、启动失败回退。
- **按文件增量，不整包下载**。真正常变的是 `content/` 下的 JSON 和入口 bundle；11,576 张 PNG 里大部分是角色帧，几乎不随剧情改。整包 zip 仍有 200MB 左右，和重装没有区别。
- **页面来源不变**。更新目录挂在 origin 根，页面仍然是 `https://appassets.androidplatform.net/`，localStorage 存档、设置和云存档登录态不受影响。
- **不联网也能玩**。启动先用本地版本，检查更新在后台进行；网络失败只记日志。
- **更新源就是同一份 `dist/`**。网页版和 APK 热更共用一次构建、一次部署。

## 更新源与服务地址

仓库已经把服务地址集中在 `config/endpoints.json`，Android 由宿主在页面脚本前注入 `globalThis.__inoitaEndpoints`，页面不写域名；规则见 [服务地址管理](endpoints.md)。

热更新沿用同一套约定：

- 更新检查地址 = `androidRelease.serverBaseUrl + "/update/latest.json"`，默认 `https://catgo.online:4002/update/latest.json`。
- 热更包不写 API 域名，也不从清单推导 API 地址；云存档、诊断地址仍由宿主注入。
- 只新增 `BuildConfig.UPDATE_BASE_URL` 一个地址，不引入第二套页面全局变量。
- debug 包不做热更：`androidDebug` 指向本地 4003，Vite 没有 `/update` 目录；壳用 `BuildConfig.DEBUG` 跳过。
- 页面 origin 与 API 不同域时，服务端 CORS 要放行该 origin（当前页面 origin 是 `appassets.androidplatform.net`，与已有云存档/诊断请求一致）。

## 服务端产物

每次 `npm run build` 在 `dist/` 里额外生成：

```text
dist/update/
  latest.json        小指针，no-store
  latest.json.sig    指针签名
  <buildId>.json     逐文件清单，immutable
  <buildId>.json.sig 清单签名
```

`latest.json`（约 200 字节）：

```json
{"schema":1,"buildId":"9f2c…","builtAt":"2026-11-01T08:44:31.053Z",
 "manifest":"update/9f2c….json","manifestSha256":"<64位hex>","minShell":1}
```

`<buildId>.json`（被签名的就是这份文件的原始字节）：

```json
{"schema":1,"buildId":"9f2c…","builtAt":"…","minShell":1,
 "assetVersion":"…","contentVersion":"…",
 "files":[{"p":"index.html","h":"a1b2c3d4e5f60718","s":1285}, …]}
```

- `buildId` = 对所有 `(路径, 文件哈希, 大小)` 排序后做 SHA-256，取前 16 位；只由内容决定，重新构建不会变。
- 文件哈希沿用 `tools/build-version.ts` 里 `hashTree` 的「路径\0内容\0」算法。
- 清单排除 `.build-meta.json` 和 `update/**`，避免自己引用自己。
- 两个 `.sig` 都是 base64(ECDSA P-256 DER)，签同名文件的原始字节。`latest.json` 必须签名，否则旧指针可以被重放，把玩家降级。
- APK 里打进同一份 `assets/update/`，它同时充当基线：壳读 APK 内的 `<buildId>.json` 就知道哪些文件已经在包里，不需要单独的 baseline 文件。

## 手机端存储与状态

```text
filesDir/update/
  builds/<buildId>/…               完整可用的更新版本
  builds/<buildId>/.manifest.json  该版本清单副本
  staging/<buildId>/…              下载中的文件（.part 续传）
SharedPreferences "inoita-update"
  active, previous, failedBuildId, activeBuiltAt
```

- `active` 为空表示当前用 APK 自带资源。
- 只保留 `active`、`previous` 两个版本目录，其余启动时清理。
- **APK 重装后要对账**：APK 自带基线比本地 `active` 新时，丢弃本地 `active`，以 APK 基线为准；否则保留本地 `active`。不能无条件信任任何一方。

## 客户端流程

1. `MainActivity.onCreate` 先按现有逻辑创建 WebView，加载当前 `active`（没有就用 APK 资源）；`loadUrl` 的 `?v=` 从 `VERSION_CODE` 改成当前 buildId。
2. 同一时刻在后台检查，每个进程只查一次：
   - `GET /update/latest.json` 和 `.sig`，验签；连接超时 4 秒、读取超时 8 秒，禁用缓存。
   - buildId 与当前一致 → 结束，不显示任何界面。
3. 有更新 → 下载清单和 `.sig`，依次校验：清单不超过 16MB；`sha256(raw)` 等于 `latest.manifestSha256`；buildId 一致；签名通过；`minShell ≤ BuildConfig.SHELL_VERSION`；清单里的 `builtAt` 比已安装的新。任何一项失败都静默放弃。
4. 计算差量。清单是唯一权威：文件哈希等于 APK 基线 → 用 APK 里的；等于 `active` 目录 → 硬链接过来；否则下载。
5. 弹原生对话框：「发现新版本，需要下载 X MB（N 个文件）」[立即更新] [稍后]。选稍后则本次不再提示；如果这个 buildId 曾经启动失败过，也不再提示。
6. 选立即更新 → 模态进度框（可取消）。3 个线程下载，逐个写 `.part`、算 SHA-256、校验通过再改名；已有 `.part` 用 `Range` 续传。磁盘空间需要 `缺失总量 × 1.25 + 16MB`。
7. 全部完成 → 写完成标记 → `staging/<buildId>` 原子改名为 `builds/<buildId>` → 更新 `previous` / `active` → 销毁并重建 WebView，加载新版本。
8. 取消或失败 → 保留 staging 供下次续传，继续用旧版本，只记日志，不弹错误框。

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
- 响应头：`bundles/` 一年 `immutable`；`index.html`、`diagnostics.js` 用 `no-store`，防止 WebView 缓存旧入口；其余 `no-cache`。
- 不实现 Range 读取，和现在的 `AssetsPathHandler` 行为一致（音频由 Phaser 整文件解码，目前可用）。
- 保留 `/__diagnostics/` 处理器和 `shouldOverrideUrlLoading` 的 host 限制；更新下载走原生，不经过 WebView。
- PathHandler 在 WebView 的 IO 线程读不可变快照，不碰可变状态。

## 回滚

只保护「新版本根本起不来」这一种情况：

- 应用下载版本、重建 WebView 时记 `pendingBoot`；`onRenderProcessGone` 也通知 Manager。
- 网页侧在标题页资源加载完成时调一次 `InotiaNative.markBootOk()`（`src/scenes/menu-scene.ts:111`，模块级 once，因为回菜单会重新 create）。
- 120 秒内没收到，或期间渲染进程崩溃：`active = previous`（没有 previous 就回到 APK 基线），删除坏版本目录，记下 `failedBuildId`，重建 WebView，Toast「更新版本启动失败，已回退」。
- 收到 `markBootOk` 后提交并清理旧目录，不再回退。

这条边界是安全的：存档格式升级只发生在玩家点存档槽之后（`src/application/saved-game.ts:196-225`），那时标题页早已加载成功、已经提交。回退发生时不可能有被升级过的存档。

## 签名与密钥

- ECDSA P-256。Node 用 `crypto.sign('sha256', bytes, { key, dsaEncoding: 'der' })`；Android 用 `Signature.getInstance("SHA256withECDSA")` 加 `X509EncodedKeySpec` 验签。
- 私钥放在仓库外：`~/.config/inoita/update-signing.pem`，权限 600。
- 公钥 SPKI DER 转 base64，写进仓库的 `android/update-public-key.txt`，Gradle 读成 `BuildConfig.UPDATE_PUBLIC_KEY`。
- 首次 `npm run apk` 或显式 `npm run update:key` 时生成；生成后必须备份。私钥丢失 = 老客户端永远不信任新清单，只能让玩家重装 APK。
- `npm run build` 有私钥就签，没有就跳过并警告；`npm run deploy` 和 `npm run apk` 要求两个 `.sig` 都存在且能验证，否则直接失败。

## 改动清单

### 构建侧（tools/）

- 新增 `tools/update-manifest.ts`：逐文件遍历与排序、路径白名单、清单与 buildId 生成、分离签名与验签、客户端差量计算（供验收脚本和测试复用）。
- 新增 `tools/update-key.ts`：生成或读取密钥，写出 `android/update-public-key.txt`；`npm run update:key` 入口打印备份提醒。
- 修改 `tools/build-version.ts`：导出 `filesUnder`（或 `walkFiles`）和 `sha256File`，供清单生成复用。
- 修改 `tools/build.mjs`：在 `validateContent(output)` 之后、原子替换 `dist/` 之前生成清单并签名。
- 修改 `tools/serve-built.ts`：`cachePolicyFor` 增加 `/update/` 规则——`latest.json` 与其签名用 `no-store`，其余 `*.json`、`*.sig` 用一年 `immutable`。
- 修改 `tools/deploy.ts`：核对线上 `latest.json` 的 buildId 与 `manifestSha256` 等于本地，并拉清单验签。
- 修改 `tools/verify-apk.mjs`：确认 APK 内有 `assets/update/latest.json`、对应 `<buildId>.json` 和 `.sig`；解包后与 `dist` 同名文件逐字节一致；按清单校验 APK 资源哈希。
- 修改 `tools/build-apk.mjs`：Gradle 之前调用 `ensureUpdateKey()`，确认 `dist/update/` 已签名；分发新 APK 时提醒递增 `versionCode`。
- 新增 `tools/verify-update.ts`：读取指定 APK 的基线清单，拉线上 latest/manifest，验签并打印差量文件数与字节数；覆盖路径穿越、签名被篡改、缺文件三种失败。挂 `npm run verify:update`。

### Android 壳（android/）

- `app/build.gradle`：新增 `BuildConfig.UPDATE_BASE_URL`（从 `config/endpoints.json` 的 `androidRelease.serverBaseUrl` 拼出）、`SHELL_VERSION`（整数，改 JS 桥时手动加一）、`UPDATE_PUBLIC_KEY`（读 `android/update-public-key.txt`）。
- 新增 `UpdateState.java`：SharedPreferences 读写 active/previous/failedBuildId/activeBuiltAt，负责选版与对账。
- 新增 `UpdateManifest.java`：解析与校验清单（schema、路径、大小、重复项）。
- 新增 `UpdateHttp.java`：固定 host、禁止重定向、超时、大小上限、Range 续传。
- 新增 `UpdateInstaller.java`：差量、硬链接、staging、逐文件哈希、原子改名、磁盘检查、清理。
- 新增 `UpdateManager.java`：进程级单例，单线程检查、3~4 线程下载；对外暴露不可变运行时快照。
- 新增 `UpdatePathHandler.java`：清单权威、磁盘优先、AssetManager 兜底、MIME、404。
- 修改 `MainActivity.java`：接入 Manager；加载地址用 buildId；启动检查与弹窗/进度；重建 WebView；启动看门狗；`onRenderProcessGone` 先回退；桥新增 `markBootOk()`、`buildInfo()`。
- `res/values/strings.xml`：新增对话框与提示文案。
- 不新增 `ACCESS_NETWORK_STATE`：下载不按网络类型限制，玩家在弹窗里看到大小后自行决定。

### 网页层（尽量少改）

- 新增 `src/application/live-update.ts`：`notifyBootReady()`（模块级 once，检测 `globalThis.InotiaNative?.markBootOk`）和 `nativeBuildInfo()`。
- 修改 `src/scenes/menu-scene.ts:111`：`ui.menuLoaded(); render(); syncLifecycle?.();` 之后调用 `notifyBootReady()`。
- 可选：`src/ui/phaser/gm-panel.ts:160-179` 状态页显示当前 buildId、上一版，并提供「检查更新」按钮。

### 文档与规则

- 同步 `docs/deployment.md`（`/update/` 缓存与部署核对）、`docs/endpoints.md`（热更边界补实现方式）、根 `AGENTS.md`、`tools/AGENTS.md`、`android/AGENTS.md`、`src/application/AGENTS.md`、`README.md`。

## 实施顺序与验收

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

### Phase 3 · 打磨与文档

进度框、失败提示、GM 面板信息、更新状态上报、文档与各目录 `AGENTS.md` 同步。

## 风险与边界

- **老玩家需要重装一次**。热更能力必须先进入 APK；已经装出去的旧版本无法远程更新，这是不可避免的一次性成本。
- **签名私钥丢失 = 更新链断掉**。只能发新 APK 让玩家重装；必须备份 `~/.config/inoita/update-signing.pem`。
- **发布窗口竞态**：下载途中正好 `npm run deploy`，旧清单文件随 `dist/` 一起消失，客户端会 404。客户端中止、保留 staging、下次启动重试，不会装出半个坏版本。
- **回滚范围有限**：只处理启动失败。已经进过标题页的版本不会自动回退，避免碰到已升级的存档。失败版本记入 `failedBuildId`，不会反复弹窗。
- **大改动仍要重装**：Java、权限、Gradle、新增原生桥方法都只能走 APK。`SHELL_VERSION` / `minShell` 就是为这种情况准备的闸门；新 APK 的 `versionCode` 必须递增。
- **不支持降级**：`builtAt` 只增不减。要撤回线上版本时，部署一个内容正确的新构建，而不是把站点换回旧构建。
- **清单体积**：1.18MB，gzip 后约 170KB，只在确实有更新时下载；常规剧情改动约 1–3MB。
- **首次检查开销**：每次启动一个几百字节的请求；失败静默，不阻塞进游戏。
