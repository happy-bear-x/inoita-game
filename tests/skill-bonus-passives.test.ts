import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  skillForGrowth,
  type BattleCatalog,
  type SkillDefinition,
  type SkillGrowthProfile,
} from '../src/domain/battle.ts';
import {passiveModifiers, type PassiveModifier} from '../src/domain/passive-skills.ts';
import type {CompanionGroupEffect} from '../src/domain/companion-progression.ts';
import {memberCombatModifiers, partyCombatModifiers} from '../src/domain/party-combat.ts';
import {StorySkillProgression} from '../src/domain/story-skills.ts';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import {SKILL_POINT_ITEM} from '../src/domain/items.ts';
import {parseBattle, parseCharacterStats, parseItemCatalog} from '../src/application/content-validation.ts';

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));

const battle: BattleCatalog = parseBattle(read('battle'));
const items = parseItemCatalog(read('items'));
const stats = parseCharacterStats(read('character-stats'));

type PassiveUnit = NonNullable<SkillDefinition['passiveUnits']>[number];
interface PassiveRow {
  skillId: string;
  attribute: PassiveUnit['attribute'];
  condition: PassiveUnit['condition'];
  ranks: PassiveUnit['ranks'];
}

const GROWTH_PROFILES: readonly SkillGrowthProfile[] = ['hero', 'companion'];

function characterOf(classId: string) {
  const character = battle.classes.find(entry => entry.id === classId);
  assert.ok(character, classId);
  return character;
}

function startsWithPassiveUnits(classId: string): string[] {
  return characterOf(classId).skills.filter(id => 'passiveUnits' in battle.skills[id]!);
}

/** 内容里挂载的被动条目，按职业技能顺序展开；测试期望只从这里取。 */
function passiveRows(classId: string, growth: SkillGrowthProfile): PassiveRow[] {
  const rows: PassiveRow[] = [];
  for (const skillId of characterOf(classId).skills) {
    const skill = skillForGrowth(battle.skills[skillId]!, growth);
    for (const unit of skill.passiveUnits ?? []) {
      rows.push({skillId, attribute: unit.attribute, condition: unit.condition, ranks: unit.ranks});
    }
  }
  return rows;
}

function conditionMatches(condition: PassiveUnit['condition'], weaponKind: string, stealthed: boolean): boolean {
  if (condition === 'always') return true;
  if (condition === 'stealthed') return stealthed;
  if (condition === 'weapon-two-handed') return weaponKind === 'two-handed';
  if (condition === 'weapon-short-or-long-sword') {
    return weaponKind === 'dagger' || weaponKind === 'shortsword' || weaponKind === 'longsword';
  }
  return condition === 'weapon-mace' && weaponKind === 'mace';
}

function expectedModifiers(
  rows: readonly PassiveRow[],
  levels: Record<string, number>,
  weaponKind: string,
  stealthed: boolean,
): PassiveModifier[] {
  const result: PassiveModifier[] = [];
  for (const row of rows) {
    const rank = levels[row.skillId] ?? 0;
    if (rank <= 0 || !conditionMatches(row.condition, weaponKind, stealthed)) continue;
    result.push({attribute: row.attribute, operation: row.ranks[Math.min(7, rank - 1)]!});
  }
  return result;
}

const WEAPON_KINDS: string[] = ['unarmed', 'shortsword'];
for (const item of Object.values(items.items)) {
  if (item.equipment?.slot === 'main-hand' && !WEAPON_KINDS.includes(item.kind)) WEAPON_KINDS.push(item.kind);
}
WEAPON_KINDS.sort();

const ARMOR_KINDS = ['', 'cloth', 'leather', 'plate', 'robe'] as const;

const ALL_GROUP_EFFECTS: readonly CompanionGroupEffect[] = [
  'low-health-resistance', 'sword-damage', 'plate-defense', 'ancient-legendary-chance',
  'sell-price', 'critical-stun-chance', 'leather-physical-damage', 'chest-quality',
  'magic-damage', 'cloth-magic-damage', 'magic-resistance', 'scroll-drop', 'buy-discount',
  'blunt-stun-chance', 'experience', 'rare-recruit-chance', 'potion-recovery', 'bow-damage',
  'critical-damage', 'material-drop', 'status-resistance', 'two-hand-damage',
  'potion-cooldown-ms', 'equipment-drop',
];

const COMBAT_GROUP_EFFECTS: ReadonlySet<CompanionGroupEffect> = new Set([
  'low-health-resistance', 'sword-damage', 'plate-defense', 'leather-physical-damage',
  'cloth-magic-damage', 'bow-damage', 'two-hand-damage', 'magic-damage', 'magic-resistance',
  'critical-damage',
]);

/** 每个战斗类佣兵团技能给一个能互相区分的值，方便同时核对顺序与归属。 */
const COMBAT_EFFECT_VALUES = {
  'low-health-resistance': 101,
  'sword-damage': 102,
  'plate-defense': 103,
  'leather-physical-damage': 104,
  'cloth-magic-damage': 105,
  'bow-damage': 106,
  'two-hand-damage': 107,
  'magic-damage': 108,
  'magic-resistance': 109,
  'critical-damage': 110,
} satisfies Partial<Record<CompanionGroupEffect, number>>;

