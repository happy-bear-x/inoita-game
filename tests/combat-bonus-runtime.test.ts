import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleBuffEffect, BattleCatalog, SkillLoadout} from '../src/domain/battle.ts';
import type {BattleStatKey} from '../src/domain/battle-semantics.ts';
import {AttackProcExecutor, type AttackProcPort} from '../src/domain/attack-proc.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {resolveHitReactionPipeline, type HitReactionPort} from '../src/domain/combat-reaction-pipeline.ts';
import type {BuffReactionEvent} from '../src/domain/buff-reactions.ts';
import type {SkillReactionEvent} from '../src/domain/skill-reactions.ts';
import {
  magicNormalDamage, normalDamageForClass, physicalNormalDamage, type DamageAttributes,
} from '../src/domain/combat-damage-source.ts';
import type {AttackContact} from '../src/domain/combat.ts';
import {
  effectiveCharacterPanel, fighterBaseFromPanel, type CharacterPanel,
} from '../src/domain/character-stats.ts';
import {equipmentAttackProcs} from '../src/domain/equipment-attack-procs.ts';
import {equipmentCombatProcs} from '../src/domain/equipment-combat-procs.ts';
import {equipmentRecoveryModifiers} from '../src/domain/equipment-recovery.ts';
import {equipmentStateImmunity} from '../src/domain/equipment-state-immunity.ts';
import type {ItemInstance} from '../src/domain/items.ts';
import {memberCombatModifiers, partyCombatModifiers} from '../src/domain/party-combat.ts';
import type {PassiveModifier} from '../src/domain/passive-skills.ts';
import {
  calculateEffectiveDefense, calculateMagicResistance, rollMagicHit, rollPhysicalHit,
  type PhysicalFighter, type PhysicalHit,
} from '../src/domain/physical-hit.ts';
import {resolveStateApplication} from '../src/domain/state-application.ts';

const add = (attribute: BattleStatKey, amount: number): PassiveModifier => ({
  attribute, operation: {kind: 'add', amount},
});

const rollAt = (value: number) => () => (value + 0.5) / 1000;
const hitOf = (roll: number, attacker: PhysicalFighter, target: PhysicalFighter, baseDamage = 1000) =>
  rollPhysicalHit(attacker, target, rollAt(roll), baseDamage);
const magicHitOf = (
  roll: number, attacker: PhysicalFighter, target: PhysicalFighter, baseDamage = 1000, extraDamageRate = 0,
) => rollMagicHit(attacker, target, baseDamage, rollAt(roll), extraDamageRate);

let gearSerial = 0;
function gear(
  modifiers: {stat: string; value: number}[] = [],
  gemModifiers: {stat: string; value: number}[] = [],
): ItemInstance {
  gearSerial += 1;
  return {
    id: `gear-${gearSerial}`, item: 'fixture', quantity: 1, enhancement: 0, gems: [],
    numbers: {modifiers, gemModifiers, magicPercent: 0, sockets: 0, enhancementUses: 0},
  };
}

function buff(
  modifiers: BattleBuffEffect['modifiers'],
  overrides: Partial<BattleBuffEffect> = {},
): BattleBuffEffect {
  return {durationMs: 60000, tickMs: 0, states: [], periodic: [], modifiers, ...overrides};
}

function fighter(overrides: Partial<PhysicalFighter> = {}): PhysicalFighter {
  return {
    level: 10, physicalAttack: 1000, defense: 0, defenseRate: 0, physicalResistanceBonus: 0,
    magicAttack: 1000, maxHealth: 1000, hitBase: 100, hitBonus: 1000, evasionBase: 0,
    evasionBonus: 0, criticalRate: 0, criticalResistance: 0, criticalDamage: 1000,
    criticalDamageResistance: 0, weaponBlock: 0, shieldBlock: 0, physicalResistance: 0,
    magicResistance: 0, ...overrides,
  };
}

function rawPanel(overrides: Partial<CharacterPanel> = {}): CharacterPanel {
  return {
    attributes: {strength: 10, dexterity: 20, vitality: 30, intelligence: 40, mentality: 50},
    maxHealth: 1000, maxMana: 300, physicalAttack: 100, magicAttack: 80, criticalRate: 30,
    hitRate: 655, baseDefense: 100, baseMagicResistance: 800, criticalDamage: 1000,
    defense: 120, defenseRate: 200, physicalResistance: 315, magicResistance: 750,
    evasionRate: 200, weaponBlock: 30, shieldBlock: 40, offhandShield: true, hitBase: 100,
    hitBonus: 0, evasionBase: 20, evasionBonus: 0, criticalResistance: 0,
    criticalDamageResistance: 0, ...overrides,
  };
}

const contact: AttackContact = {casterId: 'hero', targetId: 'enemy'};

function reactionPort(overrides: Partial<HitReactionPort> = {}): HitReactionPort {
  return {
    conditions: new CombatConditions(), actorAttribute: () => 0,
    react: () => {}, reactToBuff: () => {}, lightningOfHellReaction: () => {},
    godOfJusticeReaction: () => {}, summonOwnerReactions: () => {}, disturbanceReaction: () => {},
    partySide: () => false, activePartySlots: () => [], partyRevengeReactions: () => {},
    equipmentRecovery: () => ({lifeDrainPerThousand: 0}), physicalSuccessEquipmentProcs: () => {},
    instantRecoveryOnMiss: () => {}, isTwoHanded: () => false, moltenReflection: () => {},
    holySacrificeTransfer: () => {}, attackProc: () => {}, ...overrides,
  };
}

function recordingPort(overrides: Partial<HitReactionPort> = {}) {
  const skillEvents: SkillReactionEvent[] = [];
  const buffEvents: BuffReactionEvent[] = [];
  const port = reactionPort({
    react: event => { skillEvents.push(event); },
    reactToBuff: event => { buffEvents.push(event); },
    ...overrides,
  });
  return {port, skillEvents, buffEvents};
}

