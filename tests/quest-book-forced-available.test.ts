import assert from 'node:assert/strict';
import test from 'node:test';
import { QuestBook, type QuestCommand, type QuestContext, type QuestRules } from '../src/domain/quest-book.ts';

function rules(id: string, patch: Partial<QuestRules> = {}): QuestRules {
  return { id, completion: 'talk', goals: [], ...patch };
}

function fixture(definitions: QuestRules[]) {
  const context: QuestContext = { classId: 'priest', itemCount: () => 0, equippedItemCount: () => 0,
    questStatus: () => 'locked', eventStatus: () => 'idle', choice: () => undefined,
    flag: () => false, world: () => undefined };
  const book = new QuestBook(definitions, () => context, new Set());
  const commit = (commands: QuestCommand | readonly QuestCommand[]) => {
    const plan = book.plan(commands); book.commit(plan); return plan;
  };
  return { book, commit };
}

/** 一个靠前置任务解锁的任务；没有强制集合时它一直锁定。 */
function gatedDefinitions(): QuestRules[] {
  return [
    rules('pre', { completion: 'story' }),
    rules('gated', { completion: 'story', availableWhen: { type: 'quest', quest: 'pre', status: 'completed' } }),
    rules('other', { completion: 'story', availableWhen: { type: 'quest', quest: 'pre', status: 'completed' } }),
    rules('internal', { completion: 'internal', availableWhen: { type: 'all', conditions: [] } }),
  ];
}

test('forced availability survives a full refresh and accept, then relocks when cleared', () => {
  const { book, commit } = fixture(gatedDefinitions());
  assert.equal(book.status('gated'), 'locked');

  book.forceAvailable('gated', true);
  assert.equal(book.status('gated'), 'available');
  commit({ type: 'refresh' });
  assert.equal(book.status('gated'), 'available', '全量刷新不能把强制可接取的任务打回锁定');

  commit({ type: 'accept', quest: 'gated' });
  assert.equal(book.status('gated'), 'active');

  // 已接取的任务不会因为清掉强制集合而退回锁定。
  book.clearForcedAvailable();
  assert.equal(book.status('gated'), 'active');

  // 仍处于可接取的任务在清除强制后按 availableWhen 回到锁定。
  book.forceAvailable('other', true);
  assert.equal(book.status('other'), 'available');
  book.clearForcedAvailable();
  assert.equal(book.status('other'), 'locked');
});

test('an explicit completion releases the pinned ready progress', () => {
  const { book, commit } = fixture([
    rules('pre', { completion: 'story' }),
    rules('after', { completion: 'story' }),
  ]);
  commit({ type: 'accept', quest: 'pre' });
  book.forceProgress('pre', { status: 'ready', cycle: 0, completedCycles: 0, goals: {} });
  assert.equal(book.status('pre'), 'ready');

  commit({ type: 'script-complete', quest: 'pre' });
  assert.equal(book.status('pre'), 'completed', '正式完成不能被调试用的 ready 钉住');
});

test('forcing availability never opens internal quests', () => {
  const { book } = fixture(gatedDefinitions());
  book.forceAvailable('internal', true);
  assert.equal(book.status('internal'), 'locked');
});

test('the incremental refresh path also reads the forced set and keeps it out of state snapshots', () => {
  const { book } = fixture(gatedDefinitions());
  book.forceAvailable('gated', true);

  // 把真实状态写回锁定，再走公开的增量刷新入口：视图里也必须带上强制集合。
  const state = structuredClone(book.captureState());
  const entry = state.quests.find(([id]) => id === 'gated')!;
  entry[1] = { ...entry[1]!, status: 'locked' };
  book.installTrustedState(state);
  assert.equal(book.status('gated'), 'locked');
  book.refreshAffected(['gated']);
  assert.equal(book.status('gated'), 'available');

  book.clearForcedAvailable();
  assert.equal(book.status('gated'), 'locked');
  assert.equal('forcedAvailable' in book.captureState(), false, '强制集合不进任务快照');
});
