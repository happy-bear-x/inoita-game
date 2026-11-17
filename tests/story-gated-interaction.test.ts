import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough, headlessContent } from './helpers/story-playthrough.ts';
import { parseCampaign } from '../src/application/content-validation.ts';

const gates = [['quest-164','event-186'],['quest-165','event-189'],['quest-166','event-192'],
  ['quest-220','event-259'],['quest-283','event-319'],['quest-371','event-443'],['quest-415','event-389']];

async function forest() {
  const h = playthrough();
  h.session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest:'quest-261'}}]);
  await h.idle();
  h.session.applyStoryCommands([{type:'travel',destination:{map:'eternal-forest-bounds-3-422e3aba',x:184,y:320,facing:'north'}}]);
  return h;
}

test('declining the forest confirmation and clicking the stone reopens it without consuming the entrance', async () => {
  const h = await forest();
  try {
    h.choices(['option-1']); await h.approach('npc-409');
    h.choices(['option-1']); await h.talk('npc-409');
    assert.equal(h.session.status('quest-371'),'ready');
    assert.equal(h.director.runtime.eventStatus('event-284'),'idle');
    await h.travel('eternal-forest-6-ea15883d');
    await h.travel('eternal-forest-bounds-3-422e3aba');
    h.choices(['option-0']); await h.talk('npc-409');
    assert.equal(h.session.status('quest-263'),'active');
    assert.equal(h.session.storyWorld.activeEncounters.filter(e=>e.definitionId==='event-284-battle').length,1);
    await h.defeat('enemy-guardian-golem-1');
    assert.equal(h.session.status('quest-262'),'completed');
    assert.equal(h.session.status('quest-263'),'completed');
    assert.equal(h.session.status('quest-264'),'active');
    const receipts=h.session.captureState().receipts;
    await h.talk('npc-409');
    assert.deepEqual(h.session.captureState().receipts,receipts);
  } finally { h.director.dispose(); }
});

test('a healthy declined entrance and the subsequent live golem battle survive saving and restoring', async () => {
  const h=await forest(); let restored:ReturnType<typeof playthrough>|undefined, fighting:ReturnType<typeof playthrough>|undefined;
  try {
    h.choices(['option-1']); await h.approach('npc-409');
    restored=playthrough(JSON.parse(JSON.stringify(h.session.captureState())));
    restored.choices(['option-0']); await restored.talk('npc-409');
    assert.equal(restored.session.status('quest-263'),'active');
    fighting=playthrough(JSON.parse(JSON.stringify(restored.session.captureState())));
    await fighting.defeat('enemy-guardian-golem-1');
    assert.equal(fighting.session.status('quest-262'),'completed');
    assert.equal(fighting.session.status('quest-264'),'active');
  } finally { h.director.dispose(); restored?.director.dispose(); fighting?.director.dispose(); }
});

for (const [quest,event] of gates) test(`${quest} delegates interaction to ${event} and requires script settlement`, async () => {
  const h=playthrough();
  try {
    assert.equal(h.session.definition(quest)?.interactionEvent,event);
    const entrance=headlessContent.campaign.events.find(e=>e.id===event)!;
    const place=entrance.place!;
    assert.ok(place.type==='fixed'||place.type==='alternatives');
    const spot=place.type==='fixed'?place:place.spots[0];
    h.session.applyStoryCommands([{type:'travel',destination:{...spot,facing:'south'}}]);
    h.session.applyStoryCommands([{type:'quest',command:{type:'script-ready',quest}}]);
    for(let retry=0;retry<2;retry++){
      h.choices(['option-1']);
      await h.director.interact({id:'entrance',actor:entrance.near!,characterId:entrance.nearCharacterId,x:spot.x,y:spot.y},headlessContent.world.actors[entrance.near!]);
      await h.idle();
      assert.equal(h.session.status(quest),'ready');
      assert.equal(h.director.runtime.eventStatus(event),'completed');
    }
    assert.equal(h.session.complete(quest),false);
    assert.throws(()=>h.session.applyStoryCommands([{type:'quest',command:{type:'complete',quest}}]),/剧情事件/);
    assert.equal(h.session.status(quest),'ready');
    h.session.applyStoryCommands([{type:'quest',command:{type:'script-complete',quest}}]);
    assert.equal(h.session.status(quest),'completed');
  } finally { h.director.dispose(); }
});

test('content validation rejects missing, mismatched and undeclared entrance events', () => {
  for (const value of ['missing-event','event-285','event-186',undefined]) {
    const content=JSON.parse(JSON.stringify(headlessContent.campaign));
    content.quests.find((q:{id:string})=>q.id==='quest-371').interactionEvent=value;
    assert.throws(()=>parseCampaign(content),/剧情交互/);
  }
});
