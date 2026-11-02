import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {parseCampaign} from '../src/application/content-validation.ts';
import type {SceneActorState,SceneSnapshot} from '../src/domain/scene-snapshot.ts';
import {pendingEntranceAliases,type PerformanceAction,type StoryStage} from '../src/domain/story-performance.ts';
import {applyStorySceneAction,boundSceneActor,hidePendingEntrances,resolveStoryScene} from '../src/domain/story-scene.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const campaign=parseCampaign(read('campaign'));

function firstStage(script:string,map:string){
  for(const node of campaign.scripts[script].nodes){
    const index=node.presentation.findIndex(action=>action.type==='stage'&&action.map===map);
    if(index>=0)return {node,index,stage:node.presentation[index] as StoryStage};
  }
  throw new Error(`没有舞台：${script}/${map}`);
}

function source(stage:StoryStage,actors:SceneActorState[]):SceneSnapshot{
  return {map:stage.map,actors:[
    {id:'player',actor:'hero',x:stage.x,y:stage.y,facing:stage.facing,visible:true},
    ...actors,
  ]};
}

function worldCopy(stage:StoryStage,alias:string,x:number,y:number):SceneActorState{
  const member=stage.cast.find(candidate=>candidate.id===alias);
  if(!member)throw new Error(`舞台没有演员：${alias}`);
  return {id:`entity:${alias}`,actor:member.actor,characterId:member.characterId,enemyId:member.enemyId,
    worldEntityId:`${alias}-world`,x,y,facing:'south',visible:true};
}

function assertHiddenUntilAppearance(script:string,map:string,alias:string,worldX:number,worldY:number):void{
  const {node,index,stage}=firstStage(script,map);
  const member=stage.cast.find(candidate=>candidate.id===alias)!;
  const snapshot=resolveStoryScene(stage,source(stage,[worldCopy(stage,alias,worldX,worldY)]));
  const pending=pendingEntranceAliases(node.presentation.slice(index+1));
  assert.ok(pending.includes(alias),`${script} 本幕稍后应有 ${alias} 的 appear`);
  const hidden=hidePendingEntrances(snapshot,stage,pending);
  const actor=boundSceneActor(hidden,alias)!;
  assert.deepEqual([actor.visible,actor.stageHidden,actor.x,actor.y],[false,true,worldX,worldY],
    `${script}：地图上的旧副本先藏起来，位置留到出场时再改`);
  const appearIndex=node.presentation.findIndex((action,at)=>at>index&&action.type==='appear'&&action.target===alias);
  const appear=node.presentation[appearIndex] as Extract<PerformanceAction,{type:'appear'}>;
  const shown=applyStorySceneAction(hidden,appear);
  const appeared=boundSceneActor(shown,alias)!;
  assert.deepEqual([appeared.visible,appeared.stageHidden,appeared.x,appeared.y],
    [true,undefined,member.x,member.y],`${script}：出场后清掉临时隐藏，回到剧本位置`);
}

test('main-story entrances hide the map copy until their scripted appearance',()=>{
  assertHiddenUntilAppearance('event-133','delos-highlands-fe5f9057','enemy-redhood-bandits-1',376,184);
  assertHiddenUntilAppearance('event-165','berkel-church-monastery-4-73f46059','story-heresy-leader-9af7359d',360,584);
  assertHiddenUntilAppearance('event-549','land-of-exile-6-d87a215d','enemy-experimented-djinn-1',280,136);
});

test('event-4 keeps the saint visible because she has no entrance in this act',()=>{
  const {node,index,stage}=firstStage('event-4','silent-cave-depths');
  const alias='saint',member=stage.cast.find(candidate=>candidate.characterId==='npc-79')!;
  const snapshot=resolveStoryScene(stage,source(stage,[worldCopy(stage,member.id,360,136)]));
  const pending=pendingEntranceAliases(node.presentation.slice(index+1));
  assert.equal(pending.includes(alias),false);
  const result=hidePendingEntrances(snapshot,stage,pending);
  assert.equal(boundSceneActor(result,alias)!.visible,true);
  assert.equal(result.scene.actors.find(actor=>actor.id===`entity:${alias}`)!.stageHidden,undefined);
});

test('event-8 keeps Janus visible in the act before his appearance',()=>{
  const {node,index,stage}=firstStage('event-8','cardinal-study');
  const alias='janus',member=stage.cast.find(candidate=>candidate.characterId==='npc-55')!;
  const snapshot=resolveStoryScene(stage,source(stage,[worldCopy(stage,member.id,408,168)]));
  const pending=pendingEntranceAliases(node.presentation.slice(index+1));
  assert.equal(pending.includes(alias),false,'雅努斯的 appear 在下一节点');
  const result=hidePendingEntrances(snapshot,stage,pending);
  assert.equal(boundSceneActor(result,alias)!.visible,true);
});
