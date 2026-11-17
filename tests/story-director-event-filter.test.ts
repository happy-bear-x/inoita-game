import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';

test('an automatic event filter blocks dispatch without blocking explicit playback', async () => {
  const h = playthrough();
  try {
    const event = h.session.campaign.events.find(value => value.id === 'event-1')!;
    h.director.setAutomaticEventFilter(() => false);
    assert.equal(h.director.allowsAutomaticEvent(event), false);
    assert.equal(await h.director.enterRegion(event.id, event.map!), false);
    assert.equal(h.director.runtime.eventStatus(event.id), 'idle');

    assert.equal(await h.director.trigger(event), true);
    assert.equal(h.director.runtime.eventStatus(event.id), 'completed');
  } finally {
    h.director.dispose();
  }
});

test('an automatic event filter admits only the allowed event', async () => {
  const h = playthrough();
  try {
    const event = h.session.campaign.events.find(value => value.id === 'event-1')!;
    h.director.setAutomaticEventFilter(candidate => candidate.id === event.id);
    assert.equal(h.director.allowsAutomaticEvent(event), true);
    assert.equal(await h.director.enterRegion(event.id, event.map!), true);
    assert.equal(h.director.runtime.eventStatus(event.id), 'completed');
  } finally {
    h.director.dispose();
  }
});
