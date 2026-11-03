# 资产与纹理内存：逐问题的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。每个问题单独成案，各自带代码证据、量级、改法、风险和验证方式。

排查范围是玩家反馈的「运行一段时间后很卡」在资产与纹理内存这一块的表现。

## 一句话结论

不是泄漏，是**装得太多、装完不降**。全站 11638 张 PNG 解码后约 4.9 GB；当前实际常驻约 386 MB，其中 255 MB 是「佣兵外观」——名册和立绘根本读不到它。再叠一只重 boss（300–440 MB），峰值直接越过移动端显存预算，之后每一帧都在换页，越玩越卡。

Phaser 4 在这一层没有缓冲：**纹理创建的那一刻就上传显存**（`node_modules/phaser/src/textures/TextureSource.js` 构造函数末尾 `this.init(game)` → `renderer.createTextureFromSource(...)`），只有 `destroy()` 才 `deleteTexture`。所以「加载了多少」等于「显存占了多少」，不存在「没画到就不占」。

## 量级总账

| 项 | 解码体积 | 说明 |
|---|---|---|
| 全站素材 | 4902 MB / 11638 张 | 假设全部载入的上限，不是实际值 |
| 常驻战斗包（单职业） | **386.0 MB / 2669 张** | 第一次进世界加载，之后永不释放 |
| └ 其中佣兵外观 | **254.7 MB / 2372 张** | 41 个人物，人均 6.21 MB |
| └ 其中角色层（含主角职业） | 262.0 MB / 2428 张 | |
| └ 其中特效图集页 | 75.1 MB / 6 页 | 单页 13–15 MB |
| 单职业战斗包 | 19.8–111.2 MB | 随职业变化 |
| 重 boss（龙，整包） | **438.4 MB** | 角色图 433.0 + 特效 5.4；角色图里技能占 81% |
| 每张图自带敌人 | 平均 5.2 MB，最重 23.1 MB | 248 张图、352 种敌人 |
| 地图本体 | 平均 2.2 MB，最大 5.6 MB | 416 张图 |
| 特效图集总计 | 146.1 MB / 13 页 | |

粗算：386 MB 常驻对 512 MB 预算是 75%；打一只龙再叠 438 MB，合计 **824 MB**。这就是「运行一段时间后很卡」的直接来源——不是随着时间缓慢泄漏，而是**一进 boss 战就跨过预算线，之后再也回不去**。

## 问题 1｜佣兵外观进常驻包（255 MB）

### 代码证据

`src/rendering/resident-combat-assets.ts:91-96`：

```ts
// 佣兵的基础外观必须在入队前就绪；职业特效与召唤物已由上面的职业循环覆盖。
for (const definition of Object.values(companions.definitions)) {
  const actor = world.actors[definition.actor];
  if (!actor) continue;
  actorIds.add(actor.id);
  addAssets(characterAssets(actor));
}
```

`characterAssets`（`src/rendering/combat-asset-descriptors.ts:41`）对该角色的**每一个 clip、每一层**都生成一条资源描述，没有任何过滤参数。

### 为什么这么写

注释写的原因是「入队前就绪」，防止某处直接拿 `world.actors[definition.actor]` 建角色时缺纹理。

### 为什么实际不需要

| 用途 | 实际读什么 | 证据 |
|---|---|---|
| 队伍名册 | 预烘焙 UI 图标 `panels.assets['party-class-*']` | `src/domain/menu-panels.ts:44-55`、`src/ui/phaser/party-panel.ts:64` |
| 详情立绘 | 衣柜合成纹理 `outfit-*`，没有才退回上面那张图标 | `src/ui/phaser/party-panel.ts:153-158`、`src/ui/phaser/character-preview.ts` |
| 入队准备 | 只做衣柜合成 | `src/scenes/world-scene.ts:807` `preparePartyMember` |
| 队友战斗 | 开战时按需加载 | `src/scenes/world-combat.ts:2050` `syncAllies` |
| 搭档在地图上 | 进图计划已包含 | `src/rendering/map-assets.ts:206` `planMapCombat`、`:217` 队伍成员、`:231` 本图 `party-join` 伙伴 |

也就是说，常驻的那一份**没有任何读取者**。

### 改法

1. 删掉 `resident-combat-assets.ts:91-96` 循环与 `actorIds` 里对佣兵的收集。
2. `src/rendering/combat-visual-coverage.ts:98-102` 的伙伴循环删除，但要**换成别的不变量**：凡是能通过 `party-join` 出场的搭档，必须出现在某张地图的进图计划里。
3. `tests/resident-combat.test.ts:20-27` 的两条断言跟着改（当前断言 `scoped.actorIds.has(actor)` 必真）。
4. 兜底：在 `src/rendering/characters.ts` 的 `setCharacterClip` 加开发期检查——clip 的层纹理不存在就抛明确错误。这样漏掉的出场路径会变成一条可定位的报错，而不是一块绿方块。

