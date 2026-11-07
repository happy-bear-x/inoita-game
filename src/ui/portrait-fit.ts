/** 头像槽位的等比填充：先按“铺满框”缩放，再把多出来的边裁掉。 */
export interface PortraitSize { width: number; height: number }
export interface PortraitFit {
  scale: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const positive = (value: number): number => Math.max(1, value);

/**
 * 计算一张头像放进矩形框时的统一缩放与裁剪区域。
 * `anchorX`/`anchorY` 决定裁掉哪一侧：0 保留左上，0.5 居中，1 保留右下。
 * 裁剪区域的宽高比与框一致，缩放后正好铺满，不会把原图拉扁或拉长。
 */
export function portraitFit(source: PortraitSize, box: PortraitSize, anchorX = .5, anchorY = .5): PortraitFit {
  const sourceWidth = positive(source.width), sourceHeight = positive(source.height);
  const boxWidth = positive(box.width), boxHeight = positive(box.height);
  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const cropWidth = Math.min(sourceWidth, boxWidth / scale), cropHeight = Math.min(sourceHeight, boxHeight / scale);
  return {
    scale,
    cropX: (sourceWidth - cropWidth) * clamp01(anchorX),
    cropY: (sourceHeight - cropHeight) * clamp01(anchorY),
    cropWidth,
    cropHeight
  };
}
