import assert from 'node:assert/strict';
import test from 'node:test';
import type { CampaignQuest } from '../src/domain/campaign.ts';
import type { QuestStatus } from '../src/domain/content.ts';
import { questNotices, type QuestNoticeState } from '../src/ui/quest-progress.ts';

const quest = (patch: Partial<CampaignQuest> & { id: string }): CampaignQuest => ({
  title: patch.id, description: '', guidance: { available: '', active: '' },
  completion: 'all', goals: [], progressText: '', completeText: '', ...patch,
});
const state = (status: QuestStatus, goals?: Record<string, number>): QuestNoticeState => ({ status, goals });
const view = (status: QuestStatus, goals: Record<string, number> = {}) => ({ status, goals });
const notices = (
  previous: Map<string, QuestNoticeState>,
  next: Map<string, ReturnType<typeof view>>,
  definitions: CampaignQuest[],
) => questNotices(previous, next, id => definitions.find(value => value.id === id));

const hunt = quest({
  id: 'hunt', title: '猎狼',
  goals: [{ id: 'wolf', kind: 'defeat', target: 'wolf', quantity: 5, label: '野狼' }],
});

test('a count increase becomes one progress line', () => {
  const result = notices(
    new Map([['hunt', state('active', { wolf: 2 })]]),
    new Map([['hunt', view('active', { wolf: 3 })]]),
    [hunt],
  );
  assert.equal(result.progress, '任务进度：野狼 3/5');
  assert.deepEqual(result.completions, []);
  assert.deepEqual(result.snapshot.get('hunt'), state('active', { wolf: 3 }));
});

test('progress is capped at the goal quantity and never reports a decrease', () => {
  const capped = notices(
    new Map([['hunt', state('active', { wolf: 3 })]]),
    new Map([['hunt', view('active', { wolf: 9 })]]),
    [hunt],
  );
  assert.equal(capped.progress, '任务进度：野狼 5/5');

  const dropped = notices(
    new Map([['hunt', state('active', { wolf: 3 })]]),
    new Map([['hunt', view('active', { wolf: 2 })]]),
    [hunt],
  );
  assert.equal(dropped.progress, undefined);
  assert.deepEqual(dropped.snapshot.get('hunt'), state('active', { wolf: 2 }));
});

test('a newly accepted quest does not report items already in the bag', () => {
  const result = notices(
    new Map([['hunt', state('available')]]),
    new Map([['hunt', view('active', { wolf: 1 })]]),
    [hunt],
  );
  assert.equal(result.progress, undefined);
  assert.deepEqual(result.snapshot.get('hunt'), state('active', { wolf: 1 }));
});

test('becoming ready reports completion instead of progress', () => {
  const result = notices(
    new Map([['hunt', state('active', { wolf: 4 })]]),
    new Map([['hunt', view('ready', { wolf: 5 })]]),
    [hunt],
  );
  assert.deepEqual(result.completions, ['任务完成：猎狼']);
  assert.equal(result.progress, undefined);
  assert.deepEqual(result.snapshot.get('hunt'), state('ready', { wolf: 5 }));
});

test('a quest that becomes ready straight from available still reports completion', () => {
  const result = notices(
    new Map([['hunt', state('available')]]),
    new Map([['hunt', view('ready', { wolf: 5 })]]),
    [hunt],
  );
  assert.deepEqual(result.completions, ['任务完成：猎狼']);
});

test('journal-external quests neither report nor enter the snapshot', () => {
  const secret = quest({
    id: 'secret', journal: false,
    goals: [{ id: 'wolf', kind: 'defeat', target: 'wolf', quantity: 5, label: '野狼' }],
  });
  const result = notices(
    new Map([['secret', state('active', { wolf: 2 })]]),
    new Map([['secret', view('active', { wolf: 3 })]]),
    [secret],
  );
  assert.equal(result.progress, undefined);
  assert.equal(result.snapshot.has('secret'), false);
});

test('multiple increases share one line and stop after three goals', () => {
  const mixed = quest({
    id: 'mixed', title: '混合',
    goals: ['a', 'b', 'c', 'd'].map((id, index) => ({
      id, kind: 'defeat' as const, target: id, quantity: index + 1, label: ['甲', '乙', '丙', '丁'][index],
    })),
  });
  const result = notices(
    new Map([['mixed', state('active', { a: 0, b: 0, c: 0, d: 0 })]]),
    new Map([['mixed', view('active', { a: 1, b: 2, c: 3, d: 4 })]]),
    [mixed],
  );
  assert.equal(result.progress, '任务进度：甲 1/1、乙 2/2、丙 3/3…');
});

test('long labels are shortened to keep the hint on one line', () => {
  const long = quest({
    id: 'long', title: '长标签',
    goals: [
      { id: 'a', kind: 'defeat', target: 'a', quantity: 10, label: '被揭露的帝国间谍多哈莫尔' },
      { id: 'b', kind: 'defeat', target: 'b', quantity: 10, label: '暴走的暗精灵副队长之亡灵' },
    ],
  });
  const result = notices(
    new Map([['long', state('active', { a: 0, b: 0 })]]),
    new Map([['long', view('active', { a: 1, b: 1 })]]),
    [long],
  );
  assert.equal(result.progress, '任务进度：被揭露的帝国间谍多哈莫尔 1/10…');
});

test('an overlong first label is shortened instead of overflowing', () => {
  const long = quest({
    id: 'long-label', title: '超长',
    goals: [
      { id: 'a', kind: 'defeat', target: 'a', quantity: 1, label: '一'.repeat(30) },
      { id: 'b', kind: 'defeat', target: 'b', quantity: 1, label: '二'.repeat(30) },
    ],
  });
  const result = notices(
    new Map([['long-label', state('active', { a: 0, b: 0 })]]),
    new Map([['long-label', view('active', { a: 1, b: 1 })]]),
    [long],
  );
  assert.equal(result.progress, `任务进度：${'一'.repeat(19)}… 1/1…`);
  assert.ok((result.progress?.length ?? 0) <= 32);
});

test('only goals whose number grew are reported', () => {
  const mixed = quest({
    id: 'mixed', title: '混合',
    goals: [
      { id: 'a', kind: 'defeat', target: 'a', quantity: 5, label: '甲' },
      { id: 'b', kind: 'defeat', target: 'b', quantity: 5, label: '乙' },
    ],
  });
  const result = notices(
    new Map([['mixed', state('active', { a: 2, b: 3 })]]),
    new Map([['mixed', view('active', { a: 1, b: 4 })]]),
    [mixed],
  );
  assert.equal(result.progress, '任务进度：乙 4/5');
});

test('story and talk quests stay out of the snapshot', () => {
  const talk = quest({ id: 'talk', completion: 'talk' });
  const result = notices(
    new Map([['talk', state('available')]]),
    new Map([['talk', view('ready')]]),
    [talk],
  );
  assert.deepEqual(result.completions, []);
  assert.equal(result.snapshot.has('talk'), false);
});
