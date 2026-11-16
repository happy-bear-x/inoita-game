import type { Point } from '../domain/navigation.ts';

/** 还没收到物理步时长时，按每秒 60 步估算一个逻辑步。 */
const DEFAULT_STEP_MS = 1000 / 60;

interface MovingVisual extends Point { active: boolean }
interface MotionSample {
  position(): Point;
  /** 写入调用方给的坐标；物理步采样共用一块临时点，避免每人每步新建对象。 */
  positionInto(out: Point): Point;
  enabled(): boolean;
  previous: Point;
  current: Point;
  saved: Point;
}

/** 保存已完成碰撞的两次位置，只在绘制期间借用人物容器的坐标。 */
export class MovementInterpolation {
  private remainingMs = 0;
  private stepMs = DEFAULT_STEP_MS;
  private readonly samples = new Map<MovingVisual, MotionSample>();
  private readonly restoredPositions = new Map<MovingVisual, Point>();
  private readonly moving = new Set<MovingVisual>();
  /** 物理步采样共用这一块坐标；`positionInto` 当场写满后立刻读取。 */
  private readonly scratch: Point = { x: 0, y: 0 };

  register(visual: MovingVisual, position: () => Point, enabled: () => boolean, positionInto?: (out: Point) => Point): void {
    const current = position();
    const into = positionInto ?? ((out: Point) => {
      const point = position(); out.x = point.x; out.y = point.y; return out;
    });
    this.samples.set(visual, { position, positionInto: into, enabled, previous: { ...current }, current: { ...current }, saved: { ...current } });
  }

  beginFrame(deltaMs: number): void {
    this.restore();
    this.remainingMs += deltaMs;
  }

  /** 每个物理步调用一次，长帧补步也逐次采样，保留最后两个结算位置。 */
  completeStep(durationMs: number): void {
    this.stepMs = durationMs;
    this.remainingMs -= durationMs;
    const scratch = this.scratch;
    for (const [visual, sample] of this.samples) {
      sample.positionInto(scratch);
      const x = scratch.x, y = scratch.y;
      if (!sample.enabled()) {
        // 禁用期间也收敛到当前脚点，重新启用时不会从旧位置滑一段。
        sample.previous.x = x; sample.previous.y = y;
        sample.current.x = x; sample.current.y = y;
        this.moving.delete(visual);
        continue;
      }
      if (x === sample.current.x && y === sample.current.y) {
        // position() 也会读取 previous；停步后必须把两次采样都收敛到当前点。
        sample.previous.x = x; sample.previous.y = y;
        this.moving.delete(visual);
        continue;
      }
      sample.previous.x = sample.current.x; sample.previous.y = sample.current.y;
      sample.current.x = x; sample.current.y = y;
      this.moving.add(visual);
    }
  }

  position(visual: MovingVisual): Point {
    const sample = this.samples.get(visual);
    if (!sample) return { x: visual.x, y: visual.y };
    if (!sample.enabled()) return sample.position();
    const fraction = Math.max(0, Math.min(1, this.remainingMs / this.stepMs));
    return {
      x: sample.previous.x + (sample.current.x - sample.previous.x) * fraction,
      y: sample.previous.y + (sample.current.y - sample.previous.y) * fraction
    };
  }

  apply(): void {
    this.restore();
    const fraction = Math.max(0, Math.min(1, this.remainingMs / this.stepMs));
    for (const visual of this.moving) {
      const sample = this.samples.get(visual)!;
      if (!visual.active || !sample.enabled()) continue;
      const x = sample.previous.x + (sample.current.x - sample.previous.x) * fraction;
      const y = sample.previous.y + (sample.current.y - sample.previous.y) * fraction;
      if (visual.x === x && visual.y === y) continue;
      sample.saved.x = visual.x; sample.saved.y = visual.y;
      this.restoredPositions.set(visual, sample.saved);
      visual.x = x; visual.y = y;
    }
  }

  restore(): void {
    for (const [visual, position] of this.restoredPositions) {
      if (visual.active) Object.assign(visual, position);
    }
    this.restoredPositions.clear();
  }

  /** 瞬移、换装和重新启用时从实际落点开始显示。物理时钟的余量保持不变。 */
  reset(visual: MovingVisual): void {
    const saved = this.restoredPositions.get(visual);
    if (saved && visual.active) Object.assign(visual, saved);
    this.restoredPositions.delete(visual);
    this.moving.delete(visual);
    const sample = this.samples.get(visual);
    if (sample) {
      const current = sample.position();
      sample.previous.x = sample.current.x = current.x;
      sample.previous.y = sample.current.y = current.y;
    }
  }

  remove(visual: MovingVisual): void { this.reset(visual); this.samples.delete(visual); }
  destroy(): void { this.restore(); this.samples.clear(); this.moving.clear(); }
}
