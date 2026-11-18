/** 一次靠近角色或踏入区域最多选中一个事件。过滤中的候选尚未占用，解除过滤后可原地补播。 */
export function claimStoryTrigger<E extends { id: string }, S>(
  events: readonly E[],
  occupied: Set<string>,
  inContact: (event: E) => boolean,
  select: (event: E) => S | false | null,
): { event: E; selection: S } | null {
  let claimed: { event: E; selection: S } | null = null;
  for (const event of events) {
    const alreadyOccupied = occupied.has(event.id);
    if (claimed && !alreadyOccupied) continue;
    if (!inContact(event)) { occupied.delete(event.id); continue; }
    if (alreadyOccupied) continue;
    const selection = select(event);
    if (selection === false || selection === null) continue;
    occupied.add(event.id);
    claimed = { event, selection };
  }
  return claimed;
}