const add = (attribute: PassiveModifier['attribute'], amount: number): PassiveModifier =>
  ({attribute, operation: {kind: 'add', amount}});

const investedAt = (skill: SkillDefinition, rank: number): number => {
  if (rank <= 0) return 0;
  const entry = skill.ranks[rank - 1]!;
  return entry.investedSkillPoints ?? skill.ranks.slice(0, rank).reduce((sum, value) => sum + value.pointCost, 0);
};

function createProgression(classId = 'dark-knight') {
  const hero = new BattleCharacter(classId, stats, items);
  const skills = new StorySkillProgression(hero, battle);
  hero.setSkillUseHandler((item, skillId) => skills.applyItem(item, skillId));
  return {hero, skills};
}

function levelTo(hero: BattleCharacter, targetLevel: number): void {
  while (hero.level < targetLevel) {
    const needed = hero.catalog.experience[hero.level - 1];
    if (typeof needed !== 'number') assert.fail(`缺少 ${hero.level} 级升级经验`);
    hero.addExperience(needed);
  }
  assert.equal(hero.level, targetLevel);
}

// ---------------------------------------------------------------------------
// 1. 被动内容与全矩阵
// ---------------------------------------------------------------------------

test('content exposes 37 passive-unit skills and every growth profile keeps eight ranks', () => {
  const classSkillIds = battle.classes.flatMap(character => startsWithPassiveUnits(character.id));
  assert.equal(classSkillIds.length, 37);
  assert.equal(new Set(classSkillIds).size, 37);
  const nonEmpty = classSkillIds.filter(id => battle.skills[id]!.passiveUnits!.length > 0);
  assert.equal(nonEmpty.length, 20);
  const empty = classSkillIds.filter(id => battle.skills[id]!.passiveUnits!.length === 0);
  assert.equal(empty.length, 17);
  const unitCount = classSkillIds.reduce((sum, id) => sum + battle.skills[id]!.passiveUnits!.length, 0);
  assert.equal(unitCount, 27);
  const conditions = new Set(classSkillIds.flatMap(id => battle.skills[id]!.passiveUnits!.map(unit => unit.condition)));
  assert.deepEqual([...conditions].sort(),
    ['always', 'stealthed', 'weapon-mace', 'weapon-short-or-long-sword', 'weapon-two-handed']);
  for (const growth of GROWTH_PROFILES) {
    for (const id of classSkillIds) {
      const skill = skillForGrowth(battle.skills[id]!, growth);
      assert.ok(skill.passiveUnits, `${growth}/${id}`);
      for (const unit of skill.passiveUnits) {
        assert.equal(unit.ranks.length, 8, `${growth}/${id}/${unit.attribute}/${unit.condition}`);
      }
    }
  }
});

test('companion growth takes passiveUnits, ranks and action from the raw companion field', () => {
  for (const skillId of ['twin-blade', 'shadow-phantom', 'deep-breath', 'weapon-specializing']) {
    const raw = battle.skills[skillId]!;
    const companion = raw.companion;
    assert.ok(companion, skillId);
    const grown = skillForGrowth(raw, 'companion');
    assert.deepEqual(grown.passiveUnits, companion.passiveUnits, `${skillId}/passiveUnits`);
    assert.notDeepEqual(grown.passiveUnits, raw.passiveUnits, `${skillId}/不是主角表`);
    assert.deepEqual(grown.ranks, companion.ranks, `${skillId}/ranks`);
    assert.notDeepEqual(grown.ranks, raw.ranks, `${skillId}/不是主角等级表`);
    assert.deepEqual(grown.action, companion.action, `${skillId}/action`);
    assert.equal(grown.requiredInvestedSkillPoints, companion.requiredInvestedSkillPoints, `${skillId}/投资门槛`);
    assert.equal(skillForGrowth(raw, 'hero'), raw, `${skillId}/主角直接返回原表`);
  }
  const whist = battle.skills['whist']!;
  const companionWhist = skillForGrowth(whist, 'companion');
  assert.equal(whist.kind, 'active');
  assert.notDeepEqual(companionWhist.action, whist.action, 'whist/伙伴动作不同');
  assert.deepEqual(companionWhist.action, whist.companion!.action, 'whist/动作来自伙伴字段');
});

