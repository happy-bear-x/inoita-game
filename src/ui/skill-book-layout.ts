/**
 * 技能书页面的参考像素布局，原点取菜单内容区左上角（与强化台、合成台同一坐标系）。
 *
 * 左框放技能图标：4 列 × 4 行共 16 格，当前每个职业 15 个技能，一屏放得下且不用滚动。
 * 图标沿用技能目录页的 75×75 技能格、93×93 槽框与右下角等级数字，玩家在技能页见过的
 * 排列语言不再换一套。右框是所选技能的说明与「使用技能书」按钮。
 */
export const SKILL_BOOK = {
  leftFrame: { x: 10, y: 0, width: 462, height: 431 },
  rightFrame: { x: 496, y: 0, width: 395, height: 431 },
  header: { x: 40, y: 26, width: 400, size: 18 },
  grid: { x: 51, y: 54, size: 75, strideX: 96, strideY: 88, columns: 4, rows: 4 },
  /** 槽框和选中圈都比 75 的格子大，坐标相对格子左上角。 */
  slotFrame: { x: -9, y: -9, width: 93, height: 93 },
  selection: { x: -14, y: -14, width: 106, height: 102 },
  rank: { x: 57, y: 51, width: 24, height: 25 },
  rankDigit: { x: 63, y: 57, width: 10, height: 13 },
  /** 可用技能在格子左下角挂一枚技能书图标。 */
  bookBadge: { x: 2, y: 49, size: 24 },
  title: { x: 520, y: 28, width: 347, size: 24 },
  level: { x: 520, y: 60, width: 347, size: 18 },
  status: { x: 520, y: 86, width: 347, size: 16 },
  message: { x: 520, y: 108, width: 347, size: 16 },
  /** 说明用独立滚动区，底部按钮固定在它下面，长说明不会压住按钮。 */
  scroll: { x: 520, y: 134, width: 347, height: 196 },
  primary: { x: 520, y: 345, width: 168, height: 55 },
  secondary: { x: 700, y: 345, width: 100, height: 55 },
} as const;

/** 第 index 个技能格左上角；顺序与职业技能列表一致。 */
export function skillBookCell(index: number): { x: number; y: number } {
  const grid = SKILL_BOOK.grid;
  return {
    x: grid.x + (index % grid.columns) * grid.strideX,
    y: grid.y + Math.floor(index / grid.columns) * grid.strideY,
  };
}
