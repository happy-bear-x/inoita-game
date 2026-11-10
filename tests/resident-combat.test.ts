import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  parseBattle, parseCompanions, parseWardrobe, parseWorld
} from '../src/application/content-validation.ts';
import type { ClipName } from '../src/domain/content.ts';
import { characterAssets } from '../src/rendering/combat-asset-descriptors.ts';
import { residentCombatCoverageGaps } from '../src/rendering/combat-visual-coverage.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';

const read = (file: string): any => JSON.parse(fs.readFileSync(new URL(`../public/content/${file}`, import.meta.url), 'utf8'));
const battle = parseBattle(read('battle.json'));
const wardrobe = parseWardrobe(read('wardrobe.json'));
const world = parseWorld(read('world.json'));
const companions = parseCompanions(read('companions.json'));

test('runtime resident resources only retain common combat feedback', () => {
  const full = residentCombatAssets({ battle, wardrobe, world, companions });
  const feedback = residentCombatAssets({ battle, wardrobe, world, companions, feedbackOnly: true });
  assert.equal(feedback.actorIds.size, 0);
  assert.ok(feedback.assets.length < full.assets.length);
  assert.ok(feedback.effectNames.has('state-sleep'));
  assert.ok(feedback.effectNames.has('state-stun'));
  assert.equal(feedback.effectNames.has('firestorm-swing'), false);
});

test('scoped resident packs keep only the active class and owned companion appearances', () => {
  const full = residentCombatAssets({ battle, wardrobe, world, companions });
  // 同一图集页在不同范围里会合并不同的帧集合；冲突检查只比较文件、页和帧布局。
  const layout = (asset: unknown): string => {
    const rest = { ...(asset as Record<string, unknown>) };
    delete rest.frames;
    return JSON.stringify(rest);
  };
  const fullByKey = new Map(full.assets.map(asset => [asset.key, layout(asset)]));
  const allCompanionActors = new Set(Object.values(companions.definitions).map(definition => definition.actor));
  assert.equal(allCompanionActors.size, 41);
  for (const actor of allCompanionActors) assert.ok(full.actorIds.has(actor), `全量包缺少伙伴 ${actor}`);
  const mercenaries = Object.values(companions.definitions)
    .filter(definition => (definition.source ?? 'mercenary') === 'mercenary');
  const owned = mercenaries.slice(0, 2);
  const ownedIds = owned.map(definition => definition.id);
  const ownedActors = new Set(owned.map(definition => definition.actor));
  const unownedActors = [...allCompanionActors].filter(actor => !ownedActors.has(actor));
  for (const character of battle.classes) {
    const scoped = residentCombatAssets({
      battle, wardrobe, world, companions, classIds: [character.id], ownedCompanionIds: ownedIds
    });
    assert.ok(scoped.actorIds.has(character.actor.id));
    for (const actor of ownedActors) assert.ok(scoped.actorIds.has(actor), `${character.id} missing owned companion ${actor}`);
    for (const actor of unownedActors)
      assert.equal(scoped.actorIds.has(actor), false, `${character.id} leaked unowned companion ${actor}`);
    for (const other of battle.classes) if (other.id !== character.id)
      assert.equal(scoped.actorIds.has(other.actor.id), false, `${character.id} leaked ${other.id}`);
    for (const asset of scoped.assets) {
      assert.equal(fullByKey.get(asset.key), layout(asset), `${character.id}: ${asset.key}`);
    }
    for (const effect of scoped.effectNames) assert.ok(full.effectNames.has(effect), `${character.id}: ${effect}`);
    assert.ok(scoped.effectNames.size < full.effectNames.size, `${character.id} did not narrow effects`);
    for (const asset of characterAssets(character.actor)) assert.ok(scoped.assets.some(value => value.key === asset.key), `${character.id}: ${asset.key}`);
    for (const skillId of character.skills)
      assert.ok(scoped.assets.some(value => value.key === battle.skills[skillId].icon), `${character.id}: icon ${skillId}`);
    const gaps = residentCombatCoverageGaps({
      battle, wardrobe, world, companions, classIds: [character.id], ownedCompanionIds: ownedIds
    });
    assert.deepEqual(gaps, { effects: [], layers: [], actorLayers: [], definitions: [], companions: [] }, character.id);
  }
});

