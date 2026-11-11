import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { playthrough } from './helpers/story-playthrough.ts';
import { prepareTaskStart, storyTaskPreview } from '../src/debug/story-jump.ts';
import { createGmActions } from '../src/debug/gm-actions.ts';
import { validateStoryDebug } from '../src/domain/story-debug.ts';
import { questJournal } from '../src/domain/quest-journal.ts';
import type { StoryPlace } from '../src/domain/story-graph.ts';
import { NavigationWorld } from '../src/domain/navigation-world.ts';

test('the task catalog is valid and only contains tasks with a fixed entry',()=>{
 const h=playthrough();try{
  const campaign=h.session.campaign;validateStoryDebug(campaign);
  const tasks=campaign.debugStory!.tasks;
  assert.ok(tasks.length>400,`任务目录只有 ${tasks.length} 条`);
  assert(tasks.every(task=>task.entry.type==='fixed'&&task.entry.map&&task.entry.source));
  assert(tasks.every(task=>campaign.quests.some(quest=>quest.id===task.quest)));
  assert(tasks.every(task=>task.phase==='available'||task.phase==='active'));
  assert(tasks.some(task=>task.phase==='available'));
 }finally{h.director.dispose();}
});

test('preparing an available task stays before its opening and focuses the journal',async()=>{
 const h=playthrough();try{
  const task=h.session.campaign.debugStory!.tasks.find(task=>
   task.phase==='available'&&h.session.campaign.quests.find(quest=>quest.id===task.quest)!.journal!==false)!;
  const before=h.session.captureState();
  const prepared=await prepareTaskStart(h.session,{quest:task.quest});
  assert.deepEqual(h.session.captureState(),before,'准备过程不能修改当前会话');
  h.session.restoreState(prepared);
  // 现场表停在开幕演出之前；接取由导演播放的演出自己完成。
  assert.equal(h.session.status(task.quest),'available');
  assert.equal(task.play?.cut,'before-opening');
  const journal=questJournal(h.session.campaign,h.session.quests,h.session.debugFocusQuest);
  assert.deepEqual(journal.flatMap(group=>group.entries.map(entry=>entry.quest.id)),[task.quest],
   'GM 任务现场的任务菜单只显示当前任务');
  assert.deepEqual(h.session.storyWorld.currentLocation,{map:task.entry.map,x:task.entry.x,y:task.entry.y,facing:'south'});
 }finally{h.director.dispose();}
});

test('preparing a task installs the start table cast without pre-playing the opening',async()=>{
 const h=playthrough();try{
  const task=h.session.campaign.debugStory!.tasks.find(task=>task.quest==='grafton-mission')!;
  const prepared=await prepareTaskStart(h.session,{quest:task.quest});
  h.session.restoreState(prepared);
  assert.equal(h.session.debugFocusQuest,'grafton-mission');
  // 现场表记录的是开幕前的世界：接取人自己由开幕演出的舞台投影带进来。
  const entities=task.start!.world!.entities!;
  assert.ok(entities.length,'现场表缺少接取场景人物');
  for(const entity of entities)
   assert.equal(h.session.storyWorld.entity(entity.id)?.map,entity.map,entity.id);
  assert.equal(task.play?.script,'event-1');
 }finally{h.director.dispose();}
});

test('an active task default is already running when the catalog has one',async()=>{
 const h=playthrough();try{
  const task=h.session.campaign.debugStory!.tasks.find(task=>task.phase==='active')!;
  const prepared=await prepareTaskStart(h.session,{quest:task.quest});
  h.session.restoreState(prepared);
  assert.ok(['active','ready'].includes(h.session.status(task.quest)),h.session.status(task.quest));
  const declared=task.start!.quests?.find(row=>row.id===task.quest)?.status;
  if(declared)assert.equal(h.session.status(task.quest),declared);
  assert.deepEqual(h.session.storyWorld.currentLocation,{map:task.entry.map,x:task.entry.x,y:task.entry.y,facing:'south'});
 }finally{h.director.dispose();}
});

test('tasks without a fixed entry are absent instead of being reported as enterable',async()=>{
 const h=playthrough();try{
  const dormant=h.session.campaign.quests.find(quest=>quest.places?.available?.type==='unavailable')!;
  assert(!h.session.campaign.debugStory!.tasks.some(task=>task.quest===dormant.id));
  await assert.rejects(prepareTaskStart(h.session,{quest:dormant.id}),/没有调试入口/);
 }finally{h.director.dispose();}
});

test('task preparation installs the declared quest history and completed events',async()=>{
 const h=playthrough();try{
  const tasks=h.session.campaign.debugStory!.tasks;
  assert(tasks.every(task=>task.start),'每个任务都要有现场表');
  const task=tasks.find(task=>(task.start!.completedEvents?.length??0)>0
   &&(task.start!.quests?.some(row=>row.status==='completed')??false))!;
  assert.ok(task,'导出器没有生成带前置历史的现场表');
  const prepared=await prepareTaskStart(h.session,{quest:task.quest});
  h.session.restoreState(prepared);
  for(const event of task.start!.completedEvents??[])
   assert.ok(prepared.runtime.completedEvents.includes(event.id),event.id);
  for(const row of task.start!.quests??[])
   assert.equal(h.session.status(row.id),row.status,row.id);
 }finally{h.director.dispose();}
});

