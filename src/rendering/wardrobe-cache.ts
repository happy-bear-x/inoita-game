/**
 * 伙伴衣柜的默认上限。世界场景按「上阵佣兵数 + 当前预览」传入更小的值，
 * 让缓存只保留正在用的成员；这个默认值只给没有上阵人数概念的调用方兜底。
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

/**
 * 主动清掉不再需要保留的衣柜。菜单关闭或离开队伍页时调用，
 * 只留下 `keep` 返回 true 的成员；被清掉的成员下次需要时重新合成。
 */
export function pruneCompanionWardrobes<K, V extends CompanionWardrobeCacheEntry>(
  wardrobes: Map<K, V>, keep: (id: K) => boolean, onEvict?: (id: K) => void
): void {
  for (const [id, wardrobe] of [...wardrobes]) {
    if (keep(id)) continue;
    wardrobe.destroy();
    wardrobes.delete(id);
    onEvict?.(id);
  }
}
