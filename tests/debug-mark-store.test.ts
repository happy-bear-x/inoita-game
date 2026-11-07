import assert from 'node:assert/strict';
import test from 'node:test';
import { IndexedDbDebugMarkStore } from '../src/application/debug-mark-store.ts';
import type { DebugMark } from '../src/debug/debug-marks.ts';

/** IndexedDB 边界替身：请求异步完成，事务末尾统一提交，模拟正文配额失败。 */
function database() {
  const state = new Map<string, Map<string, unknown>>();
  let failBody = false, opened = false, closed = 0;
  const reads: string[] = [];
  const factory = {
    open() {
      const request: Partial<IDBOpenDBRequest> = {};
      const db = {
        createObjectStore(name: string) { state.set(name, new Map()); return { createIndex() {} }; },
        close() { closed++; },
        transaction(names: string[]) {
          const pending = new Map(names.map(name => [name, new Map(state.get(name))]));
          let aborted = false;
          const tx = {
            error: null as DOMException | null,
            oncomplete: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void),
            abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); },
            objectStore(name: string) {
              assert.ok(names.includes(name));
              return {
                put(value: DebugMark | DebugMark['summary']) {
                  const key = 'summary' in value ? value.summary.name : value.name;
                  pending.get(name)!.set(key, structuredClone(value));
                  if (failBody && name === 'bodies') { tx.error = new DOMException('full', 'QuotaExceededError'); tx.abort(); }
                },
                delete(key: string) { pending.get(name)!.delete(key); },
                get(key: string) {
                  reads.push(name);
                  const req = { result: structuredClone(pending.get(name)!.get(key)), onsuccess: undefined as undefined | (() => void) };
                  queueMicrotask(() => req.onsuccess?.()); return req;
                },
                index() { return { openCursor() {
                  reads.push(name);
                  const rows = [...pending.get(name)!.values()].sort((a,b)=>(b as DebugMark['summary']).savedAt-(a as DebugMark['summary']).savedAt);
                  let position = 0;
                  const req = { result: null as unknown, onsuccess: undefined as undefined | (() => void) };
                  const next = () => queueMicrotask(() => {
                    req.result = position >= rows.length ? null : { value: structuredClone(rows[position]),
                      advance(count: number) { position += count; next(); }, continue() { position++; next(); } };
                    req.onsuccess?.();
                  });
                  next(); return req;
                } }; },
              };
            },
          };
          setTimeout(() => {
            if (aborted) return;
            for (const [name, values] of pending) state.set(name, values);
            tx.oncomplete?.();
          }, 0);
          return tx;
        },
      };
      Object.assign(request, { result: db });
      queueMicrotask(() => {
        if (!opened) { opened = true; request.onupgradeneeded?.call(request as IDBOpenDBRequest, {} as IDBVersionChangeEvent); }
        request.onsuccess?.call(request as IDBOpenDBRequest, {} as Event);
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, reads, full: (value: boolean) => { failBody = value; }, closed: () => closed };
}
const mark = (name: string, savedAt: number): DebugMark => ({ version: 1, summary: { name, savedAt, classId: 'mage', map: 'camp' }, session: { money: savedAt } as DebugMark['session'] });

test('mark summaries page newest first without reading bodies; a new store reads durable bodies', async () => {
  const db = database(), store = new IndexedDbDebugMarkStore(() => db.factory);
  await store.put(mark('one', 1)); await store.put(mark('two', 2)); await store.put(mark('three', 3));
  assert.deepEqual((await store.list(1, 1)).map(row => row.name), ['two']);
  assert.deepEqual(db.reads, ['summaries']);
  const reopened = new IndexedDbDebugMarkStore(() => db.factory);
  assert.deepEqual(await reopened.get('one'), mark('one', 1));
  assert.deepEqual(db.reads, ['summaries', 'bodies']);
  assert.equal(db.closed(), 5);
  await reopened.delete('one');
  assert.equal(await reopened.get('one'), undefined);
  assert.deepEqual((await reopened.list()).map(row => row.name), ['three', 'two']);
});

test('quota failure aborts both summary and body so an existing mark remains intact', async () => {
  const db = database(), store = new IndexedDbDebugMarkStore(() => db.factory);
  await store.put(mark('safe', 1));
  db.full(true);
  await assert.rejects(store.put(mark('safe', 99)), { name: 'QuotaExceededError' });
  assert.deepEqual(await store.get('safe'), mark('safe', 1));
  assert.deepEqual(await store.list(), [mark('safe', 1).summary]);
  await assert.rejects(store.put(mark('new', 100)), { name: 'QuotaExceededError' });
  assert.equal(await store.get('new'), undefined);
  assert.deepEqual(await store.list(), [mark('safe', 1).summary]);
});

test('unsupported storage and invalid pages fail explicitly', async () => {
  const store = new IndexedDbDebugMarkStore(() => undefined);
  await assert.rejects(store.list(), /不支持/);
  await assert.rejects(store.list(-1), /分页/);
  await assert.rejects(store.list(0, 101), /分页/);
});