test('companion growth changes the actual modifier values from the hero table', () => {
  // 期望用绝对数值写死；如果 skillForGrowth 永远返回主角表，下面四条伙伴值都会失败。
  const cases = [
    {classId: 'assassin', skillId: 'twin-blade', weapon: 'longsword', stealthed: false,
      attribute: 'offhandAttackChance', hero: 30, companion: 40},
    {classId: 'assassin', skillId: 'shadow-phantom', weapon: 'dagger', stealthed: true,
      attribute: 'criticalRate', hero: 170, companion: 130},
    {classId: 'assassin', skillId: 'deep-breath', weapon: 'dagger', stealthed: false,
      attribute: 'deepBreathDurationBonus', hero: 20, companion: 10},
    {classId: 'warrior', skillId: 'weapon-specializing', weapon: 'two-handed', stealthed: false,
      attribute: 'physicalDamageRate', hero: 30, companion: 40},
  ] as const;
  for (const entry of cases) {
    const levels = {[entry.skillId]: 1};
    const hero = passiveModifiers(battle, entry.classId, {levels}, entry.weapon, entry.stealthed, 'hero');
    const companion = passiveModifiers(battle, entry.classId, {levels}, entry.weapon, entry.stealthed, 'companion');
    assert.deepEqual(hero.find(modifier => modifier.attribute === entry.attribute), {
      attribute: entry.attribute, operation: {kind: 'add', amount: entry.hero},
    }, `${entry.skillId}/hero`);
    assert.deepEqual(companion.find(modifier => modifier.attribute === entry.attribute), {
      attribute: entry.attribute, operation: {kind: 'add', amount: entry.companion},
    }, `${entry.skillId}/companion`);
    assert.notEqual(entry.hero, entry.companion, `${entry.skillId}/两套表确实不同`);
  }
});

for (const character of battle.classes) {
  test(`passive modifiers match content for every learned ${character.id} rank, weapon, stealth and growth`, () => {
    const skillIds = startsWithPassiveUnits(character.id)
      .filter(id => battle.skills[id]!.passiveUnits!.length > 0);
    for (const growth of GROWTH_PROFILES) {
      const rows = passiveRows(character.id, growth);
      for (const weaponKind of WEAPON_KINDS) {
        for (const stealthed of [false, true]) {
          for (const skillId of skillIds) {
            for (let rank = 1; rank <= 8; rank++) {
              const levels = {[skillId]: rank};
              const actual = passiveModifiers(battle, character.id, {levels}, weaponKind, stealthed, growth);
              const expected = expectedModifiers(rows, levels, weaponKind, stealthed);
              assert.deepEqual(actual, expected,
                `${character.id}/${growth}/${skillId} rank=${rank} weapon=${weaponKind} stealthed=${stealthed}`);
            }
          }
        }
      }
    }
  });
}

test('the seventeen empty passiveUnits arrays never produce modifiers', () => {
  const emptyIds = battle.classes.flatMap(character => startsWithPassiveUnits(character.id)
    .filter(id => battle.skills[id]!.passiveUnits!.length === 0));
  assert.equal(emptyIds.length, 17);
  for (const character of battle.classes) {
    const ids = startsWithPassiveUnits(character.id)
      .filter(id => battle.skills[id]!.passiveUnits!.length === 0);
    for (const growth of GROWTH_PROFILES) {
      for (const weaponKind of WEAPON_KINDS) {
        for (const stealthed of [false, true]) {
          for (const skillId of ids) {
            for (let rank = 1; rank <= 8; rank++) {
              assert.deepEqual(
                passiveModifiers(battle, character.id, {levels: {[skillId]: rank}}, weaponKind, stealthed, growth),
                [],
                `${character.id}/${growth}/${skillId} rank=${rank} weapon=${weaponKind} stealthed=${stealthed}`,
              );
            }
          }
        }
      }
    }
  }
});

test('passive modifiers keep class skill order when several skills are learned at different ranks', () => {
  for (const character of battle.classes) {
    const levels = Object.fromEntries(character.skills.map((id, index) => [id, index % 8 + 1]));
    for (const growth of GROWTH_PROFILES) {
      const rows = passiveRows(character.id, growth);
      for (const weaponKind of WEAPON_KINDS) {
        for (const stealthed of [false, true]) {
          assert.deepEqual(
            passiveModifiers(battle, character.id, {levels}, weaponKind, stealthed, growth),
            expectedModifiers(rows, levels, weaponKind, stealthed),
            `${character.id}/${growth}/${weaponKind}/stealthed=${stealthed}`,
          );
        }
      }
    }
  }
});

test('two passive skills activate together in class skill order with absolute values', () => {
  // dark-knight 技能顺序：improved-defense 在 blood-sword 之前。
  assert.deepEqual(passiveModifiers(battle, 'dark-knight', {
    levels: {'improved-defense': 2, 'blood-sword': 3},
  }, 'unarmed'), [
    {attribute: 'defense', operation: {kind: 'increase-thousandth', ratePerThousand: 101}},
    {attribute: 'evasionBonus', operation: {kind: 'add', amount: 25}},
    {attribute: 'magicDamageRate', operation: {kind: 'add', amount: 180}},
  ]);
  // warrior 技能顺序：skin-of-steel 在 soul-s-thirst 之前。
  assert.deepEqual(passiveModifiers(battle, 'warrior', {
    levels: {'skin-of-steel': 1, 'soul-s-thirst': 2},
  }, 'unarmed'), [
    {attribute: 'physicalResistanceBonus', operation: {kind: 'add', amount: 45}},
    {attribute: 'magicResistance', operation: {kind: 'add', amount: 45}},
    {attribute: 'bloodThirstChance', operation: {kind: 'add', amount: 70}},
    {attribute: 'bloodThirstManaRecovery', operation: {kind: 'add', amount: 9}},
  ]);
});

