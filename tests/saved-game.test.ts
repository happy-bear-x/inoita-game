import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
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
