import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reportAssets } from '../tools/asset-report.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('asset report groups identical files and estimates decoded bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-report-'));
  try {
    await fs.mkdir(path.join(root, 'assets', 'a'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets', 'b'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(root, 'assets', 'a', 'one.png'), png),
      fs.writeFile(path.join(root, 'assets', 'b', 'two.png'), png),
      fs.writeFile(path.join(root, 'assets', 'b', 'other.png'), Buffer.concat([png, Buffer.from('x')]))
    ]);
    const report = await reportAssets(root);
    assert.equal(report.files, 3);
    assert.equal(report.uniqueFiles, 2);
    assert.equal(report.duplicateGroups, 1);
    assert.equal(report.duplicateFiles, 1);
    assert.equal(report.duplicateDecodedBytes, 4);
    assert.equal(report.runtime, undefined);
    assert.equal(report.topDuplicateGroups[0]!.count, 2);
    assert.deepEqual(report.topDuplicateGroups[0]!.files.sort(),
      ['a/one.png', 'b/two.png']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const clip = (file: string, frames = 1) => ({
  frameWidth: 1, frameHeight: 1, frames, frameRate: 1,
  layers: [{ key: file.replace(/\W/g, '-'), file }]
});

async function runtimeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, 'assets', 'a'), { recursive: true });
  await fs.mkdir(path.join(root, 'content'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'assets', 'a', 'one.png'), png),
    fs.writeFile(path.join(root, 'assets', 'a', 'two.png'), png)
  ]);
  return root;
}

test('runtime report merges identical clips with the same frame layout', async () => {
  const root = await runtimeRoot('asset-report-runtime-');
  try {
    await fs.writeFile(path.join(root, 'content', 'world.json'), JSON.stringify({
      actors: [{
        id: 'a',
        clips: {
          'idle-south': clip('assets/a/one.png'),
          'idle-east': clip('assets/a/two.png')
        }
      }]
    }));
    const report = await reportAssets(root);
    assert.equal(report.runtime?.clipKeysBefore, 2);
    assert.equal(report.runtime?.clipKeysAfter, 1);
    assert.equal(report.runtime?.dedupedLayers, 1);
    assert.equal(report.runtime?.referencedFiles, 1);
    assert.equal(report.runtime?.referencedDecodedBytes, 4);
    assert.equal(report.runtime?.residualDuplicateGroups, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime report keeps clips whose frame counts differ and counts the residual duplicates', async () => {
  const root = await runtimeRoot('asset-report-residual-');
  try {
    await fs.writeFile(path.join(root, 'content', 'world.json'), JSON.stringify({
      actors: [{
        id: 'a',
        clips: {
          'idle-south': clip('assets/a/one.png', 1),
          'idle-east': clip('assets/a/two.png', 2)
        }
      }]
    }));
    const report = await reportAssets(root);
    assert.equal(report.runtime?.clipKeysAfter, 2);
    assert.equal(report.runtime?.referencedFiles, 2);
    assert.equal(report.runtime?.referencedDecodedBytes, 8);
    assert.equal(report.runtime?.residualDuplicateGroups, 1);
    assert.equal(report.runtime?.residualDuplicateFiles, 1);
    assert.equal(report.runtime?.residualDuplicateDecodedBytes, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
