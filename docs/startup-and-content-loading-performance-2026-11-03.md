# 启动与内容装载：逐问题的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。每个问题单独成案，各自带代码证据、慢的原因、改法、风险和验证方式。

排查范围是玩家反馈的「运行一段时间后很卡」在「启动与内容装载」这条线上的表现：点开游戏、进世界、切图、演出前补素材——这一路到底装了什么、什么时候装、什么时候放。

## 一句话结论

卡不是慢慢漏出来的，是**一进世界就装太多**：约 470–570 MB 的解码纹理在第一次进图时就位，而其中 386 MB 是「常驻战斗包」，这个包里有 66%（254.7 MB）是 **41 个此刻一个都没上场的佣兵外观**。手机显存撑不住以后，浏览器会开始丢弃纹理、需要时再重传，表现出来就是「玩一阵子开始卡、切图开始顿」。

另外还有三个容器只进不出：内容 JSON、战斗音效、界面图片租约。

## 三个环节各自的判断

| 环节 | 判断 |
|---|---|
| 启动 | 不是主要来源。13 个内容 JSON 共 24.8 MB 文本，桌面解析合计 41 ms；416 张地图 JSON 每张 0.02 ms、合计 7 ms。 |
| 内容装载 | **主要问题在这里**。进世界一次性压 470–570 MB 解码纹理，其中 386 MB 常驻包有 66% 是没上场的佣兵。 |
| 释放 | 第二问题。纹理本身有池子上限（地图 3 张、剧情预取 2 张），但回菜单不清；音效、内容 JSON、界面图片三个容器没有任何上限。 |

## 测量方法与基线

- 环境：Node 24，Mac 桌面，直接读真实的 `public/content`；把 `phaser` 短路成空模块后，用游戏自己的 `buildEntryPlan`、`residentCombatAssets`、`planMapVisuals`、`planMapCombat`、`gameMenuImageGroups` 复算。
- 解码量口径：读 PNG 文件头的宽高，按 `宽 × 高 × 4 字节` 计；同一张贴图（同 key 或同文件）只算一次。这是浏览器上传给 GPU 前的解码占用，不含浏览器自己的额外拷贝。
- 手机还没有正式数据。桌面数字用于看**相对大小**，手机上按经验慢 5–10 倍、显存更小，结论以比例为准。
- 测量脚本是 `/tmp/measure-boot.mts`，临时文件，不在仓库里。复测请用同一口径，否则数字对不上。
- 注意：`4003` 是 Vite 开发服务器，体积和 `4002`（打包产物）不同。手机结论只能基于 `4002` 或 APK 上的 `?perf`。

### 进世界那一刻装了什么

| 批次 | 内容 | 解码量 |
|---|---|---|
| 共享素材 | HUD、控制皮肤、小地图、地面物品、衣柜图集、剧情特效、战斗全局特效 | 42.2 MB |
| 常驻战斗包 | 当前职业 + 全部佣兵 + 武器/技能/召唤物/共享特效 | 293–386 MB（按职业） |
| 首图计划 | 本图场景 + 本图战斗（含主角职业特效、上阵队员、可能出现的敌人） | 中位 138.9 MB |
| 合计 | 三批一起排进同一次加载（去重后约 460–560 MB） | **约 470–570 MB** |

### 常驻战斗包里面到底装了什么

以 `dark-knight` 为例，合计 386 MB：

| 内容 | 解码量 | 张数 | 占比 |
|---|---|---|---|
| 41 个佣兵的外观 | 254.7 MB | 2716 | **66%** |
| 本职业全部技能特效 | 104.3 MB | — | 27% |
| 共享战斗特效 | 21.3 MB | — | 5.5% |
| 本职业本体外观 | 7.4 MB | 56 | 1.9% |
| 技能图标 | 0.3 MB | 15 | — |

