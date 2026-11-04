/**
 * 伙伴衣柜的全局上限：每个衣柜都持有该成员合成后的动作纹理，按成员永久累积会随招募人数上涨。
 * 8 套覆盖当前选中、三名上阵队员和最近翻看的几名，够菜单来回切换，又不会无限增长。
 */
export const COMPANION_WARDROBE_LIMIT = 8;

interface CompanionWardrobeCacheEntry { destroy(): void }

interface CompanionWardrobeCacheOptions<K> {
  limit?: number;
  /** 当前选中、上阵或正在准备的成员不淘汰。 */
  keep: (id: K) => boolean;
  onEvict?: (id: K) => void;
}

/**
 * 取伙伴衣柜并按最近使用顺序维护全局上限。
 * `wardrobes` 的迭代顺序就是 LRU 顺序：每次取用把该成员移到末尾。
 * 超过上限时从最久未使用的开始销毁；`keep` 返回 true 的成员不会被淘汰。
 */
export function acquireCompanionWardrobe<K, V extends CompanionWardrobeCacheEntry>(
  wardrobes: Map<K, V>, id: K, create: () => V, options: CompanionWardrobeCacheOptions<K>
): V {
  let wardrobe = wardrobes.get(id);
  if (wardrobe) wardrobes.delete(id);
  else wardrobe = create();
  wardrobes.set(id, wardrobe);
  const limit = options.limit ?? COMPANION_WARDROBE_LIMIT;
  if (wardrobes.size > limit) {
    for (const [candidate, value] of wardrobes) {
      if (wardrobes.size <= limit) break;
      if (candidate === id || options.keep(candidate)) continue;
      value.destroy();
      wardrobes.delete(candidate);
      options.onEvict?.(candidate);
    }
  }
  return wardrobe;
}
