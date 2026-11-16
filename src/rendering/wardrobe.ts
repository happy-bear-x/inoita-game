import type Phaser from 'phaser';
import type { ActorDefinition } from '../domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../domain/items.ts';
import type { CostumePose, WardrobeCatalog } from '../domain/wardrobe.ts';
import { OutfitPool, type Outfit, type WardrobePrepareOptions } from './outfit-pool.ts';

/** 场景只持有外观使用权；合成与缓存交给本次游戏共用的外观池。 */
export class Wardrobe {
  private readonly scene: Phaser.Scene;
  private readonly pool: OutfitPool;
  private readonly ownsPool: boolean;
  private readonly held = new Map<string, { outfit: Outfit; release(): void; preview?: boolean }>();
  private request = new AbortController();
  private active = true;
  private current?: Outfit;
  private readonly onShutdown = () => this.destroy();

  constructor(scene: Phaser.Scene, catalog: WardrobeCatalog, items: ItemCatalog,
    poseLoader?: (ids: readonly string[], signal: AbortSignal) => Promise<Record<string, CostumePose>>, pool?: OutfitPool) {
    this.scene = scene; this.ownsPool = !pool;
    this.pool = pool ?? new OutfitPool(scene, catalog, items, poseLoader);
    scene.events.once('shutdown', this.onShutdown);
  }
  activate(outfit: Outfit): void {
    if (this.current === outfit) return;
    if (this.current) this.current.users--;
    outfit.users++; this.current = outfit;
    // 预览外观只给菜单里的小人用，不跟着世界外观一起换掉。
    for (const [key, lease] of this.held)
      if (lease.outfit !== outfit && !lease.preview) { lease.release(); this.held.delete(key); }
  }
  async prepare(base: ActorDefinition, equipment: Partial<Record<EquipmentSlot, string>>, classId?: string,
    options?: WardrobePrepareOptions): Promise<Outfit> {
    if (!this.active || !this.pool.available) throw new DOMException('场景已关闭', 'AbortError');
    const request = this.request.signal, external = options?.signal, controller = new AbortController();
    const abort = () => controller.abort(request.aborted ? request.reason : external?.reason);
    request.addEventListener('abort', abort, { once: true }); external?.addEventListener('abort', abort, { once: true });
    if (request.aborted || external?.aborted) abort();
    const normalized = options?.clipNames === undefined ? options : { ...options, clipNames: [...options.clipNames] };
    let lease: { outfit: Outfit; release(): void } | undefined;
    try {
      const key = this.pool.key(base, equipment, classId, normalized);
      controller.signal.throwIfAborted();
      const ready = this.held.get(key);
      if (ready) return ready.outfit;
      // 一个成员只保留最新一套预览外观；世界外观的租约不受影响。
      if (options?.preview) this.dropPreviews();
      lease = await this.pool.acquire(base, equipment, classId, normalized, controller.signal);
      controller.signal.throwIfAborted();
      const existing = this.held.get(key);
      if (existing) { lease.release(); return existing.outfit; }
      // 并发准备时两份 preview 都在 await 前执行过 drop，这里再清一次，
      // 保证一个衣柜同时只留最新一套预览外观。
      if (options?.preview) this.dropPreviews(key);
      this.held.set(key, options?.preview ? { ...lease, preview: true } : lease);
      for (const [candidate, held] of this.held) {
        if (this.held.size <= 3) break;
        if (candidate !== key && held.outfit !== this.current && !held.preview) { held.release(); this.held.delete(candidate); }
      }
      return lease.outfit;
    } catch (error) { lease?.release(); throw error; }
    finally { request.removeEventListener('abort', abort); external?.removeEventListener('abort', abort); }
  }
  /** 菜单关闭或切换成员时归还预览外观；世界外观继续由 activate 管理。 */
  releasePreview(): void { this.dropPreviews(); }
  private dropPreviews(keepKey?: string): void {
    for (const [key, lease] of [...this.held]) {
      if (!lease.preview || key === keepKey) continue;
      lease.release(); this.held.delete(key);
    }
  }
  clear(): void {
    this.request.abort(new DOMException('人物外观生成已取消', 'AbortError')); this.request = new AbortController();
    if (this.current) this.current.users--; this.current = undefined;
    for (const lease of this.held.values()) lease.release(); this.held.clear();
    if (this.ownsPool) this.pool.clear();
  }
  destroy(): void {
    if (!this.active) return;
    this.active = false; this.scene.events.off('shutdown', this.onShutdown); this.clear();
    if (this.ownsPool) this.pool.destroy();
  }
}