六个职业分别是：dark-knight 386 MB、warrior 375.7 MB、assassin 372.3 MB、priest 342.8 MB、warlock 341.9 MB、ranger 293.2 MB。差异主要来自本职业技能特效，逐职业的拆分没有做，这里只用总量。

### 稳定态水位

「稳定态」= 常驻包 + 共享素材 + 地图池里最多 3 张图（按贴图去重后的并集）：

| 组成 | 中位 | 最坏情况 |
|---|---|---|
| 常驻战斗包 | 386 MB | 386 MB |
| 共享素材 | 42.2 MB | 42.2 MB |
| 3 张地图历史（含共享，去重后） | 174 MB | 893.5 MB |
| 合计 | **约 500–560 MB** | **约 1.15 GB** |

416 张图全部并起来是 2486.7 MB——池子按 3 张截断，所以不会到顶，但「3 张」这个上限本身就选得很高。

### 切一次图真正换掉多少

| | 中位 | p90 | 最大 |
|---|---|---|---|
| 新加载 | 6.5 MB | 17.9 MB | 302.2 MB |
| 可释放 | 6.9 MB | 18.5 MB | 101.2 MB |

普通换图不贵。贵的是三类图：Boss 图、回忆图、最终决战图——最重的一张 `forgotten-ruins-3-39193752` 单图计划 457 个纹理、569.6 MB。

### 单图计划为什么这么大

一张图的计划分两半，平均 138.7 MB：

| 部分 | 平均 | 说明 |
|---|---|---|
| 场景素材 | 8.8 MB | 地面、树冠、道具图集、角色 |
| 战斗素材 | 129.5 MB | 主角职业特效（约 104 MB）+ 上阵队员 + 本图可能出现的敌人 + 敌人技能用到的特效图集页 |

主角那 104 MB 和常驻包里的是同一批贴图，加载时会按 key 去重、不会重复下载。**所以这份清单大，但重复部分不额外花显存**；它是「计划清单大」，不是「每次切图都多占 100 MB」。

## 问题一：41 个佣兵外观常驻 254.7 MB，占了常驻包的 66%

### 代码证据

`src/rendering/resident-combat-assets.ts:90-96`，每次组装常驻包都把全部佣兵外观塞进去：

```ts
// 佣兵的基础外观必须在入队前就绪；职业特效与召唤物已由上面的职业循环覆盖。
for (const definition of Object.values(companions.definitions)) {
  const actor = world.actors[definition.actor];
  if (!actor) continue;
  actorIds.add(actor.id);
  addAssets(characterAssets(actor));
}
```

`:22` 的注释说明了原因：「伙伴外观始终全量，保留菜单实时预览」。这个包由 `src/application/entry-plan.ts:85-91` 在首次进世界时并进主加载批次，之后由 `src/app.ts:91-94` 的 `releaseResidentCombat()` 在新游戏/读档/回菜单时释放。

但**按需加载的路其实已经铺好了三处**：

- `src/scenes/world-scene.ts:1634`：进图时对 `session.party.activeIds` 逐个 `preparePartyMember()`，上阵队员一定有素材。
- `src/rendering/map-assets.ts:219-232`：`planMapCombat` 会扫剧情脚本里的 `party-join` 命令，把该图会加入的佣兵也列进本图计划。
- `src/ui/phaser/party-panel.ts:59` 和 `src/ui/story-ui.ts:1427`：队伍页选中某个佣兵时调 `preparePartyMember(id)`，加载完再重绘。

也就是说：入队路径、出场路径、菜单预览路径都已经各自按需加载了，常驻包里那一份是**纯保险**。

### 为什么这和「越玩越卡」有关

它不属于「随时间增长」，而是把地板抬高 254.7 MB。显存预算是共享的：这 254.7 MB 一次都不会被画到，却把「同时能放下几张地图」的余量吃掉了 254.7 MB。同样玩三张图，工作集更容易被挤出显存，浏览器重传的频率也就更高。

### 改法

