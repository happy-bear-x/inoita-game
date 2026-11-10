import assert from 'node:assert/strict';
import test from 'node:test';
import { packAtlasBlocks, type AtlasPackingItem } from '../tools/atlas-pack.ts';

const item = (id: string, width: number, height: number): AtlasPackingItem => ({ id, width, height });

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('小块共享页面，帧不重叠且都在页内', () => {
  const pages = packAtlasBlocks([
    { id: 'a', items: [item('a-0', 40, 30), item('a-1', 40, 20)] },
    { id: 'b', items: [item('b-0', 20, 50)] }
  ], { maxSize: 128, padding: 2 });
  assert.equal(pages.length, 1, '两个小块应装进同一页');
  for (const page of pages) {
    assert.ok(page.width <= 128 && page.height <= 128);
    for (const placed of page.items) {
      assert.ok(placed.x >= 0 && placed.y >= 0);
      assert.ok(placed.x + placed.width <= 128 && placed.y + placed.height <= 128, `${placed.id} 在页内`);
    }
    for (let a = 0; a < page.items.length; a++) for (let b = a + 1; b < page.items.length; b++) {
      const first = page.items[a]!, second = page.items[b]!;
      assert.equal(overlaps(first, second), false, `${first.id} 与 ${second.id} 重叠`);
    }
  }
});

test('放得下的块不会被拆到两页', () => {
  const pages = packAtlasBlocks([
    { id: 'fill', items: [item('fill-0', 120, 50)] },
    { id: 'block', items: [item('block-0', 60, 40), item('block-1', 60, 40)] }
  ], { maxSize: 128, padding: 2 });
  const pagesOf = new Map<string, number>();
  pages.forEach((page, index) => page.items.forEach(placed => pagesOf.set(placed.id, index)));
  assert.equal(pagesOf.get('block-0'), pagesOf.get('block-1'), '同一块的两帧必须在同一页');
  assert.notEqual(pagesOf.get('fill-0'), pagesOf.get('block-0'), '新块放不下时应整体换页');
});

test('超大块按顺序拆页，帧不丢失', () => {
  const items = Array.from({ length: 20 }, (_, index) => item(`big-${String(index).padStart(2, '0')}`, 60, 60));
  const pages = packAtlasBlocks([{ id: 'big', items }], { maxSize: 128, padding: 2 });
  assert.ok(pages.length > 1, '必须拆成多页');
  const placed = pages.flatMap(page => page.items.map(entry => entry.id));
  assert.deepEqual([...placed].sort(), items.map(entry => entry.id).sort(), '拆页后帧不丢失');
  for (const page of pages) {
    assert.ok(page.width <= 128 && page.height <= 128);
    for (const entry of page.items) assert.ok(entry.x + entry.width <= 128 && entry.y + entry.height <= 128);
  }
});

test('重复装箱结果稳定', () => {
  const blocks = [
    { id: 'b', items: [item('b-0', 30, 20), item('b-1', 10, 40)] },
    { id: 'a', items: [item('a-0', 50, 50)] }
  ];
  const first = packAtlasBlocks(blocks, { maxSize: 128, padding: 2 });
  const second = packAtlasBlocks(blocks, { maxSize: 128, padding: 2 });
  assert.deepEqual(first, second);
});

test('单帧超过页上限直接报错，不静默截断', () => {
  assert.throws(() => packAtlasBlocks([
    { id: 'too-big', items: [item('huge', 300, 10)] }
  ], { maxSize: 128, padding: 2 }), /图集帧过大/);
});

test('贴边的帧不会让页宽超过上限', () => {
  const pages = packAtlasBlocks([{ id: 'edge', items: [item('edge-0', 60, 60)] }],
    { maxSize: 64, padding: 2 });
  assert.equal(pages.length, 1);
  assert.ok(pages[0]!.width <= 64, `页宽 ${pages[0]!.width} 不应超过 64`);
  assert.ok(pages[0]!.height <= 64, `页高 ${pages[0]!.height} 不应超过 64`);
});

test('重复帧 id 直接报错，避免同一页里两条长条图互相覆盖', () => {
  assert.throws(() => packAtlasBlocks([
    { id: 'a', items: [item('same-id', 10, 10)] },
    { id: 'b', items: [item('same-id', 10, 10)] }
  ]), /id 重复/);
});
