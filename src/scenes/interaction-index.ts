import { FOOT_BOX_SIZE, NEAR_OBJECT_DISTANCE, SHOP_COUNTER_GAP } from '../domain/chests.ts';
import type { CollisionBox } from '../domain/content.ts';

/** 参与交互检索的角色所需的最小结构；场景里的人物体也满足它。 */
export interface InteractionIndexTarget {
  readonly container: { readonly x: number; readonly y: number };
  readonly actor: { readonly collision?: CollisionBox };
  readonly entity: { readonly flip?: boolean };
}

/**
 * 格子边长。原版近身搜索是脚底曼哈顿 24px，商店柜台再放宽到 32px；32px 一格时，
 * 常见目标的可交互包围盒只覆盖 2×2 到 3×3 格，查询只取玩家所在的一格。
 */
export const INTERACTION_CELL_SIZE = 32;

/** 玩家脚底框半宽；和 `domain/chests.ts` 的 bodyGap 共用同一个脚底框尺寸。 */
const PLAYER_FOOT_HALF = FOOT_BOX_SIZE / 2;
/** 最宽的贴身档：商店/旅店的柜台距离，索引按它给所有目标留缓冲。 */
const WIDEST_BODY_REACH = SHOP_COUNTER_GAP;
/** 原版 `PLAYER_DoCheckNearNPC` 的曼哈顿距离，和 `nearInteractable` 共用。 */
const NEAR_OBJECT_REACH = NEAR_OBJECT_DISTANCE;
const EMPTY: readonly never[] = [];

interface Bounds { left: number; right: number; top: number; bottom: number }

/**
 * 一个目标可能在哪些脚底位置被选中：曼哈顿 24px 的包围盒，加上目标碰撞盒向外
 * 扩出「玩家脚底半框 + 最宽柜台距离」。把这块区域涉及的格子都登记上，查询时
 * 只看玩家所在格，就不会漏掉大体积机关和隔柜台的商店。
 */
function interactionBounds(target: InteractionIndexTarget): Bounds {
  const x = target.container.x, y = target.container.y;
  let left = x - NEAR_OBJECT_REACH, right = x + NEAR_OBJECT_REACH;
  let top = y - NEAR_OBJECT_REACH, bottom = y + NEAR_OBJECT_REACH;
  const collision = target.actor.collision;
  if (collision) {
    const boxLeft = x + (target.entity.flip ? -collision.x - collision.width : collision.x);
    const boxTop = y + collision.y;
    const padding = PLAYER_FOOT_HALF + WIDEST_BODY_REACH;
    left = Math.min(left, boxLeft - padding);
    right = Math.max(right, boxLeft + collision.width + padding);
    top = Math.min(top, boxTop - padding);
    bottom = Math.max(bottom, boxTop + collision.height + padding);
  }
  return { left, right, top, bottom };
}

/**
 * 交互候选的空间索引（= 把角色按所在格子的名单分开放，查询只翻玩家那一格）。
 *
 * 桶里保留传入列表的顺序，所以同一格返回的候选就是原 `characters` 顺序；
 * 每个目标在每个格子只登记一次，查询一格不需要再去重。显隐、宝箱已开等状态
 * 仍由调用方逐项过滤，这里只负责缩小候选范围。
 */
export class InteractionTargetIndex<T extends InteractionIndexTarget> {
  /** 先按 X 格再按 Y 格分两层，查询不用拼字符串键。 */
  private readonly columns = new Map<number, Map<number, T[]>>();

  rebuild(entries: readonly T[]): void {
    this.columns.clear();
    for (const entry of entries) {
      const bounds = interactionBounds(entry);
      const minX = Math.floor(bounds.left / INTERACTION_CELL_SIZE);
      const maxX = Math.floor(bounds.right / INTERACTION_CELL_SIZE);
      const minY = Math.floor(bounds.top / INTERACTION_CELL_SIZE);
      const maxY = Math.floor(bounds.bottom / INTERACTION_CELL_SIZE);
      for (let cellX = minX; cellX <= maxX; cellX++) {
        let column = this.columns.get(cellX);
        if (!column) { column = new Map(); this.columns.set(cellX, column); }
        for (let cellY = minY; cellY <= maxY; cellY++) {
          const bucket = column.get(cellY);
          if (bucket) bucket.push(entry); else column.set(cellY, [entry]);
        }
      }
    }
  }

  /** 脚底位置可能选中哪些目标；未命中桶时返回共享空数组。 */
  near(x: number, y: number): readonly T[] {
    const column = this.columns.get(Math.floor(x / INTERACTION_CELL_SIZE));
    return column?.get(Math.floor(y / INTERACTION_CELL_SIZE)) ?? EMPTY;
  }
}