1. 删掉 `resident-combat-assets.ts:90-96` 的佣兵循环，`CombatAssetPack.actorIds` 只保留当前职业的主角。
2. `ResidentCombatInput.companions` 参数一起删掉，`entry-plan.ts:86-90` 的调用同步改。
3. 补一条兜底：佣兵在剧情里只是**立绘**出场时不需要这套外观（立绘走 `portraits`）；只有会动的时候才需要。把「入队」这条路做扎实即可——`party-join` 命令执行前若素材未就绪，await `preparePartyMember`。
4. 队伍页首帧：`party-panel.ts:59` 已经会等加载完再重绘，确认 `render()` 在此之前不会用空外观画一帧。

### 风险

- 测试 `tests/resident-combat.test.ts:17-25` 明确锁了「scoped pack keeps every companion appearance」并断言 41 个 actor；`tests/combat-visual-coverage.test.ts:70` 也断言包里必须有 `mercenary-black-knight`。改完要一起改成「不再包含任何佣兵」。
- 构建期覆盖校验 `src/rendering/combat-visual-coverage.ts:95-98` 会逐个检查伙伴 actor 的层是否在包里，删掉后仍然会报缺口。这里要改口径：伙伴层不再要求「常驻包覆盖」，改成「`partyMemberCombatAssets` 覆盖」，否则每次构建都失败。
- 佣兵在剧情对话里以**动画角色**出场、但还没 `party-join`——需要先扫一遍 `campaign.json` 有没有这种用法。若有，就让 `map-assets` 也把它们列进本图计划（那里已经有按脚本收集的逻辑，加一个分支即可）。

### 验证

- `npm test -- tests/resident-combat.test.ts tests/resident-combat-lifecycle.test.ts tests/entry-plan.test.ts`
- `npm run validate:content`（构建期还有一遍 `residentCombatCoverageGaps` 覆盖校验，确认没有效果因此漏装）
- 手动：新游戏进世界 → 开队伍页逐个点佣兵 → 招一个佣兵入队 → 带佣兵打一场。

### 预期

常驻包 386 MB → 约 131 MB；进世界总装载 470–570 MB → 约 220–320 MB。

---

## 问题二：主角职业技能特效 104.3 MB 全量常驻，而且每张图的计划里再算一遍

### 代码证据

`src/rendering/resident-combat-assets.ts:67`，一个职业的所有技能特效一次装完：

```ts
const attack = resolveBasicAttack(battle, { actor: character.actor, basicAttack: character.basicAttack });
addEffects(classEffects(battle, character, attack, wardrobe));
```

`classEffects` 展开的是这个职业的全部技能，不看角色当前学没学会。

同时 `src/rendering/map-assets.ts:206-210` 的 `planMapCombat` 每张图都重算一遍同一个函数：

```ts
const assets: PendingAsset[] = [
  ...playerCombatAssets({ catalog: input.battle, wardrobe: input.wardrobe, items: input.items, hero: input.hero, actor: input.playerBase }),
  ...sharedCombatAssets(input.battle, input.wardrobe)
];
```

这就是单图计划里那 104 MB 的来源。它和常驻包重复，加载时按贴图 key 去重，不额外占显存——但**它让每张图的计划清单虚高 104 MB**，也让「计划里到底有没有漏装」这件事更难判断。战斗开场 `src/scenes/world-combat.ts:2312` 还会第三次算同一批（注释 `:2304` 说得很清楚：这里再取一次是幂等的，只是为了让战斗开场不卡）。

### 为什么这和「越玩越卡」有关

同一个不增长的东西被算了三遍。第一个代价是内存地板：一个刚创建、只学会两三个技能的角色，也要为全职业特效付 104.3 MB。第二个代价是每次进图、每场战斗都要为几千个纹理键走一遍去重和可用性检查，手机上是实打实的主线程时间。

### 改法