test('unlearned, foreign, unknown-class and above-table ranks follow the passive lookup rules', () => {
  assert.deepEqual(passiveModifiers(battle, 'warrior', {levels: {'skin-of-steel': 0}}, 'unarmed'), []);
  assert.deepEqual(passiveModifiers(battle, 'warrior', {levels: {}}, 'unarmed'), []);
  assert.deepEqual(passiveModifiers(battle, 'warrior', {levels: {'improved-defense': 8}}, 'unarmed'), []);
  assert.deepEqual(passiveModifiers(battle, 'assassin', {levels: {'skin-of-steel': 8}}, 'dagger'), []);
  assert.deepEqual(passiveModifiers(battle, 'no-such-class', {levels: {'skin-of-steel': 8}}, 'unarmed'), []);

  const divineArms = skillForGrowth(battle.skills['divine-arms']!, 'hero').passiveUnits!;
  for (const growth of GROWTH_PROFILES) {
    const rows = passiveRows('priest', growth).filter(row => row.skillId === 'divine-arms');
    for (const rank of [8, 9, 100]) {
      for (const weaponKind of ['mace', 'unarmed']) {
        const levels = {'divine-arms': rank};
        const actual = passiveModifiers(battle, 'priest', {levels}, weaponKind, false, growth);
        const expected = expectedModifiers(rows, levels, weaponKind, false);
        assert.deepEqual(actual, expected, `${growth}/rank=${rank}/${weaponKind}`);
        if (rank >= 8) {
          // 超过普通 8 级表时只重复最后一级，不会报错或返回空。
          assert.equal(actual.length, weaponKind === 'mace' ? 3 : 1);
          assert.deepEqual(actual, passiveModifiers(battle, 'priest',
            {levels: {'divine-arms': 8}}, weaponKind, false, growth));
        }
      }
    }
  }
  // 被动表本身确实是 8 行；这里用内容对象再确认一次，避免上面的循环掩盖缺行。
  assert.equal(divineArms.every(unit => unit.ranks.length === 8), true);
});

// ---------------------------------------------------------------------------
// 2. 佣兵团技能与成员修正
// ---------------------------------------------------------------------------

test('party combat modifiers append conditional effects in native order', () => {
  assert.deepEqual(partyCombatModifiers(COMBAT_EFFECT_VALUES, 'longsword', 'plate', 10, 100), [
    add('physicalResistanceBonus', 101),
    add('magicResistance', 101),
    add('physicalDamageRate', 102),
    add('magicDamageRate', 102),
    add('defenseRate', 103),
    add('magicDamageRate', 108),
    add('magicResistance', 109),
    add('criticalDamage', 110),
  ]);
});

test('party combat modifiers match every weapon and armor kind without false positives', () => {
  const healthStates = [10, 100];
  for (const weaponKind of WEAPON_KINDS) {
    for (const armorKind of ARMOR_KINDS) {
      for (const health of healthStates) {
        // longsword 的剑之达人排在护甲之前；弓、弩和双手排在护甲之后。
        const swordBeforeArmor = weaponKind === 'longsword'
          ? [add('physicalDamageRate', 102), add('magicDamageRate', 102)]
          : [];
        const weaponAfterArmor = weaponKind === 'bow' || weaponKind === 'crossbow'
          ? [add('physicalDamageRate', 106)]
          : weaponKind === 'two-handed'
            ? [add('physicalDamageRate', 107)]
            : [];
        const armor = armorKind === 'plate'
          ? [add('defenseRate', 103)]
          : armorKind === 'leather'
            ? [add('physicalDamageRate', 104)]
            : armorKind === 'cloth'
              ? [add('magicDamageRate', 105)]
              : [];
        const lowHealth = health <= Math.floor(100 * 30 / 100)
          ? [add('physicalResistanceBonus', 101), add('magicResistance', 101)]
          : [];
        const expected = [
          ...lowHealth,
          ...swordBeforeArmor,
          ...armor,
          ...weaponAfterArmor,
          add('magicDamageRate', 108),
          add('magicResistance', 109),
          add('criticalDamage', 110),
        ];
        assert.deepEqual(partyCombatModifiers(COMBAT_EFFECT_VALUES, weaponKind, armorKind, health, 100), expected,
          `${weaponKind}/${armorKind}/health=${health}`);
      }
    }
  }
});

test('low-health resistance uses the inclusive integer thirty percent boundary', () => {
  const effects: Partial<Record<CompanionGroupEffect, number>> = {'low-health-resistance': 100};
  const cases: readonly [number, number, boolean][] = [
    [100, 30, true], [100, 31, false],
    [101, 30, true], [101, 31, false],
    [99, 29, true], [99, 30, false],
    [1, 0, true],
  ];
  for (const [maxHealth, health, active] of cases) {
    assert.deepEqual(
      partyCombatModifiers(effects, 'dagger', '', health, maxHealth),
      active ? [add('physicalResistanceBonus', 100), add('magicResistance', 100)] : [],
      `health=${health}/maxHealth=${maxHealth}`,
    );
  }
});

test('party combat modifiers skip zero and missing effect values', () => {
  const zero: Partial<Record<CompanionGroupEffect, number>> = Object.fromEntries(
    ALL_GROUP_EFFECTS.map(key => [key, 0]),
  );
  assert.deepEqual(partyCombatModifiers(zero, 'longsword', 'plate', 1, 100), []);
  assert.deepEqual(partyCombatModifiers({}, 'longsword', 'plate', 1, 100), []);
  const onlyUnconditional: Partial<Record<CompanionGroupEffect, number>> = {'magic-damage': 0};
  assert.deepEqual(partyCombatModifiers(onlyUnconditional, 'dagger', '', 100, 100), []);
});

