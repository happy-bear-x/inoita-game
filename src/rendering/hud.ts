import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';

/**
 * 每个游戏场景在共用界面场景里拥有一层控件空间；场景暂停、睡眠和唤醒时
 * 把显隐状态通知给 DOM 组件，并保持共用界面场景在最上层。
 */
export class Hud {
  readonly scene: Phaser.Scene;
  private readonly owner: Phaser.Scene;
  private readonly layer: Phaser.GameObjects.Layer;
  private readonly domListeners = new Set<(active: boolean) => void>();

  constructor(owner: Phaser.Scene) {
    this.owner = owner;
    this.scene = owner.scene.get(SCENE_KEYS.controlsUi);
    this.layer = this.scene.add.layer();
    for (const event of ['sleep', 'wake', 'pause', 'resume']) owner.events.on(event, this.refresh, this);
    this.scene.scene.bringToTop();
    if(owner.scene.manager.keys['formal-ui'])owner.scene.bringToTop('formal-ui');
  }
  private refresh(): void {
    for (const listener of this.domListeners) listener(this.owner.sys.isActive());
    if(this.owner.sys.isActive()){this.scene.scene.bringToTop();if(this.owner.scene.manager.keys['formal-ui'])this.owner.scene.bringToTop('formal-ui');}
  }
  layout(width: number, height: number): void {
    this.scene.cameras.main.setSize(width, height);
    this.refresh();
  }
  watchVisibility(listener: (active: boolean) => void): () => void {
    this.domListeners.add(listener);
    listener(this.owner.sys.isActive());
    return () => { this.domListeners.delete(listener); };
  }
  destroy(): void {
    for (const event of ['sleep', 'wake', 'pause', 'resume']) this.owner.events.off(event, this.refresh, this);
    for (const listener of this.domListeners) listener(false);
    this.domListeners.clear(); this.layer.destroy(true);
  }
}
