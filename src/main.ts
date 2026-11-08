// 必须最先执行：补齐旧版 Android WebView 缺少的浏览器 API，后面的模块才能正常加载。
import './application/browser-compat.ts';
import {prepareSavedGame} from './application/saved-game.ts';
import {SavedGameLoader} from './application/saved-game-loader.ts';
import {AutoSaver} from './application/auto-save.ts';
import {AUTO_SAVE_SLOT, type SaveSlotRef} from './domain/save-game.ts';
import { SCENE_KEYS } from './application/scene-keys.ts';
import { UI_EVENTS } from './application/ui-events.ts';
import {validateCrafting} from './domain/crafting.ts';
import type { GameMode } from './application/control-state.ts';
import { validateStoryPerformance } from './application/story-performance-validation.ts';
import { storyReferenceMaps, validateStoryReferences } from './application/story-reference-validation.ts';
import { ControlsScene } from './scenes/controls-scene.ts';
import Phaser from 'phaser';
import { StoryApp } from './app.ts';
import { trustedContentNow } from './application/content-trust.ts';
import type { Session } from './domain/session.ts';
import { newStorySession } from './domain/story-class.ts';
import { StoryClassScene } from './scenes/story-class-scene.ts';
import { StoryPresenter } from './rendering/story-presenter.ts';
import { OutfitPool } from './rendering/outfit-pool.ts';
import { StoryStageScene } from './scenes/story-stage-scene.ts';
import type { StoryWorldViewSnapshot } from './scenes/world-scene.ts';
import { StoryDirector } from './domain/story-director.ts';
import { FormalUiScene } from './scenes/formal-ui-scene.ts';
import { MenuScene } from './scenes/menu-scene.ts';
import { AudioScene } from './scenes/audio-scene.ts';

import { WorldScene } from './scenes/world-scene.ts';
import { GameUI, uiOcclusion } from './ui/game-ui.ts';
import { StoryUI } from './ui/story-ui.ts';
import { validateCharacterStats, validateMenuClasses, validateItemSkills, validateStoryItems, validateStoryPortraits, validateWardrobe, validateShops, validateCompanions } from './application/content-validation.ts';

import { GAME_HEIGHT, GAME_WIDTH, fitViewport, configureCanvas } from './ui/viewport.ts';
import { gameMenuImageGroups } from './application/menu-images.ts';
import { UI_ICON_ATLAS_FILE } from './generated/icon-atlas.ts';
import { MINIMAP_ASSETS } from './domain/story-interface.ts';
import { GAME_FRAME_TIMING, installFrameLimitClock } from './application/game-timing.ts';
import { displaySettings } from './application/display-settings.ts';
import { installGameDiagnostics, installStorySkipDiagnostics } from './application/game-diagnostics.ts';
import { storyDevMode } from './domain/dev-mode.ts';
import { createGmActions, consoleGmActions, type ConsoleGmActions } from './debug/gm-actions.ts';
import { IndexedDbDebugMarkStore } from './application/debug-mark-store.ts';
import { prepareDebugMark } from './application/debug-mark-preparation.ts';
import { persistentDebugWorld, prepareDebugWorld } from './application/debug-world.ts';
import { DomUi } from './ui/dom/dom-ui.ts';

declare global {
  /** GM 入口暴露出来的运行实例，浏览器测试用它检查状态。 */
  var storyApp: StoryApp | undefined;
  var render_game_to_text: (() => string) | undefined;
  /** GM 打开时才挂上的调试动作层，agent 经 CDP 驱动它（与游戏内面板同一份实现）。 */
  var gm: ConsoleGmActions | undefined;
}

/** 场景实例，浏览器测试和流程代码都按 `world` 这个键取它。 */
function worldScene(): WorldScene | undefined {
  return app.game?.scene.getScene(SCENE_KEYS.world) as WorldScene | undefined;
}
/**
 * 世界场景在启动切换与场景重启的空窗里不存在。下面两组接线的期望不同，用名字区分：
 *
 * - `requireWorldScene` 用于**玩家发起的操作**。静默丢掉会表现成「点了没反应」，
 *   而玩家已经把这次操作当成生效了，所以这里抛错。
 * - `worldScene()?.…` 用于**查询与可选表现**（预览、外观、镜头焦点）。没有世界场景时
 *   返回 undefined 是合法结果，静默跳过不算丢信息。
 */
function requireWorldScene(): WorldScene {
  const scene = worldScene();
  if (!scene) throw new Error('请等待地图加载');
  return scene;
}

fitViewport();
let layoutFrame = 0;
/**
 * 手机键盘弹出/收起会改变 visualViewport 的尺寸和偏移，但这不是游戏画布尺寸变化。
 * 文本输入框聚焦期间保持当前画布、面板和固定输入框的位置；失焦后的键盘收起事件
 * 会再次触发布局，届时才按恢复后的可视区重排。否则整个菜单会跟着输入框被顶上去。
 */
