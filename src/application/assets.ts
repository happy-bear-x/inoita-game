export interface AssetLease { release(): void }
/** 资源使用者持有独立凭据；最后一个使用者离开时释放资源。 */
export class AssetPool {
  private users = new Map<string, number>();
  private readonly dispose: (key: string) => void;
  private readonly onAcquire: (key: string) => void;
  constructor(dispose: (key: string) => void, onAcquire: (key: string) => void = () => undefined) {
    this.dispose = dispose; this.onAcquire = onAcquire;
  }
  /** 当前仍持有该纹理的租约数；用于判断能否安全重建残帧纹理。 */
  holders(key: string): number { return this.users.get(key) ?? 0; }
  acquire(keys: Iterable<string>): AssetLease {
    const owned = new Set(keys);
    for (const key of owned) { this.onAcquire(key); this.users.set(key, (this.users.get(key) ?? 0) + 1); }
    let released = false;
    return {release: () => {
      if (released) return; released = true;
      for (const key of owned) {
        const count = this.users.get(key)! - 1;
        if (count) this.users.set(key,count); else {this.users.delete(key); this.dispose(key);}
      }
    }};
  }
}
