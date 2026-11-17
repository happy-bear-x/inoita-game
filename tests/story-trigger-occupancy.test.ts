import assert from 'node:assert/strict';
import test from 'node:test';
import { claimNearTrigger } from '../src/domain/story-trigger-occupancy.ts';

type Actor = { id: string };

test('walking away releases the claim so the same near event can fire again', () => {
  // 事件 186：莱曼的「现在准备好出发了？」。玩家选「我还有事，请稍等」之后原路走回来，
  // 原版要能重开（这批近身事件带重复标志）。占用表不释放就会一直跳过，永远不再触发。
  const events = [{ id: 'event-186' }];
  const occupied = new Set<string>();
  let beside: Actor | null = { id: 'lyman' };
  const claim = () => claimNearTrigger(events, occupied, () => beside, () => true);

  assert.equal(claim()?.event.id, 'event-186', '第一次靠近就该起演');
  assert.equal(claim(), null, '同一次靠近不重复上报');

  beside = null;
  assert.equal(claim(), null);
  assert.equal(occupied.has('event-186'), false, '走开之后占用要放下');

  beside = { id: 'lyman' };
  assert.equal(claim()?.event.id, 'event-186', '走回来应当能重新触发');
});

test('a replayed story releases its claim even while the player keeps standing there', () => {
  // 起演没成功（导演这一刻不收、或运行时不认这次触发）时，由调用方在回调里 delete；
  // 这里钉住同一个语义的另一面：占用只挡「同一帧重复上报」，不挡显式释放。
  const events = [{ id: 'event-186' }];
  const occupied = new Set<string>();
  assert.equal(claimNearTrigger(events, occupied, () => ({ id: 'lyman' }), () => true)?.event.id, 'event-186');
  occupied.delete('event-186');
  assert.equal(claimNearTrigger(events, occupied, () => ({ id: 'lyman' }), () => true)?.event.id, 'event-186');
});

test('clearing an automatic-event filter releases the near claim in place', () => {
  const events = [{ id: 'event-186' }];
  const occupied = new Set(['event-186']);
  const beside = () => ({ id: 'lyman' });
  assert.equal(claimNearTrigger(events, occupied, beside, () => true, () => false), null);
  assert.equal(occupied.has('event-186'), true, '调试过滤期间保持占用');

  assert.equal(claimNearTrigger(events, occupied, beside, () => true, () => true)?.event.id,
    'event-186', '过滤解除后不用走开也能补触发');
});

test('an occupied event keeps its claim while its condition is unmet', () => {
  const events = [{ id: 'event-186' }];
  const occupied = new Set(['event-186']);
  const claimed = claimNearTrigger(events, occupied, () => ({ id: 'lyman' }), () => false);
  assert.equal(claimed, null);
  assert.equal(occupied.has('event-186'), true, '条件不成立不该顺手把占用丢掉');
});