function attackProcPort(overrides: Partial<AttackProcPort> = {}): AttackProcPort {
  return {
    readChance: () => 0, applyDamage: () => {}, applyBuff: () => {},
    fireSplash: () => 0, random: () => 0, ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 1. CombatConditions.fighter：基础值 + 被动 + Buff + 临时属性        */
/* ------------------------------------------------------------------ */

test('fighter combines panel bases, passives, buffs and temporary values once per attribute', () => {
  const conditions = new CombatConditions();
  const base: PhysicalFighter = {
    level: 10, physicalAttack: 100, defense: 100, defenseRate: 200, physicalResistanceBonus: 0,
    magicAttack: 40, maxHealth: 1000, hitBase: 100, hitBonus: 10, evasionBase: 20,
    evasionBonus: 30, criticalRate: 50, criticalResistance: 60, criticalDamage: 1000,
    criticalDamageResistance: 200, weaponBlock: 30, shieldBlock: 0, physicalResistance: 0,
    magicResistance: 100,
  };
  const passives: PassiveModifier[] = [
    add('physicalAttack', 50), add('magicAttack', 20), add('defense', 40), add('defenseRate', 100),
    add('physicalResistanceBonus', 50), add('magicResistance', 30), add('maxHealth', 100),
    add('hitBase', 10), add('hitBonus', 3), add('evasionBase', 5), add('evasionBonus', 15),
    add('criticalRate', 5), add('criticalDamage', 100), add('criticalResistance', 10),
    add('criticalDamageResistance', 20), add('weaponBlock', 7), add('shieldBlock', 25),
    add('physicalDamageRate', 100), add('magicDamageRate', 50), add('zealotRate', 100),
  ];
  conditions.applyBuff('hero', 'dark-strike', 1, buff([
    {attribute: 'physicalAttack', operation: {kind: 'add', amount: 25}},
    {attribute: 'weaponBlock', operation: {kind: 'add', amount: 5}},
    {attribute: 'maxHealth', operation: {kind: 'add', amount: 50}},
    {attribute: 'evasionBonus', operation: {kind: 'add', amount: 20}},
  ]));
  conditions.setTemporaryAttribute('hero', 'defenseRate', 900);
  conditions.setTemporaryAttribute('hero', 'criticalRate', 500);
  conditions.setTemporaryAttribute('hero', 'hitBonus', 77);
  conditions.setTemporaryAttribute('hero', 'stealthAttackEnabled', 1);
  conditions.setTemporaryAttribute('hero', 'stealthDamageRate', 300);

  const result = conditions.fighter('hero', base, passives, {offhandShield: true});

  // 物攻先合并被动与 Buff（100+50+25），再乘一次物伤与潜行增幅。
  assert.equal(result.physicalAttack, Math.trunc(175 * (1000 + 100 + 300) / 1000));
  assert.equal(result.physicalDamageRate, 100);
  assert.equal(result.magicAttack, 60);
  assert.equal(result.magicDamageRate, 50);
  // 防御率被显式临时值覆盖，不再叠加基础值与被动。
  assert.equal(result.defense, 140);
  assert.equal(result.defenseRate, 900);
  const effectiveDefense = Math.trunc(140 * (1000 + 900) / 1000);
  assert.equal(effectiveDefense, 266);
  // 物减 = 有效防御公式 + 被动物减，再按狂战士比例扣自身减伤。
  const beforeZealot = Math.trunc(1000 * effectiveDefense / (effectiveDefense + 20 * (10 + 3))) + 50;
  assert.equal(beforeZealot, 555);
  assert.equal(result.physicalResistance, beforeZealot - Math.trunc(beforeZealot * 100 / 1000));
  assert.equal(result.magicResistance, 130);
  assert.equal(result.maxHealth, 1150);
  assert.equal(result.hitBase, 110);
  assert.equal(result.hitBonus, 77);
  assert.equal(result.evasionBase, 25);
  assert.equal(result.evasionBonus, 65);
  assert.equal(result.criticalRate, 500);
  assert.equal(result.criticalDamage, 1100);
  assert.equal(result.criticalResistance, 70);
  assert.equal(result.criticalDamageResistance, 220);
  assert.equal(result.weaponBlock, 42);
  assert.equal(result.shieldBlock, 25);
  assert.equal(result.zealotRate, 100);
  assert.equal(result.stealthAttackEnabled, true);
  assert.equal(result.stealthDamageRate, 300);

  const withoutShield = conditions.fighter('hero', base, passives, {offhandShield: false});
  assert.equal(withoutShield.shieldBlock, 0, '没有真实副手盾时被动也加不出盾挡');
  assert.equal(conditions.fighter('hero', base, passives).shieldBlock, 25,
    '省略副手信息时沿用调用方声明，不额外清零');
});

test('fighter does not add the same passive or buff twice when a field is read more than once', () => {
  const conditions = new CombatConditions();
  const base = fighter({physicalAttack: 100, defense: 100, defenseRate: 0, maxHealth: 1000});
  const passives = [add('physicalAttack', 40), add('maxHealth', 60)];
  conditions.applyBuff('hero', 'dark-strike', 1, buff([
    {attribute: 'physicalAttack', operation: {kind: 'add', amount: 10}},
  ]));
  const first = conditions.fighter('hero', base, passives);
  const second = conditions.fighter('hero', base, passives);
  assert.equal(first.physicalAttack, 150);
  assert.equal(second.physicalAttack, 150, '重复读取 fighter 不会把 Buff 再叠一层');
  assert.equal(first.maxHealth, 1060);
  assert.equal(second.maxHealth, 1060);
});

/* ------------------------------------------------------------------ */
/* 2. CombatConditions.attribute：顺序、层数、斜坡、临时值与上限       */
/* ------------------------------------------------------------------ */

test('attribute applies passives first, then buffs from newest to oldest', () => {
  const conditions = new CombatConditions();
  const passives = [add('physicalAttack', 100)];
  const darkStrike = buff([{attribute: 'physicalAttack', operation: {kind: 'add', amount: 20}}],
    {maxStacks: 3});
  conditions.applyBuff('actor', 'dark-strike', 1, darkStrike);
  conditions.applyBuff('actor', 'dark-strike', 1, darkStrike);
  conditions.applyBuff('actor', 'phantom-clash', 1, buff([
    {attribute: 'physicalAttack', operation: {kind: 'increase-thousandth', ratePerThousand: 100}},
  ]));

  // 被动：(50+100)=150。后加的 phantom-clash 先 ×1.1 =165；先加的 dark-strike
  // 两层 add 再 +40 =205。若顺序反过来会得到 209。
  assert.equal(conditions.attribute('actor', 'physicalAttack', 50, passives), 205);
  const dark = conditions.snapshot('actor').find(entry => entry.id === 'dark-strike');
  assert.equal(dark?.stackCount, 2);
});

test('attribute multiplies add, set and increase-thousandth operands by stack count once', () => {
  const conditions = new CombatConditions();

  const addEffect = buff([{attribute: 'weaponBlock', operation: {kind: 'add', amount: 10}}],
    {maxStacks: 5});
  for (let stack = 0; stack < 3; stack += 1) conditions.applyBuff('adder', 'dark-strike', 1, addEffect);
  assert.equal(conditions.attribute('adder', 'weaponBlock', 30), 60);

  const setEffect = buff([{attribute: 'shieldBlock', operation: {kind: 'set', amount: 100}}],
    {maxStacks: 2});
  for (let stack = 0; stack < 2; stack += 1) conditions.applyBuff('setter', 'demon-s-shield', 1, setEffect);
  assert.equal(conditions.attribute('setter', 'shieldBlock', 0), 200);

  const increaseEffect = buff([
    {attribute: 'criticalDamage', operation: {kind: 'increase-thousandth', ratePerThousand: 100}},
  ], {maxStacks: 2});
  for (let stack = 0; stack < 2; stack += 1) conditions.applyBuff('scaler', 'phantom-clash', 1, increaseEffect);
  // ratePerThousand 先放大到 200，只做一次运算：200 × 1.2 = 240，不是 242。
  assert.equal(conditions.attribute('scaler', 'criticalDamage', 200), 240);
});

test('attribute ramps add one segment at age zero and one more per interval', () => {
  const conditions = new CombatConditions();
  conditions.applyBuff('actor', 'dark-strike', 1, buff([], {
    attributeRamps: [{attribute: 'physicalAttack', operation: {kind: 'add', amount: 25}, intervalFrames: 2}],
  }));
  assert.equal(conditions.attribute('actor', 'physicalAttack', 100), 125, '年龄 0 叠第一段');
  conditions.update(120);
  assert.equal(conditions.attribute('actor', 'physicalAttack', 100), 150, '经过 2 段间隔后叠第二段');
  conditions.update(60);
  assert.equal(conditions.attribute('actor', 'physicalAttack', 100), 150, '同一段内不重复叠加');
  conditions.update(60);
  assert.equal(conditions.attribute('actor', 'physicalAttack', 100), 175, '再跨两段后叠第三段');
});

test('attribute applies a temporary operation after passives and buffs, then caches the result', () => {
  const conditions = new CombatConditions();
  const passives = [add('physicalAttack', 20)];
  conditions.applyBuff('actor', 'dark-strike', 1, buff([
    {attribute: 'physicalAttack', operation: {kind: 'add', amount: 30}},
  ]));
  const state = conditions.captureState();
  state.temporary = [['actor', [['physicalAttack', {
    operation: {kind: 'increase-thousandth', ratePerThousand: 500},
  }]]]];
  conditions.restoreState(state);

  // 100 基础 +20 被动 =120；+30 Buff =150；最后临时 +50% =225。
  assert.equal(conditions.attribute('actor', 'physicalAttack', 100, passives), 225);
  assert.equal(conditions.cachedAttribute('actor', 'physicalAttack'), 225);
  assert.equal(conditions.attribute('actor', 'physicalAttack', 9999, passives), 225,
    '临时结果已缓存，后续读取不再重新叠加');
});

test('ordinary magic resistance is capped at 750 only after passives and buffs are merged', () => {
  const conditions = new CombatConditions();
  conditions.applyBuff('actor', 'phantom-clash', 1, buff([
    {attribute: 'magicResistance', operation: {kind: 'add', amount: 800}},
  ]));
  assert.equal(conditions.attribute('actor', 'magicResistance', 0), 800,
    'attribute 本身返回合并后的中间值');
  assert.equal(calculateMagicResistance(800), 750);
  const base = fighter({magicResistance: 0});
  assert.equal(conditions.fighter('actor', base).magicResistance, 750,
    'fighter 在合并完成后施加 750 上限');
  assert.equal(calculateMagicResistance(-50), -50, '负魔抗保留，用来增加所受伤害');
});

test('attribute clamps stealth toggles but keeps explicitly cached signed values', () => {
  const conditions = new CombatConditions();
  conditions.applyBuff('actor', 'dark-strike', 1, buff([
    {attribute: 'stealthDamageRate', operation: {kind: 'subtract', amount: 200}},
  ]));
  assert.equal(conditions.attribute('actor', 'stealthDamageRate', 0), 0);
  conditions.setTemporaryAttribute('actor', 'stealthDamageRate', -736);
  assert.equal(conditions.attribute('actor', 'stealthDamageRate', 0), -736);
  assert.equal(conditions.fighter('actor', fighter()).stealthAttackEnabled, false);
});

test('attribute applies max health and max mana modifiers once and feeds the resource capacity cache', () => {
  const conditions = new CombatConditions();
  const passives = [add('maxHealth', 100), add('maxMana', 50)];
  conditions.applyBuff('actor', 'dark-strike', 1, buff([
    {attribute: 'maxHealth', operation: {kind: 'add', amount: 50}},
  ]));
  assert.equal(conditions.attribute('actor', 'maxHealth', 1000, passives), 1150);
  assert.equal(conditions.attribute('actor', 'maxMana', 200, passives), 250);

  let computations = 0;
  const read = () => conditions.readResourceCapacity('actor', 'maxHealth', () => {
    computations += 1;
    return conditions.attribute('actor', 'maxHealth', 1000, passives);
  });
  assert.equal(read(), 1150);
  assert.equal(read(), 1150);
  assert.equal(computations, 1, '容量结果复用缓存');
  conditions.setTemporaryAttribute('actor', 'maxHealth', 2000);
  assert.equal(read(), 2000, '显式临时上限优先于缓存');
  conditions.clearTemporaryAttribute('actor', 'maxHealth');
  assert.equal(read(), 1150);
  assert.equal(computations, 2, '清除临时上限后重新计算');
});

/* ------------------------------------------------------------------ */
/* 3. effectiveCharacterPanel 与 fighter 的一致性                      */
/* ------------------------------------------------------------------ */

test('effective panel display matches fighter values for the same raw panel and passives', () => {
  const panel = rawPanel();
  const passives: PassiveModifier[] = [
    add('physicalAttack', 50), add('magicAttack', 20), add('defense', 50),
    add('defenseRate', 1000), add('physicalResistanceBonus', 45), add('magicResistance', -100),
    add('maxHealth', 100), add('criticalRate', 10), add('criticalDamage', 200),
    add('criticalResistance', 15), add('criticalDamageResistance', 25), add('hitBase', 20),
    add('hitBonus', 30), add('evasionBonus', 100),
    add('weaponBlock', 20), add('shieldBlock', 10),
  ];
  const display = effectiveCharacterPanel(panel, 10, passives);
  const combat = new CombatConditions().fighter(
    'hero', fighterBaseFromPanel(panel, 10), passives, {offhandShield: panel.offhandShield},
  );

  assert.equal(display.physicalAttack, 150);
  assert.equal(display.magicAttack, 100);
  assert.equal(display.maxHealth, 1100);
  assert.equal(display.criticalRate, 40);
  assert.equal(display.criticalDamage, 1200);
  assert.equal(display.criticalResistance, 15);
  assert.equal(display.criticalDamageResistance, 25);
  assert.equal(display.hitBase, 120);
  assert.equal(display.hitBonus, 30);
  assert.equal(display.evasionBase, 20);
  assert.equal(display.evasionBonus, 100);
  assert.equal(display.weaponBlock, 50);
  assert.equal(display.shieldBlock, 50);
  assert.equal(display.defenseRate, 1200);
  assert.equal(display.defense, 330);
  assert.equal(display.physicalResistance, 604);
  assert.equal(display.magicResistance, 700);

  assert.equal(combat.physicalAttack, display.physicalAttack);
  assert.equal(combat.magicAttack, display.magicAttack);
  assert.equal(combat.maxHealth, display.maxHealth);
  assert.equal(combat.criticalRate, display.criticalRate);
  assert.equal(combat.criticalDamage, display.criticalDamage);
  assert.equal(combat.criticalResistance, display.criticalResistance);
  assert.equal(combat.criticalDamageResistance, display.criticalDamageResistance);
  assert.equal(combat.hitBase, display.hitBase);
  assert.equal(combat.hitBonus, display.hitBonus);
  assert.equal(combat.evasionBase, display.evasionBase);
  assert.equal(combat.evasionBonus, display.evasionBonus);
  assert.equal(combat.weaponBlock, display.weaponBlock);
  assert.equal(combat.shieldBlock, display.shieldBlock);
  assert.equal(combat.defenseRate, display.defenseRate);
  assert.equal(combat.defense, 150, 'fighter 保留原始防御');
  assert.equal(calculateEffectiveDefense(combat.defense!, combat.defenseRate!), display.defense);
  assert.equal(combat.physicalResistance, display.physicalResistance);
  assert.equal(combat.magicResistance, display.magicResistance);
});

test('effective panel applies evasionBase to both its field and the displayed evasion rate', () => {
  const panel = rawPanel();
  const passives = [add('evasionBase', 5)];
  const display = effectiveCharacterPanel(panel, 10, passives);
  const combat = new CombatConditions().fighter(
    'hero', fighterBaseFromPanel(panel, 10), passives, {offhandShield: panel.offhandShield},
  );
  assert.equal(combat.evasionBase, 25, 'fighter 会把 evasionBase 被动加进命中公式的分母');
  assert.equal(display.evasionBase, 25, '内部面板字段应与战斗值一致');
  // 回避显示 = min(750, 1000 + 回避加成 − trunc((5000×等级+1000000)/(5×等级+回避基础+1200)))。
  assert.equal(display.evasionRate, 177, '回避显示应使用叠加后的 evasionBase：1000 − trunc(1050000/1275)');
});

test('effective panel leaves base defense and base magic resistance untouched for combat reassembly', () => {
  const panel = rawPanel({baseDefense: 100, defense: 120, baseMagicResistance: 800, magicResistance: 750});
  const passives = [add('defense', 50), add('defenseRate', 1000), add('magicResistance', -100)];
  const display = effectiveCharacterPanel(panel, 10, passives);
  assert.equal(display.baseDefense, 100);
  assert.equal(display.baseMagicResistance, 800);

  const conditions = new CombatConditions();
  assert.equal(conditions.attribute('hero', 'defense', display.baseDefense, passives), 150,
    '从原始防御重新叠加，不读已经乘过防御率的 display.defense');
  assert.equal(conditions.attribute('hero', 'magicResistance', display.baseMagicResistance, passives), 700,
    '从原始魔抗重新叠加，不读已经限过上限的 display.magicResistance');
  assert.equal(display.defense, 330);
  assert.equal(display.magicResistance, 700);
});

/* ------------------------------------------------------------------ */
/* 4. 命中与伤害结算                                                   */
/* ------------------------------------------------------------------ */

test('physical hit uses hit base, evasion bonus cap and hit-rate adjustment at integer boundaries', () => {
  const attacker = fighter({hitBase: 100, hitBonus: 0, criticalRate: 0});
  const baseTarget = fighter({evasionBase: 50, evasionBonus: 200});
  // 命中率 = trunc(120000/175)+100 = 785；未命中阈值 = 1000-785+200 = 415。
  assert.equal(hitOf(414, attacker, baseTarget).kind, 'miss');
  assert.equal(hitOf(415, attacker, baseTarget).kind, 'hit');

  const capped = fighter({evasionBase: 50, evasionBonus: 900});
  // 回避加成只取到 750：阈值 = 1000-785+750 = 965。
  assert.equal(hitOf(964, attacker, capped).kind, 'miss');
  assert.equal(hitOf(965, attacker, capped).kind, 'hit');

  const negative = fighter({evasionBase: 50, evasionBonus: -200});
  // 负回避加成降低未命中阈值：1000-785-200 = 15。
  assert.equal(hitOf(14, attacker, negative).kind, 'miss');
  assert.equal(hitOf(15, attacker, negative).kind, 'hit');

  const normalTarget = fighter({evasionBase: 50, evasionBonus: 0});
  assert.equal(hitPhysicalWithAdjustment(114, attacker, normalTarget, 100).kind, 'miss');
  assert.equal(hitPhysicalWithAdjustment(115, attacker, normalTarget, 100).kind, 'hit');
});

function hitPhysicalWithAdjustment(
  roll: number, attacker: PhysicalFighter, target: PhysicalFighter, adjustment: number,
): PhysicalHit {
  return rollPhysicalHit(attacker, target, rollAt(roll), 1000, 0, adjustment);
}

test('physical shield, weapon and critical thresholds shift with level advantage', () => {
  const equalAttacker = fighter({hitBonus: 1000, criticalRate: 50});
  const equalTarget = fighter({shieldBlock: 200, weaponBlock: 100});
  assert.equal(hitOf(199, equalAttacker, equalTarget).kind, 'shield-block');
  assert.equal(hitOf(200, equalAttacker, equalTarget).kind, 'weapon-block');
  assert.equal(hitOf(299, equalAttacker, equalTarget).kind, 'weapon-block');
  assert.equal(hitOf(300, equalAttacker, equalTarget).kind, 'critical');
  assert.equal(hitOf(349, equalAttacker, equalTarget).kind, 'critical');
  assert.equal(hitOf(350, equalAttacker, equalTarget).kind, 'hit');

  const higher = fighter({level: 20, hitBonus: 1000, criticalRate: 0});
  const lower = fighter({level: 10, shieldBlock: 200, weaponBlock: 100});
  // 等级优势 = trunc(10×1000/110) = 90；盾挡 200-90=110，武器格挡 100-90=10，
  // 暴击率 0 也获得 90 的等级优势区间。
  assert.equal(hitOf(109, higher, lower).kind, 'shield-block');
  assert.equal(hitOf(110, higher, lower).kind, 'weapon-block');
  assert.equal(hitOf(119, higher, lower).kind, 'weapon-block');
  assert.equal(hitOf(120, higher, lower).kind, 'critical');
  assert.equal(hitOf(209, higher, lower).kind, 'critical');
  assert.equal(hitOf(210, higher, lower).kind, 'hit');

  const lowerAttacker = fighter({level: 10, hitBonus: 1000, criticalRate: 200});
  const higherTarget = fighter({level: 20, shieldBlock: 200, weaponBlock: 100});
  // 等级劣势 = -90；盾挡 290，武器格挡 190；暴击区间再叠加 200-90=110。
  assert.equal(hitOf(289, lowerAttacker, higherTarget).kind, 'shield-block');
  assert.equal(hitOf(290, lowerAttacker, higherTarget).kind, 'weapon-block');
  assert.equal(hitOf(479, lowerAttacker, higherTarget).kind, 'weapon-block');
  assert.equal(hitOf(480, lowerAttacker, higherTarget).kind, 'critical');
  assert.equal(hitOf(589, lowerAttacker, higherTarget).kind, 'critical');
  assert.equal(hitOf(590, lowerAttacker, higherTarget).kind, 'hit');
});

test('physical critical chance is reduced by critical resistance and disabled below zero', () => {
  const attacker = fighter({hitBonus: 1000, criticalRate: 100});
  const resistant = fighter({criticalResistance: 60});
  assert.equal(hitOf(39, attacker, resistant).kind, 'critical');
  assert.equal(hitOf(40, attacker, resistant).kind, 'hit');

  const immune = fighter({criticalResistance: 120});
  assert.equal(hitOf(0, attacker, immune).kind, 'hit', '暴击率减暴击抵抗不为正时不会暴击');
});

test('physical damage applies skill/stealth/zealot rates once, then target resistance', () => {
  const baseAttacker = fighter({
    physicalAttack: 1000, physicalDamageRate: 100, stealthAttackEnabled: false,
    stealthDamageRate: 300, zealotRate: 25, criticalRate: 0,
  });
  const target = fighter({physicalResistance: 200});
  // 1000 × (1000+100+0+0+25)/1000 = 1125；再乘 (1000-200)/1000 = 900。
  assert.equal(hitOf(0, baseAttacker, target).damage, 900);
  assert.equal(hitPhysicalExtra(0, baseAttacker, target, 100).damage, 980,
    '额外伤害率同样只加一次');

  const stealthed = {...baseAttacker, stealthAttackEnabled: true};
  assert.equal(hitOf(0, stealthed, target).damage, 1140);
  let skillCalls = 0;
  const withSkill = rollPhysicalHit(stealthed, target, rollAt(0), 1000, 0, 0,
    () => (skillCalls += 1, 500));
  // 主伤害 1000×1.425=1425；潜行技能追加 500×1.3=650；合计 2075→1660。
  assert.equal(withSkill.damage, 1660);
  assert.equal(skillCalls, 1);

  const visible = rollPhysicalHit(baseAttacker, target, rollAt(0), 1000, 0, 0,
    () => assert.fail('未开启潜行时不应读取技能物攻'));
  assert.equal(visible.damage, 900);
});

function hitPhysicalExtra(
  roll: number, attacker: PhysicalFighter, target: PhysicalFighter, extra: number,
): PhysicalHit {
  return rollPhysicalHit(attacker, target, rollAt(roll), 1000, extra);
}

test('physical weapon block multiplies damage before resistance and shield block uses its own formula', () => {
  const weaponAttacker = fighter({physicalDamageRate: 100, criticalRate: 0});
  const weaponTarget = fighter({weaponBlock: 1000, physicalResistance: 200});
  const weaponHit = hitOf(0, weaponAttacker, weaponTarget);
  assert.equal(weaponHit.kind, 'weapon-block');
  // 1000×1.1=1100；武器格挡 ×0.7 =770；再乘 0.8 =616。
  assert.equal(weaponHit.damage, 616);

  const shieldAttacker = fighter({criticalRate: 0});
  const shieldTarget = fighter({shieldBlock: 200, physicalResistance: 200, level: 10});
  const shieldHit = hitOf(0, shieldAttacker, shieldTarget);
  assert.equal(shieldHit.kind, 'shield-block');
  // 先扣物减 1000×0.8=800；盾挡公式：防御 400、减伤 606，800×394/1000=315。
  assert.equal(shieldHit.damage, 315);
});

test('critical damage applies critical damage bonus and critical damage resistance in order', () => {
  const attacker = fighter({criticalRate: 1000, criticalDamage: 500});
  const target = fighter({criticalDamageResistance: 100});
  const result = hitOf(0, attacker, target);
  assert.equal(result.kind, 'critical');
  // 1000 × 1.5 = 1500；暴伤抵抗 100/1000 后 1500×0.9 = 1350。
  assert.equal(result.damage, 1350);
});

test('magic hit uses evasion and shield thresholds but skips weapon block', () => {
  const attacker = fighter({hitBonus: 1000, criticalRate: 50});
  const target = fighter({shieldBlock: 200, weaponBlock: 100});
  assert.equal(magicHitOf(199, attacker, target).kind, 'shield-block');
  assert.equal(magicHitOf(200, attacker, target).kind, 'critical');
  assert.equal(magicHitOf(249, attacker, target).kind, 'critical');
  assert.equal(magicHitOf(250, attacker, target).kind, 'hit');

  const missAttacker = fighter({hitBase: 100, hitBonus: 0, criticalRate: 0});
  const evasive = fighter({evasionBase: 50, evasionBonus: 200});
  // 与物理相同的命中公式：命中率 785，未命中阈值 415。
  assert.equal(magicHitOf(414, missAttacker, evasive).kind, 'miss');
  assert.equal(magicHitOf(415, missAttacker, evasive).kind, 'hit');
});

test('magic damage applies magic rate once, then resistance, then critical modifiers', () => {
  const attacker = fighter({magicDamageRate: 250, criticalRate: 0});
  const target = fighter({magicResistance: 200});
  // 1000×1.25=1250；目标魔抗 200 → 1000。
  assert.equal(magicHitOf(0, attacker, target).damage, 1000);
  assert.equal(magicHitOf(0, attacker, target, 1000, 50).damage, 1040);

  const vulnerable = fighter({magicResistance: -100});
  // 1250 × (1000-(-100))/1000 = 1375。
  assert.equal(magicHitOf(0, attacker, vulnerable).damage, 1375, '负魔抗提高所受魔法伤害');

  const critical = fighter({magicDamageRate: 250, criticalRate: 1000, criticalDamage: 500});
  const resistant = fighter({magicResistance: 200, criticalDamageResistance: 100});
  // 1250→魔抗后 1000→暴击 ×1.5=1500→暴伤抵抗 ×0.9=1350。
  assert.equal(magicHitOf(0, critical, resistant).damage, 1350);

  const shieldAttacker = fighter({criticalRate: 0});
  const shieldTarget = fighter({shieldBlock: 200, magicResistance: 0, level: 10});
  assert.equal(magicHitOf(0, shieldAttacker, shieldTarget).damage, 394);
});

test('defense and magic resistance formulas clamp the right ends', () => {
  assert.equal(calculateEffectiveDefense(100, 200), 120);
  assert.equal(calculateEffectiveDefense(101, 333), 134);
  assert.equal(calculateEffectiveDefense(-100, 200), 0);
  assert.equal(calculateEffectiveDefense(100, -200), 100);
  assert.equal(calculateEffectiveDefense(0, 1000), 0);
  assert.equal(calculateMagicResistance(800), 750);
  assert.equal(calculateMagicResistance(750), 750);
  assert.equal(calculateMagicResistance(-50), -50);
  assert.equal(calculateMagicResistance(0), 0);
});

test('normal damage helpers apply only their matching rate once and class picks the row', () => {
  const attributes: DamageAttributes = {
    physicalAttack: 123, magicAttack: 456, physicalDamageRate: 100, magicDamageRate: 50,
    stealthDamageRate: 200,
  };
  assert.equal(physicalNormalDamage(attributes), 159);
  assert.equal(magicNormalDamage(attributes), 478);
  assert.equal(normalDamageForClass(attributes, 'warlock'), 478);
  assert.equal(normalDamageForClass(attributes, 'priest'), 478);
  assert.equal(normalDamageForClass(attributes, 'warrior'), 159);
  assert.equal(normalDamageForClass(attributes, null), 159);
});

/* ------------------------------------------------------------------ */
/* 5. 装备聚合值与战斗消费端                                          */
/* ------------------------------------------------------------------ */

test('equipment attack procs sum item and gem modifiers and ignore unrelated stats', () => {
  const equipped = [
    gear([{stat: 'fire', value: 100}, {stat: 'wind', value: 50},
      {stat: 'lifeSteal', value: 30}, {stat: 'toString', value: 999}]),
    gear([], [{stat: 'fire', value: 25}, {stat: 'freeze', value: 75},
      {stat: 'poison', value: 10}]),
    gear([{stat: 'darkness', value: -40}]),
  ];
  assert.deepEqual(equipmentAttackProcs(equipped), {
    fireSplashChance: 125, windStrikeChance: 50, frostStrikeChance: 75,
    divineStrikeChance: 0, darknessStrikeChance: -40, poisonStrikeChance: 10,
  });
  assert.deepEqual(equipmentAttackProcs([]), {
    fireSplashChance: 0, windStrikeChance: 0, frostStrikeChance: 0,
    divineStrikeChance: 0, darknessStrikeChance: 0, poisonStrikeChance: 0,
  });
});

test('equipment combat procs sum signed item and gem modifiers', () => {
  const equipped = [
    gear([{stat: 'pendulum', value: 60}, {stat: 'zealot', value: 100}]),
    gear([], [{stat: 'pendulum', value: 40}, {stat: 'frost', value: 75},
      {stat: 'healingEnergy', value: 25}, {stat: 'instantRecovery', value: 35},
      {stat: 'zealot', value: -30}]),
  ];
  assert.deepEqual(equipmentCombatProcs(equipped), {
    pendulumStunChance: 100, frostRetaliationChance: 75, healingEnergyChance: 25,
    zealotRate: 70, instantRecoveryPerThousand: 35,
  });
  assert.deepEqual(equipmentCombatProcs([]), {
    pendulumStunChance: 0, frostRetaliationChance: 0, healingEnergyChance: 0,
    zealotRate: 0, instantRecoveryPerThousand: 0,
  });
});

test('equipment recovery clamps life drain and spell cost but keeps signed mana regeneration', () => {
  const equipped = [
    gear([{stat: 'lifeSteal', value: 30}, {stat: 'manaRegen', value: 4},
      {stat: 'spellExpert', value: 10}]),
    gear([], [{stat: 'lifeSteal', value: 20}, {stat: 'manaRegen', value: 1},
      {stat: 'spellExpert', value: 15}]),
  ];
  assert.deepEqual(equipmentRecoveryModifiers(equipped), {
    lifeDrainPerThousand: 50, manaRecoveryPerPulse: 5, manaCostReductionRate: 25,
  });

  const negative = [
    gear([{stat: 'lifeSteal', value: -50}, {stat: 'manaRegen', value: -3},
      {stat: 'spellExpert', value: -20}]),
    gear([], [{stat: 'lifeSteal', value: 20}, {stat: 'spellExpert', value: 5}]),
  ];
  assert.deepEqual(equipmentRecoveryModifiers(negative), {
    lifeDrainPerThousand: 0, manaRecoveryPerPulse: -3, manaCostReductionRate: 0,
  });
});

test('equipment state immunity sums the matching resistance and drives the state gate', () => {
  const equipped = [
    gear([{stat: 'sleepResistance', value: 30}, {stat: 'stunResistance', value: 100}]),
    gear([], [{stat: 'sleepResistance', value: 20}]),
  ];
  assert.equal(equipmentStateImmunity(equipped, 'sleep'), 50);
  assert.equal(equipmentStateImmunity(equipped, 'stun'), 100);
  assert.equal(equipmentStateImmunity(equipped, 'immobilized'), 0);
  assert.equal(equipmentStateImmunity([], 'sleep'), 0);

  assert.deepEqual(resolveStateApplication({
    kind: 'buff', state: 'sleep', sourceRelation: 'hostile',
    specificImmunityValue: equipmentStateImmunity(equipped, 'sleep'),
  }), {allowed: false, reason: 'immune'});
  assert.equal(resolveStateApplication({
    kind: 'buff', state: 'sleep', sourceRelation: 'hostile',
    specificImmunityValue: equipmentStateImmunity([], 'sleep'),
  }).allowed, true);
  assert.equal(resolveStateApplication({
    kind: 'buff', state: 'sleep', sourceRelation: 'hostile', specificImmunityValue: -50,
  }).allowed, true, '负值不算免疫');
});

test('pipeline passes equipment life drain into attack success and keeps proc hooks on success', () => {
  const equipped = [
    gear([{stat: 'lifeSteal', value: 40}, {stat: 'wind', value: 600}]),
    gear([], [{stat: 'lifeSteal', value: 20}]),
  ];
  const recovery = equipmentRecoveryModifiers(equipped);
  const hit: PhysicalHit = {kind: 'hit', damage: 120};
  let observedDrain: number | undefined;
  let physicalProcs = 0;
  let attackProcs = 0;
  resolveHitReactionPipeline(contact, hit, 'physical', 'basic-attack', reactionPort({
    equipmentRecovery: id => {
      assert.equal(id, 'hero');
      return recovery;
    },
    react: event => {
      if (event.kind === 'attack-success') observedDrain = event.otherLifeDrainPerThousand;
    },
    physicalSuccessEquipmentProcs: (_event, seen) => {
      physicalProcs += 1;
      assert.deepEqual(seen, hit);
    },
    attackProc: (_event, seen) => {
      attackProcs += 1;
      assert.deepEqual(seen, hit);
    },
  }));
  assert.equal(observedDrain, 60);
  assert.equal(physicalProcs, 1);
  assert.equal(attackProcs, 1);
});

test('pipeline attack hook consumes equipment attack proc rates through the executor', () => {
  const rates = equipmentAttackProcs([gear([{stat: 'wind', value: 600}])]);
  const damages: number[] = [];
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 100}, 'physical', 'basic-attack',
    reactionPort({
      attackProc: () => {
        new AttackProcExecutor().execute(1000, {
          readChance: key => rates[key],
          applyDamage: amount => { damages.push(amount); },
          applyBuff: () => {},
          fireSplash: () => 0,
          random: () => 0.5,
        });
      },
    }));
  assert.deepEqual(damages, [700], '聚合阈值 600 在成功链末尾实际触发 700 点风击伤害');
});