1. 给 `classEffects()` 加一个可选参数：只展开传入的 `skillIds`；不传时保持现在的全量（构建期校验仍然要全量）。
2. 常驻包按 `session` 里已解锁的技能传入（`battle.classes[].skills` 与角色已学生效表取交集）。
3. 技能解锁时补加载一次：解锁发生在升级界面/剧情里，那时候补 8–20 MB 可以接受；补完更新常驻包记录。
4. `planMapCombat` 里，常驻包已就绪时跳过 `playerCombatAssets`（`entry-plan.ts` 已经有 `includeResidentCombat` 这个开关，把这个判断传下去即可）。

### 风险

- 技能在战斗中途解锁（升级、剧情授予）而素材没加载 → 必须保证解锁入口 await 加载完成。
- `tests/resident-combat.test.ts` 里关于覆盖率的断言需要跟着新参数调整。
- 战斗开场 `world-combat.ts:2312` 仍然全量取一次，所以「漏装」不会变成崩，只会变成战斗开场多等一下——这也是这条改动安全的原因。

### 验证

- `npm test -- tests/resident-combat.test.ts tests/entry-plan.test.ts`
- `npm run validate:content`（`residentCombatCoverageGaps` 用全量口径校验，必须仍然通过）
- 手动：新角色进世界 → 打一场 → 学会新技能 → 再打一场。

### 预期

新角色常驻包 386 MB → 约 130 MB（去掉佣兵后）；随技能解锁逐步回升，但满级前不会到 386 MB。单图计划清单 138.9 MB → 约 35 MB。

---

## 问题三：回菜单不清地图历史，切图池还留着 3 张

### 代码证据

`src/app.ts:156-167`：

```ts
private mapAssetHistory: AssetLease[] = [];
retainMapAssets(lease: AssetLease): void {
  this.mapAssetHistory.push(lease);
  while(this.mapAssetHistory.length+(this.mapPrefetch ? 1 : 0)>3)this.mapAssetHistory.shift()!.release();
```

`clearStoryPrefetch()` 和 `clearMapPrefetch()` 都有调用点（`src/main.ts` 读档和回菜单），但 **`mapAssetHistory` 全仓库没有任何清空调用**：回标题、读另一个档、开新游戏，都还留着最多 3 张图的整份素材。

### 为什么这和「越玩越卡」有关

严格说它不是「越玩越多」——上限就是 3 张。但它是**每次会话开始时白占的地板**：3 张图并集中位 174 MB、最坏 893.5 MB。手机上「回菜单再读档」这种动作会让旧的地图素材和新的一起活着，直到新的挤掉旧的为止。

### 改法

1. 加 `clearMapAssets()`：`this.mapAssetHistory.splice(0).forEach(lease => lease.release())`。
2. 在回菜单、读档 `stopCurrent`、开新游戏三处调用，与 `clearStoryPrefetch()` 并列。
3. 顺手把上限 3 改成 2：切图实测中位只新增 6.5 MB，多留一张图换来的收益很小，省下的是一整张图的解码量。

### 风险

读档后回到同一张图要重新加载（多 6.5–140 MB）。可接受的代价；若担心，就只做第 1、2 步，上限保持 3。

### 验证

`npm test -- tests/scene-assets.test.ts`；手动：进图 A → 进图 B → 回菜单 → 读档 → 确认贴图正常。

### 预期

回菜单后释放 174–893 MB；稳定态上限从「3 张图」降到「2 张图」。

---

## 问题四：内容 JSON 只进不出

### 代码证据

`src/application/content-loader.ts:25` 是一个只增不删的 Map：

```ts
private readonly requests = new Map<string, ContentRequest<unknown>>();
```

`read()` 成功后只把 `finished` 标成 `true`（`:74`），条目留在 Map 里；只有失败才 `delete`（`:79`）。这张 Map 里装的是**解析后的对象**，不是原始文本。

### 为什么这和「越玩越卡」有关

它不占显存，但占 JS 堆。游玩过程中被读进来的有：

