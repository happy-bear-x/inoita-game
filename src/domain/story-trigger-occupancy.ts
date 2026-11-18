/** 一次靠近角色或踏入区域最多选中一个事件。过滤中的候选尚未占用，解除过滤后可原地补播。 */
export function claimStoryTrigger<E extends { id: string }, S>(
  events: readonly E[],
  occupied: Set<string>,
  inContact: (event: E) => boolean,
  select: (event: E) => S | false | null,
  preferred?: (selection: S) => boolean,
): { event: E; selection: S } | null {
  let claimed: { event: E; selection: S } | null = null;
  let finalChoice = false;
  for (const event of events) {
    const alreadyOccupied = occupied.has(event.id);
    if (finalChoice && !alreadyOccupied) continue;
    if (!inContact(event)) { occupied.delete(event.id); continue; }
    if (alreadyOccupied || finalChoice) continue;
    const selection = select(event);
    if (selection === false || selection === null) continue;
    finalChoice = preferred?.(selection) ?? true;
    if (!claimed || finalChoice) claimed = { event, selection };
  }
  if (claimed) occupied.add(claimed.event.id);
  return claimed;
}
