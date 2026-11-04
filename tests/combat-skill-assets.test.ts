import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import { classEffects, effectAssets } from '../src/rendering/combat-asset-descriptors.ts';

const battle = JSON.parse(readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')) as BattleCatalog;
const darkKnight = battle.classes.find(character => character.id === 'dark-knight')!;
const attack = resolveBasicAttack(battle, { actor: darkKnight.actor, basicAttack: darkKnight.basicAttack });

function effectKeys(learned: readonly string[]): Set<string> {
  return new Set(effectAssets(classEffects(battle, darkKnight, attack, undefined, new Set(learned))).map(asset => asset.key));
}

test('a newly learned skill contributes its effects to the combat asset plan',()=>{
  assert.equal(effectKeys(['dark-strike']).has('spell-impact-default-0-'),false);
  const withGuardian = effectKeys(['dark-strike', 'guardian-of-darkness']);
  assert.ok(withGuardian.has('spell-impact-default-0-'),'守护黑暗的 spell-impact 必须进入素材计划');
  assert.ok(withGuardian.has('spell-impact-default-0-screen'));

  const withArmor = effectKeys(['dark-strike', 'molten-armor']);
  assert.ok(withArmor.has('molten-armor-aura-default-screen'),'熔岩护甲的光环必须进入素材计划');
  assert.ok(withArmor.has('shadow-veil-default-0-add'),'熔岩护甲的暗影帷幕必须进入素材计划');
});
