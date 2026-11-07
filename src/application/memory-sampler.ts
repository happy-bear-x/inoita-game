// 账本只保存键、大小和场景名称。图片、声音和场景对象仍由引擎自己持有。
interface TextureSize { loadedAt: number; bytes: number; owners: readonly string[] }
interface MemoryOperation {
  subject: string;
  startedAt: number;
  peak: { textureBytes: number; audioBytes: number };
  // 峰值之后第一次发生变化前的条目。结束时可还原已卸载的大图，无需每次加载都排序。
  atPeak: Map<string, TextureSize | undefined>;
}

export type FinishMemorySample = (result?: 'ready' | 'cancelled' | 'error') => void;
export const textureMemory = new WeakMap<object, MemorySampler>();

export class MemorySampler {
  private readonly textures = new Map<string, TextureSize>();
  private readonly leases = new Map<string, Map<string, number>>();
  private readonly audio = new Map<string, number | null>();
  private readonly operations = new Map<number, MemoryOperation>();
  private textureBytes = 0;
  private audioBytes = 0;
  private unknownAudio = 0;
  private sequence = 0;
  private textureSequence = 0;
  private readonly sessions = typeof WeakRef === 'function' ? new Array<WeakRef<object>>() : undefined;
  private resumed = false;
  effects = 0;
  readonly content = { maps: 0, poses: 0, pending: 0 };
  private readonly context: () => object;
  private readonly record: (kind: string, details: object) => void;

  constructor(context: () => object, record: (kind: string, details: object) => void) {
    this.context = context;
    this.record = record;
  }

  private changeTexture(key: string, next?: TextureSize): void {
    const previous = this.textures.get(key);
    for (const op of this.operations.values()) {
      if (!op.atPeak.has(key)) op.atPeak.set(key, previous);
      if (!next && !op.atPeak.get(key)) op.atPeak.delete(key);
    }
    this.textureBytes += (next?.bytes ?? 0) - (previous?.bytes ?? 0);
    if (next) this.textures.set(key, next);
    else this.textures.delete(key);
    this.updatePeaks();
  }

  addTexture(key: string, bytes: number): void {
    this.changeTexture(key, { loadedAt: ++this.textureSequence, bytes, owners: [...(this.leases.get(key)?.keys() ?? [])] });
  }

  resizeTexture(key: string, deltaBytes: number): void {
    const current = this.textures.get(key);
    if (current && deltaBytes) this.changeTexture(key, {...current, bytes: current.bytes + deltaBytes});
  }

  removeTexture(key: string): void {
    if (this.textures.has(key)) this.changeTexture(key);
  }

  generatedBy(key: string, owner: string): void {
    const texture = this.textures.get(key);
    if (texture) this.changeTexture(key, {...texture, owners: [owner]});
  }

  changeOwner(keys: Iterable<string>, owner: string, delta: 1 | -1): void {
    for (const key of keys) {
      const owners = this.leases.get(key) ?? new Map<string, number>();
      const previous = owners.get(owner) ?? 0, count = previous + delta;
      if (count > 0) owners.set(owner, count);
      else owners.delete(owner);
      if (owners.size) this.leases.set(key, owners);
      else this.leases.delete(key);
      const texture = this.textures.get(key);
      if (texture && (previous > 0) !== (count > 0)) this.changeTexture(key, {...texture, owners: [...owners.keys()]});
    }
  }

  setAudio(key: string, bytes: number | null | undefined): void {
    const previous = this.audio.get(key);
    this.audioBytes += (bytes ?? 0) - (previous ?? 0);
    this.unknownAudio += Number(bytes === null) - Number(previous === null);
    if (bytes === undefined) this.audio.delete(key);
    else this.audio.set(key, bytes);
    this.updatePeaks();
  }

  private updatePeaks(): void {
    for (const op of this.operations.values()) {
      if (this.textureBytes + this.audioBytes >= op.peak.textureBytes + op.peak.audioBytes) {
        op.peak.textureBytes = this.textureBytes;
        op.peak.audioBytes = this.audioBytes;
        op.atPeak.clear();
      }
    }
  }

  trackSession(session: object): void {
    if (!this.sessions) return;
    this.sessions.push(new WeakRef(session));
    if (this.sessions.length > 8) this.sessions.shift();
  }

  snapshot() {
    const browser = globalThis.performance as Performance & { memory?: { usedJSHeapSize?: number } };
    let context: object;
    try { context = this.context(); }
    catch { context = {contextUnavailable: true}; }
    return {
      textureCount: this.textures.size, textureBytes: this.textureBytes,
      audioCount: this.audio.size, audioBytes: this.audioBytes, unknownAudio: this.unknownAudio,
      heapBytes: browser?.memory?.usedJSHeapSize ?? null,
      recentSessionsAlive: this.sessions?.reduce((n, ref) => n + Number(!!ref.deref()), 0) ?? null,
      content: {...this.content}, effects: this.effects, ...context
    };
  }

  markResume(): void { this.resumed = true; }

  frame() {
    const firstAfterResume = this.resumed;
    this.resumed = false;
    return {...this.snapshot(), firstAfterResume};
  }

  compare(name: string, subject: string): () => void {
    const before = this.snapshot();
    return () => this.record('memory-cleanup', {name, subject, before, after: this.snapshot()});
  }

  begin(name: string, subject = ''): FinishMemorySample {
    const id = ++this.sequence;
    this.operations.set(id, {subject, startedAt: this.textureSequence, peak: { textureBytes: this.textureBytes, audioBytes: this.audioBytes }, atPeak: new Map()});
    this.record('memory-step', {name, subject, id, phase: 'before', memory: this.snapshot()});
    return (result = 'ready') => this.finish(name, id, result);
  }

  private finish(name: string, id: number, result: string): void {
    const op = this.operations.get(id);
    if (!op) return;
    this.operations.delete(id);
    type Contribution = {key: string; bytes: number; owners: readonly string[]};
    const largest: Contribution[] = [], largestAdded: Contribution[] = [];
    const rank = (list: Contribution[], key: string, item: TextureSize) => {
      if (list.length === 5 && item.bytes <= list[4].bytes) return;
      list.push({key, bytes: item.bytes, owners: [...item.owners]});
      list.sort((a, b) => b.bytes - a.bytes);
      if (list.length > 5) list.pop();
    };
    const consider = (key: string, item?: TextureSize) => {
      if (!item) return;
      rank(largest, key, item);
      if (item.loadedAt > op.startedAt) rank(largestAdded, key, item);
    };
    for (const [key, item] of this.textures) if (!op.atPeak.has(key)) consider(key, item);
    for (const [key, item] of op.atPeak) consider(key, item);
    this.record('memory-step', {name, subject: op.subject, id, phase: result, peak: op.peak, largest, largestAdded, memory: this.snapshot()});
  }
}
