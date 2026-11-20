import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {SAVE_FORMAT,captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;
const content:SavedGameContent={campaign:read('campaign'),world:read('world'),storyClasses:read('story-classes'),
  items:read('items'),characterStats:read('character-stats'),battleCatalog:read('battle'),companions:read('companions')};
function record(index=0){
  const character=content.storyClasses.classes[index],session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],character,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  session.gainMoney(321);session.hero!.setHealth(7);session.hero!.setMana(3);
  const map=content.world.maps.find(entry=>entry.id!==content.campaign.start.map)!;
  const world:StoryWorldViewSnapshot={location:{map:map.id,x:16,y:24,facing:'west'},generatedEntities:[],scene:{map:map.id,
    actors:[{id:'player',actor:content.campaign.start.actor,memberId:'player',x:16,y:24,facing:'west',visible:true}]}};
  return captureSaveGame(session,world,saveSummary(session,{id:map.id,name:map.name},{name:character.name,portrait:'assets/ui/menus/character-kiyan.png'}));
}

test('each class restores into a fresh candidate and retains its destination, resources and inventory',()=>{
  for(let index=0;index<content.storyClasses.classes.length;index++){
    const saved=record(index),before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
    assert.equal(candidate.session.hero!.classId,saved.summary.classId);assert.equal(candidate.session.money,321);
    assert.equal(candidate.session.hero!.player.health,7);assert.equal(candidate.session.hero!.player.mana,3);
    assert.deepEqual(candidate.session.bag.captureState(),saved.session.bag);
    assert.deepEqual(candidate.world,saved.world);assert.equal(candidate.map.id,saved.world.location.map);
    assert.deepEqual(saved,before);
  }
});

test('a save before the minotaur scene keeps its fishcake',()=>{
  const saved=record(),bag=saved.session.bag,id='legacy-fishcake';
  bag.instances.push({id,item:'special-fishcake',quantity:1,enhancement:0,gems:[]});
  bag.pouches.quest.push(id);bag.allCells.push(id);
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.count('special-fishcake'),1,'还没走过那段剧情时保留任务道具');
});

test('invalid class, map, position and actors are rejected without changing the saved input',()=>{
  for(const change of [
    (game:ReturnType<typeof record>)=>{game.summary.classId='missing';},
    (game:ReturnType<typeof record>)=>{game.world.location.map='missing';},
    (game:ReturnType<typeof record>)=>{game.world.location.x=NaN;},
    (game:ReturnType<typeof record>)=>{game.world.generatedEntities.push({id:'ghost',actor:'missing',x:0,y:0});},
    (game:ReturnType<typeof record>)=>{game.world.scene!.map='another-map';},
    (game:ReturnType<typeof record>)=>{game.world.scene!.actors[0]!.x++;},
    (game:ReturnType<typeof record>)=>{game.world.scene!.actors.push({...game.world.scene!.actors[0]!});},
  ]){
    const saved=record();change(saved);const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content));assert.deepEqual(saved,before);
  }
});

test('scene visit actors are validated before installation',()=>{
  const saved=record();
  saved.world.scene!.visit={generatedEntities:[{id:'visitor',actor:'missing',x:0,y:0}],
    breakableRolls:[],roster:{enemies:[],sequence:0,partySize:1}};
  const before=structuredClone(saved);
  assert.throws(()=>prepareSavedGame(saved,content),/存档记录的地图人物无效/);
  assert.deepEqual(saved,before);
  saved.world.scene!.visit.generatedEntities[0]!.actor=content.campaign.start.actor;
  assert.equal(prepareSavedGame(saved,content).world.scene!.visit!.generatedEntities[0]!.actor,content.campaign.start.actor);
});

test('scene visit enemy roster and breakable rolls are validated before installation',()=>{
  const enemy=content.battleCatalog.enemies[0]!.id;
  for(const invalid of ['roster','roll']){
    const saved=record();
    const visit=saved.world.scene!.visit={generatedEntities:[],
      breakableRolls:[['spawn',invalid==='roll'?'missing':enemy]],
      roster:{enemies:[{key:'enemy',enemyId:invalid==='roster'?'missing':enemy,x:0,y:0}],sequence:0,partySize:1}};
    const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content),/存档记录的地图敌人无效/);
    assert.deepEqual(saved,before);
    visit.roster.enemies[0]!.enemyId=enemy;visit.breakableRolls[0]![1]=enemy;
    assert.deepEqual(prepareSavedGame(saved,content).world.scene!.visit,visit);
  }
});

test('current saves keep the per-map consumed sword list',()=>{
  const saved=record();saved.session.legendaryWeapons={used:['map-a:sword-001','map-a:sword-005']};
  const candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.legendaryWeapons.captureState(),{used:['map-a:sword-001','map-a:sword-005']});
});

test('equipment defaults unlocked and current equipment locks round trip',()=>{
  const candidate=prepareSavedGame(record(),content);
  assert.ok(candidate.session.bag.captureState().instances.every(entry=>!entry.locked));
  const saved=record(),equipment=saved.session.bag.instances.find(entry=>content.items.items[entry.item].equipment)!;
  equipment.locked=true;
  const loaded=prepareSavedGame(saved,content);
  assert.equal(loaded.session.bag.get(equipment.id)!.locked,true);
});

