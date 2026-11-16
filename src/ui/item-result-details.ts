import type { ItemCatalog, ItemResult } from '../domain/items.ts';

/** Concrete contents remain available in the bag's detail pane after an operation. */
export function itemResultDetails(result: ItemResult | undefined, catalog: ItemCatalog,
  skillName: (id: string) => string, className: (id: string) => string): string[] {
  if (!result) return [];
  const lines = result.rewards.map(reward => `${catalog.items[reward.item].name} × ${reward.quantity}`);
  if (result.kind === 'unseal') lines.push('已永久解锁');
  if (result.skill) lines.push(`技能：${skillName(result.skill)}`);
  if (result.classId) lines.push(`职业：${className(result.classId)}`);
  if (result.recipe) {
    const recipe = catalog.recipes[result.recipe];
    lines.push(`配方：${recipe.name}`, `产物：${catalog.items[recipe.result].name}`, '所需材料：',
      ...recipe.materials.map(material => `${catalog.items[material.item].name} × ${material.quantity}`));
  }
  return lines;
}
