import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContentLoader } from '../src/application/content-loader.ts';

const fixture = JSON.parse(readFileSync(new URL('../public/content/status-hud.json', import.meta.url), 'utf8'));

test('concurrent callers fetch and parse one content file once, even if one caller cancels', async () => {
  const original = globalThis.fetch;
  let calls = 0, parses = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>(resolve => { finish = resolve; });
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    const cancelled = new AbortController();
    const first = loader.statusHud(cancelled.signal);
    const second = loader.statusHud();
    cancelled.abort();
    await assert.rejects(first, { name: 'AbortError' });
    finish({ ok: true, json: async () => { parses++; return fixture; } } as Response);
    const result = await second;
    assert.equal(calls, 1);
    assert.equal(parses, 1);
    assert.equal(await loader.statusHud(), result);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

const manifest = { schema: 1, contentVersion: '', required: {} };
const manifestResponse = () => ({ ok: true, json: async () => manifest } as Response);

test('trusted loader returns raw JSON without running the semantic parser', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? manifestResponse() : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const trusted = new ContentLoader();
    trusted.trusted = true;
    assert.deepEqual(await trusted.statusHud(), {});
    const checked = new ContentLoader();
    await assert.rejects(checked.statusHud());
  } finally { globalThis.fetch = original; }
});

test('trusted loader rejects a content version that differs from the page build', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? { ok: true, json: async () => ({ ...manifest, contentVersion: 'other' }) } as Response
    : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    loader.contentVersion = 'page-build';
    await assert.rejects(loader.statusHud(), /内容版本与页面不一致/);
  } finally { globalThis.fetch = original; }
});

test('trusted loader rejects a file missing a required top-level key', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? { ok: true, json: async () => ({ ...manifest, required: { 'content/status-hud.json': ['version'] } }) } as Response
    : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await assert.rejects(loader.statusHud(), /缺少必需字段：content\/status-hud\.json version/);
  } finally { globalThis.fetch = original; }
});

test('trusted loader fails clearly when the production manifest is missing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => String(input) === 'content-manifest.json'
    ? { ok: false } as Response : { ok: true, json: async () => ({}) } as Response) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await assert.rejects(loader.statusHud(), /生产内容清单缺失/);
  } finally { globalThis.fetch = original; }
});

test('trusted wardrobe returns the core file and fetches only requested poses', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === 'content-manifest.json') return manifestResponse();
    const body = url === 'content/wardrobe.json' ? { poses: {} } : { mirrorX: false, frameRate: 8, frames: [] };
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    assert.deepEqual(await loader.wardrobe(), { poses: {} });
    await loader.wardrobePoses(['pose-a']);
    assert.deepEqual(calls, ['content/wardrobe.json', 'content-manifest.json', 'content/wardrobe/poses/pose-a.json']);
    await loader.wardrobePoses(['pose-a']);
    assert.deepEqual(calls, ['content/wardrobe.json', 'content-manifest.json', 'content/wardrobe/poses/pose-a.json']);
  } finally { globalThis.fetch = original; }
});

test('failed content can be requested again', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1 ? { ok: false } as Response : { ok: true, json: async () => fixture } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    await assert.rejects(loader.statusHud(), /status-hud.json/);
    await loader.statusHud();
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('session cleanup keeps core content tables cached', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    calls.push(url);
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    await loader.statusHud();
    loader.clearSessionCaches();
    await loader.statusHud();
    assert.deepEqual(calls, ['content/status-hud.json']);
  } finally { globalThis.fetch = original; }
});

test('session cleanup drops map and pose content so the next request reloads them', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    calls.push(url);
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    const counts = loader.memoryCounts = { maps: 0, poses: 0, pending: 0 };
    await loader.map('content/maps/town.json');
    await loader.wardrobePoses(['pose-a', 'pose-a']);
    assert.deepEqual(counts, {maps: 1, poses: 1, pending: 0});
    loader.clearSessionCaches();
    assert.deepEqual(counts, {maps: 0, poses: 0, pending: 0});
    await loader.map('content/maps/town.json');
    await loader.wardrobePoses(['pose-a']);
    assert.deepEqual(calls, [
      'content/maps/town.json', 'content/wardrobe/poses/pose-a.json',
      'content/maps/town.json', 'content/wardrobe/poses/pose-a.json',
    ]);
  } finally { globalThis.fetch = original; }
});

test('session cleanup keeps an in-flight map request and resolves its waiter', async () => {
  const original = globalThis.fetch;
  let mapCalls = 0;
  let finish!: () => void;
  const value = { id: 'town' };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'content-manifest.json') return manifestResponse();
    mapCalls++;
    return new Promise<Response>(resolve => {
      finish = () => resolve({ ok: true, json: async () => value } as Response);
    });
  }) as typeof fetch;
  try {
    const loader = new ContentLoader();
    loader.trusted = true;
    const counts = loader.memoryCounts = { maps: 0, poses: 0, pending: 0 };
    const pending = loader.map('content/maps/town.json');
    loader.clearSessionCaches();
    assert.deepEqual(counts, {maps: 0, poses: 0, pending: 1});
    finish();
    assert.equal(await pending, value);
    assert.deepEqual(counts, {maps: 1, poses: 0, pending: 0});
    assert.equal(await loader.map('content/maps/town.json'), value);
    assert.equal(mapCalls, 1, '完成后仍留在缓存里，下一次调用不再请求');
  } finally { globalThis.fetch = original; }
});
