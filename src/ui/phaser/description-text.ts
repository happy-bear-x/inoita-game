import type Phaser from 'phaser';
import type { DescriptionTextPart } from '../../domain/description-text.ts';
import { layoutDescriptionText } from '../description-text-layout.ts';
import { DESCRIPTION_TEXT } from '../bag-layout.ts';
import type { MenuTextClip, MenuTextWriter } from '../dom/menu-text.ts';
import type { UiSurface } from './widgets.ts';

/** 一段说明的断行结果；行高和总高都由同一份 Phaser 测量结果算出。 */
export interface DescriptionTextLayout {
  lines: { runs: { text: string; color?: string; x: number }[] }[];
  lineHeight: number;
  /** 与 `UiSurface.text` 的正文高度同口径：最后一行下面不留行距。 */
  height: number;
}

/**
 * 用现有断行器算出每一行和每个色块的位置。
 *
 * 这里的 Phaser 文字只负责测量，创建后立刻销毁，不参与显示；DOM 和 Phaser
 * 两条绘制路径都读这一份结果，所以正文高度和按钮位置不会两边不一致。
 */
export function layoutDescriptionTextForSurface(view: UiSurface, parts: readonly DescriptionTextPart[],
  width: number, size: number): DescriptionTextLayout {
  if (!parts.length) return { lines: [], lineHeight: 0, height: 0 };
  const probe = view.text('测', 0, 0, 0, size, DESCRIPTION_TEXT);
  const lines = layoutDescriptionText(parts, width, text => probe.context.measureText(text).width);
  const lineHeight = probe.height + 5;
  probe.destroy();
  return { lines, lineHeight, height: Math.max(0, lines.length * lineHeight - 5) };
}

/** 原生 Text 负责绘字，返回排版后的实际高度供滚动区使用。 */
export function drawDescriptionText(view: UiSurface, parts: readonly DescriptionTextPart[], x: number, y: number,
  width: number, size: number, parent?: Phaser.GameObjects.Container): number {
  const layout = layoutDescriptionTextForSurface(view, parts, width, size);
  layout.lines.forEach((line, index) => {
    for (const run of line.runs) view.text(run.text, x + run.x, y + index * layout.lineHeight, 0, size,
      run.color ?? DESCRIPTION_TEXT, parent);
  });
  return layout.height;
}

/**
 * 把断行结果写成 DOM 文字。每个色块单独一条标签，横向位置和行高都沿用布局结果；
 * `clip` 用滚动视口的内容块坐标，滚动时由 `MenuTextLayer` 扣掉偏移后决定显隐。
 */
export function writeDescriptionText(writer: MenuTextWriter, keyPrefix: string, layout: DescriptionTextLayout,
  x: number, y: number, width: number, size: number, scroll?: string, clip?: MenuTextClip): void {
  layout.lines.forEach((line, lineIndex) => line.runs.forEach((run, runIndex) => {
    writer.add({
      key: `${keyPrefix}-${lineIndex}-${runIndex}`,
      text: run.text,
      x: x + run.x,
      y: y + lineIndex * layout.lineHeight,
      // 每个色块只占它在该行里的剩余宽度，避免浏览器量字略宽时越过面板右缘。
      style: { size, color: run.color ?? DESCRIPTION_TEXT, width: Math.max(1, width - run.x),
        lineHeight: layout.lineHeight, wrap: 'word' },
      scroll,
      clip
    });
  }));
}
