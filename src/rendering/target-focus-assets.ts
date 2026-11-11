import type { PendingAsset } from './scene-assets.ts';

export const PLAYER_RING_FILE = 'assets/ui/status/target-ring-player.png';
export const TARGET_RING_FILE = 'assets/ui/status/target-ring-target.png';

const image = (file: string): PendingAsset => ({ kind: 'image', key: file, file });

/** 脚下选中圈；两张小图随公共常驻包预载，换图和战斗结束都不释放。 */
export const targetFocusAssets: PendingAsset[] = [
  image(PLAYER_RING_FILE),
  image(TARGET_RING_FILE)
];