test('misses use equipment instant recovery and never run the attack proc chain', () => {
  const procs = equipmentCombatProcs([gear([{stat: 'instantRecovery', value: 35}])]);
  let recovered: number | undefined;
  let attacks = 0;
  resolveHitReactionPipeline(contact, {kind: 'miss', damage: 0}, 'physical', 'basic-attack',
    reactionPort({
      instantRecoveryOnMiss: () => { recovered = procs.instantRecoveryPerThousand; },
      attackProc: () => { attacks += 1; },
    }));
  assert.equal(recovered, 35);
  assert.equal(attacks, 0);

  let magicAttacks = 0;
  resolveHitReactionPipeline(contact, {kind: 'shield-block', damage: 0}, 'magic', 'firestorm',
    reactionPort({attackProc: () => { magicAttacks += 1; }}));
  assert.equal(magicAttacks, 0, '魔法盾挡在攻击触发链之前返回');
});

test('equipment attack proc rates drive the attack proc executor at exact thresholds', () => {
  const rates = equipmentAttackProcs([gear([{stat: 'wind', value: 600}])]);
  const executor = new AttackProcExecutor();
  const damages: number[] = [];
  const buffs: string[] = [];
  const result = executor.execute(1000, {
    readChance: key => rates[key],
    applyDamage: amount => { damages.push(amount); },
    applyBuff: key => { buffs.push(key); },
    fireSplash: () => 0,
    random: () => 0.5,
  });
  assert.equal(result.status, 'completed');
  // 随机值 0.5 → 1+floor(0.5×999)=500 < 600，触发风击；伤害 1000×0.7=700。
  assert.deepEqual(damages, [700]);
  assert.deepEqual(buffs, ['attack-stun']);
  assert.equal(executor.execute(1000, {
    readChance: key => key === 'windStrikeChance' ? 500 : 0,
    applyDamage: amount => { damages.push(amount); },
    applyBuff: key => { buffs.push(key); },
    fireSplash: () => 0,
    random: () => 0.5,
  }).status, 'completed');
  assert.deepEqual(damages, [700], '500 等于阈值时不触发，只有严格大于才成功');
  assert.equal(executor.execute(1000, {
    readChance: () => -50,
    applyDamage: () => assert.fail('负门槛不应造成伤害'),
    applyBuff: () => assert.fail('负门槛不应施加状态'),
    fireSplash: () => 0,
    random: () => assert.fail('非正门槛不应消耗随机数'),
  }).status, 'completed');
});