test('every CompanionGroupEffect is either wired to a combat trigger or inert', () => {
  assert.equal(ALL_GROUP_EFFECTS.length, 24);
  assert.equal(new Set(ALL_GROUP_EFFECTS).size, 24);
  for (const key of COMBAT_GROUP_EFFECTS) assert.ok(ALL_GROUP_EFFECTS.includes(key), key);
  // 非战斗类佣兵团技能（掉落、商店、经验等）不参与常驻战斗修正，任何装备与血量下都不产生条目。
  for (const key of ALL_GROUP_EFFECTS) {
    if (COMBAT_GROUP_EFFECTS.has(key)) continue;
    for (const weaponKind of WEAPON_KINDS) {
      for (const armorKind of ARMOR_KINDS) {
        for (const health of [30, 31]) {
          const effects: Partial<Record<CompanionGroupEffect, number>> = {[key]: 9};
          assert.deepEqual(partyCombatModifiers(effects, weaponKind, armorKind, health, 100), [],
            `${key}/${weaponKind}/${armorKind}/${health}`);
        }
      }
    }
  }
});

test('member combat modifiers put class passives before group effects and forward state', () => {
  const skinRows = passiveRows('warrior', 'hero').filter(row => row.skillId === 'skin-of-steel');
  const classPassives = skinRows.map(row => ({attribute: row.attribute, operation: row.ranks[0]!}));
  const party = [
    add('physicalResistanceBonus', 101),
    add('magicResistance', 101),
    add('physicalDamageRate', 102),
    add('magicDamageRate', 102),
    add('defenseRate', 103),
    add('magicDamageRate', 108),
    add('magicResistance', 109),
    add('criticalDamage', 110),
  ];
  assert.deepEqual(memberCombatModifiers({
    catalog: battle, classId: 'warrior', loadout: {levels: {'skin-of-steel': 1}},
    weaponKind: 'longsword', armorKind: 'plate', health: 10, maxHealth: 100,
    groupEffects: COMBAT_EFFECT_VALUES,
  }), [...classPassives, ...party]);

  // 伙伴成长表用 twin-blade 的第一级和主角表区分；潜行条件用 shadow-phantom 验证。
  const companionTwin = passiveRows('assassin', 'companion').filter(row => row.skillId === 'twin-blade');
  assert.deepEqual(memberCombatModifiers({
    catalog: battle, classId: 'assassin', loadout: {levels: {'twin-blade': 1}},
    weaponKind: 'longsword', armorKind: '', health: 100, maxHealth: 100,
    groupEffects: {}, growth: 'companion',
  }), companionTwin.map(row => ({attribute: row.attribute, operation: row.ranks[0]!})));

  const companionShadow = passiveRows('assassin', 'companion').find(row => row.skillId === 'shadow-phantom')!;
  assert.deepEqual(memberCombatModifiers({
    catalog: battle, classId: 'assassin', loadout: {levels: {'shadow-phantom': 1}},
    weaponKind: 'dagger', armorKind: '', health: 100, maxHealth: 100,
    groupEffects: {}, stealthed: true, growth: 'companion',
  }), [{attribute: companionShadow.attribute, operation: companionShadow.ranks[0]!}]);
  assert.deepEqual(memberCombatModifiers({
    catalog: battle, classId: 'assassin', loadout: {levels: {'shadow-phantom': 1}},
    weaponKind: 'dagger', armorKind: '', health: 100, maxHealth: 100,
    groupEffects: {}, stealthed: false, growth: 'companion',
  }), []);

  const heroShadow = passiveRows('assassin', 'hero').find(row => row.skillId === 'shadow-phantom')!;
  assert.deepEqual(memberCombatModifiers({
    catalog: battle, classId: 'assassin', loadout: {levels: {'shadow-phantom': 1}},
    weaponKind: 'dagger', armorKind: '', health: 100, maxHealth: 100,
    groupEffects: {}, stealthed: true,
  }), [{attribute: heroShadow.attribute, operation: heroShadow.ranks[0]!}]);
});

// ---------------------------------------------------------------------------
// 3. 技能点学习、技能书与重置
// ---------------------------------------------------------------------------

test('six classes start with only the starter active skill at rank one', () => {
  for (const character of battle.classes) {
    const {hero, skills} = createProgression(character.id);
    const starter = character.skills[0]!;
    const starterSkill = battle.skills[starter]!;
    assert.equal(starterSkill.kind, 'active');
    assert.equal(hero.level, 1);
    assert.equal(hero.skillPoints, 0);
    assert.equal(skills.points(), 0);
    assert.equal(skills.level(starter), 1);
    const levels = skills.draft(battle, character.id).levels;
    for (const id of character.skills) assert.equal(levels[id], id === starter ? 1 : 0);
    assert.equal(skills.investedPoints(), investedAt(starterSkill, 1));
    const invested = investedAt(starterSkill, 1);
    assert.deepEqual(skills.learningRequirements(starter), {
      level: 1,
      cost: starterSkill.ranks[1]!.pointCost,
      invested,
      requiredInvested: starterSkill.requiredInvestedSkillPoints ?? 0,
      atLimit: starterSkill.normalMaxLevel <= 1,
      conditionMet: invested >= (starterSkill.requiredInvestedSkillPoints ?? 0),
      pointsAvailable: false,
    });
    assert.match(skills.learningProblem(starter)!, /技能点/);
  }
});

