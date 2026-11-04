import type { Point } from './navigation.ts';

/** 主角走过的路径点间距；越密越贴近真实路线，越疏越省内存。 */
const PARTY_TRAIL_SPACING_PX = 8;
/** 最多保留的路径点数；按 8 像素一个点，约覆盖身后 512 像素。 */
export const PARTY_TRAIL_MAX_POINTS = 64;
/**
 * 窄路回退时，佣兵追的是主角身后多远的位置。
 * 太近会和主角挤在一起，太远会看起来像在拖队。
 */
export const PARTY_TRAIL_OFFSETS_PX: readonly number[] = [24, 32, 40, 48, 56];

/**
 * 主角最近走过的路径。点按“最新在前”保存，`pointBehind()` 从最新点往回量距离。
 *
 * 这是一份纯粹的路线记录，不做寻路、不碰场景；切图、读档、传送或主角瞬移时由宿主
 * 调用 `reset()`，避免把一段瞬移当成可以跟着走的路。
 */
export class PartyTrail {
  private points: Point[] = [];
  private readonly spacingPx: number;
  private readonly maxPoints: number;

  constructor(spacingPx = PARTY_TRAIL_SPACING_PX, maxPoints = PARTY_TRAIL_MAX_POINTS) {
    this.spacingPx = spacingPx;
    this.maxPoints = maxPoints;
  }

  reset(point?: Point): void {
    this.points = point ? [{ ...point }] : [];
  }

  /** 记录主角当前位置；不足一个间距时不新建点。一次跨得太远视为传送，直接重置。 */
  record(point: Point): void {
    const newest = this.points[0];
    if (!newest) {
      this.points.unshift({ ...point });
      return;
    }
    const dx = point.x - newest.x, dy = point.y - newest.y;
    const distance = Math.hypot(dx, dy);
    if (distance < this.spacingPx) return;
    if (distance > this.spacingPx * this.maxPoints) {
      this.reset(point);
      return;
    }
    // 一帧走出多个间距时补齐中间点，避免路径跳空后佣兵直接抄近路穿墙。
    const steps = Math.floor(distance / this.spacingPx);
    for (let step = 1; step <= steps; step++) {
      const ratio = step * this.spacingPx / distance;
      if (ratio >= 1) break;
      this.points.unshift({ x: newest.x + dx * ratio, y: newest.y + dy * ratio });
    }
    this.points.unshift({ ...point });
    if (this.points.length > this.maxPoints) this.points.length = this.maxPoints;
  }

  /** 沿路径从最新点往回走 `distance` 像素，返回插值后的点；路径不够长时返回最旧点。 */
  pointBehind(distance: number): Point | undefined {
    const points = this.points;
    if (!points.length) return undefined;
    let remaining = Math.max(0, distance);
    for (let index = 0; index < points.length - 1; index++) {
      const newest = points[index]!, older = points[index + 1]!;
      const segment = Math.hypot(newest.x - older.x, newest.y - older.y);
      if (segment > 0 && remaining <= segment) {
        const ratio = remaining / segment;
        return { x: newest.x + (older.x - newest.x) * ratio, y: newest.y + (older.y - newest.y) * ratio };
      }
      remaining -= segment;
    }
    return { ...points[points.length - 1]! };
  }

  get length(): number { return this.points.length; }
}
