/**
 * 剧情触发的占用表。
 *
 * 区域触发和近身触发共用一张表：某段戏这一帧报过了就记下来，避免每帧重复上报。
 * 关键在于**什么时候放下占用**——放下得太保守，玩家走开再回来就再也触发不了。
 *
 * 原版这批近身事件允许多次触发（61 条带重复标志），事件 186 就是典型：玩家在选项里
 * 选「我还有事，请稍等」之后，原路走回来应当能重开。所以「身边不再站着这个人」就要
 * 把占用放下，而不是等到切图重建场景。
 */
interface OccupancyEvent { id: string }

/**
 * 这一帧该起演的近身事件。`besideAt` 返回「玩家身边站着的、这个事件点名的角色」，没有就是 null。
 *
 * - 不在身边：放下占用（下次靠近才能重新触发）；
 * - 在身边且此前已占用：跳过；
 * - 在身边、未占用，且条件成立（`eligible`）：占用并返回。
 *
 * 判定顺序与场景原本的写法一致（先看占用、再看条件），所以已经占用的事件不会因为条件
 * 这一帧不成立就丢掉占用。
 */
export function claimNearTrigger<E extends OccupancyEvent, C>(
  events: readonly E[],
  occupied: Set<string>,
  besideAt: (event: E) => C | null,
  eligible: (event: E) => boolean,
): { event: E; beside: C } | null {
  for (const event of events) {
    const beside = besideAt(event);
    if (!beside) { occupied.delete(event.id); continue; }
    if (occupied.has(event.id)) continue;
    if (!eligible(event)) continue;
    occupied.add(event.id);
    return { event, beside };
  }
  return null;
}
