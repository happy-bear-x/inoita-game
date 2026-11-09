/**
 * 帧率上限换算：玩家选的是「想要的帧率」，Phaser 要的是「限帧阈值」。
 *
 * Phaser 的限帧器只在累计时间越过 1000 / 上限 毫秒时才交付一帧，并把不足一帧的
 * 余量直接丢掉。阈值等于屏幕刷新率时，单帧耗时只要比 16.7 毫秒慢一点点，累积时间
 * 就反复差一丁点过不去，画面会成规律地跳到一半（实测刷新 54 次只交付 34 帧）。
 * 所以选的帧率够得着屏幕时，直接交给屏幕节拍（limit 0），不再自己数帧。
 */

/** 与 vsync 的距离小于这个值时不再自己限帧。 */
const NEAR_VSYNC_HZ = 2;
export const DEFAULT_REFRESH_HZ = 60;
const SAMPLE_COUNT = 24;
const MAX_SAMPLE_MS = 700;
const FALLBACK_WAIT_MS = 1200;

/** 把玩家选的帧率换算成 Phaser 的 `fps.limit`；0 表示跟随屏幕刷新率。 */
export function resolveFrameLimit(chosen: number, refreshHz: number): number {
  return chosen + NEAR_VSYNC_HZ >= refreshHz ? 0 : chosen;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function refreshFromIntervals(intervals: number[]): number {
  const hz = 1000 / median(intervals);
  if (!Number.isFinite(hz) || hz < 20 || hz > 300) return DEFAULT_REFRESH_HZ;
  return Math.round(hz * 2) / 2;
}

/**
 * 量屏幕刷新率：连续记录 rAF 间隔，取中位数。最多等约 0.7 秒；页面不可见或
 * 浏览器不给 rAF 时按 60 处理。中位数能避开加载期间偶发的一两拍长间隔。
 */
export function measureRefreshRate(
  schedule: (callback: (time: number) => void) => void = callback => { requestAnimationFrame(callback); },
): Promise<number> {
  return new Promise(resolve => {
    const intervals: number[] = [];
    let first = 0, last = 0, done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(intervals.length >= 6 ? refreshFromIntervals(intervals) : DEFAULT_REFRESH_HZ);
    };
    const timer = setTimeout(finish, FALLBACK_WAIT_MS);
    const tick = (time: number): void => {
      if (done) return;
      if (!first) first = time;
      if (last) intervals.push(time - last);
      last = time;
      if (intervals.length >= SAMPLE_COUNT || time - first >= MAX_SAMPLE_MS) finish();
      else schedule(tick);
    };
    // 第一拍只用来取起点；启动时的 rAF 时间戳不一定从 0 开始。
    schedule(time => {
      if (done) return;
      first = last = time;
      schedule(tick);
    });
  });
}

let measuredRefreshHz = DEFAULT_REFRESH_HZ;

/** 启动后量一次；量完之前按 60Hz 处理。 */
export async function detectRefreshRate(): Promise<number> {
  measuredRefreshHz = await measureRefreshRate();
  return measuredRefreshHz;
}

/** 最近一次测到的刷新率；没测过是 60。 */
export function currentRefreshRate(): number {
  return measuredRefreshHz;
}
