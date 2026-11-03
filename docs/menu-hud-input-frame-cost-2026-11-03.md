# 菜单、HUD 与输入：逐问题的代码级方案（2026-11-03）

本文只做审查和方案，**没有改任何游戏代码**。每个问题单独成案，各自带代码证据、慢的原因、改法、风险和验证方式。

排查范围是玩家反馈的「运行一段时间后很卡」在这三块里的表现：菜单（面板的打开、重画、布局）、HUD（血条、技能栏、名字条）、输入（点击区、按键与指针事件）。

同一轮还有两份姊妹文档，结论可以互相引用：`docs/ai-pathfinding-frame-cost-2026-11-03.md`（AI 与寻路）、`docs/session-save-economy-performance-2026-11-03.md`（会话、存档与经济）。

## 一句话结论

不是内存泄漏。菜单、HUD、输入三块里，没有一个容器会随游玩时间变长。

真正会「越玩越卡」的只有一处：**任务页把「任何一条状态通知」都当成「整页要重画」**，而整页重画的单价随任务条数增长；菜单打开时世界没有暂停，战斗中掉血、拾取都会发通知，于是重画频率也跟着战斗强度走。单价涨、频率也涨，两者相乘就是越玩越卡。

其余问题都是固定开销（每帧、每次点击都在花同样的钱）或两个正确性 bug。它们会让手机上的操作发涩，但不是「越玩越慢」的原因。方案仍然逐条给出，并按「先修频率、再修单价」排了提交顺序。

## 三块的判断

| 子系统 | 判断 |
|---|---|
| 菜单 | 对象不泄漏，创建与销毁成对。但重画粒度太粗：一次重画 = 整层拆掉重建，任务页且对每条通知都重建。 |
| HUD | 只有 8 个固定控件，不随时间增长。每帧有一点点固定计算，量级在微秒到几十微秒。 |
| 输入 | 交互对象不累积（Phaser 自己会清理）。有一个命中区永远不更新的真 bug，和一处每次命中都新建数组的小浪费。 |

## 已排除的累积型泄漏

逐项核过，都有硬上限或成对释放，不是本次原因：

| 容器 / 资源 | 上限或释放时机 | 出处 |
|---|---|---|
| 菜单的 8 层 UiSurface | `attach` 建一次，场景 `shutdown` 一次性 `destroy()` | `src/ui/story-ui.ts:148-175` |
| 操控布局 / 键位编辑器 | `??=` 缓存单例，只在 `shutdown` 销毁 | `src/ui/story-ui.ts:520`、`:530`、`:173` |
| 会话订阅 | `bind()` 先 `this.unsubscribe?.()` 再重订 | `src/ui/story-ui.ts:176-188` |
| 滚动区的场景事件 | `destroy()` 成对 `off` 四路输入，销毁 zone/layer/mask | `src/ui/phaser/widgets.ts:369` |
| 面板子对象 | `clear()` 逐个 `child.destroy()`，显式跳过静态层 | `src/ui/phaser/widgets.ts:103` |
| Phaser 输入列表 | `GameObject.destroy` 里 `scene.sys.input.clear(this)`；插入队列按 `indexOf` 去重 | `node_modules/phaser/src/gameobjects/GameObject.js:1029`、`src/input/InputPlugin.js:2220` |
| HUD 可见性登记表 | 全仓只有 8 处 `hud.add`，都是每场景一次的固定控件 | `src/rendering/hud.ts` 加 8 个调用点 |
| 拾取提示 | `MESSAGE_LIMIT=32`，出队即 `destroy` 并清 tween | `src/rendering/pickup-messages.ts` |
| 掉落视觉对象 | 按 id 对账，多退少补 | `src/rendering/ground-loot.ts` |
| 头顶状态 | `container.once('destroy', unsubscribe)` | `src/rendering/overhead-status.ts:32` |

所以「开一百次菜单比开一次慢」不成立。可测的差异只来自**内容体积**（任务越多、背包越满，单次重画越贵）。

## 两笔账