- 416 张地图 JSON（5.6 MB 文本，解析后是对象树）；
- 每张图对应的实体、剧情脚本引用；
- 开发模式（`?gm`、未信任构建）下 `prepareStory` 还会把 281 张剧情图一次性读进来做引用校验。

32.3 MB 文本解析成对象后通常是 3–5 倍（经验值，没在真机量）。这部分增长很慢，单独看不足以造成卡顿，但它是**唯一真正无上限**的容器之一，且每次垃圾回收都要扫过它。

### 改法

1. 只有 `map()` 需要 LRU：保留最近 8 张（当前图 + 预取 + 最近走过的），超出时 `requests.delete(file)`。
2. 13 个核心内容文件（world/campaign/battle/... ）保持常驻，它们本来就只有一个实例。
3. 注意：`delete` 只丢掉「下次再来要重新 fetch 和 parse」的能力，已经拿到对象的调用方不受影响——所以这条改动不会让任何东西变空。

### 风险

- 同一张图在 LRU 边界反复进出 → 反复 fetch。给 `map()` 单独计数，命中即刷新时间戳。
- 开发模式的 281 张校验：那条路径可以继续不设上限（只在 GM/未信任构建下发生），但要加注释说明。

### 验证

`npm test -- tests/content-loader.test.ts`（现有用例覆盖复用与取消）；补一个「超过容量后重新 fetch」的用例。

### 预期

堆从「随访问地图数线性增长」变成「约 8 张图 + 13 个核心文件」，手机长局可省几十 MB 堆，GC 压力同时下降。

---

## 问题五：战斗音效只进不出

### 代码证据

`src/application/game-audio.ts:264-277` 的 `load()` 把音效解码进 `scene.cache.audio` 后，**没有任何删除路径**。全文件只有两处 `cache.audio.remove`：

- `:234` ambience 换曲时删上一首；
- `:254` BGM 历史超过 `MUSIC_CACHE_RETENTION`（=1）时淘汰最旧。

`se:*` 前缀的键没有淘汰。而 `:183-192` 的 `prepareCombat()` 每次进战斗都会铺开一整套：固定战斗音效 + **全部武器**（critical/blocked/normal/miss）+ **全部敌人**（attack/death/struck）+ 参战职业技能音效。

### 为什么这和「越玩越卡」有关

音频目录里 170 条音效，合计 304.5 秒（按文件码率估），按 44.1 kHz 立体声 Float32 估算是 **约 102 MB 解码内存**。战斗打得越多、遇到的敌人种类越多，缓存越满。这是真实的、随游玩时长单调增长的一项。

它不占显存，但和显存在抢同一台手机的内存。

### 改法

1. 给 `se:*` 加 LRU 上限（建议 48 条），淘汰时 `scene.cache.audio.remove(key)`。
2. 关键音效（UI、升级、受击）标为常驻，不参与淘汰。
3. 或者在换图/战斗结束时按「这一场用过哪些」批量清——比 LRU 更简单，但会误删下一个场景马上要用的。

### 风险

被淘汰的音效再次播放时要重新解码，表现为「第一次点按钮没声音或延迟半拍」。所以 UI 音效必须常驻；LRU 只作用在战斗音效上。

### 验证

`npm test -- tests/game-audio.test.ts`；手动：连续打十场、换几种敌人，确认常用音效无延迟。

### 预期

音效解码内存从「随游玩种类增长」压到约 30 MB 上限。

---

## 问题六：界面图片租约只增不减

### 代码证据

`src/ui/phaser/ui-asset-host.ts:19` 是一个只推不删的数组：

```ts
private leases: AssetLease[] = [];
```

`preloadFiles()`（`:23-28`）每调用一次 push 一条新租约，`retain()`（`:31`）单张立绘也 push。唯一释放点是 `releaseContent()`（`:33`），它把整个数组一次清空。

### 为什么这和「越玩越卡」有关