test('attack proc fire retries on an empty splash and skips stages by collected target count', () => {
  const executor = new AttackProcExecutor();
  const attempts: number[] = [];
  const damages: number[] = [];
  const buffs: string[] = [];
  const counts = [0, 2];
  // 风与冰霜门槛都设成 1000，用来看火焰返回 2 时是否真的跳过后续冰霜阶段。
  const result = executor.execute(1000, attackProcPort({
    readChance: key => key === 'fireSplashChance' || key === 'frostStrikeChance' ? 1000 : 0,
    fireSplash: amount => {
      attempts.push(amount);
      return counts.shift()!;
    },
    applyDamage: amount => { damages.push(amount); },
    applyBuff: key => { buffs.push(key); },
  }));
  assert.deepEqual(attempts, [500, 500], '第一次 0 目标后重试火焰，第二次返回 2 个目标');
  assert.deepEqual(damages, []);
  assert.deepEqual(buffs, [], 'count=2 时从 index 3 继续，冰霜阶段被跳过');
  assert.deepEqual(result, {status: 'completed', stagesExecuted: 6});

  const frostDamages: number[] = [];
  const frostBuffs: string[] = [];
  const oneTarget = executor.execute(1000, attackProcPort({
    readChance: key => key === 'fireSplashChance' || key === 'frostStrikeChance' ? 1000 : 0,
    fireSplash: () => 1,
    applyDamage: amount => { frostDamages.push(amount); },
    applyBuff: key => { frostBuffs.push(key); },
  }));
  assert.deepEqual(frostDamages, [700], 'count=1 时 index=2，冰霜阶段照常执行一次');
  assert.deepEqual(frostBuffs, ['attack-slow']);
  assert.deepEqual(oneTarget, {status: 'completed', stagesExecuted: 6});

  const allSkipped = executor.execute(1000, attackProcPort({
    readChance: key => key === 'fireSplashChance' ? 1000 : 0,
    fireSplash: () => 5,
    applyDamage: () => assert.fail('count=5 时后续伤害阶段应全部跳过'),
  }));
  assert.deepEqual(allSkipped, {status: 'completed', stagesExecuted: 2});

  const rounded: number[] = [];
  executor.execute(999, attackProcPort({
    readChance: key => key === 'fireSplashChance' ? 1000 : 0,
    fireSplash: amount => {
      rounded.push(amount);
      return 5;
    },
  }));
  assert.deepEqual(rounded, [499], '溅射伤害按 normalDamage×500/1000 取整');
});