### 打开菜单时的稳态（每帧）

| 每帧做的事 | 位置 | 量级 |
|---|---|---|
| 拼目标签名、写 6 次可见性、同步名字条 | `src/scenes/world-scene.ts:1750` `syncHud()` | 几十微秒 |
| 把 6 个快捷格 map 成新数组并拼签名，技能栏再拼一遍同样的签名 | `src/scenes/world-scene.ts:883`、`src/ui/phaser/computer-skill-hud.ts:71` | 十几微秒 |
| 推进提示与 toast、同步一条提示文字 | `src/scenes/formal-ui-scene.ts:79-84` | Phaser 的 `setText`/`setFontSize` 有相等短路（`Text.js:639`、`TextStyle.js:647`），内容不变时几乎为零 |

结论：稳态每帧开销在微秒级，不足以解释卡顿。**菜单的账不在这里，在「重画」那一下。**

### 一次整页重画

`renderNow()`（`src/ui/story-ui.ts:450`）的顺序是：抓各面板滚动位置 → 把整个 body 摘下来 → `surface.clear()` → `body.clear()` → `description.clear()` → `modal.clear()` → 重建静态图框 → 逐页重建内容 → 末尾 `this.sync()` → `layout()`。

所以一次重画 = 几十到上百个 `Text` 重新创建（每个 `Text` 自带一张画布纹理，`widgets.ts:127` 的 `resolution:Math.min(3,devicePixelRatio)`）+ 每个滚动区一张按屏幕大小开的动态遮罩贴图 + 一次全量布局（4–5 次强制读布局）。

---

# P1 任务页对每条通知都整页重画（唯一随游玩变慢的问题）

## 证据

- 通知没有分类：`emit()` 直接遍历所有订阅者 —— `src/domain/session.ts:602`。
- 会发通知的动作很多：掉血 `setPlayerHealth`（`src/domain/session.ts:208`）、加钱（`:182`、`:186`）、伙伴属性变化（`:297` 的 `hero?.subscribe`）、剧情命令批提交（`:979`，任务接取/完成、换图、拾取都走这里）、追踪目标变化（`:833`）、调试传送（`:996`）。
- 订阅方靠签名去重：`if(signature===undefined||signature!==this.sessionSignature)this.render();` —— `src/ui/story-ui.ts:186`。
- 签名的 switch 里没有 `quests` 分支，落到 `default:return undefined;` —— `src/ui/story-ui.ts:426`。
- `render()` 同步调用 `renderNow()`，不排队、不节流 —— `src/ui/story-ui.ts:387`。
- 任务页固定两个滚动区 —— `src/ui/phaser/quest-panel.ts:61`（列表）、`:82`（详情）。
- 任务页自己其实早就知道「任务只在版本变化时才变」：`src/ui/phaser/quest-panel.ts:19` 的注释写着「面板开着时每次 `emit` 都会重画，但任务只在版本变化时才变」，作者据此给分组计算加了 `{questVersion, focus}` 缓存（`:44`）。漏的只是「重画」这一层。

## 为什么慢

三条叠加，缺一不可：

1. **频率**：菜单打开时世界没暂停（见 P3），战斗里掉血、拾取、任务推进都在发通知。开着任务页挨打，一秒能触发好几次重画。
2. **单价**：每次都是整层拆建，不是「改一行」。两个滚动区各要重新分配一张几兆的 GPU 贴图（见 P2）。
3. **内容量**：任务越多，列表行越多，每次重建的 `Text` 越多。这是唯一会随游玩时间变长的因子。

姊妹文档测过 `emit()` 本身很便宜（后期一次 0.06–0.25 ms），所以成本全在监听者身上 —— 正好就是这里。

## 方案

**第一步：给任务页一个真签名。**

```ts
// src/ui/story-ui.ts 的 sessionDataSignature()
case 'quests': return `quests|${session.questBook.version}|${session.debugFocusQuest ?? ''}`;
```

