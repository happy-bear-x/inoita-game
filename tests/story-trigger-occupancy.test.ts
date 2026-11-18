import assert from 'node:assert/strict';
import test from 'node:test';
import { claimStoryTrigger } from '../src/domain/story-trigger-occupancy.ts';
import { headlessContent, playthrough } from './helpers/story-playthrough.ts';

test('the border-gateway greeter plays once per approach through the world frame', async () => {
  const h = playthrough();
  const map = 'border-gateway-67e044a2';
  const placement = headlessContent.campaign.scripts['event-125'].nodes.flatMap(node => node.commands)
    .find(command => command.type === 'world' && command.command.kind === 'place' && command.command.entity.characterId === 'npc-240')!;
  const greetings = () => h.lines.filter(line => line.includes('富起来了')).length;
  try {
    h.session.applyStoryCommands([{type:'travel',destination:{map,x:216,y:168,facing:'north'}},placement]);
    for (let frame = 0; frame < 4; frame++) { h.frame('all'); await h.idle(); }
    assert.equal(greetings(),1);
    h.session.movePlayer({map,x:240,y:184,facing:'north'});
    h.frame('all'); await h.idle();
    h.session.movePlayer({map,x:216,y:168,facing:'north'});
    h.frame('all'); await h.idle();
    assert.equal(greetings(),2);
  } finally { h.director.dispose(); }
});

test('unblocking an eligible trigger plays it once without another approach', () => {
  const event = { id: 'filtered' };
  const occupied = new Set<string>();
  const claim = (allowed: boolean) => claimStoryTrigger([event], occupied, () => true, () => allowed);
  assert.equal(claim(false), null);
  assert.equal(claim(true)?.event, event);
  assert.equal(claim(true), null);
});

test('a consumed trigger yields to the next candidate and a new claim still clears contact that ended', () => {
  const events = [{ id: 'first' }, { id: 'second' }, { id: 'left' }];
  const occupied = new Set(['first', 'left']);
  const claim = () => claimStoryTrigger(events, occupied, event => event.id === 'left' ? null : true, () => true);
  assert.equal(claim()?.event.id, 'second');
  assert.equal(claim(), null);
  assert.deepEqual([...occupied], ['first', 'second']);
});
