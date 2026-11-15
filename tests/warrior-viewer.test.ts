import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Facing } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import type { CostumePose, WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { actionChoices, compatibleOffhands, framePieces, Playback, PoseRepository,
  poseBounds, variantChoices, viewerRecipe, weaponChoices } from '../tools/warrior-viewer/model.ts';
import type { EquipmentSelection } from '../tools/warrior-viewer/model.ts';

const root = new URL('../public/', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(new URL('content/wardrobe.json', root), 'utf8')) as WardrobeCatalog;
const items = JSON.parse(fs.readFileSync(new URL('content/items.json', root), 'utf8')) as ItemCatalog;
const defaults = items.startingEquipment.warrior;
const directions: Facing[] = ['south', 'west', 'north', 'east'];

test('viewer includes all warrior skills, combo and frenzy poses, plus separate town movement', () => {
  for (const facing of directions) {
    const choices = actionChoices(catalog, items, defaults, facing, {});
    assert.equal(choices.filter(choice => choice.group === '主动技能').length, 9);
    assert.ok(choices.some(choice => choice.key === 'attack-3'));
    assert.ok(choices.some(choice => choice.key === 'frenzy-two-handed'));
    assert.equal(new Set(choices.map(choice => choice.key)).size, choices.length);
    const town = choices.find(choice => choice.key === 'town-walk')!;
    assert.equal(town.poseId, catalog.stances['unarmed:empty'][`walk-${facing}`]);
    assert.notEqual(town.poseId, choices.find(choice => choice.key === 'walk')!.poseId);
  }
});

test('weapons offer unique warrior appearances and only supported offhand combinations', () => {
  const main = weaponChoices(catalog, items);
  const signatures = main.map(choice => JSON.stringify([choice.kind, catalog.equipment[choice.id].main]));
  assert.equal(signatures.length, new Set(signatures).size);
  assert.ok(main.every(choice => items.items[choice.id].equipment!.classes.includes('warrior')));
  assert.deepEqual(compatibleOffhands(catalog, items, 'greatsword'), []);
  assert.ok(compatibleOffhands(catalog, items, 'dagger').some(choice => choice.kind === 'shield'));
  assert.ok(compatibleOffhands(catalog, items, 'dagger').some(choice => choice.kind === 'longsword'));
  assert.ok(compatibleOffhands(catalog, items).every(choice => choice.kind === 'shield'));
});

test('every available weapon stance resolves all four directions and every frame to valid atlas pieces', () => {
  const representatives = new Map<string, string | undefined>([['unarmed', undefined]]);
  for (const choice of weaponChoices(catalog, items)) representatives.set(choice.kind, choice.id);
  const sheets = new Map(catalog.textures.map(texture => {
    const bytes = fs.readFileSync(new URL(texture.file, root));
    return [texture.key, [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]];
  }));
  const seen = new Set<string>();
  for (const [mainKind, main] of representatives) {
    const offhands = new Map<string, string | undefined>([['empty', undefined]]);
    for (const choice of compatibleOffhands(catalog, items, main)) offhands.set(choice.kind, choice.id);
    for (const [offKind, off] of offhands) {
      const equipment: EquipmentSelection = {};
      if (main) equipment['main-hand'] = main;
      if (off) equipment['off-hand'] = off;
      const recipe = viewerRecipe(catalog, items, equipment, {});
      seen.add(`${mainKind}:${offKind}`);
      for (const facing of directions) for (const action of actionChoices(catalog, items, equipment, facing, {})) {
        const pose = catalog.poses[action.poseId];
        assert.ok(pose?.frames.length, action.poseId);
        assert.ok(pose.frameRate > 0);
        for (const frame of pose.frames) {
          const pieces = framePieces(catalog, recipe.variants, frame);
          assert.deepEqual(pieces.map(piece => piece.order), pieces.map(piece => piece.order).sort((a, b) => a - b));
          for (const { sprite } of pieces) {
            const sheet = sheets.get(sprite.texture)!;
            assert.ok(sheet, sprite.texture);
            assert.ok(sprite.x >= 0 && sprite.y >= 0);
            assert.ok(sprite.x + sprite.width <= sheet[0] && sprite.y + sprite.height <= sheet[1]);
          }
        }
      }
    }
  }
  assert.equal(seen.size, 27);
});

test('independent appearance overrides keep pose selection and original catalog intact', () => {
  const recipe = viewerRecipe(catalog, items, defaults, { 'coat-front': 'coat-front-style-2', 'head-front': null });
  assert.equal(recipe.variants['coat-front'], 'coat-front-style-2');
  assert.equal(recipe.variants['coat-back'], catalog.defaults['coat-back']);
  assert.equal(recipe.variants['head-front'], undefined);
  assert.equal(catalog.defaults['coat-front'], 'coat-front-style-1');
  const pose = catalog.poses[recipe.poses['attack-west']!];
  const entries = framePieces(catalog, recipe.variants, pose.frames[0]);
  assert.ok(!entries.some(piece => piece.part.part === 'head-front'));
  assert.ok(entries.some(piece => piece.part.part === 'coat-front'));
  const options = variantChoices(catalog, items, 'two-handed');
  assert.equal(options.length, 13);
  assert.equal(new Set(options.map(choice => choice.id)).size, options.length);
  assert.throws(() => framePieces(catalog, { body: 'missing' }, pose.frames[0]), /外观款式缺失/);
});

test('bounds use anchors and negative part scale, then mirror the entire pose', () => {
  const data = {
    variants: { base: ['test'] },
    sprites: { test: { texture: 'sheet', x: 0, y: 0, width: 6, height: 4, anchorX: 2, anchorY: 1 } },
  } as unknown as WardrobeCatalog;
  const pose: CostumePose = { mirrorX: false, frameRate: 10, frames: [[{
    part: 'body', piece: 0, x: 3, y: 4, angle: 0, scaleX: -1, scaleY: 1, alpha: 0.3,
  }]] };
  assert.deepEqual(poseBounds(data, { body: 'base' }, pose), { left: -1, right: 5, top: 0, bottom: 7 });
  assert.deepEqual(poseBounds(data, { body: 'base' }, { ...pose, mirrorX: true }),
    { left: -5, right: 1, top: 0, bottom: 7 });
  assert.equal(framePieces(data, { body: 'base' }, pose.frames[0])[0].part.alpha, 0.3);
});

test('playback preserves repeated source frames and supports pause, stepping, resume and speed changes', () => {
  const player = new Playback();
  player.configure(4, 10);
  assert.equal(player.advance(250), true);
  assert.equal(player.frame, 2);
  player.seek(3);
  assert.equal(player.advance(1000), false);
  assert.equal(player.frame, 3);
  player.toggle();
  player.advance(100);
  assert.equal(player.frame, 0);
  player.speed = 2;
  player.advance(50);
  assert.equal(player.frame, 1);
  player.seek(100);
  assert.equal(player.frame, 3);
  player.configure(2, 20);
  assert.equal(player.frame, 1);
  player.seek(-1);
  assert.equal(player.frame, 0);
});

test('split pose loading shares requests, supports full catalogs and retries failures', async () => {
  const sample = Object.values(catalog.poses)[0];
  const split = { ...catalog, poses: {} };
  let loads = 0;
  const repository = new PoseRepository(split, async url => {
    loads++;
    assert.ok(url.startsWith('/content/wardrobe/poses/'));
    if (loads === 1) throw new Error('load failed');
    return sample;
  });
  await assert.rejects(repository.get('test'), /load failed/);
  const [first, second] = await Promise.all([repository.get('test'), repository.get('test')]);
  assert.equal(first, second);
  assert.equal(loads, 2);
  await repository.get('test');
  assert.equal(loads, 2);
  const full = new PoseRepository(catalog, async () => { throw new Error('unexpected download'); });
  assert.equal(await full.get(Object.keys(catalog.poses)[0]), sample);
});