只认版本号，不手写字段。理由：`session.refresh()`（`src/domain/session.ts:606`）已经做了投影缓存——任务版本、背包版本、操控者、条件值都没变时它会早退，不提交计划；只有真的提交了才 `revision++`（`src/domain/quest-book.ts:508`）。所以 `questBook.version` 就是「任务显示是否过期」的现成答案。

加 `debugFocusQuest`，是因为调试聚焦会换掉整张列表，而它在 `quest-panel.ts:44` 的缓存键里。

**第二步：订阅路径改成排队，每帧最多一次。**

```ts
private renderQueued=false;
/** 会话通知走这里：同一帧内的多条通知只重画一次，也不会卡在战斗逻辑中间。 */
private requestRender():void{
  if(this.renderQueued)return;
  const scene=this.scene; if(!scene)return;
  this.renderQueued=true;
  scene.events.once('postupdate',()=>{
    this.renderQueued=false;
    if(!this.scene||scene!==this.scene)return; // 场景已被换掉/销毁
    this.render();
  });
}
```

点击、翻页、打开菜单仍然走立即 `render()`，保证操作跟手。`shutdown`/`destroy` 里要把 `renderQueued` 复位并把 `scene` 置空，避免场景重启后回调打到旧界面。

**第三步（可选）：把签名抽成纯函数。**

新建 `src/ui/menu-signature.ts`，导出 `menuPageSignature(page, session, uiState): string | undefined`，`StoryUI` 只负责调用。好处是不用起 Phaser 场景就能单元测试，也避免以后加页时又漏分支。

## 风险

- 签名漏字段 → 页面显示过期。缓解：不猜字段，只认版本号；面板本地的选中分组、详情展开、滚动位置**不进**签名——这些只在点击时变，而点击本来就直接重画。
- 排队后有一帧延迟。菜单本来就在等玩家操作，一帧延迟看不出来；`postupdate` 晚于本帧所有逻辑，反而避开了「战斗结算中途重排 UI」。

## 验证

- 单测（`tests/menu-signature.test.ts`，按 `tests/AGENTS.md` 的写法）：血量变化返回同一串，`questBook.version` 变化返回不同串，切页返回不同串。
- 手动：开任务页站在怪堆里 30 秒，看是否还一闪一闪。
- `?perf` 前后对比（见文末「怎么量」）。

---

# P2 重画必然重建滚动区（卡顿尖峰的主因）

## 证据

- `clear()` 第一件事就是销毁所有滚动区：`this.scrolls.splice(0).forEach(scroll=>scroll.destroy());` —— `src/ui/phaser/widgets.ts:103`。
- `scroll()` 每次都 `new ScrollArea(...)`，没有复用 —— `src/ui/phaser/widgets.ts:245`。
- `ScrollArea` 在 WebGL 下给图层开滤镜并挂一张遮罩：`this.layer.enableFilters()`、`this.layer.filters!.external.addMask(this.mask,false,scene.cameras.main,'world')` —— `src/ui/phaser/widgets.ts:297-298`。
- Phaser 侧每个遮罩占一张动态贴图：`textureManager.addDynamicTexture(UUID(), scaledWidth, scaledHeight, false)`（`node_modules/phaser/src/filters/Mask.js` 的 `updateDynamicTexture`）；遮罩重画的尺寸取渲染目标：`controller.updateDynamicTexture(drawingContext.width, drawingContext.height)`（`src/renderer/webgl/renderNodes/filters/FilterMask.js:65`）。
- 任务页每次重画都走一遍「销毁两张 → 分配两张 → 重画遮罩」——`src/ui/phaser/quest-panel.ts:61` 与 `:82`。

## 为什么慢

- 一张 1024×640 的 RGBA 贴图约 2.6 MB。销毁再分配不是零成本：GPU 纹理创建、首次使用时上传、滤镜管线重新绑定。这类开销不进 CPU 帧时间，却会让浏览器当场卡一下。
- 仓库里已经有相关的历史证据：`ScrollArea` 的注释提到全量渲染几千行会让 Safari 报 `Framebuffer Unsupported` 并丢 WebGL 上下文；诊断日志里也有 2 条 `webgl-context-lost`。
- 这条不随游玩时间增长（每次都是两张），所以它是「点一下就顿一下」的来源，不是「越玩越卡」的来源。P1 修好之后，它从「按通知次数触发」降到「按点击次数触发」，但尖峰还在。

