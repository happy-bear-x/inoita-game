// 开放地图允许折返。这里列出有正式交接依据的单线阶段；同图的自由支线各自保留进度。
// 一段用真实脚本标识定位，含玩家在两段之间通过对话或战斗完成的交接。
const opening = [
  'event-0', 'event-1', 'event-2', 'event-13', 'event-14',
  'event-3', 'event-4', 'event-5', 'event-6', 'event-411',
  'event-7', 'event-8', 'event-9', 'event-10', 'event-418',
  'event-47', 'next:quest-10:quest-11', 'event-15', 'event-184',
];

const castleRescue = [
  'event-49', 'event-50', 'event-51', 'event-57', 'event-52',
  'event-53', 'event-54', 'event-55', 'event-19',
];

const desertPursuit = [
  'event-20', 'event-21', 'event-22', 'event-23',
];

const storyRoute = [...opening, ...castleRescue, ...desertPursuit];

export function questJumpHistory(intakeScript: string | undefined, quest: string, mode: 'available' | 'active' | 'ready') {
  if (!intakeScript) return;
  const index = storyRoute.indexOf(intakeScript);
  if (index < 0) return;
  // 救人后回莱曼处、打完伯爵回卓拉德处，均从实际完成战斗或救人的演出之后开始。
  const at = mode === 'ready' && quest === 'quest-40' ? storyRoute.indexOf('event-52') + 1
    : mode === 'ready' && quest === 'grafton-mission' ? storyRoute.indexOf('event-5') + 1
    : index + (mode === 'available' ? 0 : 1);
  return { past: storyRoute.slice(0, at), future: storyRoute.slice(at) };
}
