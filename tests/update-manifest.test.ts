import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertSafePath, buildIdOf, buildManifest, diffManifests, fileDigest, manifestFromDirectory,
  parseManifest, serialize, signBytes, verifyBytes, verifyManifestFiles, type UpdateFile,
} from '../tools/update-manifest.ts';

const ASSET_VERSION = '0123456789abcdef';
const CONTENT_VERSION = 'fedcba9876543210';

test('same content rebuilds the same buildId and manifest bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inoita-update-'));
  try {
    await mkdir(path.join(root, 'content'), { recursive: true });
    await mkdir(path.join(root, 'update'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<!doctype html>');
    await writeFile(path.join(root, 'content', 'a.json'), '{"a":1}');
    await writeFile(path.join(root, '.build-meta.json'), '{"builtAt":"ignored"}');
    await writeFile(path.join(root, 'update', 'old.json'), '{}');

    const first = await manifestFromDirectory(root, ASSET_VERSION, CONTENT_VERSION);
    const second = await manifestFromDirectory(root, ASSET_VERSION, CONTENT_VERSION);
    assert.equal(first.buildId, second.buildId);
    assert.equal(buildIdOf(first.files), first.buildId);
    assert.equal(serialize(first), serialize(second));
    assert.deepEqual(first.files.map(file => file.p), ['content/a.json', 'index.html']);
    assert.equal(first.files[1]!.h, fileDigest('index.html', Buffer.from('<!doctype html>')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects absolute, empty, dot and traversal paths', () => {
  for (const value of ['', '/etc/passwd', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\0b', '.hidden', 'dir/.hidden'])
    assert.throws(() => assertSafePath(value), /清单路径/, value);
  assert.doesNotThrow(() => assertSafePath('content/a.json'));
});

test('rejects duplicate paths in a manifest', () => {
  const entry: UpdateFile = { p: 'a.txt', h: '0'.repeat(16), s: 1 };
  assert.throws(() => buildManifest([entry, { ...entry }], ASSET_VERSION, CONTENT_VERSION), /重复/);
});

test('parseManifest validates paths and duplicates', () => {
  const manifest = buildManifest([{ p: 'a.txt', h: '0'.repeat(16), s: 1 }], ASSET_VERSION, CONTENT_VERSION);
  assert.equal(parseManifest(JSON.parse(serialize(manifest))).buildId, manifest.buildId);
  assert.throws(() => parseManifest({ ...manifest, files: [{ p: '../x', h: '0'.repeat(16), s: 1 }] }), /清单路径/);
  assert.throws(() => parseManifest({ ...manifest, files: [...manifest.files, ...manifest.files] }), /重复/);
});

test('detects tampered signatures and bytes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const bytes = Buffer.from('manifest bytes');
  const signature = signBytes(bytes, privateKey);
  assert.equal(verifyBytes(bytes, signature, publicKey), true);
  assert.equal(verifyBytes(Buffer.from('manifest bytez'), signature, publicKey), false);

  const tampered = Buffer.from(signature, 'base64');
  tampered[0] = (tampered[0] ?? 0) ^ 0xff;
  assert.equal(verifyBytes(bytes, tampered.toString('base64'), publicKey), false);
  assert.equal(verifyBytes(bytes, 'not-base64!!', publicKey), false);
});

test('reports missing and mismatched files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inoita-update-'));
  try {
    await writeFile(path.join(root, 'a.txt'), 'one');
    await writeFile(path.join(root, 'b.txt'), 'two');
    const manifest = await manifestFromDirectory(root, ASSET_VERSION, CONTENT_VERSION);
    await unlink(path.join(root, 'a.txt'));
    await assert.rejects(() => verifyManifestFiles(root, manifest), /缺少 a\.txt/);

    await writeFile(path.join(root, 'a.txt'), 'three');
    await assert.rejects(() => verifyManifestFiles(root, manifest), /大小不符|哈希不符/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff counts added, changed and removed files', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'inoita-update-base-'));
  const remoteRoot = await mkdtemp(path.join(tmpdir(), 'inoita-update-remote-'));
  try {
    await writeFile(path.join(baseRoot, 'a.txt'), 'one');
    await writeFile(path.join(baseRoot, 'b.txt'), 'two');
    await writeFile(path.join(remoteRoot, 'a.txt'), 'ONE!');
    await writeFile(path.join(remoteRoot, 'c.txt'), 'three');
    const base = await manifestFromDirectory(baseRoot, ASSET_VERSION, CONTENT_VERSION);
    const remote = await manifestFromDirectory(remoteRoot, ASSET_VERSION, CONTENT_VERSION);

    const diff = diffManifests(base, remote);
    assert.deepEqual(diff.changed.map(file => file.p), ['a.txt', 'c.txt']);
    assert.deepEqual(diff.removed, ['b.txt']);
    assert.equal(diff.downloadBytes, 4 + 5);
  } finally {
    await rm(baseRoot, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  }
});