## 方案

给 `UiSurface` 加一个**滚动区池**，只在任务页开启：

```ts
// src/ui/phaser/widgets.ts
private scrollPool:ScrollArea[]=[];
private reuseScrolls=false; // 默认关闭，其它页面保持旧语义

clear():void{
  this.sliders.splice(0).forEach(slider=>slider.destroy());
  this.scrolls.splice(0).forEach(scroll=>{
    if(this.reuseScrolls){scroll.content.removeAll(true);this.scrollPool.push(scroll);}
    else scroll.destroy();
  });
  this.buttons=[];this.focusIndex=-1;
  [...this.root.list].forEach(child=>{if(child!==this.staticRoot)child.destroy();});
}

scroll(x:number,y:number,width:number,height:number,bleed=0):ScrollArea{
  const index=this.scrolls.length;
  const reused=this.reuseScrolls?this.scrollPool[index]:undefined;
  const scroll=reused&&reused.matches(x,y,width,height,bleed)?reused:new ScrollArea(this,x,y,width,height,bleed);
  if(reused&&scroll!==reused)reused.destroy();
  this.scrolls.push(scroll);return scroll;
}
```

复用时要重置四样东西，缺一样就会点错或滚不动：

1. `content.removeAll(true)`（`clear()` 里已经做）。
2. `setHeight`（调用方每轮都会设，不用额外处理）。
3. `scrollTop`（`QuestPanel` 已有 `captureScroll()`/`listOffset`/`detailOffset`，照旧）。
4. `onScroll` 与 `guard` 回调（闭包指向上一轮的局部变量，必须在复用路径里重新赋值）。

`ScrollArea.matches(x,y,w,h,bleed)` 是新加的纯比较方法，几何一致才复用，否则销毁重建。

只在任务页开启：`StoryUI.renderQuests()` 之前把 `this.body.reuseScrolls=true`，其它页保持 `false`。

## 风险

- 复用带旧闭包 → 点击错行、滚动失效。缓解：只认「同序号 + 同几何」；每次复用都显式重设 `onScroll`/`guard`；先在任务页单独验证再考虑推广。
- 池里的滚动区会一直占着贴图（最多几张），属于「用一点内存换不卡」，可以接受。

## 验证

- 手动：点任务分组、滚动列表与详情、缩放窗口后滚动。
- `?perf` 看长帧数与 p95。
- Safari 上确认不再出现 `Framebuffer Unsupported`。

---

# P3 菜单开着时世界继续跑（会放大 P1，且是玩法决策）

## 证据

- 打开菜单只做了一件事：锁输入。`if(!this.open){this.open=true;this.app.ui.lock(true,'story-menu');}` —— `src/ui/story-ui.ts:220`。
- 世界每帧照常推进战斗：`this.combat?.update(stepDelta,this.canCombatControl);` —— `src/scenes/world-scene.ts:1847`。
- `canControl` 只影响玩家操作与移动，不拦战斗模拟：`src/scenes/world-scene.ts:1313`。

## 为什么慢

这不是性能问题本身，是**触发源**：只要世界在跑，掉血、拾取、任务推进就会持续发通知，P1 的重画就被持续触发。P1 修好后这条的性能代价基本消失，但「看背包时被怪打死」这条玩法还在。

## 方案

### 方案 A：菜单打开时冻结世界（推荐）

- 在 `GameUI` 上加一个菜单暂停标记（比 `locked` 精确：`locked` 还包含对白、演出、加载）。
- `StoryUI.show()` 置真、`close()` 置假。
- `WorldScene.update` 开头早退：`if(this.app.ui.menuPaused){this.syncHud();return;}`，同时跳过战斗、掉落推进、敌人 AI。
- 补 1–2 帧输入闸门，防止关菜单瞬间误触放技能（现有 `entryInputGate` 就是同类做法，`src/scenes/world-scene.ts:1787`）。
- 自动存档已经用 `locked` 挡了（`src/main.ts:139`），不用改。

