/** 一次靠近角色或踏入区域最多选中一个事件。过滤中的候选尚未占用，解除过滤后可原地补播。 */
export function claimStoryTrigger<E extends { id: string }, C>(
  events: readonly E[],
  occupied: Set<string>,
  contactAt: (event: E) => C | null,
  eligible: (event: E) => boolean,
): { event: E; contact: C } | null {
  let claimed: { event: E; contact: C } | null = null;
  for (const event of events) {
    const alreadyOccupied = occupied.has(event.id);
    if (claimed && !alreadyOccupied) continue;
    const contact = contactAt(event);
    if (contact === null) { occupied.delete(event.id); continue; }
    if (alreadyOccupied || !eligible(event)) continue;
    occupied.add(event.id);
    claimed = { event, contact };
  }
  return claimed;
}
