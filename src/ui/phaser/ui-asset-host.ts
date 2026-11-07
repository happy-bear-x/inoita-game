import type Phaser from 'phaser';
import type { AssetLease } from '../../application/assets.ts';
import { loadUiImages } from './widgets.ts';

/**
 * 菜单图片的预载与释放。正式 UI 场景持有租约账，菜单预载通过 `app.uiAssets` 读取。
 */
export interface UiAssetHost {
  preloadFiles(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void>;
  releaseContent(): void;
}

/**
 * 把预载图片和立绘都记在同一个租约账上，`releaseContent` 一次全部释放。
 * 纹理的释放还绑在创建它的场景的 shutdown 上（见 `rendering/scene-assets.ts`）。
 */
export class SceneUiAssets implements UiAssetHost {
  private leases: AssetLease[] = [];
  private readonly scene: Phaser.Scene;
  constructor(scene: Phaser.Scene) { this.scene = scene; }

  async preloadFiles(files: string[], signal: AbortSignal, progress: (value: number) => void): Promise<void> {
    signal.throwIfAborted();
    const lease = await loadUiImages(this.scene, files, value => { if (!signal.aborted) progress(value); });
    if (signal.aborted) { lease.release(); signal.throwIfAborted(); }
    this.leases.push(lease);
  }

  /** 单张图（立绘）也走同一本账，和菜单图片一起释放。 */
  retain(lease: AssetLease): void { this.leases.push(lease); }

  releaseContent(): void { this.leases.splice(0).forEach(lease => lease.release()); }
}
