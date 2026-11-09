import type { GameRectangle, Point } from './navigation.ts';
import { PATH_GRID_SIZE } from './pathfinding.ts';
import { PathBudget } from './path-budget.ts';

/** 流场只读地图和内容机关；会移动的单位交给物理分离，避免同一张场因人群走动频繁失效。 */
export interface FlowFieldQuery {
  bounds: GameRectangle;
  canStand(position: Point): boolean;
}

export interface FlowRoute {
  /** 当前格朝目标环的下一格；已经在目标环或不可达时返回 undefined。 */
  next(from: Point): Point | undefined;
  /** 当前格到目标环的剩余路程（像素）；不可达时为 Infinity。 */
  distanceAt(from: Point): number;
}

export interface FlowSearch extends FlowRoute {
  step(maxExpanded: number): { status: 'pending' | 'complete'; expanded: number };
}

/** 多个单位追同一个目标时共享一张流场，避免每个单位各跑一次 A*。 */
export const FLOW_FIELD_BUDGET_PER_RENDER_FRAME = 192;

const DIAGONAL_COST = PATH_GRID_SIZE * Math.SQRT2;
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [0, -1], [-1, 0], [1, 0], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1],
];
const FIELD_SLICE = 64;
const FIELD_TTL_MS = 800;
const DEMAND_WINDOW_MS = 200;
const GOAL_BUCKET_PX = 16;
const MAX_FIELDS = 4;
const DEFAULT_SEED_RADIUS = 16;

/**
 * 从目标周围一圈可站格反向铺开距离场。
 * 单位只读自己格子里的方向，不再各自搜索；目标身体或人群挡住目标格时也不影响种子。
 */
export function createFlowField(goal: Point, query: FlowFieldQuery, seedRadius = DEFAULT_SEED_RADIUS): FlowSearch {
  const bounds = { ...query.bounds };
  const columns = Math.max(1, Math.floor(bounds.width / PATH_GRID_SIZE) + 1);
  const rows = Math.max(1, Math.floor(bounds.height / PATH_GRID_SIZE) + 1);
  const size = columns * rows;
  const distance = new Float32Array(size).fill(Infinity);
  const direction = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const standability = new Uint8Array(size);

  const cellPoint = (cell: number): Point => ({
    x: bounds.x + (cell % columns) * PATH_GRID_SIZE,
    y: bounds.y + Math.floor(cell / columns) * PATH_GRID_SIZE,
  });
  const cellOf = (point: Point): number => {
    const column = Math.round((point.x - bounds.x) / PATH_GRID_SIZE);
    const row = Math.round((point.y - bounds.y) / PATH_GRID_SIZE);
    return column < 0 || row < 0 || column >= columns || row >= rows ? -1 : row * columns + column;
  };
  const free = (cell: number): boolean => {
    const cached = standability[cell];
    if (cached) return cached === 1;
    const result = query.canStand(cellPoint(cell));
    standability[cell] = result ? 1 : 2;
    return result;
  };

  const heap: number[] = [];
  const compare = (first: number, second: number) => distance[first] - distance[second];
  const push = (cell: number): void => {
    heap.push(cell);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(heap[parent]!, cell) <= 0) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = cell;
  };
  const pop = (): number => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) < 0) child++;
        if (compare(last, heap[child]!) <= 0) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
    }
    return first;
  };

  // 目标格本身可能被目标身体或人群占住；从周围一圈可站格起铺，单位走进攻击距离就会停。
  const goalColumn = Math.round((goal.x - bounds.x) / PATH_GRID_SIZE);
  const goalRow = Math.round((goal.y - bounds.y) / PATH_GRID_SIZE);
  const reach = Math.ceil(seedRadius / PATH_GRID_SIZE) + 1;
  for (let row = Math.max(0, goalRow - reach); row <= Math.min(rows - 1, goalRow + reach); row++) {
    for (let column = Math.max(0, goalColumn - reach); column <= Math.min(columns - 1, goalColumn + reach); column++) {
      const cell = row * columns + column;
      if (!free(cell)) continue;
      const point = cellPoint(cell);
      if (Math.hypot(point.x - goal.x, point.y - goal.y) > seedRadius + PATH_GRID_SIZE) continue;
      if (Number.isFinite(distance[cell])) continue;
      distance[cell] = 0;
      push(cell);
    }
  }

  let complete = heap.length === 0;
  return {
    step(maxExpanded) {
      if (!Number.isSafeInteger(maxExpanded) || maxExpanded < 0) throw new RangeError('流场节点预算必须是非负整数');
      if (complete) return { status: 'complete', expanded: 0 };
      let expanded = 0;
      while (heap.length && expanded < maxExpanded) {
        const cell = pop();
        expanded++;
        if (closed[cell]) continue;
        closed[cell] = 1;
        const column = cell % columns;
        const row = Math.floor(cell / columns);
        for (const [dx, dy] of DIRECTIONS) {
          const nextColumn = column + dx;
          const nextRow = row + dy;
          if (nextColumn < 0 || nextRow < 0 || nextColumn >= columns || nextRow >= rows) continue;
          const next = nextRow * columns + nextColumn;
          if (!free(next)) continue;
          // 斜向不能从障碍角穿过，和 A* 的通行口径一致。
          if (dx && dy && (!free(row * columns + nextColumn) || !free(nextRow * columns + column))) continue;
          const cost = distance[cell]! + (dx && dy ? DIAGONAL_COST : PATH_GRID_SIZE);
          if (cost >= distance[next]!) continue;
          distance[next] = cost;
          direction[next] = cell;
          push(next);
        }
      }
      if (!heap.length) {
        complete = true;
        return { status: 'complete', expanded };
      }
      return { status: 'pending', expanded };
    },
    next(from) {
      const cell = cellOf(from);
      if (cell < 0) return undefined;
      const next = direction[cell]!;
      return next < 0 ? undefined : cellPoint(next);
    },
    distanceAt(from) {
      const cell = cellOf(from);
      return cell < 0 ? Infinity : distance[cell]!;
    },
  };
}