test('attack proc executor reports budget exhaustion and rejects invalid budgets', () => {
  const executor = new AttackProcExecutor();
  assert.deepEqual(executor.execute(1000, attackProcPort(), 0),
    {status: 'budget-exhausted', stagesExecuted: 0});
  assert.deepEqual(executor.execute(1000, attackProcPort(), 3),
    {status: 'budget-exhausted', stagesExecuted: 3});
  assert.deepEqual(executor.execute(1000, attackProcPort(), 6),
    {status: 'completed', stagesExecuted: 6});
  for (const budget of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => executor.execute(1000, attackProcPort(), budget), RangeError);
  }
  assert.equal(executor.execute(1000, attackProcPort()).status, 'completed',
    '非法预算抛出后执行器仍可再次使用');
});

test('attack proc executor rejects invalid splash counts and resets its reentrancy guard', () => {
  for (const count of [-1, 17, 1.5, Number.NaN]) {
    const executor = new AttackProcExecutor();
    assert.throws(() => executor.execute(1000, attackProcPort({
      readChance: key => key === 'fireSplashChance' ? 1000 : 0,
      fireSplash: () => count,
    })), RangeError);
    assert.equal(executor.execute(1000, attackProcPort()).status, 'completed',
      '溅射目标数非法抛出后可以重新执行');
  }
});