test('each character level earns one point and learning spends the content rank cost', () => {
  const {hero, skills} = createProgression('dark-knight');
  levelTo(hero, 4);
  assert.equal(hero.skillPoints, (hero.level - 1) * stats.skillPointsPerLevel);
  const improved = battle.skills['improved-defense']!;
  const starter = battle.skills['dark-strike']!;
  assert.equal(skills.learn('improved-defense'), 1);
  assert.equal(hero.skillPoints, 3 - improved.ranks[0]!.pointCost);
  assert.equal(skills.investedPoints(), investedAt(starter, 1) + investedAt(improved, 1));
  assert.equal(skills.learn('improved-defense'), 2);
  assert.equal(hero.skillPoints, 3 - improved.ranks[0]!.pointCost - improved.ranks[1]!.pointCost);
  assert.equal(hero.skillPoints, 0);
  const invested = investedAt(starter, 1) + investedAt(improved, 2);
  assert.deepEqual(skills.learningRequirements('improved-defense'), {
    level: 2,
    cost: improved.ranks[2]!.pointCost,
    invested,
    requiredInvested: improved.requiredInvestedSkillPoints ?? 0,
    atLimit: false,
    conditionMet: true,
    pointsAvailable: false,
  });
  assert.match(skills.learningProblem('improved-defense')!, /需要 3 个技能点/);
});

test('required invested points gate cross-skill learning with cumulative content values', () => {
  const {hero, skills} = createProgression('dark-knight');
  levelTo(hero, 9);
  assert.equal(hero.skillPoints, 8);
  const phantom = battle.skills['phantom-clash']!;
  const darkStrike = battle.skills['dark-strike']!;
  assert.equal(phantom.requiredInvestedSkillPoints, 6);
  assert.equal(skills.learningRequirements('phantom-clash').conditionMet, false);
  assert.match(skills.learningProblem('phantom-clash')!, /投入6技能点/);
  assert.throws(() => skills.learn('phantom-clash'), /投入6技能点/);

  assert.equal(skills.learn('dark-strike'), 2);
  assert.equal(skills.investedPoints(), investedAt(darkStrike, 2));
  assert.equal(skills.learningRequirements('phantom-clash').conditionMet, false);
  assert.equal(skills.learn('dark-strike'), 3);
  assert.equal(skills.investedPoints(), investedAt(darkStrike, 3));
  assert.equal(skills.learningRequirements('phantom-clash').conditionMet, true);
  assert.equal(skills.learningProblem('phantom-clash'), undefined);

  assert.equal(skills.learn('phantom-clash'), 1);
  assert.equal(hero.skillPoints, 8 - darkStrike.ranks[1]!.pointCost - darkStrike.ranks[2]!.pointCost
    - phantom.ranks[0]!.pointCost);
  assert.equal(skills.investedPoints(), investedAt(darkStrike, 3) + investedAt(phantom, 1));
});

test('normal learning caps at normalMaxLevel while books reach eight and then stop', () => {
  const {hero, skills} = createProgression('dark-knight');
  levelTo(hero, 10);
  const skill = battle.skills['dark-strike']!;
  assert.equal(skill.normalMaxLevel, 4);
  assert.match(skills.bookProblem('dark-strike')!, /技能达到 4 级后才能使用技能书/);
  assert.throws(() => skills.book('dark-strike'), /技能达到 4 级后才能使用技能书/);
  for (let rank = 2; rank <= skill.normalMaxLevel; rank++) assert.equal(skills.learn('dark-strike'), rank);
  assert.equal(hero.skillPoints, 0);
  assert.match(skills.learningProblem('dark-strike')!, /普通学习上限/);
  assert.throws(() => skills.learn('dark-strike'), /普通学习上限/);
  assert.equal(skills.bookProblem('dark-strike'), undefined);

  const pointsAtCap = hero.skillPoints;
  for (let rank = skill.normalMaxLevel + 1; rank <= skill.ranks.length; rank++) {
    assert.equal(skills.book('dark-strike'), rank);
    assert.equal(hero.skillPoints, pointsAtCap, '技能书不消耗技能点');
  }
  assert.equal(skills.level('dark-strike'), 8);
  assert.equal(skills.investedPoints(), investedAt(skill, 8));
  assert.match(skills.bookProblem('dark-strike')!, /最高等级/);
  assert.throws(() => skills.book('dark-strike'), /最高等级/);
  assert.equal(skills.level('dark-strike'), 8);
});

