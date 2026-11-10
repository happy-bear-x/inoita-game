import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { classEffects, effectAssets } from '../src/rendering/combat-asset-descriptors.ts';

const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;
const darkKnight = battle.classes.find(character => character.id === 'dark-knight')!;
const attack = resolveBasicAttack(battle, { actor: darkKnight.actor, basicAttack: darkKnight.basicAttack });

function effectFrames(learned: readonly string[]): Map<string, Set<string>> {
  const assets = effectAssets(classEffects(battle, darkKnight, attack, undefined, new Set(learned)));
  return new Map(assets.map(asset => [asset.key, new Set(asset.kind === 'atlas' ? asset.frames ?? [] : [])]));
}

function gainedFrames(base: Map<string, Set<string>>, extended: Map<string, Set<string>>): number {
  let gained = 0;
  for (const [key, frames] of extended)
    for (const frame of frames) if (!base.get(key)?.has(frame)) gained++;
  return gained;
}

test('a newly learned skill contributes its effects to the combat asset plan',()=>{
  const base = effectFrames(['dark-strike']);
  const withGuardian = effectFrames(['dark-strike', 'guardian-of-darkness']);
  assert.equal(base.has('effects-atlas:22'), false);
  assert.ok(withGuardian.has('effects-atlas:22'), '守护黑暗的特效必须进入素材计划');
  assert.ok(gainedFrames(base, withGuardian) > 0, '守护黑暗必须带来新的图集帧');

  const withArmor = effectFrames(['dark-strike', 'molten-armor']);
  assert.ok(withArmor.has('effects-atlas:22'), '熔岩护甲的特效必须进入素材计划');
  assert.ok(gainedFrames(base, withArmor) > 0, '熔岩护甲必须带来新的图集帧');
});