菜单图片分两批：core 247 个文件 7.6 MB、extra 413 个文件 7.0 MB。每打开一个带新立绘的剧情、每刷新一次菜单，就多一条租约；直到 `clearMenuPreparations()` 才整体释放。数据量不大（14.6 MB 封顶），但它是「只增」的第四个容器。

### 改法

按批替换而不是追加：`preloadFiles()` 里把同一批（同一次菜单准备）的租约归组，新一批到位时释放上一批；立绘单独一组，按「当前剧情」整体替换。

### 风险

菜单同一帧里引用了正在被替换的贴图 → 需要等新一批加载完成再释放旧的一批（现有的 `refreshMenuWhenReady()` 正好是这个时机）。

### 验证

`npm test -- tests/scene-assets.test.ts`；手动：反复开关菜单、连看几段剧情立绘。

### 预期

界面图片稳定在 15 MB 以内，不再随打开次数增长。

---

## 已排除的怀疑

逐项核过，都不是本次原因：

| 怀疑点 | 结论 |
|---|---|
| 地图 JSON 解析慢 | 不是。416 张共 5.6 MB、合计 7 ms，单张 0.02 ms。 |
| 启动时解析 13 个内容文件 | 不是。24.8 MB 文本、桌面合计 41 ms。问题在「解析结果常驻」（问题四），不在解析耗时。 |
| 同一张图重复下载贴图 | 没有。`src/rendering/scene-assets.ts` 的 `loadSceneAssets` 按贴图 key 去重，同 key 不同描述会直接报错。 |
| 跨图扇出预取 | 已修。提交 `974eb76` 删掉了「按剧情链预取后续 12–20 张图」，现在只备目标图入口与声明过的跨地图舞台。 |
| 菜单图片太大 | 不是。core 7.6 MB + extra 7.0 MB，有界。 |
| 地面/树冠整图太占 | 是素材层问题，不是装载逻辑问题。416 张 ground 与 416 张 canopy 各 462.8 MB，但池子只留当前几张，属于另一个话题。 |

## 修复顺序

1. **问题一**（佣兵外观）——占比最大、风险最低、按需路径已经存在。
2. **问题二**（技能特效按解锁）——依赖问题一改完后的常驻包结构。
3. **问题五**（音效 LRU）——独立，长局收益明显。
4. **问题四**（内容 JSON LRU）——独立，改小。
5. **问题三**（地图历史清理）——独立，改小。
6. **问题六**（界面租约）——收尾优化。

每步单独一个提交，先复测基线再改，改完再测，改前改后的数字写进提交说明。

## 不在本轮范围

- 素材本身的解码体积（416 张地图整图各 462.8 MB、`skill-monster-*` 整画布 PNG 重复 8–16 份）。那是构建期的图集与裁边工作，走 `npm run report:assets` 和 `tools/build-*-atlas.ts` 那条线。
- 存档、会话通知、寻路与 AI 的逐帧成本——各自有单独文档。
- 渲染管线与 Phaser 内部的贴图管理。

## 怎么复核

- 桌面：`npm run build && npm run serve`，在 `http://127.0.0.1:4004/?perf` 里正常玩 2 分钟，看每 30 秒一条的 `frame-stats`（P50/P95/最长帧、`>50ms` 与 `>100ms` 长帧数）。改动前后各跑一次，同样的操作顺序。
- 手机：`4002` 或 APK 上带 `?perf`，重点看**进图后 10 秒**和**连续切 5 张图之后**这两段的 P95。
- 显存：桌面上用 Chrome DevTools 的 Memory 面板看 JS 堆趋势；GPU 显存没有稳定可用的浏览器 API，所以以「切图后是否还在长」和「长帧是否变多」间接判断。
- 数值复测：`/tmp/measure-boot.mts` 的五个口径（常驻包、单图计划、稳定态并集、切图换手、启动 JSON）原样重跑。