test('attack proc executor reports reentrancy and lets the outer run finish', () => {
  const executor = new AttackProcExecutor();
  let inner: ReturnType<AttackProcExecutor['execute']> | undefined;
  const outer = executor.execute(1000, attackProcPort({
    readChance: key => key === 'windStrikeChance' ? 1000 : 0,
    applyDamage: () => { inner = executor.execute(1000, attackProcPort()); },
  }));
  assert.deepEqual(inner, {status: 'reentrant', stagesExecuted: 0});
  assert.deepEqual(outer, {status: 'completed', stagesExecuted: 6});
});

test('attack proc executor applies each damage stage once and pure buff stages deal no damage', () => {
  const executor = new AttackProcExecutor();
  const damages: number[] = [];
  const buffs: string[] = [];
  const result = executor.execute(1000, attackProcPort({
    readChance: key => key === 'windStrikeChance' || key === 'frostStrikeChance' ? 1000 : 0,
    applyDamage: amount => { damages.push(amount); },
    applyBuff: key => { buffs.push(key); },
  }));
  assert.deepEqual(damages, [700, 700], '风击与冰霜各结算一次，不因同一命中重复');
  assert.deepEqual(buffs, ['attack-stun', 'attack-slow']);
  assert.deepEqual(result, {status: 'completed', stagesExecuted: 6});

  const pollution: string[] = [];
  const noDamage: number[] = [];
  const poison = executor.execute(1000, attackProcPort({
    readChance: key => key === 'poisonStrikeChance' ? 1000 : 0,
    applyDamage: amount => { noDamage.push(amount); },
    applyBuff: key => { pollution.push(key); },
  }));
  assert.deepEqual(pollution, ['poisoned'], '纯 Buff 阶段只施加状态');
  assert.deepEqual(noDamage, []);
  assert.deepEqual(poison, {status: 'completed', stagesExecuted: 6});
});