test('normalMaxLevel three active and passive skills stop at three and books raise them to eight', () => {
  const {hero, skills} = createProgression('warrior');
  levelTo(hero, 60);
  // 先把累计投入堆到 30，解锁两个三级上限技能。
  for (let rank = 2; rank <= 4; rank++) assert.equal(skills.learn('rush-of-anger'), rank);
  for (let rank = 1; rank <= 4; rank++) assert.equal(skills.learn('weapon-specializing'), rank);
  for (let rank = 1; rank <= 4; rank++) assert.equal(skills.learn('skin-of-steel'), rank);
  assert.equal(skills.learn('blood-thirst'), 1);
  assert.equal(skills.investedPoints(), 30);

  const active = battle.skills['swirling-storm']!;
  const passive = battle.skills['insanity-thrills']!;
  assert.equal(active.kind, 'active');
  assert.equal(passive.kind, 'passive');
  assert.equal(active.normalMaxLevel, 3);
  assert.equal(passive.normalMaxLevel, 3);
  assert.equal(skills.learningRequirements('swirling-storm').requiredInvested, 30);
  assert.equal(skills.learningRequirements('insanity-thrills').requiredInvested, 30);
  assert.match(skills.bookProblem('swirling-storm')!, /技能达到 3 级后才能使用技能书/);
  assert.match(skills.bookProblem('insanity-thrills')!, /技能达到 3 级后才能使用技能书/);

  for (let rank = 1; rank <= 3; rank++) {
    assert.equal(skills.learn('swirling-storm'), rank);
    assert.equal(skills.learn('insanity-thrills'), rank);
  }
  for (const id of ['swirling-storm', 'insanity-thrills']) {
    assert.equal(skills.level(id), 3);
    assert.match(skills.learningProblem(id)!, /普通学习上限/);
    assert.throws(() => skills.learn(id), /普通学习上限/);
    assert.equal(skills.bookProblem(id), undefined);
  }
  assert.deepEqual(passiveModifiers(battle, 'warrior', {
    levels: {'insanity-thrills': 3},
  }, 'unarmed'), [{attribute: 'frenzyAttackChance', operation: {kind: 'add', amount: 270}}]);

  const pointsBeforeBooks = hero.skillPoints;
  for (const id of ['swirling-storm', 'insanity-thrills']) {
    for (let rank = 4; rank <= 8; rank++) assert.equal(skills.book(id), rank);
    assert.equal(skills.level(id), 8);
    assert.equal(skills.bookProblem(id), '技能已达到最高等级');
    assert.throws(() => skills.book(id), /最高等级/);
    assert.equal(hero.skillPoints, pointsBeforeBooks, `${id}/技能书不消耗技能点`);
  }
  assert.deepEqual(passiveModifiers(battle, 'warrior', {
    levels: {'insanity-thrills': 8},
  }, 'unarmed'), [{attribute: 'frenzyAttackChance', operation: {kind: 'add', amount: 370}}]);
});

test('elixirs grant points and the reset scroll clears ranks, points and shortcuts', () => {
  const {hero, skills} = createProgression('dark-knight');
  levelTo(hero, 6);
  assert.equal(hero.skillPoints, (hero.level - 1) * stats.skillPointsPerLevel);
  assert.equal(skills.learn('improved-defense'), 1);
  assert.equal(skills.learn('dark-strike'), 2);
  const afterLearning = hero.skillPoints;

  hero.bag.add(SKILL_POINT_ITEM);
  const elixir = hero.bag.entries.find(entry => entry.item === SKILL_POINT_ITEM);
  assert.ok(elixir);
  assert.equal(SKILL_POINT_ITEM, 'supreme-elixir');
  assert.equal(hero.bag.use(elixir.id).message, '获得 1 个技能点');
  assert.equal(hero.skillPoints, afterLearning + 1);
  assert.equal(hero.bag.count(SKILL_POINT_ITEM), 0);

  skills.setShortcutPage(hero.classId, 1);
  skills.bar().assign(1, 0, {kind: 'skill', id: 'improved-defense'});
  assert.equal(skills.shortcutPage(hero.classId), 1);
  const resetVersion = skills.resetVersion;
  const resetId = Object.entries(items.items).find(([, item]) => item.use?.kind === 'reset-skills')?.[0];
  assert.equal(resetId, 'skills-reset-spell');
  hero.bag.add(resetId!);
  const scroll = hero.bag.entries.find(entry => entry.item === resetId);
  assert.ok(scroll);
  assert.equal(hero.bag.use(scroll.id).message, '已初始化技能与技能点');
  assert.equal(hero.bag.count(resetId!), 0);
  assert.ok(skills.resetVersion > resetVersion);

  const levels = skills.draft(battle, hero.classId).levels;
  for (const id of characterOf(hero.classId).skills) assert.equal(levels[id], id === 'dark-strike' ? 1 : 0);
  assert.equal(skills.investedPoints(), investedAt(battle.skills['dark-strike']!, 1));
  assert.equal(hero.skillPoints, (hero.level - 1) * stats.skillPointsPerLevel);
  assert.equal(skills.shortcutPage(hero.classId), 0);
  assert.deepEqual(skills.bar().page(0), [
    {kind: 'skill', id: 'dark-strike'}, null, null, null, null,
    {kind: 'item', id: items.startingShortcut},
  ]);
  assert.deepEqual(skills.bar().page(1), [null, null, null, null, null, null]);
});