代价：改玩法。原版这类菜单基本都暂停世界，改完更接近原版手感。

### 方案 B：保持世界运行

不改世界，只靠 P1 保证界面不因战斗重画。代价是保留「菜单里会被打」的设计，并且菜单里仍会掉血、仍会有提示类 UI 更新。

**这条需要你拍板。** P1 与 P2 不依赖这个选择。

---

# P4 每次界面状态变化都做一次全量布局（固定尖峰）

## 证据

- 状态变化的总出口：`ui.onStateChange = () => { configureCanvas(app.game); app.storyUI.sync(); worldScene()?.syncHud(); }` —— `src/main.ts:594`。
- `updateControls()` 被约 20 处调用（打开、关闭、锁、解锁、对白、选项、加载等）—— `src/ui/game-ui.ts:96`。
- `configureCanvas` 每次都先 `getBoundingClientRect()` —— `src/ui/viewport.ts`。
- `sync()` 末尾无条件 `this.layout()`，而 `renderNow()` 末尾又调 `this.sync()`（`src/ui/story-ui.ts:515`），所以**每次重画都附带一次全量布局**。
- `layout()` 里再读 4–5 次 `getBoundingClientRect()`（surface、shortcutScreen、hudButtons），每个滚动区一次 `getWorldTransformMatrix()` —— `src/ui/story-ui.ts:332-345`。

## 为什么慢

`getBoundingClientRect()` 是强制同步布局：浏览器必须先把待处理的样式算完才能回答。一次两次不疼，但它是「点一下、顿一下」的典型来源：菜单打开/翻页/锁解开，都会连带一串布局读取。

## 方案

1. 布局参数只在入口测一次，往下传：`{rect, safe, unit, scale}`，去掉 `UiSurface.layout`、`controlPlacement`、`hudButtons`、`shortcutScreen` 里重复的 `getBoundingClientRect()`。
2. 加一条布局短路键：

```ts
private layoutKey='';
private layout():void{
  if(!this.scene)return;
  const rect=this.scene.game.canvas.getBoundingClientRect(), safe=readSafeArea();
  const key=`${rect.width}x${rect.height}|${window.devicePixelRatio??1}|${safe.left},${safe.top},${safe.right},${safe.bottom}|${this.page}|${this.renderVersion}|${this.body?.scrolls.length??0}`;
  if(key===this.layoutKey)return;
  this.layoutKey=key;
  // …原来的布局工作
}
```

`renderVersion` 在 `renderNow()` 开头自增。这样：
- 重画之后必定重排（新滚动的滚动区需要定位）。
- 纯状态变化（锁/解锁、对白开合）尺寸没变就不重排。

3. 安全区版本号 `safeAreaRevision` 是 `src/ui/viewport.ts` 的模块私有变量，`readSafeArea()` 只返回四个数值。所以键里直接放这四个数（便宜，命中缓存时连 `getComputedStyle` 都不调用）。
4. 若担心手机地址栏收起等场景不触发 `resize`，可以在 `visualViewport` 的 `resize` 上补一次 `layoutKey=''`，强制重排一次。`src/ui/viewport.ts` 里已经有 `visualViewport` 的处理，照现有写法接即可。

## 风险

漏掉某个依赖会导致布局不更新（最典型是安全区变化）。缓解：安全区的四个数值都进了键；旋转和窗口变化走 `resize` 事件，进键的尺寸也会变。

## 验证

手动开关菜单、翻页、切换页签，观察是否还有顿感；`?perf` 对比「连点页签」那 30 秒。

---

# P5 每帧的固定小计算（顺手清，不是主因）

## 证据

