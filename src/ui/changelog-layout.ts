/**
 * 标题页更新日志弹窗的几何与可视窗口。
 *
 * 弹窗画在标题页的 1024×640 弹层画布上，边框复用标题页的 `slot` 图；
 * 文字区在边框内缩一圈的不透明底上，按条目高度只输出屏幕内能看到的几条。
 */
export const CHANGELOG_LAYOUT = {
  /** 弹窗面板：在 1024×640 弹层画布里的外框。 */
  panel: { x: 82, y: 60, width: 860, height: 520 },
  /** 滚动文字区：离 24 像素图框再留一圈边距，文字不会压到边框。 */
  scroll: { x: 138, y: 140, width: 748, height: 392 },
  /** 右上角圆形关闭钮。 */
  close: { size: 67, right: 12, top: 10 },
  textSize: 24,
  /** 相邻两条更新日志之间的空档。 */
  entryGap: 26,
  /** 视口外多渲染的高度，滚动时不会出现整条空白。 */
  overscan: 320,
} as const;

export interface ChangelogMetrics {
  offsets: number[];
  total: number;
}

/** 根据每条正文的高度算累计起点和总内容高度；条目之间留空档，末尾不留。 */
export function changelogMetrics(heights: readonly number[], gap: number = CHANGELOG_LAYOUT.entryGap): ChangelogMetrics {
  const offsets: number[] = [];
  let total = 0;
  heights.forEach((height, index) => {
    offsets.push(total);
    total += Math.max(1, height);
    if (index < heights.length - 1) total += gap;
  });
  return { offsets, total };
}

/** 当前滚动位置下需要输出的条目范围（含视口外一层缓冲）。 */
export function changelogVisibleRange(offsets: readonly number[], heights: readonly number[],
  scrollTop: number, viewportHeight: number, overscan: number = CHANGELOG_LAYOUT.overscan): { first: number; last: number } {
  if (!heights.length) return { first: 0, last: -1 };
  const top = scrollTop - overscan, bottom = scrollTop + viewportHeight + overscan;
  let first = 0;
  while (first < heights.length && offsets[first]! + heights[first]! <= top) first++;
  let last = first - 1;
  for (let index = first; index < heights.length; index++) {
    if (offsets[index]! >= bottom) break;
    last = index;
  }
  return { first, last };
}
