import type Phaser from 'phaser';
import type { StoryInterface } from '../domain/story-interface.ts';
import type { CharacterVisual } from './characters.ts';
import type { PendingAsset } from './scene-assets.ts';

/** 头顶图标只用这三张小地图状态图；`locked` 和 `completed` 不挂标记。 */
const MARKER_STATUSES = ['available', 'active', 'ready'] as const;

/**
 * 三张图标随共享入口一次装好：任何一张地图上的人都可能挂标记，
 * 不能等到某个任务可接取时再请求图片。
 */
export function questMarkerAssets(storyInterface: StoryInterface): PendingAsset[] {
  return MARKER_STATUSES.map(status => {
    const file = storyInterface.assets[`minimap-${status}`];
    return { kind: 'image' as const, key: file, file };
  });
}

/**
 * 人物头顶的任务图标。
 *
 * 挂在人物容器下：坐标、镜头缩放、人物显隐和舞台遮挡都跟着容器走，
 * 不需要每帧把世界坐标换算成屏幕坐标。只有任务状态变化时才换图。
 */
export class QuestMarker {
  private readonly scene: Phaser.Scene;
  private readonly image: Phaser.GameObjects.Image;
  /** 当前贴图键；与内容里的文件名一致，重复设置同一张图时跳过。 */
  private file = '';

  constructor(scene: Phaser.Scene, character: CharacterVisual) {
    this.scene = scene;
    // 和小地图共用原版图标；中心停在脚点上方 50 像素，与进画布前的 DOM 版一致。
    this.image = scene.add.image(0, -50, '').setName('quest-marker').setVisible(false);
    character.container.add(this.image);
  }

  /** 传 undefined 表示这个角色现在不该挂标记；贴图缺失时同样保持隐藏。 */
  setFile(file: string | undefined): void {
    const key = file && this.scene.textures.exists(file) ? file : '';
    if (key !== this.file) {
      this.file = key;
      if (key) this.image.setTexture(key);
    }
    this.image.setVisible(key !== '');
  }

  destroy(): void {
    this.image.destroy();
  }
}
