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

test('Elinia offers one destination per approach and reports the other completed quest on the next visit', async () => {
  const h = playthrough();
  const map = 'kiyan-s-memory-layer-2-85e3306a';
  const beside = {map, x:232, y:200, facing:'north' as const};
  const prompts = () => h.lines.filter(line => line.includes('接下来去消灭哪里的记忆')).length;
  try {
    h.session.applyStoryCommands([{type:'travel',destination:beside}, ...headlessContent.campaign.scripts['event-465'].nodes[0].commands]);
    for (const quest of ['quest-404','quest-405']) {
      h.session.accept(quest);
      h.session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest}}]);
    }
    h.choices(['option-3','option-3']);
    h.frame('all'); await h.idle();
    assert.equal(prompts(),1);
    assert.equal(h.director.runtime.eventStatus('event-469'),'completed');
    assert.equal(h.director.runtime.eventStatus('event-470'),'idle');
    // 演出把玩家送回远处；走开后的下一次靠近应能听到另一项任务的回报。
    h.frame('all'); await h.idle();
    h.session.movePlayer(beside);
    h.frame('all'); await h.idle();
    assert.equal(prompts(),2);
    assert.equal(h.director.runtime.eventStatus('event-470'),'completed');
  } finally { h.director.dispose(); }
});

test('the overlapping Kamuran regions offer event 77 before replaying event 75', async () => {
  const h = playthrough();
  const pos = {map:'kamuran-wilderness-d37060c8', x:96, y:16, facing:'north' as const};
  try {
    h.session.applyStoryCommands([{type:'travel',destination:pos}]);
    h.session.accept('quest-58');
    h.frame('all'); await h.idle();
    assert.equal(h.director.runtime.eventStatus('event-75'),'completed');
    h.frame('all'); await h.idle();
    h.session.accept('quest-59');
    h.session.movePlayer(pos);
    h.frame('all'); await h.idle();
    assert.equal(h.director.runtime.eventStatus('event-77'),'completed');
  } finally { h.director.dispose(); }
});

test('the five hall doors play their shared event once while the player stays in contact', async () => {
  const h = playthrough();
  const pos = {map:'hall-of-reality-bf3cc6de',x:272,y:361,facing:'north' as const};
  const approach = async () => { h.frame('near','event-266'); await h.idle(); };
  const plays = () => h.lines.filter(line=>line.includes('好像打不开呢')).length;
  try {
    h.session.applyStoryCommands([{type:'travel',destination:pos}]);
    h.session.accept('quest-210');
    await approach(); await approach();
    assert.equal(plays(),1);
  } finally { h.director.dispose(); }
});

test('duplicated barricades still offer each quest its own event', async () => {
  const h = playthrough();
  const map = 'sealed-dungeon-1-2-c824bb14';
  const pos = {map, x:136, y:496, facing:'north' as const};
  try {
    h.session.applyStoryCommands([{type:'travel',destination:pos}]);
    h.session.accept('quest-210');
    h.session.accept('quest-325');
    h.frame('near'); await h.idle();
    assert.equal(h.director.runtime.eventStatus('event-246'),'completed');
    assert.equal(h.director.runtime.eventStatus('event-351'),'idle');
    h.session.movePlayer(pos);
    h.frame('near'); await h.idle();
    assert.equal(h.director.runtime.eventStatus('event-351'),'completed');
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
  const claim = () => claimStoryTrigger(events, occupied, event => event.id !== 'left', () => true);
  assert.equal(claim()?.event.id, 'second');
  assert.equal(claim(), null);
  assert.deepEqual([...occupied], ['first', 'second']);
});
