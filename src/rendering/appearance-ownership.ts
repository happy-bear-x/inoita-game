import type { AssetLease } from '../application/assets.ts';
import type { ActorDefinition } from '../domain/content.ts';

// 只在渲染层登记；内容定义和存档继续只包含游戏数据。
const appearances = new WeakMap<ActorDefinition, () => AssetLease>();

export function registerAppearance(actor: ActorDefinition, retain: () => AssetLease): void {
  appearances.set(actor, retain);
}

export function retainAppearance(actor: ActorDefinition): AssetLease | undefined {
  return appearances.get(actor)?.();
}

export function retireAppearance(actor: ActorDefinition): void {
  if (appearances.has(actor)) appearances.set(actor, () => {
    throw new DOMException('人物外观已释放', 'AbortError');
  });
}