test('fire splash delivers one proc per execute; per-target production wiring is outside the domain', () => {
  // 领域层不覆盖生产接线：world-combat.ts 的 fireSplash 如何枚举目标、去重并逐个调用
  // attackProcDamage 属于场景层。这里只验证执行器每次火焰触发只交付一笔溅射伤害，
  // 不会在领域内自行对每个目标重复结算。
  const executor = new AttackProcExecutor();
  const splashes: number[] = [];
  const damages: number[] = [];
  const result = executor.execute(2000, attackProcPort({
    readChance: key => key === 'fireSplashChance' ? 1000 : 0,
    fireSplash: amount => {
      splashes.push(amount);
      return 5;
    },
    applyDamage: amount => { damages.push(amount); },
  }));
  assert.deepEqual(splashes, [1000], '2000×500/1000=1000，火焰只触发一次');
  assert.deepEqual(damages, []);
  assert.deepEqual(result, {status: 'completed', stagesExecuted: 2});
});

test('equipment combat procs feed zealot attack and defense through fighter', () => {
  const panel = rawPanel({
    physicalAttack: 100, magicAttack: 50, baseDefense: 500, defenseRate: 0,
    baseMagicResistance: 200,
  });
  const procs = equipmentCombatProcs([gear([{stat: 'zealot', value: 200}])]);
  const zealot = new CombatConditions().fighter('hero', fighterBaseFromPanel(panel, 10, procs.zealotRate));
  // 有效防御 500：物减 = trunc(1000×500/(500+260)) = 657；狂战士扣 657×0.2=131 →526。
  assert.equal(zealot.physicalResistance, 526);
  assert.equal(zealot.zealotRate, 200);

  const target = fighter({physicalResistance: 0, criticalRate: 0});
  const attacker = {...zealot, hitBonus: 1000, criticalRate: 0};
  assert.equal(hitOf(0, attacker, target).damage, 1200, '狂战士攻击侧在命中公式中加 200‰');

  const negativeProcs = equipmentCombatProcs([gear([{stat: 'zealot', value: -200}])]);
  const plain = new CombatConditions().fighter('plain', fighterBaseFromPanel(panel, 10, negativeProcs.zealotRate));
  assert.equal(plain.zealotRate, 0);
  assert.equal(plain.physicalResistance, 657);
  assert.equal(hitOf(0, {...plain, hitBonus: 1000, criticalRate: 0}, target).damage, 1000);
});

test('a lethal equipment proc can defer defeat until the whole hit chain closes', () => {
  const resolution = new CombatHitResolution();
  const order: string[] = [];
  resolution.run(() => {
    resolveHitReactionPipeline(contact, {kind: 'hit', damage: 50}, 'physical', 'basic-attack',
      reactionPort({
        attackProc: () => {
          order.push('equipment-proc');
          resolution.deferDefeat('enemy', () => order.push('defeat-finalized'));
        },
      }));
    order.push('reactions-done');
    assert.deepEqual(order, ['equipment-proc', 'reactions-done'],
      '命中链未结束时不能提前结算死亡');
    assert.equal(resolution.isAwaitingDefeat('enemy'), true);
  });
  assert.deepEqual(order, ['equipment-proc', 'reactions-done', 'defeat-finalized']);
});

/* ------------------------------------------------------------------ */
/* 5b. CombatHitResolution 与 CombatReactionPipeline 的分支             */
/* ------------------------------------------------------------------ */

test('hit resolution runs a depth-zero deferral immediately', () => {
  const resolution = new CombatHitResolution();
  const order: string[] = [];
  resolution.deferDefeat('enemy', () => order.push('finalized'));
  assert.deepEqual(order, ['finalized']);
  assert.equal(resolution.isAwaitingDefeat('enemy'), false);
});

test('hit resolution closes finalizers after a nested run throws', () => {
  const resolution = new CombatHitResolution();
  let finalized = 0;
  assert.throws(() => resolution.run(() => {
    resolution.run(() => {
      resolution.deferDefeat('enemy', () => { finalized += 1; });
      throw new Error('nested failure');
    });
  }), /nested failure/);
  assert.equal(finalized, 1);
  assert.equal(resolution.isAwaitingDefeat('enemy'), false);
  resolution.run(() => assert.equal(finalized, 1, '异常关闭后不应再次执行 finalizer'));
});

test('hit resolution overwrites the same id and keeps first-seen order across ids', () => {
  const resolution = new CombatHitResolution();
  const order: string[] = [];
  resolution.run(() => {
    resolution.deferDefeat('a', () => order.push('a-first'));
    resolution.deferDefeat('b', () => order.push('b'));
    resolution.deferDefeat('a', () => order.push('a-latest'));
    resolution.deferDefeat('c', () => order.push('c'));
  });
  // Map 保留第一次插入位置；同一个 id 只执行最后登记的回调。
  assert.deepEqual(order, ['a-latest', 'b', 'c']);
});

test('physical weapon-block and shield-block emit their own reaction branches', () => {
  const weapon = recordingPort();
  resolveHitReactionPipeline(contact, {kind: 'weapon-block', damage: 50}, 'physical', 'basic-attack',
    weapon.port);
  const weaponBuffs = weapon.buffEvents.map(event => event.kind);
  assert.ok(weaponBuffs.includes('weapon-block-stun'));
  assert.ok(weaponBuffs.includes('weapon-block-counter'));
  assert.ok(weaponBuffs.indexOf('weapon-block-stun') < weaponBuffs.indexOf('weapon-block-counter'),
    '生存本能的眩晕先于绝命格挡反制');
  assert.ok(weapon.skillEvents.some(event => event.kind === 'physical-block'));
  assert.equal(weapon.skillEvents.filter(event => event.kind === 'attack-success').length, 1);
  assert.equal(weapon.skillEvents.some(event => event.kind === 'skill-attack-success'), false);

  const shield = recordingPort();
  resolveHitReactionPipeline(contact, {kind: 'shield-block', damage: 50}, 'physical', 'basic-attack',
    shield.port);
  const shieldBuffs = shield.buffEvents.map(event => event.kind);
  assert.equal(shieldBuffs.includes('weapon-block-stun'), false);
  assert.equal(shieldBuffs.includes('weapon-block-counter'), false);
  assert.ok(shield.skillEvents.some(event => event.kind === 'physical-block'));
  assert.equal(shield.skillEvents.filter(event => event.kind === 'attack-success').length, 1);
});

test('magic critical triggers lightning of hell while physical critical does not', () => {
  let magicLightning = 0;
  let physicalLightning = 0;
  let magicGod = 0;
  let physicalGod = 0;
  resolveHitReactionPipeline(contact, {kind: 'critical', damage: 100}, 'magic', 'basic-attack',
    reactionPort({
      lightningOfHellReaction: () => { magicLightning += 1; },
      godOfJusticeReaction: () => { magicGod += 1; },
    }));
  resolveHitReactionPipeline(contact, {kind: 'critical', damage: 100}, 'physical', 'basic-attack',
    reactionPort({
      lightningOfHellReaction: () => { physicalLightning += 1; },
      godOfJusticeReaction: () => { physicalGod += 1; },
    }));
  assert.equal(magicLightning, 1);
  assert.equal(physicalLightning, 0);
  assert.equal(magicGod, 0, '普通魔法暴击不触发神之定义');
  assert.equal(physicalGod, 0, '普通物理暴击不触发神之定义');
});

test('god of justice fires for divine-strike and hammer-of-wrath criticals', () => {
  let divineGod = 0;
  const divine = recordingPort({godOfJusticeReaction: () => { divineGod += 1; }});
  resolveHitReactionPipeline(contact, {kind: 'critical', damage: 100}, 'physical', 'divine-strike',
    divine.port);
  assert.equal(divineGod, 1);
  assert.ok(divine.skillEvents.some(event => event.kind === 'skill-attack-success'),
    '非普攻暴击仍进入技能成功链');

  let hammerGod = 0;
  let hammerLightning = 0;
  const hammer = recordingPort({
    godOfJusticeReaction: () => { hammerGod += 1; },
    lightningOfHellReaction: () => { hammerLightning += 1; },
  });
  resolveHitReactionPipeline(contact, {kind: 'critical', damage: 100}, 'magic', 'hammer-of-wrath',
    hammer.port);
  assert.equal(hammerGod, 1);
  assert.equal(hammerLightning, 1, '魔法暴击的落雷判定先于神之定义');

  let otherGod = 0;
  const other = recordingPort({godOfJusticeReaction: () => { otherGod += 1; }});
  resolveHitReactionPipeline(contact, {kind: 'critical', damage: 100}, 'magic', 'firestorm', other.port);
  assert.equal(otherGod, 0);
});

