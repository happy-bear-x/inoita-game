import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { WorldMap } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { CampaignQuest } from '../src/domain/campaign.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { WorldEnemyRoster, encounterSpawnId } from '../src/domain/world-enemies.ts';

const read=<T>(file:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${file}.json`,import.meta.url),'utf8'));
const base=read<Campaign>('campaign');
const quest=(id:string,completion:CampaignQuest['completion']):CampaignQuest=>({id,title:id,description:'isolated native contract sample',
  guidance:{available:'',active:''},goals:[],completion,progressText:'',completeText:''});
const ui:StoryUI={async dialogue(){throw new Error('This event has no dialogue');},async choice(){throw new Error('This event has no choice');},
  async questPopup(){throw new Error('This fixture does not open a task popup');},closeDialogue(){},skipDialogue(){},toast(){}};

// The verified event 28 ends by settling original quests 30 and 31, without dialogue.
// Its still separate camera/wait/sound performance is outside this contract fixture.
test('original event 28 links two quest states through a command-only event and deduplicates its trigger',async()=>{
  const first={...quest('native-quest-30','internal'),journal:false},second=quest('native-quest-31','story');
  const campaign:Campaign={...structuredClone(base),quests:[first,second],questGroups:[{id:'fixture',title:'fixture',kind:'main',questIds:[second.id]}],placements:[],
    scripts:{native:{entry:'settle',nodes:[{id:'settle',presentation:[],commands:[
      {type:'quest',command:{type:'script-complete',quest:first.id}},{type:'quest',command:{type:'script-complete',quest:second.id}}
    ],exit:{type:'end'}}]}},events:[{id:'native-event-28',source:'quest',key:second.id,script:'native',condition:{type:'quest',quest:second.id,status:'ready'}}]};
  const session=new Session(campaign),director=new StoryDirector(campaign,session,ui,()=>{});
  session.accept(second.id);session.applyStoryCommands([{type:'quest',command:{type:'script-ready',quest:second.id}}]);
  await director.notify('quest',second.id);
  assert.equal(session.status(first.id),'completed');assert.equal(session.status(second.id),'completed');
  assert.equal(session.flags.has('native-event-28'),true);
  const settled=session.captureState();await director.notify('quest',second.id);
  assert.deepEqual(session.captureState().questBook,settled.questBook);director.dispose();
});

test('isolated Earl and guard encounter requires real settled deaths before continuing the quest',async()=>{
  const map=read<WorldMap>('maps/silent-cave-depths'),earl='enemy-earl-grafton-1',guard='enemy-arnen-guard-1';
  const task:CampaignQuest={...quest('native-earl','all'),goals:[{id:'earl',kind:'defeat',target:earl,quantity:1},{id:'guard',kind:'defeat',target:guard,quantity:1}]};
  const campaign:Campaign={...structuredClone(base),quests:[task],questGroups:[{id:'fixture',title:'fixture',kind:'main',questIds:[task.id]}],placements:[],events:[{id:'native-battle',source:'start',script:'battle'}],
    scripts:{battle:{entry:'handoff',nodes:[{id:'handoff',presentation:[],commands:[],exit:{type:'waitEncounter',
      encounter:{id:'earl-and-guard',map:map.id,status:'prepared',spawns:[{id:'earl',enemyId:earl,x:184,y:184},{id:'guard',enemyId:guard,x:216,y:184}]},
      outcomes:{won:{script:'battle',node:'settle'}}}},
      {id:'settle',presentation:[],commands:[{type:'quest',command:{type:'complete',quest:task.id}}],exit:{type:'end'}}]}}};
  const session=new Session(campaign),director=new StoryDirector(campaign,session,ui,()=>{});session.accept(task.id);
  await director.start();assert.equal(director.busy,false);
  const id=director.runtime.snapshot().runs[0].waiting!.encounter;
  const roster=new WorldEnemyRoster(session,{...map,enemySpawns:[]},[],1);
  const first=roster.source(encounterSpawnId(id,'earl'))!,second=roster.source(encounterSpawnId(id,'guard'))!;
  session.enemyDefeated(first);session.gainMoney(7);assert.equal(roster.completedEncounters().length,0);
  assert.equal(session.status(task.id),'active');session.enemyDefeated(second);session.gainMoney(5);
  assert.equal(session.status(task.id),'ready');assert.equal(roster.completedEncounters()[0].id,id);
  await director.encounterResult(id,'won',`result:${id}:won`);
  assert.equal(session.status(task.id),'completed');assert.equal(session.money,12);
  assert.equal(await director.encounterResult(id,'won',`result:${id}:won`),false);assert.equal(session.money,12);director.dispose();
});
