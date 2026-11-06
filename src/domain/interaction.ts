import type { ActorDefinition } from './content.ts';

type InteractionService = NonNullable<ActorDefinition['service']>;

/** 交互决策的结果；场景按 kind 执行对应表现或面板。 */
type InteractionAction =
  | { kind: 'chest' }
  | { kind: 'spring' }
  | { kind: 'crafting' }
  | { kind: 'soul-healer' }
  | { kind: 'legendary-sword' }
  | { kind: 'innkeeper' }
  | { kind: 'shop' }
  | { kind: 'story' };

/** 场景对“附近目标”的只读描述；判定顺序按原版，不由调用方拼 switch。 */
export interface InteractionTarget {
  chest: boolean;
  spring: boolean;
  service?: InteractionService;
  /** 目标实体是否带任务目标（objective）；有任务目标时商店让位给剧情。 */
  objective: boolean;
  /** 该 NPC 当前是否占用了任务槽（可接/可交）。 */
  questSlot: boolean;
  /** 附近目标是否有对应商店。 */
  shop: boolean;
}

/**
 * 纯决策：宝箱 → 泉水 → 任务槽 → NPC 服务 → 商店 → 普通剧情。
 * 场景只负责把附近对象翻译成这些布尔值，并按返回的动作执行。
 */
export function resolveInteraction(target: InteractionTarget): InteractionAction {
  if (target.chest) return { kind: 'chest' };
  if (target.spring) return { kind: 'spring' };
  // 原版先取 NPC 任务槽，再执行 NPC 功能分支；任务槽优先于融合机/治疗/古剑/旅店。
  if (target.service && target.questSlot) return { kind: 'story' };
  if (target.service === 'fusion-machine') return { kind: 'crafting' };
  if (target.service === 'soul-healer') return { kind: 'soul-healer' };
  if (target.service === 'legendary-sword') return { kind: 'legendary-sword' };
  if (target.service === 'innkeeper') return { kind: 'innkeeper' };
  if (target.shop && !target.objective && !target.questSlot) return { kind: 'shop' };
  return { kind: 'story' };
}
