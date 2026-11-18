import assert from 'node:assert/strict';
import test from 'node:test';
import {buildStoryTriggerIndex} from '../src/domain/story-trigger-index.ts';
import type {StoryEvent, StoryGraph} from '../src/domain/story-graph.ts';

const event=(id:string,extra:Partial<StoryEvent>)=>({id,...extra}) as StoryEvent;
const campaign={events:[
  event('region-a',{source:'region',map:'a',region:{x:0,y:0,width:16,height:16}}),
  event('region-b',{source:'region',map:'b',region:{x:0,y:0,width:16,height:16}}),
  event('near-free',{source:'near',near:'npc'}),
  event('near-a',{source:'near',near:'npc',map:'a',nearCharacterId:'npc-2'}),
  event('near-b',{source:'near',near:'npc',map:'b'}),
  event('other',{source:'event'}),
]} as unknown as StoryGraph;

const character=(id:string,actor:string,characterId?:string,visible=true)=>({
  entity:{id,actor,characterId},container:{visible},
});

test('trigger index groups the current map and preserves campaign order',()=>{
  const first=character('npc-1','npc'), second=character('npc-2','npc','npc-2'), hidden=character('npc-3','npc',undefined,false);
  const index=buildStoryTriggerIndex(campaign,'a',[first,second,hidden]);
  assert.deepEqual(index.regionEvents.map(value=>value.id),['region-a']);
  assert.deepEqual(index.nearCharacters.map(group => group.character), [first,second,hidden]);
  assert.deepEqual(index.nearCharacters.map(group => group.events.map(event => event.id)), [
    ['near-free'], ['near-free','near-a'], ['near-free'],
  ]);
});
