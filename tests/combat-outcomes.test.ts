import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';

interface Failure { error: unknown; render: boolean; phase: 'settle' | 'present' }

test('a failing settlement clears the ticket and calls the failure hook', () => {
  const pending = new PendingEnemyDefeats();
  const failures: Failure[] = [];
  let presented = 0;
  pending.add('enemy:1', () => { throw new Error('settle failed'); }, () => { presented++; },
    (error, render, phase) => failures.push({ error, render, phase }));

  assert.doesNotThrow(() => pending.complete('enemy:1'));
  assert.equal(pending.has('enemy:1'), false);
  assert.equal(presented, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.phase, 'settle');
  assert.equal((failures[0]!.error as Error).message, 'settle failed');
});

test('a failing presentation clears the ticket and calls the failure hook', () => {
  const pending = new PendingEnemyDefeats();
  const failures: Failure[] = [];
  let settled = 0;
  pending.add('enemy:2', () => { settled++; }, () => { throw new Error('present failed'); },
    (error, render, phase) => failures.push({ error, render, phase }));

  assert.doesNotThrow(() => pending.complete('enemy:2'));
  assert.equal(settled, 1);
  assert.equal(pending.has('enemy:2'), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.phase, 'present');
  assert.equal((failures[0]!.error as Error).message, 'present failed');
});

test('a failure hook that throws cannot escape the combat frame', () => {
  const pending = new PendingEnemyDefeats();
  pending.add('enemy:3', () => { throw new Error('settle failed'); }, undefined,
    () => { throw new Error('failure hook failed'); });

  assert.doesNotThrow(() => pending.complete('enemy:3'));
  assert.equal(pending.has('enemy:3'), false);
});

test('flush clears every failing ticket without throwing', () => {
  const pending = new PendingEnemyDefeats();
  const failures: string[] = [];
  for (const key of ['enemy:a', 'enemy:b']) {
    pending.add(key, () => { throw new Error(key); }, undefined,
      (_error, _render, phase) => failures.push(`${key}:${phase}`));
  }

  assert.doesNotThrow(() => pending.flush());
  assert.equal(pending.has('enemy:a'), false);
  assert.equal(pending.has('enemy:b'), false);
  assert.deepEqual(failures, ['enemy:a:settle', 'enemy:b:settle']);
});
