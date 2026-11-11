import type Phaser from 'phaser';
import type { ControlViewport } from '../control-layout.ts';
import { readSafeArea } from '../viewport.ts';

/** DOM 安全区以 CSS 像素提供，这里统一换成 Phaser 画布像素。 */
export function controlViewport(scene: Phaser.Scene, width = scene.scale.width, height = scene.scale.height): ControlViewport {
  const bounds = scene.game.canvas.getBoundingClientRect(), safe = readSafeArea();
  const unitX = width / Math.max(1, bounds.width), unitY = height / Math.max(1, bounds.height);
  return {width, height, insets: {left: safe.left * unitX, right: safe.right * unitX, top: safe.top * unitY, bottom: safe.bottom * unitY}};
}

/** DOM 控件直接写 CSS 坐标，布局视口也必须用画框的 CSS 尺寸。 */
export function controlViewportCss(scene: Phaser.Scene): ControlViewport {
  const bounds = scene.game.canvas.getBoundingClientRect();
  const safe = readSafeArea();
  return {
    width: bounds.width,
    height: bounds.height,
    insets: { left: safe.left, right: safe.right, top: safe.top, bottom: safe.bottom }
  };
}
