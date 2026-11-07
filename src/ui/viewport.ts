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
  // Android 壳隐藏系统栏并铺满整屏；横屏时顶部不会再压状态栏，顶部安全区不应再给
  // 小地图和右上角 HUD 留空。左右安全区继续保留，用来避开横屏时的挖孔和手势区。
  if (typeof globalThis.InotiaNative !== 'undefined' && globalThis.innerWidth > globalThis.innerHeight) value.top = 0;
  safeAreaCache = { revision: safeAreaRevision, value };
  return value;
}

/**
 * 按可视区摆放画布。`keepSize` 只跟随可视区的位置偏移，不按当前可视区重算尺寸：
 * 手机键盘弹出时可视区会变矮，但画布尺寸不能跟着缩，否则菜单会被重排；位置偏移
 * 仍要跟随，否则 iOS 为了露出输入框滚动可视区后，fixed 画布会整体上移。
 */
export function fitViewport(options?: { keepSize?: boolean }): void {
  const viewport = window.visualViewport;
  const frame = element('game-frame');
  Object.assign(frame.style, {
    left: `${viewport?.offsetLeft ?? 0}px`,
    top: `${viewport?.offsetTop ?? 0}px`
  });
  if (options?.keepSize) return;
  // 只有视口重建时安全区才可能变；布局每帧读取时直接复用这次测量。
  safeAreaRevision++;
  const width = Math.max(1, viewport?.width ?? innerWidth);
  const height = Math.max(1, viewport?.height ?? innerHeight);
  Object.assign(frame.style, { width: `${width}px`, height: `${height}px` });
}

/** 画布按 CSS 尺寸渲染，不按设备像素比放大；地图镜头同步换算，视野仍按参考尺寸展开。 */
export function configureCanvas(game:import('phaser').Game):void {
  const bounds=element('game-frame').getBoundingClientRect();
  const width=Math.round(bounds.width),height=Math.round(bounds.height);
  const resized=game.scale.width!==width||game.scale.height!==height;
  if(resized)game.scale.resize(width,height);
  // Scale.NONE 在 zoom=1 时 resize 不更新 CSS 尺寸；新尺寸就绪后由 setZoom 同步。
  if(resized||game.scale.zoom!==1)game.scale.setZoom(1);
  game.canvas.style.imageRendering='auto';
}
/**
 * 世界相对界面的倍率。逻辑尺寸 960×640（3:2）是本版按用户选择固定的，镜头倍率取 3；
 * 依据见 `work/findings/47_story_original_visuals.md`。正式地图、剧情舞台与动画调试共用。
 */
const WORLD_ZOOM_SCALE = 3;

/**
 * 地图镜头的缩放：世界倍率 × 画框内的等比缩放 × 画布像素与 CSS 像素的比例。
 * 画布按 CSS 尺寸渲染时比例为 1；改动这里会整体改变地图视野大小。
 */
export function worldZoom(scene:import('phaser').Scene):number {
  const bounds=scene.game.canvas.getBoundingClientRect();
  const fit=Math.min(bounds.width/GAME_WIDTH,bounds.height/GAME_HEIGHT);
  return WORLD_ZOOM_SCALE*fit*scene.scale.width/Math.max(1,bounds.width);
}
