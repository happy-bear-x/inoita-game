import assert from 'node:assert/strict';
import test from 'node:test';
import {buildStoryTriggerIndex} from '../src/domain/story-trigger-index.ts';
import type {StoryEvent, StoryGraph} from '../src/domain/story-graph.ts';

const event=(id:string,extra:Partial<StoryEvent>)=>({id,...extra}) as StoryEvent;
const campaign={events:[
  event('region-a',{source:'region',map:'a',region:{x:0,y:0,width:16,height:16}}),
  event('region-b',{source:'region',map:'b',region:{x:0,y:0,width:16,height:16}}),
  event('near-free',{source:'near',near:'npc'}),
  event('near-a',{source:'near',near:'npc',map:'a'}),
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
  assert.deepEqual(index.nearEvents.map(value=>value.id),['near-free','near-a']);
  assert.deepEqual(index.charactersByActor.get('npc'),[first,second,hidden]);
});

test('near lookup filters by character id and visibility without changing order',()=>{
  const hidden=character('npc-1','npc','npc-1',false), visible=character('npc-2','npc','npc-2');
  const index=buildStoryTriggerIndex(campaign,'a',[hidden,visible]);
  const candidates=index.charactersByActor.get('npc')!;
  const beside=candidates.find(value=>(!('nearCharacterId' in index.nearEvents[0]!)||value.entity.characterId==='npc-2')&&value.container.visible);
  assert.equal(beside,visible);
});