test('applyItem routes books, elixirs and reset scrolls through the same progression', () => {
  const {hero, skills} = createProgression('dark-knight');
  levelTo(hero, 11);

  assert.throws(() => skills.applyItem('skillbook'), /请选择本职业的技能/);
  assert.throws(() => skills.applyItem('skillbook', 'no-such-skill'), /请选择本职业的技能/);
  assert.throws(() => skills.applyItem('skillbook', 'skin-of-steel'), /请选择本职业的技能/);
  assert.throws(() => skills.applyItem('skillbook', 'improved-defense'), /技能达到 4 级后才能使用技能书/);

  for (let rank = 1; rank <= 4; rank++) assert.equal(skills.learn('improved-defense'), rank);
  const pointsBeforeBook = hero.skillPoints;
  assert.equal(skills.applyItem('skillbook', 'improved-defense'), '防御磨练提升至 5 级');
  assert.equal(skills.level('improved-defense'), 5);
  assert.equal(hero.skillPoints, pointsBeforeBook, '技能书不扣技能点');

  assert.equal(skills.applyItem('skills-reset-spell'), '已初始化技能与技能点');
  assert.equal(skills.level('improved-defense'), 0);
  assert.equal(hero.skillPoints, (hero.level - 1) * stats.skillPointsPerLevel);
  const beforeElixir = hero.skillPoints;
  assert.equal(skills.applyItem(SKILL_POINT_ITEM), '获得 1 个技能点');
  assert.equal(hero.skillPoints, beforeElixir + 1);
  assert.equal(skills.applyItem('skills-reset-spell'), '已初始化技能与技能点');
  assert.equal(hero.skillPoints, (hero.level - 1) * stats.skillPointsPerLevel);
});

test('repeated passive queries see new ranks without mutating earlier results', () => {
  const {hero, skills} = createProgression('dark-knight');
  levelTo(hero, 8);
  const before = passiveModifiers(battle, hero.classId, skills.draft(battle, hero.classId), 'unarmed');
  const beforeSnapshot = structuredClone(before);
  assert.deepEqual(before, []);

  assert.equal(skills.learn('improved-defense'), 1);
  const rankOne = passiveModifiers(battle, hero.classId, skills.draft(battle, hero.classId), 'unarmed');
  const improved = battle.skills['improved-defense']!;
  assert.deepEqual(rankOne, [
    {attribute: 'defense', operation: improved.passiveUnits![0]!.ranks[0]!},
    {attribute: 'evasionBonus', operation: improved.passiveUnits![1]!.ranks[0]!},
  ]);
  assert.deepEqual(before, beforeSnapshot, '先前的查询结果不应被后续学习改写');

  assert.equal(skills.learn('improved-defense'), 2);
  const rankTwo = passiveModifiers(battle, hero.classId, skills.draft(battle, hero.classId), 'unarmed');
  assert.deepEqual(rankTwo, [
    {attribute: 'defense', operation: improved.passiveUnits![0]!.ranks[1]!},
    {attribute: 'evasionBonus', operation: improved.passiveUnits![1]!.ranks[1]!},
  ]);
  assert.notDeepEqual(rankOne, rankTwo);
});

test('learning one hero does not leak into another hero or another class configuration', () => {
  const first = createProgression('dark-knight');
  const second = createProgression('dark-knight');
  const warrior = createProgression('warrior');
  levelTo(first.hero, 5);
  levelTo(second.hero, 5);
  levelTo(warrior.hero, 5);

  assert.equal(first.skills.learn('improved-defense'), 1);
  assert.equal(first.skills.investedPoints(), investedAt(battle.skills['dark-strike']!, 1)
    + investedAt(battle.skills['improved-defense']!, 1));
  assert.equal(second.skills.level('improved-defense'), 0);
  assert.equal(second.skills.investedPoints(), investedAt(battle.skills['dark-strike']!, 1));
  assert.equal(second.hero.skillPoints, 4);
  assert.equal(first.hero.skillPoints, 3);
  assert.deepEqual(passiveModifiers(battle, 'dark-knight',
    second.skills.draft(battle, 'dark-knight'), 'unarmed'), []);

  assert.throws(() => warrior.skills.level('improved-defense'), /请选择本职业的技能/);
  assert.throws(() => warrior.skills.learningRequirements('improved-defense'), /请选择本职业的技能/);
  assert.deepEqual(warrior.skills.draft(battle, 'warrior'), {
    levels: Object.fromEntries(characterOf('warrior').skills.map((id, index) => [id, index === 0 ? 1 : 0])),
  });
  assert.throws(() => first.skills.save(battle, 'warrior', warrior.skills.draft(battle, 'warrior')),
    /技能配置无效/);
  assert.throws(() => first.skills.draft(battle, 'no-such-class'), /职业不存在/);

  const forged = first.skills.draft(battle, 'dark-knight');
  forged.levels['improved-defense'] = 8;
  assert.throws(() => first.skills.save(battle, 'dark-knight', forged), /等级/);
  forged.levels['improved-defense'] = 1;
  assert.equal(first.skills.level('improved-defense'), 1, '草稿修改不能直接写回配置');
});
