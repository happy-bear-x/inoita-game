import type { UiSurface } from './widgets.ts';

/** 面板声明弹层外框的参考尺寸，由菜单统一保存并在重绘、缩放时定位。 */
export type PlaceModal = (width:number, height:number) => void;

/**
 * 弹层画布按自己的内容尺寸在父画布里居中。宽度与高度是内容实际占用的外框，由各对话框按
 * 自己画的框给出——锚点因此不再依赖写死的坐标，改某个对话框的尺寸也不会让别的对话框跑偏。
 * 对话框都从框左上角开始画，所以移动画布就等于移动那个左上角。
 *
 * 此模块只计算坐标，通过类型导入避免布局计算依赖 DOM 环境。
 */
export function centerModal(modal: UiSurface, parent: UiSurface, width: number, height: number): void {
  const matrix = parent.root.getWorldTransformMatrix();
  const position = matrix.transformPoint((parent.width - width) / 2, (parent.height - height) / 2);
  modal.root.setPosition(position.x, position.y).setScale(matrix.scaleX, matrix.scaleY);
}

/**
 * 画布在 surface 本地坐标里覆盖的范围。surface 会按设备安全区和留白缩放、居中，
 * 直接按 `surface.width` 画的横带会在屏幕两侧留下空隙；需要铺满整屏时用这里的范围。
 * 原点取 surface 根节点的实际屏幕位置，安全区左右不相等时横带也不会偏出屏幕。
 */
export function screenCoverage(surface: UiSurface):{left:number;top:number;width:number;height:number} {
  const matrix = surface.root.getWorldTransformMatrix();
  const scaleX = matrix.scaleX || 1, scaleY = matrix.scaleY || 1;
  const origin = matrix.transformPoint(0, 0);
  // 按画布根节点的实际屏幕原点反算，菜单在安全区内居中时也不受左右安全区不对称影响。
  return {left:-origin.x / scaleX, top:-origin.y / scaleY,
    width:surface.scene.scale.width / scaleX, height:surface.scene.scale.height / scaleY};
}
