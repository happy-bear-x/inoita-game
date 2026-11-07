import { versionedAsset } from '../../application/asset-version.ts';
import { UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_DATA, UI_ICON_FRAMES } from '../../generated/icon-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../../generated/ui-atlas.ts';
import type { AssetLease } from '../../application/assets.ts';

export interface ImageRect { x: number; y: number; width: number; height: number }
export interface DomImageSource {
  url: string;
  width: number;
  height: number;
  frame: ImageRect;
}
interface AtlasData { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> }
export interface DomImageLoader {
  image(url: string, signal: AbortSignal): Promise<{ width: number; height: number }>;
  atlas(url: string, signal: AbortSignal): Promise<AtlasData>;
}
interface ImageEntry {
  users: number;
  controller: AbortController;
  ready: Promise<DomImageSource>;
}

/** 图片与数据请求按资源共享，调用者取消只释放自己的持有权。 */
export class DomAssets {
  private readonly entries = new Map<string, ImageEntry>();
  private readonly loader: DomImageLoader;
  constructor(loader: DomImageLoader = browserImageLoader) { this.loader = loader; }
  get size(): number { return this.entries.size; }

  async acquire(file: string, signal: AbortSignal): Promise<AssetLease & { source: DomImageSource }> {
    signal.throwIfAborted();
    const name = file.replace(/^\//, '');
    const icon = UI_ICON_FRAMES[name];
    const ui = UI_ATLAS_FRAMES[name];
    const page = ui ? UI_ATLAS_PAGES[ui.page] : undefined;
    const imageFile = icon ? UI_ICON_ATLAS_FILE : page?.file ?? file;
    const dataFile = icon ? UI_ICON_ATLAS_DATA : page?.data;
    const frameName = icon ?? ui?.frame;
    const key = imageFile.replace(/^\//, '');
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const ready = this.loader.image(versionedAsset(imageFile), controller.signal).then(size => ({
        url: versionedAsset(imageFile), ...size, frame: { x: 0, y: 0, ...size }
      }));
      entry = { users: 0, controller, ready };
      this.entries.set(key, entry);
    }
    entry.users++;
    const current = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', release);
      if (--current.users === 0) {
        current.controller.abort();
        if (this.entries.get(key) === current) this.entries.delete(key);
      }
    };
    signal.addEventListener('abort', release, { once: true });
    try {
      const source = await abortable(current.ready, signal);
      let result = source;
      if (dataFile && frameName) {
        const data = await abortable(this.atlas(dataFile, current.controller.signal), signal);
        const rect = data.frames[frameName]?.frame;
        if (!rect) throw new Error(`界面图集缺少图片：${file}`);
        result = { ...source, frame: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } };
      }
      signal.throwIfAborted();
      return { source: result, release };
    } catch (error) { release(); throw error; }
  }

  private readonly atlases = new Map<string, { signal: AbortSignal; ready: Promise<AtlasData> }>();
  private atlas(file: string, signal: AbortSignal): Promise<AtlasData> {
    const cached = this.atlases.get(file);
    if (cached && !cached.signal.aborted) return cached.ready;
    const ready = this.loader.atlas(versionedAsset(file), signal);
    const record = { signal, ready };
    this.atlases.set(file, record);
    const clear = () => { if (this.atlases.get(file) === record) this.atlases.delete(file); };
    signal.addEventListener('abort', clear, { once: true });
    void ready.catch(clear);
    return ready;
  }

  async preloadFiles(files: readonly string[], signal: AbortSignal, progress: (value: number) => void): Promise<AssetLease> {
    const leases: AssetLease[] = [];
    const names = [...new Set(files)];
    try {
      for (const file of names) {
        leases.push(await this.acquire(file, signal));
        progress(leases.length / names.length);
      }
      if (!names.length) progress(1);
      return { release: () => { for (const lease of leases.splice(0)) lease.release(); } };
    } catch (error) { for (const lease of leases) lease.release(); throw error; }
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

const browserImageLoader: DomImageLoader = {
  image: (url, signal) => new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); image.removeAttribute('src'); reject(signal.reason); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    image.onload = () => { cleanup(); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { cleanup(); reject(new Error(`界面图片加载失败：${url}`)); };
    image.src = url;
  }),
  atlas: async (url, signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`界面图集加载失败：${url}`);
    return await response.json() as AtlasData;
  }
};