test('unowned companions stay out of the resident pack until loaded on demand', () => {
  const allCompanionActors = new Set(Object.values(companions.definitions).map(definition => definition.actor));
  const none = residentCombatAssets({ battle, wardrobe, world, companions, ownedCompanionIds: [] });
  for (const actor of allCompanionActors) assert.equal(none.actorIds.has(actor), false, `未拥有伙伴不应常驻：${actor}`);
  assert.throws(() => residentCombatAssets({
    battle, wardrobe, world, companions, ownedCompanionIds: ['missing-companion']
  }), /伙伴不存在/);
});

test('an unknown or empty class scope is explicit, not silently full', () => {
  assert.throws(() => residentCombatAssets({ battle, wardrobe, world, companions, classIds: ['missing'] }), /职业不存在/);
  const empty = residentCombatAssets({ battle, wardrobe, world, companions, classIds: [] });
  for (const character of battle.classes) assert.equal(empty.actorIds.has(character.actor.id), false);
  assert.equal(empty.assets.some(asset => asset.key.includes('battle-')), false);
});

test('base-only class scope keeps base actions and excludes skill clips and icons', () => {
  const character = battle.classes.find((value: { id: string }) => value.id === 'dark-knight')!;
  const pack = residentCombatAssets({
    battle, wardrobe, world, companions, classIds: [character.id], ownedCompanionIds: [],
    baseOnlyClasses: true, learnedSkillIds: []
  });
  const keys = new Set(pack.assets.map(asset => asset.key));
  const baseClips = (Object.keys(character.actor.clips) as ClipName[]).filter(name => !name.startsWith('skill-'));
  const skillClips = (Object.keys(character.actor.clips) as ClipName[]).filter(name => name.startsWith('skill-'));
  // 图集按页共享：基础动作的页必须都在，技能动作不能额外带进只在技能里出现的页。
  const clipKeys = (names: ClipName[]): Set<string> =>
    new Set(characterAssets(character.actor, names).map(asset => asset.key));
  const baseKeys = clipKeys(baseClips), skillKeys = clipKeys(skillClips);
  for (const key of baseKeys) assert.ok(keys.has(key), `基础动作缺少 ${key}`);
  const skillOnly = [...skillKeys].filter(key => !baseKeys.has(key));
  assert.ok(skillOnly.length > 0, '至少有一个技能页不属于基础动作');
  for (const key of skillOnly) assert.equal(keys.has(key), false, `技能动作不应常驻 ${key}`);
  for (const skillId of character.skills)
    assert.equal(keys.has(battle.skills[skillId].icon), false, `icon ${skillId}`);
});

test('resident pack only carries effects for learned skills', () => {
  const character = battle.classes.find((value: { id: string }) => value.id === 'dark-knight')!;
  const starter = character.skills[0]!;
  const scope = { battle, wardrobe, world, companions, classIds: [character.id], ownedCompanionIds: [] as string[] };
  const before = residentCombatAssets({ ...scope, learnedSkillIds: [starter] });
  assert.ok(before.effectNames.has('heavy-dark-slash'), '初始技能的姿态特效应在常驻包中');
  assert.equal(before.effectNames.has('firestorm-swing'), false, '未学技能的姿态特效不应常驻');
  const gaps = residentCombatCoverageGaps({ ...scope, learnedSkillIds: [starter] });
  assert.deepEqual(gaps, { effects: [], layers: [], actorLayers: [], definitions: [], companions: [] });
  const after = residentCombatAssets({ ...scope, learnedSkillIds: [starter, 'firestorm'] });
  assert.ok(after.effectNames.has('firestorm-swing'), '学会新技能后应能加载对应特效');
  assert.ok(after.effectNames.size > before.effectNames.size);
});
