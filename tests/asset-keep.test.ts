import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectAssetKeep, normalizeAssetPath } from '../tools/asset-keep.ts';
import { archiveUnkeptFiles } from '../tools/prune-assets.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const contentDir = path.join(root, 'public/content');
const assetsDir = path.join(root, 'public/assets');

test('normalizeAssetPath keeps only assets paths', () => {
  assert.equal(normalizeAssetPath('assets/ui/app-icon.png'), 'assets/ui/app-icon.png');
  assert.equal(normalizeAssetPath('/assets/ui/app-icon.png'), 'assets/ui/app-icon.png');
  assert.equal(normalizeAssetPath('./assets/ui/app-icon.png'), 'assets/ui/app-icon.png');
  assert.equal(normalizeAssetPath('assets/ui/app-icon.png?v=123'), 'assets/ui/app-icon.png');
  assert.equal(normalizeAssetPath('content/world.json'), undefined);
  assert.equal(normalizeAssetPath('interface:assets/ui/menu-icons.png'), undefined);
  assert.equal(normalizeAssetPath(''), undefined);
});

test('collectAssetKeep keeps every runtime reference it can resolve', async () => {
  const report = await collectAssetKeep(contentDir, assetsDir);
  assert.deepEqual(report.missing, []);
  assert.ok(report.keep.size > 1000);
  assert.ok(report.covered.size > 0);

  for (const file of report.keep) {
    assert.ok(existsSync(path.join(assetsDir, file.replace(/^assets\//, ''))), `保留文件不存在：${file}`);
  }

  const required = [
    'assets/audio/bgm/BGM01.mp3',
    'assets/ui/app-icon.png',
    'assets/ui/app-icon-192.png',
    'assets/ui/app-icon-512.png',
    'assets/ui/loading-background.webp',
    'assets/ui/menu-ui-0.png',
    'assets/ui/menu-ui-0.json',
    'assets/ui/menu-icons.png',
    'assets/ui/menu-icons.json',
    'assets/ui/title-menu/background.png',
    'assets/ui/title-menu/logo.png',
    'assets/ui/story-classes/background.png',
    'assets/ui/status/player-frame.png',
    'assets/ui/items/money-ground.png',
    'assets/ui/items/pickup-money-gold.png',
    'assets/ui/items/pickup-money-silver.png',
    'assets/ui/items/pickup-money-copper.png',
    'assets/wardrobe/parts-0.png',
    'assets/wardrobe/parts-1.png',
    'assets/effect-atlas/effects-0.png',
    'assets/props/atlas/props-0.png',
  ];
  for (const file of required) assert.ok(report.keep.has(file), `缺少关键素材：${file}`);

  const world = JSON.parse(await readFile(path.join(contentDir, 'world.json'), 'utf8')) as {
    maps: { id: string }[];
  };
  const firstMap = world.maps[0]!;
  const ground = `assets/maps/${firstMap.id}/ground.png`;
  if (existsSync(path.join(assetsDir, ground.replace(/^assets\//, ''))))
    assert.ok(report.keep.has(ground), `缺少地图地面：${ground}`);

  const battle = JSON.parse(await readFile(path.join(contentDir, 'battle.json'), 'utf8')) as {
    skills: Record<string, { icon?: string }>;
  };
  const skillIcons = Object.values(battle.skills).map(skill => skill.icon).filter((file): file is string => !!file);
  assert.ok(skillIcons.length > 0);
  for (const icon of skillIcons) assert.ok(report.keep.has(icon), `缺少技能图标：${icon}`);

  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  const manifest = await readFile(path.join(root, 'public/manifest.webmanifest'), 'utf8');
  const urls = [
    ...[...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map(match => match[1]!),
    ...[...manifest.matchAll(/"src":"(assets\/[^"]+)"/g)].map(match => match[1]!),
  ];
  for (const url of urls) {
    const file = normalizeAssetPath(url);
    assert.ok(file && report.keep.has(file), `入口文件引用了未保留的素材：${url}`);
  }
});

test('archiveUnkeptFiles moves unkept assets and records the reason', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'inoita-assets-'));
  try {
    const source = path.join(temp, 'assets');
    const archive = path.join(temp, 'archive');
    await mkdir(path.join(source, 'ui'), { recursive: true });
    await writeFile(path.join(source, 'ui/keep.png'), 'keep');
    await writeFile(path.join(source, 'ui/drop.png'), 'drop');
    await writeFile(path.join(source, 'other.bin'), 'other');

    const result = archiveUnkeptFiles({
      assetsDir: source,
      archiveDir: archive,
      keep: new Set(['assets/ui/keep.png', 'assets/other.bin']),
      covered: new Map([['assets/ui/drop.png', 'ui-atlas']]),
    });

    assert.equal(result.keptFiles, 2);
    assert.equal(result.archivedFiles, 1);
    assert.deepEqual(result.reasons, { 'ui-atlas': { files: 1, bytes: 4 } });
    assert.ok(existsSync(path.join(source, 'ui/keep.png')));
    assert.ok(existsSync(path.join(source, 'other.bin')));
    assert.equal(existsSync(path.join(source, 'ui/drop.png')), false);
    assert.equal(await readFile(path.join(archive, 'assets/ui/drop.png'), 'utf8'), 'drop');

    const report = JSON.parse(await readFile(path.join(archive, 'report.json'), 'utf8')) as {
      archived: { files: number };
      reasons: Record<string, { files: number }>;
    };
    assert.equal(report.archived.files, 1);
    assert.equal(report.reasons['ui-atlas']?.files, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('archiveUnkeptFiles dry run leaves files in place', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'inoita-assets-'));
  try {
    const source = path.join(temp, 'assets');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'drop.png'), 'drop');
    const archive = path.join(temp, 'archive');
    const result = archiveUnkeptFiles({
      assetsDir: source, archiveDir: archive, keep: new Set(), dryRun: true,
    });
    assert.equal(result.archivedFiles, 1);
    assert.ok(existsSync(path.join(source, 'drop.png')));
    assert.equal(existsSync(path.join(archive, 'assets/drop.png')), false);
    assert.equal(existsSync(path.join(archive, 'report.json')), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
