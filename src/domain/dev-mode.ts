/**
 * 开发服务、Node 测试和 `?gm` 为真，生产构建为假；由 Vite define 注入。
 *
 * 开发/测试模式用冻结早发现“共享快照被原地改写”的 bug；生产热路径跳过冻结成本。
 */
declare const __STORY_DEV_MODE__: boolean;

const injected = typeof __STORY_DEV_MODE__ === 'boolean' ? __STORY_DEV_MODE__ : true;

export function storyDevMode(): boolean { return injected; }

/** 开发/测试模式递归冻结；已经冻结的部分直接复用，生产原样返回。 */
export function freezeSnapshot<T>(value: T): T {
  if (!injected) return value;
  const seen = new Set<object>();
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (!Object.isFrozen(current)) Object.freeze(current);
    if (Array.isArray(current)) { for (const item of current) freeze(item); return; }
    for (const child of Object.values(current as Record<string, unknown>)) freeze(child);
  };
  freeze(value);
  return value;
}
