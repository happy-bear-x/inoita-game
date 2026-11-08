/**
 * 画面偏好：帧率上限、帧率显示和暴击装饰。
 *
 * 和音频开关一样存在 localStorage：属于本机偏好，不进存档，也不随存档回退。
 */
const STORAGE_KEY = 'inotia4.display.v1';

export type FrameRateLimit = 30 | 60 | 120;
interface DisplayPreferences { fps: boolean; criticalDecorations: boolean; frameRateLimit: FrameRateLimit }

function preferences(): DisplayPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { fps: saved.fps !== false, criticalDecorations: saved.criticalDecorations !== false, frameRateLimit: saved.frameRateLimit === 30 || saved.frameRateLimit === 120 ? saved.frameRateLimit : 60 };
  } catch { return { fps: true, criticalDecorations: true, frameRateLimit: 60 }; }
}

const settings = preferences();
const frameRateListeners = new Set<(limit: FrameRateLimit) => void>();

export const displaySettings = {
  /** 帧率显示默认开启。 */
  get fps(): boolean { return settings.fps; },
  /** 暴击光环和爆闪默认开启；只控制装饰，不影响暴击冲击、数字、震屏或音效。 */
  get criticalDecorations(): boolean { return settings.criticalDecorations; },
  get frameRateLimit(): FrameRateLimit { return settings.frameRateLimit; },
  setFrameRateLimit(limit: FrameRateLimit): void {
    if (settings.frameRateLimit === limit) return;
    settings.frameRateLimit = limit;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 本次会话内仍然生效 */ }
    for (const listener of frameRateListeners) listener(limit);
  },
  subscribeFrameRateLimit(listener: (limit: FrameRateLimit) => void): () => void {
    frameRateListeners.add(listener);
    return () => { frameRateListeners.delete(listener); };
  },
  setFps(enabled: boolean): void {
    settings.fps = enabled;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 隐私模式等写不进去的场景：本次会话内仍然生效 */ }
  },
  setCriticalDecorations(enabled: boolean): void {
    settings.criticalDecorations = enabled;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 隐私模式等写不进去的场景：本次会话内仍然生效 */ }
  },
};
