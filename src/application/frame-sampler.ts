/** 同一渲染帧内，一段工作可能执行多次，耗时累计到该帧。 */
export class FrameWorkTimer {
  elapsedMs = 0;
  private startedAt = 0;
  private readonly now: () => number;

  constructor(now: () => number) { this.now = now; }
  start(): void { this.startedAt = this.now(); }
  end(): void { this.elapsedMs += this.now() - this.startedAt; }
}

interface FrameContext {
  mode: string;
  map: string | null;
  companions: number;
  enemies: number;
}

const roundMs = (value: number): number => Math.round(value * 100) / 100;

/** 用相邻两次完成绘制的间隔计帧。最慢帧的情境和各段耗时取自同一帧。 */
export class FrameSampler {
  readonly combat: FrameWorkTimer;
  readonly partyPath: FrameWorkTimer;
  readonly worldText: FrameWorkTimer;
  private readonly now: () => number;
  private readonly context: () => FrameContext;
  private readonly report: (details: unknown) => void;
  private previousEnd?: number;
  private startedAt?: number;
  private updatedAt?: number;
  private frames = 0;
  private windowMs = 0;
  private over33Ms = 0;
  private over50Ms = 0;
  private slowestMs = 0;
  private slowest?: FrameContext & {frameMs:number; updateMs:number; renderSubmitMs:number; waitMs:number;
    combatMs:number; partyPathMs:number; worldTextMs:number};

  constructor(context: () => FrameContext, report: (details: unknown) => void, now = () => performance.now()) {
    this.context = context;
    this.report = report;
    this.now = now;
    this.combat = new FrameWorkTimer(now);
    this.partyPath = new FrameWorkTimer(now);
    this.worldText = new FrameWorkTimer(now);
  }

  reset(): void {
    this.previousEnd = this.startedAt = this.updatedAt = undefined;
    this.frames = this.windowMs = this.over33Ms = this.over50Ms = this.slowestMs = 0;
    this.slowest = undefined;
  }
  begin(): void {
    this.startedAt = this.now();
    this.updatedAt = undefined;
    this.combat.elapsedMs = this.partyPath.elapsedMs = this.worldText.elapsedMs = 0;
  }
  updated(): void {
    if (this.startedAt !== undefined) this.updatedAt = this.now();
  }
  rendered(): void {
    const start = this.startedAt, updated = this.updatedAt;
    if (start === undefined || updated === undefined) return;
    const end = this.now(), previous = this.previousEnd;
    this.startedAt = this.updatedAt = undefined;
    this.previousEnd = end;
    if (previous === undefined) return;
    const frameMs = end - previous;
    this.frames++;
    this.windowMs += frameMs;
    if (frameMs > 33) this.over33Ms++;
    if (frameMs > 50) this.over50Ms++;
    if (frameMs > this.slowestMs) {
      this.slowestMs = frameMs;
      this.slowest = { ...this.context(), frameMs: roundMs(frameMs), waitMs: roundMs(start - previous),
        updateMs: roundMs(updated - start), renderSubmitMs: roundMs(end - updated),
        combatMs: roundMs(this.combat.elapsedMs), partyPathMs: roundMs(this.partyPath.elapsedMs),
        worldTextMs: roundMs(this.worldText.elapsedMs) };
    }
    if (this.windowMs < 5000) return;
    this.report({ windowMs: roundMs(this.windowMs), frames: this.frames, fps: roundMs(this.frames * 1000 / this.windowMs),
      over33Ms: this.over33Ms, over50Ms: this.over50Ms, slowest: this.slowest });
    this.reset();
    this.previousEnd = end;
  }
}