function editingText(): boolean {
  const active=document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    || (active instanceof HTMLElement && active.isContentEditable);
}
const scheduleLayout = () => {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    // 键盘弹出时可视区变矮：画布保持尺寸、只跟随位置偏移，菜单不会被重排。
    // 键盘收起（输入框已经失焦）后的下一次布局再按恢复后的可视区重算尺寸。
    fitViewport({ keepSize: editingText() });
    if(app.game)configureCanvas(app.game);
    app.game?.scale.getParentBounds();
    app.game?.scale.refresh();
    ui.resetInput();
    ui.reflowDialogue();
    domUi.layout();
  });
};
for (const event of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(event, scheduleLayout);
window.visualViewport?.addEventListener('resize', scheduleLayout);
window.visualViewport?.addEventListener('scroll', scheduleLayout);
const ui = new GameUI();
const app = new StoryApp(ui);
const domUi = new DomUi();
ui.onQuestPopup = kind => app.audio?.ui(kind === 'start' ? 'questStart' : 'questComplete');

const addressParams = new URLSearchParams(location.search);
/**
 * GM（调试）开关：持久值来自本地存储（标题页点击右下角版本号切换）。
 * `?gm` 只在**本次会话**打开，不写存储——否则谁试一次地址参数，就悄悄改了用户的机器。
 * GM 入口会暴露运行实例与控制台钩子：agent 用 `?gm` 一个参数就能读状态。
 */
const gmFromAddress = addressParams.has('gm');
const gmOn = (): boolean => gmFromAddress || app.gmMode.on;
// 生产构建信任构建期校验；?gm 或持久 GM 强制走完整校验。
app.content.trusted = trustedContentNow() && !gmOn();

const inspect = gmFromAddress;

let modeRequest = new AbortController();
/** 启动阶段上报：卡住时诊断日志里的最后一条就是现场。 */
function recordStartPhase(phase:string,details?:Record<string,unknown>):void{
  try{globalThis.storyDiagnostics?.record('start-phase',{phase,...details});}
  catch{/* 诊断不能影响启动 */}
}
const savedGameLoader=new SavedGameLoader();
/**
 * 自动存档：进图、剧情事件完成、任务接取/完成、定时四种时机合并写入唯一的自动槽。
 * 会话装上之后才创建，回到主菜单时停掉。
 */
let autoSaver:AutoSaver<StoryWorldViewSnapshot>|undefined;
let unsubscribeAutoSaveQuests:(()=>void)|undefined;
function stopAutoSave():void {
  unsubscribeAutoSaveQuests?.();unsubscribeAutoSaveQuests=undefined;
  autoSaver?.stop();autoSaver=undefined;
}
function startAutoSave(session:Session):void {
  stopAutoSave();
  const saver=new AutoSaver<StoryWorldViewSnapshot>({
    // 调试现场不写玩家存档：focus 存在时自动存档整个停掉，结束调试后由 GM 动作恢复。
    enabled:()=>app.mode==='game'&&!app.suspended&&!!app.session&&!app.session.debugFocusQuest&&!app.gm?.storyDebug().autoSavePaused,
    // 演出与菜单锁着时不抢写：等解锁后再写，免得存到一半的状态。
    locked:()=>app.locked||!!app.director?.busy,
    capture:()=>{const captured=app.storyUI.captureSaveRecord();return captured.ok?captured.record:undefined;},
    write:game=>app.saves.write(AUTO_SAVE_SLOT,game),
  });
  autoSaver=saver;
  unsubscribeAutoSaveQuests=saver.watchQuests(session);
  saver.start();
}
let storyPreparation: Promise<void> | undefined;
let storyPreparationSignal:AbortSignal|undefined;
interface MenuPreparation {
  signal: AbortSignal;
  progress: number;
  listeners: Set<(value: number) => void>;
  /** 菜单框架与立绘：开局前必须就绪。 */
  core: Promise<void>;
  /** 物品/技能图标：开局后后台补，不挡世界加载。 */
  all: Promise<void>;
}
let menuPreparation: MenuPreparation | undefined;
/** 当前模式对应的场景键。写成 `Record<GameMode, …>`：新增模式时必须在这里表态。 */
const MODE_SCENES:Record<GameMode,string>={menu:SCENE_KEYS.menu,'class-select':SCENE_KEYS.classSelect,game:SCENE_KEYS.world};
function currentScene(): Phaser.Scene | undefined {
  return app.game?.scene.getScene(MODE_SCENES[app.mode]);
}

function afterFirstPaint(work: () => void): void {
  requestAnimationFrame(() => setTimeout(work, 0));
}

function menuPreparationFor(signal: AbortSignal): MenuPreparation | undefined {
  let state = menuPreparation;
  if (!state || state.signal !== signal) {
    const host = app.uiAssets;
    if (!host) return undefined;
    const groups = gameMenuImageGroups(app.menuPanels, app.items, app.battleCatalog, app.storyInterface, app.shops);
    const extra = [...new Set([...groups.extra,
      ...Object.values(app.companions.groupSkills??{}).map(skill=>skill.icon)])];
    const next: MenuPreparation = { signal, progress: 0, listeners: new Set(), core: Promise.resolve(), all: Promise.resolve() };
    menuPreparation = next;
    recordStartPhase('menu-prepare-start',{core:groups.core.length,extra:extra.length});
    const report = (value: number, base: number, span: number) => {
      next.progress = base + value * span;
      for (const listener of next.listeners) listener(next.progress);
    };
    const fail = (error: unknown) => { if (menuPreparation === next) menuPreparation = undefined; throw error; };
    // 图标图集一次加载：物品/技能图标在世界 HUD 上就要用，不能被后台补图拖成空白。
    const coreFiles = [...groups.core, ...Object.values(app.controlSkin), UI_ICON_ATLAS_FILE];
    next.core = host.preloadFiles([...coreFiles,
      ...Object.values(app.statusHud.assets), ...Object.values(app.statusHud.buffIcons.catalog),
      ...MINIMAP_ASSETS.map(key => app.storyInterface.assets[key])], signal, value => report(value, 0, 0.6))
      .then(() => recordStartPhase('menu-core-loaded')).catch(fail);
    next.all = next.core.then(() => extra.length
      ? host.preloadFiles(extra, signal, value => report(value, 0.6, 0.4)).then(() => recordStartPhase('menu-extra-loaded'))
      : undefined).catch(fail);
    // 只等 core 的调用方不会观察 all；挂一个空处理，避免后台失败变成未处理拒绝。
    void next.all.catch(() => {});
    state = next;
  }
  return state;
}
function prepareMenuCore(signal: AbortSignal, onProgress?: (value: number) => void): Promise<void> {
  const state = menuPreparationFor(signal);
  if (!state) return Promise.reject(new Error('界面场景尚未就绪'));
  if (onProgress) {
    state.listeners.add(onProgress);
    onProgress(state.progress);
    const current = state;
    void current.core.finally(() => current.listeners.delete(onProgress)).catch(() => {});
  }
  return state.core;
}
/** 后台图标加载完时，已经打开的菜单要重画一次，否则首次打开会保留缺图占位。 */
function refreshMenuWhenReady(signal: AbortSignal): void {
  const state = menuPreparationFor(signal);
  if (!state) return;
  void state.all.then(() => app.storyUI?.refreshMenuAssets()).catch(error => {
    if (!signal.aborted) globalThis.storyDiagnostics?.record('menu-asset-error', { error });
  });
}

function clearMenuPreparations(): void {
  menuPreparation = undefined;
  app.uiAssets?.releaseContent();
}

function prepareStory(signal: AbortSignal): Promise<void> {
  if (app.campaign) return Promise.resolve();
  if (storyPreparation&&storyPreparationSignal===signal) return storyPreparation;
  const task = (async () => {
    recordStartPhase('story-fetch-start',{trusted:app.content.trusted,gm:gmOn()});
    const [world, campaign, presentation, battle, panels, items, wardrobe, statusHud, controlSkin, stats, shops, companions, crafting] = await Promise.all([
      app.content.world(signal), app.content.campaign(signal), app.content.storyInterface(signal), app.content.battle(signal),
      app.content.menuPanels(signal), app.content.items(signal), app.content.wardrobe(signal),
      app.content.statusHud(signal), app.content.controlSkin(signal), app.content.characterStats(signal), app.content.shops(signal), app.content.companions(signal), app.content.crafting(signal)
    ]);
    signal.throwIfAborted();
    recordStartPhase('story-fetched');
    // 调试现场表是独立产物：只有 GM 会话加载，普通游玩不请求 1.35MB 的调试数据。
    if (gmOn()) campaign.debugStory = await app.content.storyDebug(signal);
    signal.throwIfAborted();
    recordStartPhase('story-debug-ready');
    // 生产构建信任构建期校验：不重复跑语义校验，也不为校验 fetch 281 张剧情地图。
    // dev/测试/?gm 仍走完整路径。
    if (!app.content.trusted) {
      validateMenuClasses(panels, battle);
      validateWardrobe(wardrobe, items, battle);
      validateItemSkills(items, battle);
      validateCharacterStats(stats, items, battle);
      validateStoryItems(campaign, items);
      validateShops(shops, items, world);
      validateCrafting(crafting, items);
      validateCompanions(companions,world,battle,stats,campaign);
      const storyMaps = new Map(await Promise.all([...storyReferenceMaps(campaign)].map(async id => {
        const reference = world.maps.find(map => map.id === id);
        if (!reference) throw new Error(`剧情地图不存在：${id}`);
        return [id, await app.content.map(reference.file, signal)] as const;
      })));
      signal.throwIfAborted();
      validateStoryReferences(campaign, world, battle, storyMaps, items);
      validateStoryPerformance(world, campaign, storyMaps, app.audio?.catalog);
      validateStoryPortraits(world, presentation);
      app.content.releaseValidationCaches(wardrobe);
    }
    recordStartPhase('story-validated',{trusted:app.content.trusted});
    Object.assign(app, { world, campaign, storyInterface: presentation, battleCatalog: battle, characterStats: stats,
      menuPanels: panels, items, wardrobe, statusHud, controlSkin, shops, companions, crafting });
    recordStartPhase('story-assigned');
    // 商店装备表在进游戏前就开始取，走路到商人时通常已经就绪；首次打开不再等这一下。
    if(!Object.keys(app.shops.equipment).length){
      void app.content.shopEquipment(signal).then(equipment => { app.shops.equipment = equipment; }).catch(error => {
        if(!signal.aborted)globalThis.storyDiagnostics?.record('shop-equipment-warm-error',{error});
      });
    }
  })();
  storyPreparation = task;
  storyPreparationSignal=signal;
  void task.catch(() => { if (storyPreparation === task) storyPreparation = undefined; });
  return task;
}

async function enterGame(slot?:number): Promise<void> {
  if (app.mode !== 'menu' || app.suspended || !app.game?.scene.isActive('menu')) return;
  app.saveSlot=slot;
  modeRequest.abort(); modeRequest = new AbortController();
  const signal = modeRequest.signal;
  app.mode = 'class-select'; ui.setMode('class-select'); ui.loading('正在加载资源…');
  try {
    app.storyClasses = await app.content.storyClasses(signal);
    signal.throwIfAborted();
    const menu = app.game!.scene.getScene(SCENE_KEYS.menu);
    menu.scene.start(SCENE_KEYS.classSelect);
  } catch (error) {
    if(signal.aborted)return;
    console.error(error);
    ui.error(error instanceof Error ? error.message : String(error), () => {
      app.mode = 'menu'; void enterGame(slot);
    });
  }
}
function startStory(classId: string): void {
  if (app.mode !== 'class-select' || !ui.ready || app.suspended || !app.game?.scene.isActive('story-class-select')) return;
  const selected = app.storyClasses.classes.find(entry => entry.id === classId);
  if (!selected) return;
  void finishStoryStart(classId);
}
async function finishStoryStart(classId: string): Promise<void> {
  if (app.mode !== 'class-select' || !app.game?.scene.isActive('story-class-select')) return;
  const signal = modeRequest.signal;
  recordStartPhase('class-start',{classId,gm:gmOn(),trusted:app.content.trusted});
  ui.loading('正在开始游戏…');
  try {
    await prepareStory(signal);
    signal.throwIfAborted();
    recordStartPhase('story-ready');
    ui.loading('正在准备游戏菜单…', 0.15);
    await prepareMenuCore(signal, value => ui.loading('正在准备游戏菜单…', 0.15 + 0.35 * value));
    refreshMenuWhenReady(signal);
    signal.throwIfAborted();
    recordStartPhase('menu-ready');
  }
  catch (error) {
    if (signal.aborted) return;
    console.error(error);
    ui.error(error instanceof Error ? error.message : String(error), () => { void finishStoryStart(classId); });
    return;
  }
  const selected = app.storyClasses.classes.find(entry => entry.id === classId);
  if (!selected) return;
  const selection = currentScene()!;
  app.mode = 'game'; ui.setMode('game'); ui.loading('正在开始游戏…');
  const campaign = app.campaign;
  recordStartPhase('session-install-start');
  installSession(newStorySession(campaign, app.world.actors[campaign.start.actor], selected, app.items,app.characterStats,app.battleCatalog,app.companions));
  recordStartPhase('session-installed');
  selection.scene.start(SCENE_KEYS.world, { ...app.campaign.start, initialEntry: true });
  recordStartPhase('world-scene-start');
}

/** 标题与游戏内设置共用读档：准备失败保留入口，旧场景关闭后才替换会话。 */
async function resumeSlot(slot:SaveSlotRef,signal?:AbortSignal):Promise<void> {
  const game=app.game,sourceMode=app.mode,sourceScene=currentScene(),sourceSession=app.session,sourceLifetime=modeRequest;
  if(!game||(sourceMode!=='menu'&&sourceMode!=='game')||app.suspended||!ui.ready||savedGameLoader.busy||
    !sourceScene?.sys.isActive()||sourceMode==='game'&&worldScene()?.loadingWorld)return;
  const isCurrent=()=>modeRequest===sourceLifetime&&app.mode===sourceMode&&currentScene()===sourceScene&&app.session===sourceSession&&
    (sourceScene.sys.isActive()||sourceScene.sys.isPaused());
  try{
    await savedGameLoader.load(slot,{
      isCurrent,
      prepare:async(selectedSlot,request)=>{
        const reading=app.saves.inspect(selectedSlot);
        if(reading.kind!=='ok')throw new Error(reading.kind==='empty'?'没有可以载入的存档。':'游戏存档出错。无法正常进行游戏。');
        ui.loading('正在读取存档…');
        app.storyClasses=await app.content.storyClasses(request);request.throwIfAborted();
        await prepareStory(request);request.throwIfAborted();
        const candidate=prepareSavedGame(reading.game,app);
        await app.content.map(candidate.map.file,request);request.throwIfAborted();
        if(sourceMode==='menu'){
          ui.loading('正在准备游戏菜单…',0.15);
          await prepareMenuCore(request,value=>ui.loading('正在准备游戏菜单…',0.15+0.35*value));
          refreshMenuWhenReady(request);
        }
        request.throwIfAborted();return candidate;
      },
      stopCurrent:async()=>{
        stopAutoSave();app.gm?.dispose();modeRequest.abort();app.director?.dispose();app.clearMapPrefetch();app.clearStoryPrefetch();ui.resetInput();
        const stopped=new Promise<void>(resolve=>sourceScene.events.once(Phaser.Scenes.Events.SHUTDOWN,()=>resolve()));
        game.scene.stop(sourceScene.sys.settings.key);await stopped;
        app.releaseResidentCombat();
      },
      install:(candidate,lifetime)=>{
        modeRequest=lifetime;const {session,world}=candidate,location=world.location;
        app.mode='game';ui.setMode('game');ui.loading('正在读取存档…');
        installSession(session);
        // 自动槽不是玩家手动选择的槽，所以这里留空。
        app.saveSlot=slot===AUTO_SAVE_SLOT?undefined:slot;
        game.scene.start(SCENE_KEYS.world,{map:location.map,x:location.x,y:location.y,facing:location.facing,
          initialEntry:true,suppressEntry:true,resumeStory:true,signal:lifetime.signal,checkpoint:world.world,generatedEntities:world.generatedEntities,preparedScene:world.scene,
          onReady:()=>{if(!lifetime.signal.aborted&&world.audio)app.audio?.restoreStoryAudio(world.audio);}});
      },
    },signal);
  }catch(error){if(isCurrent())ui.loaded();throw error;}
}

/** 新开与读档共用的会话装配：世界场景、菜单、剧情播放器与界面都接到这份会话上。 */
function installSession(session: Session): void {
  stopAutoSave();app.gm?.dispose();app.director?.dispose();
  // 会话可能换了职业；旧常驻包、历史地图纹理和会话级内容解析结果都不再复用。
  app.releaseResidentCombat();
  app.clearMapHistory();
  app.content.clearSessionCaches();
  app.outfits?.destroy();
  app.outfits = new OutfitPool({ textures: app.game!.textures, anims: app.game!.anims, game: app.game! },
    app.wardrobe, app.items, (ids, signal) => app.content.wardrobePoses(ids, signal));
  const campaign = app.campaign, presentation = app.storyInterface;
  app.session = session;
  app.storySignal = modeRequest.signal;
  app.checkpoint.clear();
  app.changeEquipment=async(entry,slot,signal,memberId)=>requireWorldScene().changeEquipment(entry,slot,signal,memberId);
  app.equipmentAppearance=memberId=>worldScene()?.equipmentAppearance(memberId);
  app.equipmentPreview=memberId=>worldScene()?.equipmentPreview(memberId);
  app.preparePartyMember=async(id,signal,options)=>{const scene=worldScene();if(scene)await scene.preparePartyMember(id,signal,options);};
  app.releasePartyPreview=()=>worldScene()?.releasePartyPreview();
  // 属性页只在菜单重绘时读一次；菜单打开期间战斗已暂停，Buff 不会继续走。
  app.combatAttribute=(id,attribute,base,passives)=>worldScene()?.combatAttribute(id,attribute,base,passives)??base;
  app.combatStealthed=id=>worldScene()?.combatStealthed(id)??false;
  app.revivePartyMember=(id,item)=>requireWorldScene().revivePartyMember(id,item);
  ui.playerActor = campaign.start.actor;
  app.storyUI.bind(session, app.world, presentation);
  ui.questItemName = id => app.items.items[id]?.name ?? id;
  const presenter = new StoryPresenter(app, () => worldScene()!, () => app.game!.scene.getScene(SCENE_KEYS.storyStage) as StoryStageScene);
  const director = new StoryDirector(campaign, session, ui, locked => {
    if (app.director !== director) return;
    ui.lock(locked,'game');
    const scene = worldScene();
    if (locked && scene?.player) scene.setClip(scene.player, `idle-${scene.facing}`);
  }, presenter, {
    normalize: signal => worldScene()?.normalizeForStory(signal),
    capture: () => worldScene()?.captureStoryWorld(),
    restore: async (snapshot, signal) => { await worldScene()?.restoreStoryWorld(snapshot, signal); },
    project: async (stage, signal) => { await worldScene()?.projectStoryWorld(stage, signal); },
    checkpoint: () => worldScene()?.checkpointStoryWorld(),
    settle: () => worldScene()?.settleStoryPlayback(),
    prepare: async (_commands, signal, stage, script) => {
      const scene = worldScene();
      // 只预取内容里明确声明的跨地图演出：舞台自带地图、且不是当前世界地图。
      // 常规换图（travel）不预取，由目标图自己的入口加载。
      if (stage && !stage.mapFromWorld && stage.map !== scene?.map?.id) {
        presenter.prefetchMap(stage.map);
        void scene?.prefetchStoryEntry(stage.map, script, signal);
      }
      signal.throwIfAborted();
    },
    prefetch: async (scripts, signal) => { await worldScene()?.ensureStoryAssets(scripts, signal); },
  });
  app.director = director;
  if (storyDevMode() && location.port === '4003' && globalThis.storyDiagnostics) installStorySkipDiagnostics(director,
    (kind, details) => globalThis.storyDiagnostics?.record(kind, details, false));
  // 事件播完（世界投影已经结束）写入自动存档；节点中途不写。
  director.onEventCompleted = () => autoSaver?.request();
  director.onError = (error, retry) => {
    if (app.director !== director || app.mode !== 'game') return;
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const snapshot = worldScene()?.diagnosticSnapshot();
    globalThis.storyDiagnostics?.record('story-error', { message, stack: error instanceof Error ? error.stack : undefined,
      map: snapshot?.map, player: snapshot?.player });
    ui.error(message, () => {
      ui.loaded(); void retry().catch(next => director.onError?.(next, retry));
    });
  };
  // GM 动作层在会话装配好之后才建（它要 session 与 director）；开关关闭时**不建也不挂**，
  // 这样「默认关闭」是结构上的保证，而不是靠调用方自觉。
  app.gm = gmOn() ? createGmActions({
    session, campaign, director, markStore: new IndexedDbDebugMarkStore(),
    prepareMark: async (mark, signal) => { signal.throwIfAborted(); const prepared = prepareDebugMark(mark, app); signal.throwIfAborted(); return prepared; },
    status: () => runtimeDiagnostics(),
    onStoryPreparation: preparing => { if(preparing)app.ui.loading('正在准备剧情…');else app.ui.loaded(); },
    rescue: () => {
      const scene = worldScene();
      if (!scene) return { ok: false, reason: '不在游戏场景里' };
      return scene.rescuePlayer();
    },
    travel: async (map, position) => {
      const scene = worldScene();
      return scene ? scene.gmTravel(map, position) : { ok: false, reason: '不在游戏场景里' };
    },
    setNoclip: enabled => {
      app.gmNoclip = enabled;
      const scene = worldScene();
      if (scene) scene.setNoclip(enabled);
      return { ok: true };
    },
    isNoclip: () => app.gmNoclip,
    setSpeedMultiplier: multiplier => {
      app.gmSpeedMultiplier = multiplier;
      const scene = worldScene();
      if (scene) scene.setSpeedMultiplier(multiplier);
      return { ok: true };
    },
    getSpeedMultiplier: () => app.gmSpeedMultiplier ?? 1,
    persistence: {
      // 调试现场不写玩家存档：停掉待写与重试。
      suspend: () => autoSaver?.suspend(),
      // 结束调试：恢复自动存档、把当前现场记成检查点，再按正常节奏请求一次存档。
      resume: () => {
        autoSaver?.resume();
        worldScene()?.checkpointStoryWorld();
        autoSaver?.request();
      },
      // 回滚流程（死亡回检查点）接管调试现场：此刻画面还停在调试现场，只能恢复写入，不能记检查点。
      resumeAfterRollback: () => autoSaver?.resume(),
    },
    debugWorld: {
      capture: () => {
        try { return worldScene()?.captureStoryWorld(); }
        catch { return undefined; }
      },
      capturePersistent: () => { const scene = worldScene(); return scene ? persistentDebugWorld(scene.captureStoryWorld()) : undefined; },
      restore: async (snapshot, signal = modeRequest.signal) => {
        const scene = worldScene();
        if (!scene) return { ok: false, reason: '不在游戏场景里' };
        try {
          await scene.restoreStoryWorld(prepareDebugWorld(snapshot, app), signal);
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    onDebugStory: () => app.storyUI.openDebugStory(),
    ui: () => app.storyUI.diagnosticState(),
    combat: {
      setInvincible: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setInvincible(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      // 开关存在会话上，换图重建战斗后仍然有效，所以读取不必经过场景。
      isInvincible: id => session.isInvincible(id),
      setOneHitKill: (id, enabled) => {
        const scene = worldScene();
        return scene ? scene.setOneHitKill(id, enabled) : { ok: false, reason: '不在游戏场景里' };
      },
      isOneHitKill: id => session.isOneHitKill(id),
      revive: id => {
        const scene = worldScene();
        return scene ? scene.reviveMember(id) : { ok: false, reason: '不在游戏场景里' };
      },
    },
  }) : undefined;
  if (app.gm) globalThis.gm = consoleGmActions(app.gm); else delete globalThis.gm;
  app.audio?.enterStory();
  // 会话装好之后再开自动存档：它要绑定这一份会话的任务状态。
  startAutoSave(session);
}

function returnToMenu(): void {
  if (!ui.canReturn) return;
  if (app.mode === 'game' && worldScene()?.loadingWorld && !ui.failed) return;
  const returnPage=app.mode==='class-select'?'slots':'home';
  const departedSession = app.session;
  savedGameLoader.cancel();stopAutoSave();app.gm?.dispose();modeRequest.abort();modeRequest=new AbortController();clearMenuPreparations(); app.director?.dispose(); app.clearMapPrefetch(); app.clearStoryPrefetch(); ui.resetInput();
  // 会话已经销毁：把动作层一起摘掉，免得 agent 拿到一个指向已 dispose 导演的句柄。
  app.gm = undefined; delete globalThis.gm;
  const scene = currentScene();
  const releaseSessionAssets = () => { app.releaseSession(departedSession); };
  const stage = app.game?.scene.getScene(SCENE_KEYS.storyStage);
  if (stage && (stage.sys.isActive() || stage.sys.isPaused() || stage.sys.isSleeping())) app.game!.scene.stop(SCENE_KEYS.storyStage);
  if (scene?.sys.isActive() || scene?.sys.isPaused()) {
    // 场景还活着时不能提前删纹理；等 WorldScene/当前场景真正 shutdown 后再释放。
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, releaseSessionAssets);
    scene.scene.start(SCENE_KEYS.menu,{page:returnPage});
  } else releaseSessionAssets();
  // 初始内容请求失败时菜单场景仍在运行。
  app.mode = 'menu'; ui.lock(false,'game'); ui.setMode('menu');
  app.audio?.enterMenu();
}
/**
 * 人、面板、上报与 CDP 共用的一份运行态。卡住时按「锁 → 场景 → 战斗 → 移动体」的顺序看：
 * `lockOwners` 说明谁按住了操作，`world.player.inWall` 说明身体是否嵌进墙，
 * `world.combat` 说明技能/暂停/状态是否还挂着。
 */
function runtimeDiagnostics(): Record<string, unknown> {
  const session = app.session, party = session?.party;
  return {
    mode: app.mode, ready: ui.ready, locked: ui.locked, lockOwners: ui.lockOwners,
    suspended: ui.suspended, defeatOpen: ui.defeatOpen, menuOpen: app.storyUI?.menuOpen ?? false,
    dialogue: !!ui.dialogueState, choice: !!ui.choices, questPopup: !!ui.quest,
    editingControls: ui.controlLayoutEditing, editingKeys: ui.keyBindingEditing, loading: ui.loadingState?.label,
    location: session?.storyWorld.currentLocation,
    player: session?.player, combatTick: session?.combatTick,
    session: session ? {
      nowMs: session.nowMs, combatTick: session.combatTick, money: session.money,
      partyItemChance: session.partyItemChance, currentQuest: session.currentQuest()?.id ?? null,
      debugFocusQuest: session.debugFocusQuest ?? null, bagEntries: session.bag.entries.length,
      party: party ? { controlled: party.controlledId, active: party.activeIds,
        reserves: party.snapshot().reserves, rosterSlots: party.snapshot().rosterSlots } : null,
    } : null,
    audio: app.audio ? { ...app.audio.captureStoryAudio(), settings: app.audio.settings } : null,
    world: worldScene()?.diagnosticSnapshot(),
    story: app.director ? { busy: app.director.busy,
      runs: app.director.runtime.snapshot().runs.filter(run => run.status !== 'completed')
        .map(run => ({ event: run.eventId, cursor: run.cursor, status: run.status, encounter: run.waiting?.encounter })) } : null,
  };
}
function boot(): void {
  app.domUi = domUi;
  domUi.attach();
  domUi.setOccluded(uiOcclusion(ui));
  document.fonts?.ready.then(() => domUi.layout()).catch(() => {});
  app.enterGame = enterGame; app.returnToMenu = returnToMenu; app.startStory = startStory;
  app.resumeSlot = resumeSlot;
  app.captureSaveWorld = () => app.gm?.storyDebug().autoSavePaused ? {ok:false,reason:'debug'} : worldScene()?.captureSaveWorld() ?? {ok:false,reason:'not-ready'};
  app.autoSave = () => autoSaver?.request();
  app.captureControlPreview = () => worldScene()?.getControlLayoutPreview()??[];
  app.prefetchStory = () => afterFirstPaint(() => {
    if (modeRequest.signal.aborted || app.mode !== 'class-select') return;
    const signal = modeRequest.signal;
    void prepareStory(signal).then(() => prepareMenuCore(signal)).catch(() => {});
  });
  app.rescuePlayer = () => {
    const scene = worldScene();
    return scene ? scene.rescuePlayer() : { ok: false, reason: '不在游戏场景里' };
  };
  app.storyUI = new StoryUI(app);
  app.openCrafting=actorId=>app.storyUI.openCrafting(actorId);
  app.openShop=(shopId,mapId)=>app.storyUI.openShop(shopId,mapId);
  ui.onStateChange = () => { if(app.game)configureCanvas(app.game); app.storyUI.sync(); worldScene()?.syncHud(); domUi.setOccluded(uiOcclusion(ui)); };
  ui.onMenu = returnToMenu;
  ui.onResetInput = () => { worldScene()?.resetInput(); };
  const game = new Phaser.Game({
    type: Phaser.AUTO, parent: 'game', backgroundColor: '#101d24',
    pixelArt: true, roundPixels: true,
    fps: { ...GAME_FRAME_TIMING, limit: displaySettings.frameRateLimit },
    callbacks: { postBoot: game => {
      const restoreClock = installFrameLimitClock(game.loop);
      game.events.once(Phaser.Core.Events.DESTROY, restoreClock);
    } },
    scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.CENTER_BOTH, width: GAME_WIDTH, height: GAME_HEIGHT },
    render: { powerPreference: 'high-performance', batchSize: 16384, autoMobileTextures: false },
    input: { activePointers: 3, keyboard: true }, loader: { maxParallelDownloads: 6, timeout: 15000, maxRetries: 1 },
    scene: [], banner: false, audio: { disableWebAudio: false }
  });
  app.game = game;
  const unsubscribeFrameRate = displaySettings.subscribeFrameRateLimit(limit => game.loop.setFPSLimit(limit));
  game.events.once(Phaser.Core.Events.DESTROY, unsubscribeFrameRate);
  installGameDiagnostics(game, runtimeDiagnostics);
  game.events.once('ready', () => {
    configureCanvas(game);
    // iOS 弹出系统键盘会让窗口短暂失焦。Phaser 把这次失焦当成页面切走：暂停游戏
    // 循环并挂起音频，键盘收起后不一定恢复。输入框聚焦期间的失焦交给输入框自己
    // 处理；真正的页面切走仍由 lifecycle 的 visibilitychange 驱动。ready 先于
    // Phaser 注册 window.onblur，等启动流程走完再接管。
    window.setTimeout(() => {
      game.sound.pauseOnBlur = false;
      window.onblur = () => { if (!editingText()) game.events.emit(Phaser.Core.Events.BLUR); };
      window.onfocus = () => game.events.emit(Phaser.Core.Events.FOCUS);
      const sound = game.sound as Phaser.Sound.WebAudioSoundManager;
      // 系统键盘或来电可能让音频上下文停住；用户下一次触摸或页面回焦时补一次恢复。
      const resumeAudio = () => {
        if (sound.context && !sound.locked && sound.context.state !== 'running') void sound.context.resume();
      };
      window.addEventListener('pointerdown', resumeAudio, { capture: true });
      window.addEventListener('focus', resumeAudio);
    }, 0);
    game.events.on(UI_EVENTS.select,()=>app.audio?.ui('select'));
    game.scene.add(SCENE_KEYS.audio, new AudioScene(app), true);
    game.scene.add(SCENE_KEYS.controlsUi, new ControlsScene(), true);
    game.scene.add(SCENE_KEYS.world, new WorldScene(app), false);
    game.scene.add(SCENE_KEYS.storyStage, new StoryStageScene(app), false);
    game.scene.add(SCENE_KEYS.classSelect, new StoryClassScene(app), false);
    game.scene.add(SCENE_KEYS.menu, new MenuScene(app), true);
    game.scene.add(SCENE_KEYS.formalUi,new FormalUiScene(app),true);
    lifecycle();
  });
  if (inspect) {
    globalThis.storyApp = app;
    globalThis.render_game_to_text = () => {
      // GM 打开时返回与面板、上报同一份摘要：agent 读到的就是人看到的。
      if (app.gm) return JSON.stringify({ ...app.gm.digest(), coordinates: 'map pixels; x right, y down; player position is foot anchor' });
      const scene = app.mode === 'game' ? worldScene() : undefined;
      return JSON.stringify({ mode: app.mode, ready: ui.ready, suspended: app.suspended,
        coordinates: 'map pixels; x right, y down; player position is foot anchor',
        player: scene?.player ? { x: scene.player.container.x, y: scene.player.container.y, clip: scene.player.clipName } : null });
    };
  }
}
function lifecycle(): void {
  const portrait = window.matchMedia('(orientation: portrait)');
  const setSuspended = (suspended: boolean): void => {
    ui.suspend(suspended);
    const scene = currentScene();
    // 同一帧内的 pagehide/pageshow 也按事件顺序排队，避免漏掉恢复。
    if (scene?.sys?.isActive() || scene?.sys?.isPaused()) {
      if (suspended) scene.scene.pause(); else scene.scene.resume();
    }
    const stage = app.game?.scene.getScene(SCENE_KEYS.storyStage);
    if (stage?.sys.isActive() || stage?.sys.isPaused()) {
      if (suspended) stage.scene.pause(); else stage.scene.resume();
    }
    if (suspended) app.game?.sound.pauseAll(); else app.game?.sound.resumeAll();
  };
  const sync = (): void => {
    // WebKit 可能在保留的 MediaQueryList 之前就更新了视口尺寸。
    const suspended = document.hidden || window.innerHeight > window.innerWidth;
    // 进入后台或竖屏前先同步落一次自动存档，避免进程被系统回收时丢掉最近的进度。
    if(suspended&&!app.suspended)autoSaver?.flushForBackground();
    setSuspended(suspended);
  };
  app.syncLifecycle = sync;
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', () => { sync(); requestAnimationFrame(sync); });
  window.visualViewport?.addEventListener('resize', sync);
  portrait.addEventListener('change', sync);
  window.addEventListener('blur', () => ui.resetInput());
  window.addEventListener('pagehide', () => setSuspended(true));
  window.addEventListener('pageshow', sync);
  document.addEventListener('pointerdown', () => { app.game?.sound.unlock?.(); }, { once: true });
  sync();
}
boot();
