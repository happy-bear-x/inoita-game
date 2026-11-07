/**
 * 像素渲染的启动开关。默认值就是线上配置；URL 参数只用于真机 A/B。
 *
 * - `?smooth-pixel`：改用 Phaser 4 的平滑像素渲染，像素块保留、边缘抗锯齿。
 * - `?single-texture`：恢复 Phaser 在手机上一批只绑一张贴图的保守默认值。
 * - `?batch=4096`：恢复旧的每批容量，用来核对批容量的影响。
 */
export interface PixelRenderOptions {
  pixelArt: boolean;
  smoothPixelArt: boolean;
  roundPixels: boolean;
  autoMobileTextures: boolean;
  batchSize: number;
}

/** 默认每批容量。屏幕上的绘制对象远少于这个数，调大只影响顶点缓冲占用。 */
export const DEFAULT_BATCH_SIZE = 16384;
/** 旧版每批容量，保留给 A/B 对照。 */
export const LEGACY_BATCH_SIZE = 4096;

export function pixelRenderOptions(search: string): PixelRenderOptions {
  const params = new URLSearchParams(search);
  const smooth = params.has('smooth-pixel');
  return {
    pixelArt: !smooth,
    // 平滑像素渲染和最近邻像素渲染二选一；Phaser 里两者不能同时开。
    smoothPixelArt: smooth,
    // 官方像素指南不建议把最近邻的整数对齐和平滑像素渲染混用。
    roundPixels: !smooth,
    autoMobileTextures: params.has('single-texture'),
    batchSize: params.get('batch') === String(LEGACY_BATCH_SIZE) ? LEGACY_BATCH_SIZE : DEFAULT_BATCH_SIZE,
  };
}
