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
  // 安卓横屏时画面已经以可视区顶边为起点；顶部按画面边缘排布，左右仍避开挖孔与手势区。
  const android = typeof globalThis.InotiaNative !== 'undefined'
    || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent));
  if (android && globalThis.innerWidth > globalThis.innerHeight) value.top = 0;
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

/**
 * 画布位图相对 CSS 尺寸的渲染倍率上限。位图按设备像素比渲染时，每个 CSS 像素
 * 对应整数个位图像素，浏览器缩放到物理屏幕不再需要插值；倍率越高像素填充量按平方增长，
 * 2 倍已是 4 倍填充，再往上肉眼收益很小，留一档给低端机。
 */
export const MAX_RENDER_SCALE = 2;

/** 画布渲染倍率：取设备像素比并夹在 `[1, MAX_RENDER_SCALE]`，非整数 DPR 按原值使用。 */
export function renderScale(): number {
  const ratio=Number(globalThis.devicePixelRatio);
  return Math.min(MAX_RENDER_SCALE,Number.isFinite(ratio)&&ratio>0?Math.max(1,ratio):1);
}

/**
 * 画布位图按设备像素比渲染（上限 `MAX_RENDER_SCALE`），CSS 尺寸仍是可视区尺寸。
 * 地图镜头由 `worldZoom` 按这个比例补偿，界面按 `scale.width / CSS 宽` 换算，
 * 两处都跟着同一比值走，逻辑坐标（960×640 参考尺寸）不用改。
 */
export function configureCanvas(game:import('phaser').Game):void {
  const bounds=element('game-frame').getBoundingClientRect();
  const cssWidth=Math.max(1,Math.round(bounds.width)),cssHeight=Math.max(1,Math.round(bounds.height));
  const width=Math.round(cssWidth*renderScale()),height=Math.round(cssHeight*renderScale());
  const resized=game.scale.width!==width||game.scale.height!==height;
  if(resized)game.scale.resize(width,height);
  // Scale.NONE 在 zoom=1 时 resize 不更新 CSS 尺寸；新尺寸就绪后由 setZoom 同步。
  if(resized||game.scale.zoom!==1)game.scale.setZoom(1);
  // resize/setZoom 会把 canvas 的 CSS 尺寸写成位图尺寸，这里改回可视区尺寸：
  // 位图按倍率渲染，再由浏览器缩到 CSS 尺寸显示。
  const style=game.canvas.style,cssW=`${cssWidth}px`,cssH=`${cssHeight}px`;
  const restyled=style.width!==cssW||style.height!==cssH;
  if(restyled)Object.assign(style,{width:cssW,height:cssH});
  // 位图与 CSS 尺寸都落定后重算 displayScale（位图/CSS 比例），指针坐标换算依赖它。
  if(resized||restyled)game.scale.refresh();
  game.canvas.style.imageRendering='auto';
}
/**
 * 世界相对界面的倍率。逻辑尺寸 960×640（3:2）是本版按用户选择固定的，镜头倍率取 3；
 * 依据见 `work/findings/47_story_original_visuals.md`。正式地图、剧情舞台与动画调试共用。
 */
const WORLD_ZOOM_SCALE = 3;

/**
 * 地图镜头的缩放：世界倍率 × 画框内的等比缩放 × 画布位图与 CSS 像素的比例。
 * 位图按设备像素比渲染时比例为 2，镜头同步放大，视野大小不变；改动这里会整体改变地图视野。
 */
export function worldZoom(scene:import('phaser').Scene):number {
  const bounds=scene.game.canvas.getBoundingClientRect();
  const fit=Math.min(bounds.width/GAME_WIDTH,bounds.height/GAME_HEIGHT);
  return WORLD_ZOOM_SCALE*fit*scene.scale.width/Math.max(1,bounds.width);
}