### 风险

存在「无计划出场路径」：某处直接拿 `world.actors[partners]` 建角色，既不经过地图计划也不经过舞台 cast。这是唯一能让本方案退化成「偶发绿方块」的情况。

### 验证

- `npm test -- tests/resident-combat.test.ts tests/combat-visual-coverage.test.ts`
- 扩展 `tools/audit-story-actors.ts` 输出「搭档 → 出场地图」表，确认无空集
- 读数显示常驻从 386 MB 降到约 131 MB

## 问题 2｜敌人技能动画全量载入（龙 81% 是技能）

### 代码证据

`src/rendering/combat-asset-descriptors.ts:41-49`：

```ts
export function characterAssets(actor: ActorDefinition): PendingAsset[] {
  return Object.values(actor.clips).flatMap(clip => clip ? clip.layers
    .filter(layer => !!layer.file)
    .map(layer => ({ kind: 'spritesheet', key: layer.key, file: layer.file,
      config: { frameWidth: clip.frameWidth, frameHeight: clip.frameHeight, endFrame: clip.frames - 1 } })) : []);
}
```

敌人的技能 clip 名是 `skill-<技能id>-<朝向>`（`src/domain/skill-action.ts:6`），战斗时按 `actor.clips[name]` 取用（`src/scenes/world-combat.ts:881-882`）。因为 `characterAssets` 不看名字，32 个 clip 一起进包。

`enemy-dragon-alexander-1` 的实测分项（按 PNG 实际尺寸算）：

| 类别 | 体积 | 文件数 |
|---|---|---|
| idle / walk / attack | 81.3 MB | 12 |
| skill（5 个技能 × 4 向） | **351.7 MB** | 28 |
| 合计 | 433.0 MB | 40 |

技能占 81.2%。按 clip 元数据（帧宽 × 帧高 × 帧数）折算的比例是 76%，两种口径指向同一件事：**贵在技能，不在站姿**。

且每个技能的四向各存一份整表，例如 `skill-monster-meteor-*` 每份 13.92 MB × 4。

### 改法（分两层，可分开提交）

**第一层：拆包**

- 新增 `actorCoreAssets(actor)`（idle/walk/attack/die 等非 `skill-` 前缀）与 `actorSkillAssets(actor, skillIds?)`（`skill-` 前缀，可按技能过滤）
- `enemyCombatAssets`、`playerCombatAssets`、`partyMemberCombatAssets` 各自返回核心包与技能包
- `src/scenes/world-combat.ts:2302` 的 `start()` 先 `await` 核心包建 presenter；技能包**不 await**，挂在开战演出窗口后台加载

**第二层：缺纹理时降级**

技能播放前查一次纹理是否就绪（`scene.textures.exists(layer.key)`）：

- 就绪 → 正常播
- 缺 → 播 `idle-<朝向>` 顶上，等后台完成后再恢复

这一层是必须的：只靠时间窗口赌，就会在慢设备上闪占位图。

**第三层（可选，工期长）**

四向技能动画内容相同，用水平翻转共用一份，351.7 MB → 约 88 MB。前提是逐帧确认是真镜像。

### 风险

放技能那一帧纹理没到会闪。第一层 + 第二层一起做才安全，单做第一层不能上。

### 验证

- 静态量化脚本对比核心包/技能包集合与体积
- 打一场龙战：`?mem` 峰值应低于原值 300 MB 以上，六种技能各放一次不能出现占位

## 问题 3｜进图计划重复列战斗素材

### 代码证据

`src/rendering/map-assets.ts:206-238` 的 `planMapCombat` 把 `playerCombatAssets`、`sharedCombatAssets`、队伍成员、入队伙伴、敌人全拼在一起；`src/scenes/world-scene.ts:362` 把它和视觉资源合成一份 `planned` 交给 `loadSceneAssets`。

### 它到底省不省显存

**不省。** 这些键与常驻包是同一批，`AssetPool` 按 key 引用计数，同一张纹理只占一次显存。

它真正的问题是：`missingSceneAssets`（`world-scene.ts:366`）会把已常驻的键再算一遍，加载条按「账面张数」走，看起来比实际重得多。

### 改法

计划里只列「这张图独有的」，常驻部分由常驻租约引用。属于顺手清理，不是修复项，放最后做。

## 问题 4｜跨图演出预取捆了完整计划

### 代码证据

- `src/main.ts:421-425`：只有 `stage && !stage.mapFromWorld && stage.map !== scene?.map?.id` 才调 `prefetchStoryEntry`
- `src/scenes/world-scene.ts:619-648` 的 `loadStoryEntry` 走完整 `buildEntryPlan` + `entryPlanAssets`
- `src/app.ts:173-182` 的 `retainStoryPrefetch` 上限是 **2 张**（`while (this.storyPrefetches.size > 2)`）

