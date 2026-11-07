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
 * 默认以 surface 自身为绘制外框；弹层按更大的虚拟外框居中时传 width、height。
 */
export function screenCoverage(surface: UiSurface, width = surface.width, height = surface.height):{left:number;top:number;width:number;height:number} {
  const scaleX = surface.root.scaleX || 1, scaleY = surface.root.scaleY || 1;
  const visibleWidth = surface.scene.scale.width / scaleX, visibleHeight = surface.scene.scale.height / scaleY;
  return {left:(width - visibleWidth) / 2, top:(height - visibleHeight) / 2, width:visibleWidth, height:visibleHeight};
}
