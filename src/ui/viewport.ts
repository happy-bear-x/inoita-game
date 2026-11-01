function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少界面元素：${id}`);
  return node;
}

/** 世界与画布坐标的参考尺寸。 */
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 640;
/**
 * CSS 界面缩放用的参考尺寸，与 `GAME_WIDTH/GAME_HEIGHT` 是两套不同基准
 * （3:2 与 5:3），不要互相替换。界面元素按它换算后再落到屏幕上。
 */
export const UI_UNIT_WIDTH = 800;
export const UI_UNIT_HEIGHT = 480;

/** 界面单位到画布像素的倍率：侧边 HUD 按钮与电脑模式技能行等固定尺寸控件共用。 */
export function uiUnitScale(width: number, height: number): number {
  return Math.min(width / UI_UNIT_WIDTH, height / UI_UNIT_HEIGHT);
}

let safeAreaRevision = 0;
let safeAreaCache: { revision: number; value: { left: number; right: number; top: number; bottom: number } } | undefined;

/** 设备安全区，单位为屏幕 CSS 像素。界面换算后使用，画布仍铺满窗口。 */
export function readSafeArea(): { left: number; right: number; top: number; bottom: number } {
  const cached = safeAreaCache;
  if (cached?.revision === safeAreaRevision) return cached.value;
  const safe = getComputedStyle(element('safe-area'));
  const value = { left: parseFloat(safe.paddingLeft) || 0, right: parseFloat(safe.paddingRight) || 0,
    top: parseFloat(safe.paddingTop) || 0, bottom: parseFloat(safe.paddingBottom) || 0 };
  safeAreaCache = { revision: safeAreaRevision, value };
  return value;
}

/**
 * 主屏应用冷启动、手机已经是横屏时，`visualViewport` 和 `100lvh` 都可能少算
 * 一条安全区的高度（iPhone 上常见是 59 像素），页面底部就会露出一条黑边；
 * WebKit 之后不会自己纠正，只有旋转屏幕才重新测量。
 *
 * 根因是装了主屏、又带 `viewport-fit=cover` 的应用里，WebKit 的视口度量本身
 * 就不可靠，换哪个视口单位都一样错。主屏应用铺满整块屏幕，物理屏幕的尺寸才是
 * 可靠来源：用 `screen` 的宽高结合当前横竖方向还原整屏。普通浏览器有地址栏和
 * 工具栏，屏幕尺寸会超出可视区，继续用 `visualViewport`。
 */
function iosStandaloneApp(): boolean {
  if (!iosDevice()) return false;
  if ((navigator as Navigator & {standalone?: boolean}).standalone === true) return true;
  return typeof matchMedia === 'function'
    && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches);
}

/**
 * 这套按物理屏幕排版的逻辑只给 iOS：安卓和 WebView 的视口度量本来就是对的，
 * 装了 PWA 后系统状态栏和导航栏还会占走一部分，照屏幕尺寸铺满会盖住底部。
 * iPadOS 13 起 UA 伪装成 Mac，用触点数把它认回来。
 */
function iosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** 整块屏幕的 CSS 像素尺寸；拿不到物理屏幕尺寸时退回窗口尺寸。 */
function screenSize(): { width: number; height: number } {
  const screenWidth = typeof screen === 'undefined' ? 0 : screen.width;
  const screenHeight = typeof screen === 'undefined' ? 0 : screen.height;
  if (!(screenWidth > 0 && screenHeight > 0)) {
    return { width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) };
  }
  const long = Math.max(screenWidth, screenHeight), short = Math.min(screenWidth, screenHeight);
  return innerWidth >= innerHeight ? { width: long, height: short } : { width: short, height: long };
}
export function fitViewport(): void {
  // 只有视口重建时安全区才可能变；布局每帧读取时直接复用这次测量。
  safeAreaRevision++;
  const viewport = window.visualViewport;
  const { left, right, top, bottom } = readSafeArea();
  const frame = element('game-frame');
  let width: number, height: number;
  if (iosStandaloneApp()) {
    const size = screenSize();
    width = size.width;
    height = size.height;
    Object.assign(frame.style, { width: `${width}px`, height: `${height}px`, left: '0px', top: '0px' });
  } else {
    width = Math.max(1, viewport?.width ?? innerWidth);
    height = Math.max(1, viewport?.height ?? innerHeight);
    Object.assign(frame.style, {
      width: `${width}px`, height: `${height}px`,
      left: `${viewport?.offsetLeft ?? 0}px`,
      top: `${viewport?.offsetTop ?? 0}px`
    });
  }
  frame.style.setProperty('--story-unit', `${Math.min(width / UI_UNIT_WIDTH, height / UI_UNIT_HEIGHT)}px`);
  for (const [side, inset] of Object.entries({left, right, top, bottom})) {
    frame.style.setProperty(`--safe-${side}`, `${inset + 12}px`);
  }
}

/** 高清界面使用设备像素；地图镜头同步换算，视野仍按参考尺寸展开。 */
export function configureCanvas(game:import('phaser').Game):void {
  const bounds=element('game-frame').getBoundingClientRect();
  const density=Math.min(3,Math.max(1,window.devicePixelRatio||1));
  const width=Math.round(bounds.width*density),height=Math.round(bounds.height*density);
  const resized=game.scale.width!==width||game.scale.height!==height;
  if(resized)game.scale.resize(width,height);
  // Scale.NONE 在 zoom=1 时 resize 不更新 CSS 尺寸；新尺寸就绪后由 setZoom 同步。
  if(resized||game.scale.zoom!==1/density)game.scale.setZoom(1/density);
  game.canvas.style.imageRendering='auto';
}
/**
 * 世界相对界面的倍率。逻辑尺寸 960×640（3:2）是本版按用户选择固定的，镜头倍率取 3；
 * 依据见 `work/findings/47_story_original_visuals.md`。正式地图、剧情舞台与动画调试共用。
 */
const WORLD_ZOOM_SCALE = 3;

/**
 * 地图镜头的缩放：世界倍率 × 画框内的等比缩放 × 设备像素密度。
 * 后两项分别是 `fit` 与 `scene.scale.width / bounds.width`——画布按 density 放大过，
 * 见 `configureCanvas`。改动这里会整体改变地图视野大小。
 */
export function worldZoom(scene:import('phaser').Scene):number {
  const bounds=scene.game.canvas.getBoundingClientRect();
  const fit=Math.min(bounds.width/GAME_WIDTH,bounds.height/GAME_HEIGHT);
  return WORLD_ZOOM_SCALE*fit*scene.scale.width/Math.max(1,bounds.width);
}