test('current saves retain explicit hero posture', () => {
  const current = record();
  current.world.scene!.actors[0].townPose = false;
  assert.equal(prepareSavedGame(current, content).world.scene!.actors[0].townPose, false);
});

test('a save from an older format is rejected before installation',()=>{
  const saved=record();saved.format=1;
  assert.throws(()=>prepareSavedGame(saved,content),/存档版本不受支持/);
});


test('a save with no living member is rejected',()=>{
  const saved=record();saved.session.hero!.health=0;
  assert.throws(()=>prepareSavedGame(saved,content),/存档没有存活队员/);
});

test('format 2 keeps the sentinels already defeated, resumes the quest and settles its reward once',()=>{
  const old=structuredClone(record());
  old.format=2;
  const {questBook,runtime}=old.session;
  const sentinels=questBook.quests.find(([id])=>id==='quest-39')![1];
  sentinels.status='active';sentinels.goals.objective=7;
  questBook.runningQuestIds.push('quest-39','quest-13');
  for(const number of [3,4,13,14,15,16,17,27,147]){
    questBook.quests.push([`quest-${number}`,{status:number===13?'active':'locked',goals:{},cycle:0,completedCycles:0}]);
  }
  old.session.trackedQuest='quest-13';
  old.session.receipts.push({quest:'quest-4',cycle:0,reward:{experience:0,money:0,items:[]}});
  runtime.sequence=3;
  runtime.runs.push({id:'story:1',script:'event-592',cursor:{script:'event-592',node:'done'},status:'completed',occurrence:'manual:1'});
  const encounter='story:2:done:event-37-battle';
  runtime.runs.push({id:'story:2',cursor:{script:'event-37',node:'done'},status:'waiting',occurrence:'manual:2',
    waiting:{encounter,outcomes:{won:{script:'event-37',node:'battle-won'}}}});
  old.session.storyWorld.encounters.push({id:encounter,definitionId:'event-37-battle',status:'active',map:old.summary.mapId,spawns:[]});
  runtime.encounterResults.push('result:story:3:done:event-39-battle:won','result:story:4:done:event-38-battle:won');
  runtime.completedEvents.push('event-24','event-23');
  runtime.handledOccurrences.push(['event-24','obsolete'],['event-23','retained']);
  runtime.occurrenceSequences.push(['["event-24","quest"]',2],['["event-23","region"]',3]);
  runtime.pendingOccurrences.push({occurrence:{id:'next',source:'quest',key:'quest-39',sequence:8},nextEventIndex:10},
    {occurrence:{id:'gone',source:'quest',key:'quest-27',sequence:9},nextEventIndex:0});
  const before=structuredClone(old);
  const {session,world}=prepareSavedGame(old,content),state=session.captureState();
  assert.deepEqual(old,before);
  assert.equal(state.trackedQuest,undefined);
  assert.equal(state.questBook.quests.length,487);
  assert.deepEqual(state.questBook.runningQuestIds,['quest-39']);
  assert.equal(state.receipts.length,0);
  assert.deepEqual(state.runtime.runs,[]);
  assert.deepEqual(state.runtime.encounterResults,['result:story:4:done:event-38-battle:won']);
  assert.deepEqual(state.storyWorld.encounters,[]);
  assert.deepEqual(state.runtime.completedEvents,['event-23']);
  assert.deepEqual(state.runtime.handledOccurrences,[['event-23','retained']]);
  assert.deepEqual(state.runtime.occurrenceSequences,[['["event-23","region"]',3]]);
  assert.deepEqual(state.runtime.pendingOccurrences,[{occurrence:{id:'next',source:'quest',key:'quest-39',sequence:8},nextEventIndex:9}]);
  assert.deepEqual(world,old.world);
  session.recordStoryDefeat('enemy-arnen-sentinel-1');
  assert.equal(session.status('quest-39'),'ready');
  const money=session.money;
  assert.equal(session.complete('quest-39'),true);
  const reward=session.rewardReceiptFor('quest-39')!;
  assert.ok(reward.money>0);
  assert.equal(session.money,money+reward.money);
  const saved=captureSaveGame(session,world,old.summary);
  assert.equal(saved.format,SAVE_FORMAT);
  for(const format of [2,3]){
    const restored=prepareSavedGame({...saved,format},content).session;
    assert.equal(restored.status('quest-39'),'completed');
    assert.deepEqual(restored.rewardReceiptFor('quest-39'),reward);
    assert.equal(restored.complete('quest-39'),false);
    assert.equal(restored.money,money+reward.money);
  }
});

test('save migration scopes removal to known format 2 content and preserves other validation',()=>{
  for(const [format,quest] of [[2,'unknown-quest'],[3,'quest-13']] as const){
    const saved=structuredClone(record());saved.format=format;
    saved.session.questBook.quests.push([quest,{status:'locked',goals:{},cycle:0,completedCycles:0}]);
    assert.throws(()=>prepareSavedGame(saved,content),/任务快照引用未知任务/);
  }
});
