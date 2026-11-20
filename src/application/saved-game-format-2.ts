import { SAVE_FORMAT, type SaveGame } from '../domain/save-game.ts';
import { STORY_TRIGGER_SOURCES } from '../domain/story-graph.ts';
import type { StoryWorldViewSnapshot } from './world-snapshot.ts';

// 格式 2 的任务簿包含当时发布的全部任务。只移除这次撤下的引用，其余数据照常校验。
const removedQuests = new Set([3, 4, 13, 14, 15, 16, 17, 27, 147].map(id => `quest-${id}`));
const removedScripts = new Set([12, 16, 17, 18, 24, 33, 34, 37, 39, 46, 56, 79, 349, 592, 593].map(id => `event-${id}`));
const removedOccurrenceSequences = new Set([...removedScripts].flatMap(id =>
  STORY_TRIGGER_SOURCES.map(source => JSON.stringify([id, source]))));
// 格式 2 的 quest 来源候选表从 0 计数，索引 9 是唯一撤下的触发 event-24。
const removedQuestEventIndex = 9;
const removedBattle = (key: string) => /(?:^|:)event-(?:37|39)-battle(?:$|:)/.test(key);

export function migrateFormat2Save(original: SaveGame<StoryWorldViewSnapshot>): SaveGame<StoryWorldViewSnapshot> {
  const session = { ...original.session };
  const world = { ...original.world };
  const questBook = { ...session.questBook }, runtime = { ...session.runtime }, storyWorld = { ...session.storyWorld };
  questBook.quests = questBook.quests.filter(([id]) => !removedQuests.has(id));
  questBook.runningQuestIds = questBook.runningQuestIds.filter(id => !removedQuests.has(id));
  if (session.trackedQuest && removedQuests.has(session.trackedQuest)) delete session.trackedQuest;
  session.receipts = session.receipts.filter(receipt => !removedQuests.has(receipt.quest));

  runtime.runs = runtime.runs.filter(run => !removedScripts.has(run.cursor.script)
    && !(run.script && removedScripts.has(run.script)) && !(run.eventId && removedScripts.has(run.eventId)));
  runtime.completedEvents = runtime.completedEvents.filter(id => !removedScripts.has(id));
  runtime.handledOccurrences = runtime.handledOccurrences.filter(([id]) => !removedScripts.has(id));
  runtime.occurrenceSequences = runtime.occurrenceSequences.filter(([key]) => !removedOccurrenceSequences.has(key));
  runtime.pendingOccurrences = runtime.pendingOccurrences.filter(({ occurrence: { source, key } }) =>
    !(key && ((source === 'event' && removedScripts.has(key)) || (source === 'quest' && removedQuests.has(key))
      || (source === 'battle' && removedBattle(key)))));
  runtime.pendingOccurrences = runtime.pendingOccurrences.map(pending =>
    pending.occurrence.source === 'quest' && Number.isSafeInteger(pending.nextEventIndex) && pending.nextEventIndex > removedQuestEventIndex
      ? { ...pending, nextEventIndex: pending.nextEventIndex - 1 } : pending);

  storyWorld.encounters = storyWorld.encounters.filter(entry => !removedBattle(entry.definitionId ?? entry.id));
  runtime.encounterResults = runtime.encounterResults.filter(key => !removedBattle(key));
  session.enemies = session.enemies.filter(([key]) => !removedBattle(key));
  // 强制播放过旧战斗时，敌人、仇恨和召唤关系共用一份现场快照。按正式地图和会话重建现场。
  if (world.world?.roster.enemies.some(enemy => removedBattle(enemy.key))) delete world.world;
  if (world.scene?.visit?.roster.enemies.some(enemy => removedBattle(enemy.key))
    || world.scene?.actors.some(actor => actor.enemyKey && removedBattle(actor.enemyKey))) delete world.scene;
  return { ...original, format: SAVE_FORMAT, session: { ...session, questBook, runtime, storyWorld }, world };
}
