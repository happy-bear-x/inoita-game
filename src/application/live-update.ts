/**
 * 原生热更新壳的网页侧接线。
 *
 * 壳在标题页加载完成后需要知道「新版本能正常启动」，才会提交这次更新；
 * 没收到信号就回退上一版。网页只负责发这一下，以及按需读壳的构建信息。
 */

export interface NativeBuildInfo {
  buildId: string;
  previous?: string;
  builtAt?: string;
  channel?: string;
}

interface InotiaNativeBridge {
  markBootOk?: () => void;
  buildInfo?: () => string;
}

declare global {
  var InotiaNative: InotiaNativeBridge | undefined;
}

let bootReadySent = false;

/** 标题页资源加载完成后调用；同一个页面生命周期只发一次。 */
export function notifyBootReady(): void {
  if (bootReadySent) return;
  bootReadySent = true;
  try { globalThis.InotiaNative?.markBootOk?.(); } catch { /* 原生桥不可用时忽略 */ }
}

/** 读取壳当前的构建信息；网页版或旧壳返回 undefined。 */
export function nativeBuildInfo(): NativeBuildInfo | undefined {
  try {
    const raw = globalThis.InotiaNative?.buildInfo?.();
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.buildId !== 'string' || !record.buildId) return undefined;
    return {
      buildId: record.buildId,
      ...(typeof record.previous === 'string' ? { previous: record.previous } : {}),
      ...(typeof record.builtAt === 'string' ? { builtAt: record.builtAt } : {}),
      ...(typeof record.channel === 'string' ? { channel: record.channel } : {}),
    };
  } catch { return undefined; }
}