interface FieldEntry {
  search: FlowSearch;
  complete: boolean;
  lastUsed: number;
  goal: Point;
}

interface DemandEntry {
  count: number;
  lastRequest: number;
}

/**
 * 流场缓存：同一目标至少 3 个单位请求才建场，建完之前各单位继续走 A*。
 * 目标移动超过 16 像素或超过 800 毫秒没有请求就重算；最多同时保留 4 张场。
 */
export class FlowFieldStore {
  private readonly fields = new Map<string, FieldEntry>();
  private readonly demand = new Map<string, DemandEntry>();
  private readonly budget: PathBudget;

  constructor(perFrame = FLOW_FIELD_BUDGET_PER_RENDER_FRAME) {
    this.budget = new PathBudget(perFrame);
  }

  /** 每渲染帧调用一次；流场和单位寻路各用各的预算，避免互相饿死。 */
  reset(): void {
    this.budget.reset();
  }

  request(key: string, goal: Point, buildQuery: () => FlowFieldQuery, seedRadius: number, now: number, minDemand = 3): FlowRoute | undefined {
    const previous = this.demand.get(key);
    const active = previous && now - previous.lastRequest <= DEMAND_WINDOW_MS ? previous.count : 0;
    this.demand.set(key, { count: active + 1, lastRequest: now });

    let entry = this.fields.get(key);
    if (entry && (now - entry.lastUsed > FIELD_TTL_MS
      || Math.hypot(entry.goal.x - goal.x, entry.goal.y - goal.y) >= GOAL_BUCKET_PX)) {
      this.fields.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (active + 1 < minDemand) return undefined;
      entry = { search: createFlowField(goal, buildQuery(), seedRadius), complete: false, lastUsed: now, goal: { ...goal } };
      this.fields.set(key, entry);
      this.evict(now);
    }
    entry.lastUsed = now;
    if (!entry.complete) {
      const granted = this.budget.take(key, FIELD_SLICE);
      if (granted > 0) {
        const result = entry.search.step(granted);
        entry.complete = result.status === 'complete';
      }
    }
    return entry.complete ? entry.search : undefined;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.fields) if (now - entry.lastUsed > FIELD_TTL_MS) this.fields.delete(key);
    while (this.fields.size > MAX_FIELDS) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, entry] of this.fields) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.fields.delete(oldestKey);
    }
    for (const [key, entry] of this.demand) if (now - entry.lastRequest > DEMAND_WINDOW_MS) this.demand.delete(key);
  }
}
