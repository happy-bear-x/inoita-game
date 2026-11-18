import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {groundLootFor} from '../src/domain/ground-loot.ts';
import type {QuestItemSpawn} from '../src/domain/content.ts';
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
  const saved=record();saved.format=SAVE_FORMAT-1;
  assert.throws(()=>prepareSavedGame(saved,content),/存档版本不受支持/);
});


test('a save with no living member is rejected',()=>{
  const saved=record();saved.session.hero!.health=0;
  assert.throws(()=>prepareSavedGame(saved,content),/存档没有存活队员/);
});

test('a format 59 save can regenerate a quest pickup evicted by the old ground limit',()=>{
  const map=read<{id:string;name:string;questItemSpawns:QuestItemSpawn[]}>('maps/mines-west-section2-b1-83d7f81e');
  const character=content.storyClasses.classes[0];
  const questId='quest-49';
  const campaign={...content.campaign,quests:content.campaign.quests.map(q=>q.id===questId
    ? {...q,availableWhen:{type:'always' as const,value:true}} : q)};
  const session=newStorySession(campaign,content.world.actors[campaign.start.actor],character,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  const location={map:map.id,x:56,y:120,facing:'south' as const};
  session.applyStoryCommands([{type:'travel',destination:location}]);
  session.enterMap(map.id,map.questItemSpawns);
  assert.equal(session.accept(questId),true);
  session.bag.add('lumps-of-copper',4);
  session.advanceCombatFrames(60,()=>{});
  const ground=groundLootFor(session);
  assert.equal(ground.pendingItemCounts().get('lumps-of-copper'),1);
  for(let i=0;i<64;i++)ground.addFlying(map.id,location,{x:0,y:0,direction:0},'mana-gem',100);
  ground.advance(map.id,100);
  const world={location,generatedEntities:[]};
  const summary=saveSummary(session,map,{name:character.name,portrait:'assets/ui/menus/character-kiyan.png'});
  const saved=captureSaveGame(session,world,summary);
  // 旧版对没有时间戳的采集物和药丸按插入顺序只留下最后 64 件。
  saved.session.groundLoot.drops=saved.session.groundLoot.drops.slice(-64);
  const unrelated=structuredClone(saved);
  unrelated.session.questItemGeneration.generators.find(point=>point.dropId)!.dropId='ground-99999';
  assert.throws(()=>prepareSavedGame(unrelated,content),/任务地面物品实例无效/);
  const before=structuredClone(saved);
  const restored=prepareSavedGame(saved,content).session;
  assert.deepEqual(saved,before);
  restored.enterMap(map.id,map.questItemSpawns);
  restored.advanceCombatFrames(152*60,()=>{});
  assert.equal(groundLootFor(restored).pendingItemCounts().get('lumps-of-copper'),1);
  const healthy=captureSaveGame(restored,world,summary);
  assert.deepEqual(prepareSavedGame(healthy,content).session.questItemGenerators.captureState(),healthy.session.questItemGeneration);
  assert.deepEqual(groundLootFor(restored).forMap(map.id).filter(d=>d.reward.kind==='item'&&d.reward.item==='mana-gem'),before.session.groundLoot.drops);
});
