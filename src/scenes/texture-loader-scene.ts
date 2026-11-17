import Phaser from 'phaser';
import { SCENE_KEYS } from '../application/scene-keys.ts';
import { installTextureLoader } from '../rendering/scene-assets.ts';

/** 图片下载独立于地图和演出场景，只随游戏退出而结束。 */
export class TextureLoaderScene extends Phaser.Scene {
  constructor() { super({ key: SCENE_KEYS.textureLoader }); }
  create(): void {
    const detach = installTextureLoader(this);
    const close = () => {
      this.events.off('shutdown', close);
      this.events.off('destroy', close);
      detach();
    };
    this.events.once('shutdown', close);
    this.events.once('destroy', close);
  }
}