- `syncHud()` 每帧拼一个模板串、写 6 次 `setVisible`、调 `nameBanner.sync`、比较目标签名 —— `src/scenes/world-scene.ts:1750`。
- `refreshShortcutPage()` 每帧 `map` 出 6 个新对象并拼签名 —— `src/scenes/world-scene.ts:883`；`ComputerSkillHud.setPage()` 再把同样 6 格 map 成一次签名字符串 —— `src/ui/phaser/computer-skill-hud.ts:71`。同一帧拼两遍。
- `syncInstantMessage()` 每帧写一条提示的文字、字号、位置、透明度 —— `src/scenes/formal-ui-scene.ts:84`。**注**：Phaser 的 `setText`（`Text.js:639`）与 `setFontSize`（`TextStyle.js:647`）都有相等短路，内容不变时不会重画面布，所以这条实际开销可以忽略，不用改。

## 方案

- `refreshShortcutPage()`：先用廉价输入（配置版本 + 背包 revision + 操控者 + 职业 + 当前页）拼一个键，键不变直接返回，连 `map` 都不做。
- `syncHud()`：把 6 个 `setVisible` 收成一个位掩码，与上一帧比较，只在变化时写。
- 可选：`setPage` 的签名改为由调用方传入，避免同一帧拼两遍同样的字符串。

## 验证

不需要单独测；改完跟着 `?perf` 一起看。收益是省电和减少 GC，不要指望它解决「越玩越卡」。

---

# P6 成员面板的点击区永远停在第一次的尺寸（正确性 bug）

## 证据

- 第一次创建时设一次命中区：`this.container.setInteractive(new Phaser.Geom.Rectangle(0,0,layout.width,layout.height), Phaser.Geom.Rectangle.Contains)` —— `src/ui/phaser/status-hud.ts:60`。
- 此后每次内容变化又来一次：`this.container.disableInteractive().setInteractive(new Phaser.Geom.Rectangle(0,0,layout.width,layout.height), …)` —— `src/ui/phaser/status-hud.ts:94`。
- Phaser 的语义：对象已经有 `input` 时，`enable()` 只把 `input.enabled` 置真，**新传的 hitArea 与回调被直接忽略** —— `node_modules/phaser/src/input/InputPlugin.js:930`；`disable()` 只关开关，不清 `input`（`InputPlugin.js:861`）。

## 为什么有 bug

新矩形被丢掉，命中区永远是最初那一次。窗口大小变了、布局重排了，成员面板的点击范围还是老的：点边角没反应，或者点到相邻控件上。

## 方案

删掉 94 行的重建，改成原地改矩形：

```ts
// 命中矩形是 Phaser 持有的同一个对象引用，原地改才会生效。
const area=this.container.input?.hitArea as Phaser.Geom.Rectangle|undefined;
area?.setTo(0,0,layout.width,layout.height);
```

阵亡分支的 `disableInteractive()` 保留，那是开关不是几何。

## 验证

诊断里读 `container.input.hitArea.width/height`，与 `layout` 尺寸比对；或手动在窗口缩放后点成员面板四个角。

---

# P7 按钮命中判断每次新建数组（输入侧的小浪费）

## 证据

`src/ui/phaser/widgets.ts:155`：

```ts
const hitTest=(area,px,py)=>this.enabled()&&this.root.visible&&Phaser.Geom.Rectangle.Contains(area,px,py)&&
  this.scrolls.filter(scroll=>scroll.content===parent).every(scroll=>scroll.contains(this.scene.input.activePointer));
```

每颗按钮、每次指针判定，都新建一个过滤数组。背包页一页上百颗按钮，鼠标一动就是上百次分配。

## 方案

- 建按钮时把「所属滚动区」算好存进按钮：`result.setData('clipScrolls', scrolls)`；命中时 `for` 循环遍历，零分配。
- 更省的做法：按钮落在滚动区里时，只查它自己那一个滚动区，不再 filter。

## 风险

几乎没有；注意 `parent` 是按钮的父容器，滚动区内容变化时要重设这个引用（配合 P2 的复用路径一起改）。

---

# P8 自动存档是同步写（跨范围，需要拍板）

