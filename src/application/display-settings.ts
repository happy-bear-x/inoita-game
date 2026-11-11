/**
 * 画面偏好：帧率上限、帧率显示、暴击装饰和纹理批次。
 *
 * 和音频开关一样存在 localStorage：属于本机偏好，不进存档，也不随存档回退。
 */
const STORAGE_KEY = 'inotia4.display.v1';

export type FrameRateLimit = 30 | 60;
/** 自动：安卓单纹理，其余平台多纹理；多纹理每批可绑多张图集页；单纹理只绑一张。 */
export type TextureBatching = 'auto' | 'multi' | 'single';
interface DisplayPreferences { fps: boolean; criticalDecorations: boolean; frameRateLimit: FrameRateLimit; textureBatching: TextureBatching }

/** 把玩家的纹理批次偏好换算成 Phaser 的并行纹理单元上限。 */
export function parallelTextureUnits(mode: TextureBatching, android: boolean, maxTextures: number): number {
  return mode === 'single' || (mode === 'auto' && android) ? 1 : Math.max(1, maxTextures);
}

function preferences(): DisplayPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return { fps: saved.fps !== false, criticalDecorations: saved.criticalDecorations !== false,
      frameRateLimit: saved.frameRateLimit === 30 ? 30 : 60,
      textureBatching: saved.textureBatching === 'multi' || saved.textureBatching === 'single' ? saved.textureBatching : 'auto' };
  } catch { return { fps: true, criticalDecorations: true, frameRateLimit: 60, textureBatching: 'auto' }; }
}

const settings = preferences();
const frameRateListeners = new Set<(limit: FrameRateLimit) => void>();
const textureBatchingListeners = new Set<(mode: TextureBatching) => void>();

export const displaySettings = {
  /** 帧率显示默认开启。 */
  get fps(): boolean { return settings.fps; },
  /** 暴击光环和爆闪默认开启；只控制装饰，不影响暴击冲击、数字、震屏或音效。 */
  get criticalDecorations(): boolean { return settings.criticalDecorations; },
  get frameRateLimit(): FrameRateLimit { return settings.frameRateLimit; },
  /** 纹理批次默认自动：安卓单纹理，iOS 和桌面多纹理。 */
  get textureBatching(): TextureBatching { return settings.textureBatching; },
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
  setTextureBatching(mode: TextureBatching): void {
    if (settings.textureBatching === mode) return;
    settings.textureBatching = mode;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 本次会话内仍然生效 */ }
    for (const listener of textureBatchingListeners) listener(mode);
  },
  subscribeTextureBatching(listener: (mode: TextureBatching) => void): () => void {
    textureBatchingListeners.add(listener);
    return () => { textureBatchingListeners.delete(listener); };
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
