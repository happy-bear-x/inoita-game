/**
 * 图集装箱的共用实现。
 *
 * 输入按「块」分组：一个块通常是一个角色、一个特效或一组会一起加载的界面图。
 * 装箱时尽量把一个块整体放在同一页；块太大时按顺序拆到多页，不会为了单页容量
 * 把块内项目打散到不同页。这样运行时加载一个角色/特效时，最多只多带一页。
 *
 * 只负责坐标，不碰图片内容；裁边、去重、写 PNG/JSON 由各自的生成脚本处理。
 */
export interface AtlasPackingItem {
  /** 稳定标识，用于同一块内的确定性排序和错误信息。 */
  id: string;
  width: number;
  height: number;
}

export interface AtlasPackBlock<T extends AtlasPackingItem> {
  id: string;
  items: readonly T[];
}

export interface AtlasPackedItem {
  x: number;
  y: number;
}

export interface AtlasPackedPage<T extends AtlasPackingItem> {
  items: Array<T & AtlasPackedItem>;
  width: number;
  height: number;
}

export interface AtlasPackOptions {
  /** 单页最大边长；默认 2048。 */
  maxSize?: number;
  /** 帧与页面边缘、帧与帧之间的透明间距；默认 2。 */
  padding?: number;
}

interface Shelf {
  x: number;
  y: number;
  height: number;
}

interface PageState<T extends AtlasPackingItem> {
  items: Array<T & AtlasPackedItem>;
  shelves: Shelf[];
  width: number;
  height: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 帧在块内按高度降序，方便货架复用；映射仍按各自的帧序号记录，不依赖装箱顺序。 */
function orderedItems<T extends AtlasPackingItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.height - a.height || b.width - a.width || compareText(a.id, b.id));
}

function emptyPage<T extends AtlasPackingItem>(): PageState<T> {
  return { items: [], shelves: [], width: 0, height: 0 };
}

function clonePage<T extends AtlasPackingItem>(page: PageState<T>): PageState<T> {
  return { items: [...page.items], shelves: page.shelves.map(shelf => ({ ...shelf })), width: page.width, height: page.height };
}

/** 在已有货架里找最矮且放得下的一层；放不下返回 undefined。 */
function findShelf(shelves: readonly Shelf[], item: AtlasPackingItem, maxSize: number, padding: number): Shelf | undefined {
  let best: Shelf | undefined;
  for (const shelf of shelves) {
    if (shelf.x + item.width + padding * 2 > maxSize) continue;
    if (shelf.height < item.height) continue;
    if (!best || shelf.height < best.height || (shelf.height === best.height && shelf.y < best.y)) best = shelf;
  }
  return best;
}

/** 新开一层货架；页面高度不够时返回 undefined。 */
function addShelf<T extends AtlasPackingItem>(page: PageState<T>, item: AtlasPackingItem, maxSize: number, padding: number): Shelf | undefined {
  const y = page.height;
  if (y + item.height + padding * 2 > maxSize) return undefined;
  const shelf: Shelf = { x: padding, y, height: item.height };
  page.shelves.push(shelf);
  page.height = y + item.height + padding * 2;
  return shelf;
}

/**
 * 尝试把整组项目放进当前页；成功返回放入后的页面状态，失败返回 undefined（不改动原状态）。
 */
function tryPlaceAll<T extends AtlasPackingItem>(page: PageState<T>, items: readonly T[],
  maxSize: number, padding: number): PageState<T> | undefined {
  const next = clonePage(page);
  for (const item of items) {
    if (item.width + padding * 2 > maxSize || item.height + padding * 2 > maxSize)
      throw new Error(`图集帧过大，无法装入单页：${item.id} (${item.width}x${item.height})`);
    let shelf = findShelf(next.shelves, item, maxSize, padding);
    if (!shelf) shelf = addShelf(next, item, maxSize, padding);
    if (!shelf) return undefined;
    next.items.push({ ...item, x: shelf.x, y: shelf.y + padding });
    shelf.x += item.width + padding * 2;
    next.width = Math.max(next.width, shelf.x);
  }
  return next;
}

/** 大块单页放不下时，尽量把前缀放进当前页，剩下的下一轮继续。 */
function placePrefix<T extends AtlasPackingItem>(page: PageState<T>, items: readonly T[],
  maxSize: number, padding: number): { placed: PageState<T>; rest: T[] } {
  const next = clonePage(page);
  let index = 0;
  for (; index < items.length; index++) {
    const item = items[index]!;
    if (item.width + padding * 2 > maxSize || item.height + padding * 2 > maxSize)
      throw new Error(`图集帧过大，无法装入单页：${item.id} (${item.width}x${item.height})`);
    let shelf = findShelf(next.shelves, item, maxSize, padding);
    if (!shelf) shelf = addShelf(next, item, maxSize, padding);
    if (!shelf) break;
    next.items.push({ ...item, x: shelf.x, y: shelf.y + padding });
    shelf.x += item.width + padding * 2;
    next.width = Math.max(next.width, shelf.x);
  }
  if (!next.items.length)
    throw new Error(`图集页装不下任何帧：${items[0]?.id ?? '(空块)'}`);
  return { placed: next, rest: items.slice(index) };
}

/**
 * 按块装箱。块之间按总面积从大到小排，面积相同按 id 排，保证重复生成结果一致。
 * 每个块内部按帧高从大到小装，块整体优先同页；块本身超过一页时按顺序拆页。
 */
export function packAtlasBlocks<T extends AtlasPackingItem>(
  blocks: readonly AtlasPackBlock<T>[], options: AtlasPackOptions = {},
): AtlasPackedPage<T>[] {
  const maxSize = options.maxSize ?? 2048;
  const padding = options.padding ?? 2;
  const seen = new Set<string>();
  for (const block of blocks) for (const item of block.items) {
    if (seen.has(item.id)) throw new Error(`图集帧 id 重复：${item.id}`);
    seen.add(item.id);
  }
  const ordered = blocks
    .filter(block => block.items.length > 0)
    .map(block => ({ ...block, items: orderedItems(block.items),
      area: block.items.reduce((sum, item) => sum + item.width * item.height, 0) }))
    .sort((a, b) => b.area - a.area || compareText(a.id, b.id));

  const pages: AtlasPackedPage<T>[] = [];
  let page = emptyPage<T>();
  const finish = (): void => {
    if (!page.items.length) return;
    // 货架游标在放入最后一项后还会加一次尾部间距，直接拿它当页宽会多出一个 padding；
    // 按实际帧的右/下边界再加一份边距，保证返回值就是页面真实尺寸且不超过 maxSize。
    let right = 0, bottom = 0;
    for (const item of page.items) {
      right = Math.max(right, item.x + item.width);
      bottom = Math.max(bottom, item.y + item.height);
    }
    pages.push({ items: page.items, width: Math.max(1, right + padding), height: Math.max(1, bottom + padding) });
    page = emptyPage<T>();
  };

  for (const block of ordered) {
    let remaining: readonly T[] = block.items;
    while (remaining.length) {
      const placed = tryPlaceAll(page, remaining, maxSize, padding);
      if (placed) { page = placed; remaining = []; break; }
      // 整块放不下：当前页已有内容就先换页再试一次，避免把块拆在两页。
      if (page.items.length) { finish(); continue; }
      const split = placePrefix(page, remaining, maxSize, padding);
      page = split.placed;
      remaining = split.rest;
      finish();
    }
  }
  finish();
  return pages;
}
