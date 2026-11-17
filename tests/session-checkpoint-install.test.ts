import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCheckpoint } from '../src/domain/session-checkpoint.ts';
import type { Session, SessionState } from '../src/domain/session.ts';

test('install stores a detached snapshot and undefined clears the checkpoint', () => {
  const checkpoint = new SessionCheckpoint<{ marker: number }>();
  const state = { saved: true } as unknown as SessionState;
  let restored: SessionState | undefined;
  const session = {
    hasLivingMember: true,
    captureState: () => structuredClone(state),
    restoreState: (value: SessionState) => { restored = value; },
  } as unknown as Session;

  assert.equal(checkpoint.capture(session, { map: 'forest', x: 8, y: 16 }, { marker: 1 }), true);
  const peeked = checkpoint.peek()!;
  peeked.world.marker = 2;
  checkpoint.install(peeked);
  peeked.world.marker = 99;
  assert.deepEqual(checkpoint.peek()!.world, { marker: 2 }, 'install 克隆快照，不能和调用方共享');

  restored = undefined;
  assert.deepEqual(checkpoint.restore(session), { location: { map: 'forest', x: 8, y: 16 }, world: { marker: 2 } });
  assert.deepEqual(restored, state);

  checkpoint.install(undefined);
  assert.equal(checkpoint.available, false);
  assert.equal(checkpoint.restore(session), undefined);
});
