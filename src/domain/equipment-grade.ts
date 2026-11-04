import { DEFAULT_EQUIPMENT_GRADE, type CharacterStatsCatalog, type EquipmentGradeSeed, type EquipmentNumbers } from './character-stats.ts';

/**
 * 稀有度档位与品级抽样。原版地面随机装备走 `GenerateGrade(0)`：先按稀有度权重选档，
 * 再在该档的品级里按 `ITEMGRADEBASE` 的档内权重抽；两层权重都来自原版表。
 */
export interface GradeProfile {
  weights: readonly number[];
  rarityScale?: readonly number[];
  /** 保底/宝箱品质下限：低于该稀有度的档位权重清零。 */
  minRarity?: number;
  /** 地面随机装备只到品级 9；unique/epic 走静态品级。 */
  maxGrade?: number;
  /** 幸运：把少量权重从普通档移到稀有档，不改变槽位命中率。 */
  luck?: number;
}

interface RolledGrade extends EquipmentGradeSeed {
  rarity: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function draw(random: () => number, max: number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('品级随机值无效');
  return Math.floor(value * max);
}

function pickWeighted(weights: readonly number[], random: () => number): number {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return -1;
  const roll = draw(random, total);
  let sum = 0;
  for (let index = 0; index < weights.length; index += 1) {
    sum += weights[index]!;
    if (roll < sum) return index;
  }
  return weights.length - 1;
}

/** 稀有度权重经过章节缩放、品质下限和幸运修正后的结果。 */
export function rarityWeights(profile: GradeProfile): number[] {
  const scale = profile.rarityScale ?? [];
  const weights = profile.weights.map((value, tier) => Math.floor(value * (scale[tier] ?? 1000) / 1000));
  if (profile.minRarity !== undefined) {
    for (let tier = 0; tier < weights.length; tier += 1)
      if (tier < profile.minRarity) weights[tier] = 0;
  }
  const luck = clamp(profile.luck ?? 0, 0, 50);
  if (luck > 0 && weights.length >= 3 && weights[0]! > 0) {
    const move = Math.min(Math.floor(weights[0]! / 2), luck * 2);
    weights[0] = weights[0]! - move;
    weights[2] = weights[2]! + move;
  }
  return weights;
}

/**
 * 按原版顺序抽稀有度与品级。返回 undefined 表示这件物品没有可用的品级档，
 * 调用方回退到物品的 `defaultGrade`。
 */
export function rollGrade(
  stats: Pick<CharacterStatsCatalog, 'grades'>,
  equipment: Pick<EquipmentNumbers, 'gradeVariants'>,
  profile: GradeProfile,
  random: () => number,
): RolledGrade | undefined {
  const grades = stats.grades;
  const variants = equipment.gradeVariants;
  if (!grades?.length || !variants?.length) return undefined;
  const weights = rarityWeights(profile);
  let tier = pickWeighted(weights, random);
  if (tier < 0) {
    // 品质下限把所有档都清空时，回退到当前可用的最高档，而不是静默掉普通物品。
    tier = weights.length - 1;
    while (tier > 0 && weights[tier] === 0) tier -= 1;
  }
  const maxGrade = profile.maxGrade ?? 9;
  const candidates = grades.filter(grade => grade.rarity === tier && grade.index <= maxGrade && grade.index < variants.length);
  const pool = candidates.length ? candidates : grades.filter(grade => grade.index <= maxGrade && grade.index < variants.length);
  if (!pool.length) return undefined;
  const index = pickWeighted(pool.map(grade => grade.weight), random);
  if (index < 0) return undefined;
  const grade = pool[index]!;
  const variant = variants[grade.index]!;
  return {
    grade: grade.index,
    rarity: grade.rarity,
    gradeName: variant.name,
    attack: variant.attack,
    defense: variant.defense,
    optionCount: variant.optionCount,
    socketLimit: variant.socketLimit,
  };
}

/** 固定品级（unique 10、epic 11..14、固定掉落）：不重掷，直接取静态档。 */
export function staticGrade(
  stats: Pick<CharacterStatsCatalog, 'grades'>,
  equipment: Pick<EquipmentNumbers, 'gradeVariants' | 'defaultGrade'>,
): RolledGrade | undefined {
  const index = equipment.defaultGrade ?? DEFAULT_EQUIPMENT_GRADE;
  const variant = equipment.gradeVariants?.[index];
  if (!variant) return undefined;
  const rarity = stats.grades?.find(grade => grade.index === index)?.rarity ?? variant.rarity;
  return {
    grade: index,
    rarity,
    gradeName: variant.name,
    attack: variant.attack,
    defense: variant.defense,
    optionCount: variant.optionCount,
    socketLimit: variant.socketLimit,
  };
}
