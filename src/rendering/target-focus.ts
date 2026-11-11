import Phaser from 'phaser';
import type { Point } from '../domain/navigation.ts';
import { PLAYER_RING_FILE, TARGET_RING_FILE } from './target-focus-assets.ts';
import { advanceFocusPulse, FOCUS_PULSE_FRAMES, focusRingScale } from './target-focus-pulse.ts';

/**
 * 角色脚下的选中圈。绿圈跟当前受控角色，红圈跟他的当前目标；
 * 换目标后的 17 个原版帧（30fps，约 567ms）按 80%..130% 缩放脉冲，之后常亮。
 */
export class TargetFocus {
  private readonly playerRing: Phaser.GameObjects.Image;
  private readonly targetRing: Phaser.GameObjects.Image;
  private targetId?: string;
  private pulseFrames = 0;

  constructor(scene: Phaser.Scene) {
    this.playerRing = scene.add.image(0, 0, PLAYER_RING_FILE).setOrigin(0.5).setVisible(false);
    this.targetRing = scene.add.image(0, 0, TARGET_RING_FILE).setOrigin(0.5).setVisible(false);
  }

  update(player: Point | undefined, target: Point | undefined,
    targetId: string | undefined, shown: boolean, deltaMs: number): void {
    this.place(this.playerRing, shown ? player : undefined, 1);
    if (targetId !== this.targetId) {
      this.targetId = targetId;
      this.pulseFrames = FOCUS_PULSE_FRAMES;
    }
    const visible = shown && target !== undefined;
    this.place(this.targetRing, visible ? target : undefined,
      this.pulseFrames > 0 ? focusRingScale(Math.ceil(this.pulseFrames)) : 1);
    if (visible) this.pulseFrames = advanceFocusPulse(this.pulseFrames, deltaMs);
  }

  destroy(): void {
    this.playerRing.destroy();
    this.targetRing.destroy();
  }

  private place(image: Phaser.GameObjects.Image, point: Point | undefined, scale: number): void {
    if (!point) {
      if (image.visible) image.setVisible(false);
      return;
    }
    if (!image.visible) image.setVisible(true);
    image.setPosition(point.x, point.y);
    if (image.scaleX !== scale) image.setScale(scale);
    const depth = point.y - 0.5;
    if (image.depth !== depth) image.setDepth(depth);
  }
}
