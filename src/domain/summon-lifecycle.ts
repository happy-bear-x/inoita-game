import { LOGIC_FRAME_MS } from './battle.ts';

/**
 * 召唤物生命周期规则：谁属于谁、同一主人顶替、退场与寿命。
 * 场景仍持有召唤物的 visual、物理体和名册条目，这里只维护“归属和该不该退场”。
 */
export class SummonLifecycle {
  private readonly groups = new Map<string, Set<string>>();

  /** 开始一次召唤：同一主人的旧召唤全部退场，返回要移除的 key。 */
  beginSummon(ownerId: string): string[] {
    const keys = [...(this.groups.get(ownerId) ?? [])];
    this.groups.set(ownerId, new Set());
    return keys;
  }

  /** 召唤创建成功后登记到主人名下。 */
  register(ownerId: string, key: string): void {
    const group = this.groups.get(ownerId);
    if (group) group.add(key);
    else this.groups.set(ownerId, new Set([key]));
  }

  /** 召唤消失：从所有分组里删除，并清掉它自己作为主人的分组。 */
  remove(key: string): void {
    for (const group of this.groups.values()) group.delete(key);
    this.groups.delete(key);
  }

  /** 主人离队或阵亡：返回主人名下的召唤，并清空该分组。 */
  removeOwner(ownerId: string): string[] {
    const keys = [...(this.groups.get(ownerId) ?? [])];
    this.groups.delete(ownerId);
    return keys;
  }

  /** 存档/检查点用的可序列化投影；空分组也保留。 */
  capture(): [string, string[]][] {
    return [...this.groups].map(([ownerId, keys]) => [ownerId, [...keys]]);
  }

  restore(state: readonly (readonly [string, readonly string[]])[]): void {
    this.groups.clear();
    for (const [ownerId, keys] of state) this.groups.set(ownerId, new Set(keys));
  }

  clear(): void {
    this.groups.clear();
  }
}

/**
 * 召唤寿命：有主人属性换算结果时用逻辑帧数，否则用技能等级给的毫秒时长。
 * 帧数换算沿用原版的 `(frames + 1) * 60`，保证最后一帧仍能行动。
 */
export function summonDurationMs(rankDurationMs: number, lifetimeFrames?: number): number {
  return lifetimeFrames === undefined ? rankDurationMs : (lifetimeFrames + 1) * LOGIC_FRAME_MS;
}

/** 逻辑帧推进召唤寿命。 */
export function advanceSummonLifetime(remainingMs: number, elapsedMs = LOGIC_FRAME_MS): number {
  return remainingMs - elapsedMs;
}

export function summonLifetimeExpired(remainingMs: number | undefined): boolean {
  return remainingMs !== undefined && remainingMs <= 0;
}

/**
 * 召唤物退场时是否清理它在会话里的血量/法力条目。
 * 检查点恢复会按名册重建同一批召唤物，那条路径保留状态（`keepForRestore`）。
 */
export function releasesSummonVitals(summonedBy: string | undefined, keepForRestore: boolean): boolean {
  return !keepForRestore && summonedBy !== undefined;
}

/** 被移除的召唤物名下的召唤物也要一起退场（召唤物再召唤）。 */
export function summonedChildren(
  summons: readonly { key: string; summonedBy?: string }[], key: string,
): string[] {
  return summons.filter(summon => summon.summonedBy === key).map(summon => summon.key);
}