test('preparation clears pending work and keeps the declared records plus the game opening',async()=>{
 const h=playthrough();try{
  const opening=h.session.campaign.events
   .filter(event=>event.source==='start').map(event=>event.id);
  const task=h.session.campaign.debugStory!.tasks.find(task=>task.scripts?.length
   &&!(task.start!.completedEvents??[]).some(entry=>opening.includes(entry.id)))!;
  assert.ok(task,'没有现场表缺少整局开场的任务');
  const prepared=await prepareTaskStart(h.session,{quest:task.quest});
  assert.deepEqual(prepared.runtime.runs,[]);
  assert.deepEqual(prepared.runtime.pendingOccurrences,[]);
  assert.deepEqual(prepared.enemies,[]);
  assert.deepEqual(prepared.runtime.completedEvents,
   [...new Set([...opening,...(task.start!.completedEvents??[]).map(entry=>entry.id)])]);
 }finally{h.director.dispose();}
});

test('a debug scene never replays the game opening when the map is entered',async()=>{
 const h=playthrough();try{
  const opening=h.session.campaign.events
   .filter(event=>event.source==='start').map(event=>event.id);
  const task=h.session.campaign.debugStory!.tasks.find(task=>
   !(task.start!.completedEvents??[]).some(entry=>opening.includes(entry.id)))!;
  assert.ok(task,'没有现场表缺少整局开场的任务');
  h.session.restoreState(await prepareTaskStart(h.session,{quest:task.quest}));
  assert.equal(await h.director.start(),false,'调试现场把整局开场视为已播放');
  assert.deepEqual(h.lines,[],'不应重播开场对白');
 }finally{h.director.dispose();}
});

test('preview reports the same location without touching the session',async()=>{
 const h=playthrough();try{
  const gm=createGmActions({session:h.session,campaign:h.session.campaign,director:h.director,report:async()=>true});
  const task=h.session.campaign.debugStory!.tasks[0]!;
  const before=h.session.captureState();
  const preview=await gm.previewStory({quest:task.quest});
  assert.equal(preview.ok,true,preview.reason);
  assert.deepEqual(preview.preview?.location,{map:task.entry.map,x:task.entry.x,y:task.entry.y});
  assert.deepEqual(h.session.captureState(),before);
  assert.deepEqual(gm.actions(),[]);
 }finally{h.director.dispose();}
});

test('a failed jump leaves the original session and records no mark',async()=>{
 const h=playthrough();try{
  const before=h.session.captureState();
  const gm=createGmActions({session:h.session,campaign:h.session.campaign,director:h.director,travel:async()=>({ok:false,reason:'test travel failure'}),report:async()=>true});
  const result=await gm.jumpStory({quest:h.session.campaign.debugStory!.tasks[0]!.quest});
  assert.equal(result.ok,false);
  assert.match(result.reason!,/test travel failure/);
  assert.deepEqual(h.session.captureState(),before);
  assert.deepEqual(gm.marks(),[]);
 }finally{h.director.dispose();}
});

/** 地点是导出层按原版证据算出来的（见 work/tools/game_content/story_places.py）：落在哪就得站得住。 */
test('every exported quest or task place stands on its own map',()=>{
 const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
 const campaign=read('campaign'),world=read('world');
 campaign.debugStory=read('debug/start');
 const places:{owner:string;map:string;x:number;y:number}[]=[];
 const collect=(place:StoryPlace,owner:string)=>{
  if(place.type==='fixed')places.push({owner,map:place.map,x:place.x,y:place.y});
  else if(place.type==='alternatives')place.spots.forEach((spot,index)=>places.push({owner:`${owner}[${index}]`,...spot}));
 };
 for(const event of campaign.events)if(event.place)collect(event.place,event.id);
 for(const task of campaign.debugStory.tasks)collect({type:'fixed',...task.entry},`debug:${task.quest}`);
 for(const quest of campaign.quests)
  for(const phase of ['available','active','ready'] as const){const place=quest.places?.[phase];if(place)collect(place,`${quest.id}:${phase}`);}
 assert(places.length>1000,`导出的地点数量只有 ${places.length}`);
 const navigation=new Map<string,NavigationWorld>();
 for(const place of places){
  assert.ok(world.maps.some((map:{id:string})=>map.id===place.map),`${place.owner} 的地图不存在：${place.map}`);
  if(!navigation.has(place.map))navigation.set(place.map,new NavigationWorld(read('maps/'+place.map)));
  const map=navigation.get(place.map)!;
  const stand=map.nearestBody({collision:world.actors[campaign.start.actor].collision},{x:place.x,y:place.y})
   ??map.nearest({collision:world.actors[campaign.start.actor].collision},{x:place.x,y:place.y});
  assert.deepEqual([stand.x,stand.y],[place.x,place.y],`${place.owner} 的落点不可站：${place.x},${place.y}`);
 }
});

test('task preview is not tied to the order of location candidates',async()=>{
 const h=playthrough();try{
  const task=h.session.campaign.debugStory!.tasks[0]!;
  const first=await prepareTaskStart(h.session,{quest:task.quest});
  h.session.applyStoryCommands([{type:'travel',destination:{map:h.session.campaign.start.map,x:h.session.campaign.start.x,y:h.session.campaign.start.y,facing:'south'}}]);
  const second=await prepareTaskStart(h.session,{quest:task.quest});
  assert.deepEqual(second.storyWorld.location,first.storyWorld.location);
 }finally{h.director.dispose();}
});

test('storyTaskPreview can be built from a prepared state',async()=>{
 const h=playthrough();try{
  const task=h.session.campaign.debugStory!.tasks[0]!;
  const state=await prepareTaskStart(h.session,{quest:task.quest});
  const preview=storyTaskPreview(h.session.campaign,{quest:task.quest},state);
  assert.equal(preview.quest,task.quest);
  assert.equal(preview.phase,state.questBook.quests.find(([id])=>id===task.quest)?.[1].status==='available'?'available':'active');
  assert.deepEqual(preview.location,{map:task.start!.world!.location.map,x:task.start!.world!.location.x,y:task.start!.world!.location.y});
 }finally{h.director.dispose();}
});