> 更正：此前口头说「预取 20 张」是错的，代码里是 2 张。

### 改法

`buildEntryPlan` 把结果拆成「视觉」和「战斗」两个字段（`entryPlanVisuals(plan)` / `entryPlanCombat(plan)`），预取路径只取视觉；战斗素材交给 `world-combat.ts:2322` 自己在开战加载（它本来就会）。

### 收益

单次预取从「一整张图的完整计划」降到「地图图 + 人物」，实测每张图视觉部分 3–6 MB。

## 问题 5｜特效图集页粒度太粗

### 代码证据

- `tools/build-effect-atlas.ts:19` `MAX_SIZE = 2048`，`:204-224` 按顺序铺格子装页，页与特效没有归属关系
- `src/rendering/combat-asset-descriptors.ts:80-105`（`effectAssets`）遍历每个特效的每个 clip 每层；`:51-65`（`effectPageAsset`）把命中的图集页整页进包

单页 13–15 MB，一个职业包吃掉 6 页 = 75.1 MB。

### 改法

两个方向：

1. 打包器加「归属分组」（职业 / 共享 / 敌人技能各自成页），页内不再混装
2. `MAX_SIZE` 降到 1024，页更细、过取更少

代价：页数变多、draw call 略增；且页变小会让「一个特效跨页」变多，可能反向多拉页。

**结论：先出表再定。** 要一张「每个职业包实际命中哪几页、每页里非本职业内容占多少」的统计，再决定做 1 还是 2。

## 问题 6｜没有读数（应该第一个做）

### 代码证据

全仓库没有 `renderer.info` / `textures.list` 的读数（grep 0 命中）。只能靠 FPS 读数（`src/scenes/world-scene.ts:478` `createFpsReadout`，受显示设置控制）。

### 改法

在同一个读数框加一行「纹理 N 张 / 估算 X MB」：

- 张数：`scene.game.renderer.info.memory.textures`
- 估算：遍历 `scene.textures.list`，对每个 source 取 `getSourceImage().width/height` 累加 `宽 × 高 × 4`

同时用现有 `globalThis.storyDiagnostics?.record('textures', …)` 在进图、进战斗、出战斗打点。以后每个改动都用同一把尺子量。

## 建议执行顺序

| 顺序 | 做什么 | 主要文件 | 验证 |
|---|---|---|---|
| 1 | 纹理读数 | `src/scenes/world-scene.ts`、`src/application/game-diagnostics.ts` | 数字随进图/进战斗变化 |
| 2 | 出场路径审计表（不改运行代码） | `tools/audit-story-actors.ts` | 输出「搭档 → 出场地图」表 |
| 3 | 佣兵退出常驻包 | `src/rendering/resident-combat-assets.ts`、`combat-visual-coverage.ts`、两个测试 | 两个测试通过，读数 386 → 约 131 MB |
| 4 | 敌人技能拆包 + 缺纹理降级 | `combat-asset-descriptors.ts`、`combat-assets.ts`、`world-combat.ts` | 龙战峰值下降、技能不闪占位 |
| 5 | 预取只取视觉 | `src/application/entry-plan.ts`、`world-scene.ts` | 跨图演出一场 |
| 6 | 图集分组（先出表再决定） | `tools/build-effect-atlas.ts` | 构建 + 全站量化对比 |

每一步单独一个 Git 提交，提交说明写清改了什么行为、怎么验证的。

## 待决问题

1. **佣兵外观是「全删」还是「精简常驻」**：本文倾向全删，前提是第 2 步的审计表为空集。若审计发现无计划出场路径，退成「只留 idle/walk 四向」约 30 MB。
2. **开场演出窗口够不够长**：需要在真机上量一次开场演出时长与首技能释放间隔。不够则技能包加载要提前到「接近 boss 房间」时。
3. **图集做分组还是缩小页**：等第 5 步的统计表。

## 测量方法（可复现）

- 尺寸来源：Python 读 PNG 的 IHDR 头取宽高，`宽 × 高 × 4` 即解码后的 RGBA 字节数；不看磁盘文件大小（压缩率会把差异拉平）。
- 素材闭包：用 Node 直接 import `src/rendering/combat-asset-descriptors.ts`、`src/rendering/combat-assets.ts`、`src/rendering/resident-combat-assets.ts` 计算（这三个模块不依赖 Phaser，可以在纯 Node 下跑）。
- 不能直接 import 的模块：`src/rendering/map-layers.ts`、`src/rendering/characters.ts`（值导入 Phaser，Node 下会因为 `window is not defined` 失败）。
- 临时脚本放在 `/tmp/inotia-probe/`，不在仓库里；复测请用同一口径重写。