这条不属菜单/HUD/输入，但它是「运行一段时间后卡一下」最像的周期性候选，所以单列。

## 证据

- 每 5 分钟一次：`DEFAULT_INTERVAL_MS = 300_000` —— `src/application/auto-save.ts:19`。
- 另外两类立即触发：任务接取/完成（`watchQuests`，`src/application/auto-save.ts:99`）、剧情事件完成（`director.onEventCompleted = () => autoSaver?.request()`，`src/main.ts:432`）。
- `flush()` 先全量抓快照再同步写 —— `src/application/auto-save.ts:64`；抓取入口是 `app.storyUI.captureSaveRecord()`（`src/main.ts:140`）。
- 写入是 `JSON.stringify(record)` + `localStorage.setItem`，两步都在主线程 —— `src/domain/save-game.ts:242`。

## 为什么慢

姊妹文档量过：后期一次完整快照 1.61 ms，存档约 280 KB；这两项都随探索地图数、背包件数增长。`localStorage.setItem` 本身还要把整串写进磁盘。每 5 分钟一顿、任务完成一顿，玩越久越重。

## 方案（三档，按代价排）

1. **最小改动**：把 `flush()` 挪到帧末——`scene.events.once('postrender')` 或 `requestIdleCallback` 里再写，避开当前帧。
2. **降低频率**：5 分钟改 10 分钟；给任务完成触发加最小间隔（`minGapMs` 已有，只需调大）。
3. **彻底方案**：序列化放 Web Worker，主线程只收字符串再落盘（需要把 `SaveSlots` 拆成「序列化」和「写入」两步）。工作量大，不建议现在做。

**需要你拍板**：P8 要不要纳入本次。

---

# 已确认不用改的两条

- **面板对象只置空不销毁**（`shopPanel`、`craftingPanel`、`forge`、`skillBook`，见 `src/ui/story-ui.ts:291`）：它们都画进共享的 surface，不持有自己的显示对象；唯一持有资源的 `PartyPanel` 立绘已经在 `close()` 里显式 `destroyPreview()`。不是泄漏，不用改。
- **`Hud` 的可见性登记表没有移除 API**（`src/rendering/hud.ts`）：全仓只有 8 处固定控件调用，不随实体增长，不用改。

---

# 建议的提交顺序

每一条独立提交，各自跑对应的单测与 `npm run typecheck`。

1. **P1**：签名 + 排队重画（`src/ui/story-ui.ts`，可选加 `src/ui/menu-signature.ts` 与 `tests/menu-signature.test.ts`）。收益最大、风险最低。
2. **P6**：成员面板命中区（`src/ui/phaser/status-hud.ts`）。一行级修复。
3. **P7**：按钮命中判断（`src/ui/phaser/widgets.ts`）。
4. **P4**：布局短路（`src/ui/story-ui.ts`、`src/ui/phaser/widgets.ts`）。
5. **P2**：滚动区池，只在任务页开启（`src/ui/phaser/widgets.ts`、`src/ui/phaser/quest-panel.ts`）。
6. **P5**：顺手清（`src/scenes/world-scene.ts`、`src/ui/phaser/computer-skill-hud.ts`）。
7. **P3**（拍板后）、**P8**（拍板后）。

# 需要拍板的两件事

1. **P3 选 A 还是 B**：菜单打开时冻结世界（改玩法，手感更接近原版），还是保持世界运行（保留被偷袭的真实感，只靠 P1 消掉性能代价）。
2. **P8 要不要纳入**：自动存档的同步写。

# 怎么量

- 地址后加 `?perf`，每 30 秒记一条帧统计（p50/p95/max、长帧数），上报到 `.diagnostics/client-errors.jsonl`。
- 两组对照：「站着不动 30 秒」与「开任务页挨打 30 秒」。前者是基线，后者是 P1 的靶子。
- 仓库现有日志里一条帧统计都没有，说明此前没量过。`4003` 是开发服务器，手机结论以 `4002` 或 APK 上的数据为准（姊妹文档也是这个口径）。
