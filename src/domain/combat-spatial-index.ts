import { ATTACK_DISTANCE_BASE_UNITS, PIXELS_PER_DISTANCE_UNIT } from './basic-attack.ts';
import type { Combatant } from './combat.ts';
import type { CollisionBox } from './content.ts';

/** 候选按脚点位置分桶；32 像素一格，比逻辑距离的 8 像素单位更粗，减少桶数量。 */
const BUCKET_SIZE_PX = 32;
const BUCKET_COORD_OFFSET = 1 << 15;
const BUCKET_COORD_SPAN = 1 << 16;

/** 查询圆使用地图像素；圆内指候选脚点落在圆内。 */
export interface CombatQueryCircle {
  x: number;
  y: number;
  radius: number;
}

/** 8px 量化距离与坐标截断带来的取整余量。 */
export const CANDIDATE_QUERY_SAFETY_PX = 2;

/**
 * 目标身体在脚点之外的预留半径。当前战斗内容最大的碰撞盒是 32×16，
 * 这个值连同自身身体一并计入攻击距离查询，保证不会漏掉身体先接触的目标。
 */
export const CANDIDATE_QUERY_TARGET_BODY_PX = 64;

/** 脚点到碰撞盒最远角的距离；用于把矩形攻击距离换算成脚点圆半径。 */
export function bodyReachFromFoot(bounds: CollisionBox): number {
  return Math.hypot(
    Math.max(Math.abs(bounds.x), Math.abs(bounds.x + bounds.width)),
    Math.max(Math.abs(bounds.y), Math.abs(bounds.y + bounds.height)));
}

/**
 * 用 8px 量化距离做判定的查询半径。量化距离不超过 R 时，
 * 两轴真实坐标差都小于 R+1，脚点圆心距因此小于 (R+1)·√2。
 */
export function quantizedDistanceQueryRadius(distancePx: number, bodyReachPx = 0): number {
  return (distancePx + 1) * Math.SQRT2 + bodyReachPx + CANDIDATE_QUERY_SAFETY_PX;
}

/**
 * 警戒范围按 floor(量化距离 / 8) <= rangeUnits 判定，
 * 接受的最大量化距离是 (rangeUnits+1)·8-1 像素。
 */
export function awarenessRangeQueryRadius(rangeUnits: number, bodyReachPx = 0): number {
  return (rangeUnits + 1) * PIXELS_PER_DISTANCE_UNIT * Math.SQRT2 + bodyReachPx + CANDIDATE_QUERY_SAFETY_PX;
}

/**
 * 攻击距离（以 8px 为单位的矩形间隙）对应的脚点查询半径。
 * 攻击距离固定含 2 点基础值；先扣掉它，再把两轴间隙、自身身体与目标身体
 * 一起换算成圆心距上界。
 */
export function attackRangeQueryRadius(rangeUnits: number, actorBounds: CollisionBox): number {
  const rectGapPx = (Math.max(0, rangeUnits - ATTACK_DISTANCE_BASE_UNITS) + 1) * PIXELS_PER_DISTANCE_UNIT;
  return (rectGapPx + bodyReachFromFoot(actorBounds) + CANDIDATE_QUERY_TARGET_BODY_PX) * Math.SQRT2
    + CANDIDATE_QUERY_SAFETY_PX;
}

function bucketCell(value: number): number {
  const cell = Math.floor(value / BUCKET_SIZE_PX);
  return Math.max(-BUCKET_COORD_OFFSET, Math.min(BUCKET_COORD_OFFSET - 1, cell));
}

function bucketKey(cellX: number, cellY: number): number {
  return (cellX + BUCKET_COORD_OFFSET) * BUCKET_COORD_SPAN + (cellY + BUCKET_COORD_OFFSET);
}

/**
 * 战斗候选的 32 像素分桶索引。
 *
 * 桶只负责缩小范围，命中仍按候选脚点与查询圆的精确距离判断；
 * 多个圆重叠时用查询代号去重，结果按原候选数组下标升序返回，
 * 因此调用方看到的顺序与全表扫描完全一致。
 */
export class CombatSpatialIndex {
  private readonly candidates: readonly Combatant[];
  private readonly buckets = new Map<number, number[]>();
  private readonly marks: Uint32Array;
  private stamp = 0;

  constructor(candidates: readonly Combatant[]) {
    this.candidates = candidates;
    this.marks = new Uint32Array(candidates.length);
    candidates.forEach((candidate, index) => {
      const key = bucketKey(bucketCell(candidate.position.x), bucketCell(candidate.position.y));
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(index);
      else this.buckets.set(key, [index]);
    });
  }

  /** 取脚点落在任一圆内的候选；无圆时返回空数组。 */
  within(circles: readonly CombatQueryCircle[]): Combatant[] {
    if (!circles.length || !this.candidates.length) return [];
    const stamp = this.nextStamp();
    const matches: number[] = [];
    for (const circle of circles) {
      if (!Number.isFinite(circle.x) || !Number.isFinite(circle.y)
        || Number.isNaN(circle.radius) || circle.radius < 0) continue;
      const minX = bucketCell(circle.x - circle.radius), maxX = bucketCell(circle.x + circle.radius);
      const minY = bucketCell(circle.y - circle.radius), maxY = bucketCell(circle.y + circle.radius);
      const radiusSquared = circle.radius * circle.radius;
      // 圆很大时逐桶遍历可能比直接扫候选更贵；这时退化为全表精确检查。
      if ((maxX - minX + 1) * (maxY - minY + 1) > this.candidates.length) {
        for (let index = 0; index < this.candidates.length; index++)
          this.include(index, circle, radiusSquared, stamp, matches);
        continue;
      }
      for (let cellX = minX; cellX <= maxX; cellX++) {
        for (let cellY = minY; cellY <= maxY; cellY++) {
          const bucket = this.buckets.get(bucketKey(cellX, cellY));
          if (!bucket) continue;
          for (const index of bucket) this.include(index, circle, radiusSquared, stamp, matches);
        }
      }
    }
    matches.sort((a, b) => a - b);
    return matches.map(index => this.candidates[index]!);
  }

  private include(index: number, circle: CombatQueryCircle, radiusSquared: number,
    stamp: number, matches: number[]): void {
    if (this.marks[index] === stamp) return;
    const position = this.candidates[index]!.position;
    const dx = position.x - circle.x, dy = position.y - circle.y;
    if (dx * dx + dy * dy > radiusSquared) return;
    this.marks[index] = stamp;
    matches.push(index);
  }

  private nextStamp(): number {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.marks.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }
}