test('non-basic successful hits emit skill-attack-success and basic attacks do not', () => {
  const physicalSkill = recordingPort();
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 100}, 'physical', 'firestorm',
    physicalSkill.port);
  const physicalSuccess = physicalSkill.skillEvents.find(event => event.kind === 'skill-attack-success');
  assert.ok(physicalSuccess);
  if (physicalSuccess?.kind === 'skill-attack-success') {
    assert.equal(physicalSuccess.ownerId, 'hero');
    assert.equal(physicalSuccess.opponentId, 'enemy');
    assert.equal(physicalSuccess.damageKind, 'physical');
    assert.equal(physicalSuccess.outcome, 'hit');
  }

  const magicSkill = recordingPort();
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 100}, 'magic', 'ice-blast', magicSkill.port);
  const magicSuccess = magicSkill.skillEvents.find(event => event.kind === 'skill-attack-success');
  assert.ok(magicSuccess);
  if (magicSuccess?.kind === 'skill-attack-success') assert.equal(magicSuccess.damageKind, 'magic');

  const basic = recordingPort();
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 100}, 'physical', 'basic-attack', basic.port);
  assert.equal(basic.skillEvents.some(event => event.kind === 'skill-attack-success'), false);
});

test('zero-damage hits leave sleep while positive damage removes it', () => {
  const conditions = new CombatConditions();
  const port = reactionPort({conditions});
  conditions.applyState('enemy', 'sleep', 10000);
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 0}, 'physical', 'basic-attack', port);
  assert.equal(conditions.hasState('enemy', 'sleep'), true);

  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 1}, 'physical', 'basic-attack', port);
  assert.equal(conditions.hasState('enemy', 'sleep'), false);

  conditions.applyState('enemy', 'sleep', 10000);
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 0}, 'magic', 'ice-blast', port);
  assert.equal(conditions.hasState('enemy', 'sleep'), true, '零伤害魔法命中同样不移除睡眠');
  resolveHitReactionPipeline(contact, {kind: 'hit', damage: 1}, 'magic', 'ice-blast', port);
  assert.equal(conditions.hasState('enemy', 'sleep'), false);
});

test('physical equipment procs and attack hooks run once per successful hit outcome', () => {
  for (const kind of ['hit', 'critical', 'weapon-block', 'shield-block'] as const) {
    let success = 0;
    let attacks = 0;
    let recoveries = 0;
    resolveHitReactionPipeline(contact, {kind, damage: 50}, 'physical', 'basic-attack',
      reactionPort({
        physicalSuccessEquipmentProcs: () => { success += 1; },
        attackProc: () => { attacks += 1; },
        instantRecoveryOnMiss: () => { recoveries += 1; },
      }));
    assert.deepEqual([success, attacks, recoveries], [1, 1, 0], kind);
  }

  let magicSuccess = 0;
  let magicAttacks = 0;
  resolveHitReactionPipeline(contact, {kind: 'critical', damage: 50}, 'magic', 'firestorm',
    reactionPort({
      physicalSuccessEquipmentProcs: () => { magicSuccess += 1; },
      attackProc: () => { magicAttacks += 1; },
    }));
  assert.deepEqual([magicSuccess, magicAttacks], [0, 1], '魔法成功只走攻击触发，不走物理成功链');

  let blockSuccess = 0;
  let blockAttacks = 0;
  resolveHitReactionPipeline(contact, {kind: 'shield-block', damage: 50}, 'magic', 'firestorm',
    reactionPort({
      physicalSuccessEquipmentProcs: () => { blockSuccess += 1; },
      attackProc: () => { blockAttacks += 1; },
    }));
  assert.deepEqual([blockSuccess, blockAttacks], [0, 0]);

  let missSuccess = 0;
  let missAttacks = 0;
  let missRecoveries = 0;
  resolveHitReactionPipeline(contact, {kind: 'miss', damage: 0}, 'physical', 'basic-attack',
    reactionPort({
      physicalSuccessEquipmentProcs: () => { missSuccess += 1; },
      attackProc: () => { missAttacks += 1; },
      instantRecoveryOnMiss: () => { missRecoveries += 1; },
    }));
  assert.deepEqual([missSuccess, missAttacks, missRecoveries], [0, 0, 1]);
});

/* ------------------------------------------------------------------ */
/* 6. 佣兵团技能进入 fighter                                           */
/* ------------------------------------------------------------------ */

test('member combat modifiers enter fighter exactly like separately applied class and party modifiers', () => {
  const catalog = {
    classes: [{id: 'hero', skills: ['training', 'toughness']}],
    skills: {
      training: {id: 'training', passiveUnits: [{
        attribute: 'physicalAttack', condition: 'always', ranks: [{kind: 'add', amount: 100}],
      }]},
      toughness: {id: 'toughness', passiveUnits: [{
        attribute: 'criticalDamage', condition: 'always', ranks: [{kind: 'add', amount: 50}],
      }]},
    },
  } as unknown as BattleCatalog;
  const loadout: SkillLoadout = {levels: {training: 1, toughness: 1}};
  const groupEffects = {
    'low-health-resistance': 100, 'sword-damage': 40, 'plate-defense': 150,
    'magic-resistance': 20, 'critical-damage': 100,
  };
  const modifiers = memberCombatModifiers({
    catalog, classId: 'hero', loadout, weaponKind: 'longsword', armorKind: 'plate',
    health: 30, maxHealth: 100, groupEffects,
  });
  assert.deepEqual(modifiers, [
    {attribute: 'physicalAttack', operation: {kind: 'add', amount: 100}},
    {attribute: 'criticalDamage', operation: {kind: 'add', amount: 50}},
    {attribute: 'physicalResistanceBonus', operation: {kind: 'add', amount: 100}},
    {attribute: 'magicResistance', operation: {kind: 'add', amount: 100}},
    {attribute: 'physicalDamageRate', operation: {kind: 'add', amount: 40}},
    {attribute: 'magicDamageRate', operation: {kind: 'add', amount: 40}},
    {attribute: 'defenseRate', operation: {kind: 'add', amount: 150}},
    {attribute: 'magicResistance', operation: {kind: 'add', amount: 20}},
    {attribute: 'criticalDamage', operation: {kind: 'add', amount: 100}},
  ]);

  const base = fighter({
    physicalAttack: 100, defense: 100, defenseRate: 0, magicAttack: 40,
    maxHealth: 1000, magicResistance: 100,
  });
  const conditions = new CombatConditions();
  const combined = conditions.fighter('combined', base, modifiers);
  // 物攻 100+100=200，再乘 40‰ 物伤率 → 208。
  assert.equal(combined.physicalAttack, 208);
  assert.equal(combined.magicDamageRate, 40);
  // 防御 100，防御率 150 → 有效防御 115；物减 306 + 低血被动 100 = 406。
  assert.equal(combined.defense, 100);
  assert.equal(combined.defenseRate, 150);
  assert.equal(combined.physicalResistance, 406);
  assert.equal(combined.magicResistance, 220);
  assert.equal(combined.criticalDamage, 1150);

  const separately = conditions.fighter('separately', base, [
    ...passiveModifiersForTest(),
    ...partyCombatModifiers(groupEffects, 'longsword', 'plate', 30, 100),
  ]);
  assert.deepEqual(combined, separately);
});

function passiveModifiersForTest(): PassiveModifier[] {
  // 与 memberCombatModifiers 的被动段一致；单独拆出来用于对照组装结果。
  return [
    {attribute: 'physicalAttack', operation: {kind: 'add', amount: 100}},
    {attribute: 'criticalDamage', operation: {kind: 'add', amount: 50}},
  ];
}
