import assert from 'node:assert/strict';
import { stageSnapshot } from './helpers/story-stage.ts';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {Campaign} from '../src/domain/campaign.ts';
import {Session} from '../src/domain/session.ts';
import {StoryRuntime} from '../src/domain/story-runtime.ts';
const campaign=JSON.parse(readFileSync(new URL('../public/content/campaign.json',import.meta.url),'utf8')) as Campaign;

test('the native uniform event registers Gunther at the native location and later unregistering removes him',async()=>{
  const session=new Session(campaign),quest=campaign.quests.find(quest=>quest.id==='quest-18')!;
  const placement=campaign.placements.find(placement=>placement.actor===quest.giver)!;
  assert.deepEqual([placement.map,placement.x,placement.y],['training-dungeon-one',104,488]);
  assert.equal(session.visible(placement),false);
  const runtime=new StoryRuntime({...campaign,events:[]},{async prepare(){},capture:()=>session.captureState(),
    // 生产端口由 presenter 交出解析过地图的舞台（`mapFromStage` 的剧情物件要靠它落图）；桩照它给。
    async present(node){const stage=node.presentation.find(action=>action.type==='stage');return stage?{stage:stageSnapshot(stage)}:{};},async finish(){},
    currentMap:()=>session.storyWorld.currentLocation?.map,
    apply:commit=>session.applyStoryCommands(commit.commands,commit.checkpoint),commit:commit=>session.adoptRuntime(commit.checkpoint),rollback:snapshot=>session.restoreState(snapshot as ReturnType<Session['captureState']>),
    evaluate:(condition)=>session.evaluateCondition(condition)});
  await runtime.start('event-10');
  assert.equal(session.visible(placement),true);
  const projected=session.storyWorld.projectEntities(placement.map,[placement]);
  assert.equal(projected.filter(entity=>entity.actor===quest.giver).length,1);
  assert.ok(session.forActor(quest.giver!).some(candidate=>candidate.id===quest.id));
  const restored=new Session(campaign);restored.restoreState(session.captureState());
  assert.equal(restored.visible(placement),true);
  const removals=campaign.scripts['event-49'].nodes.flatMap(node=>node.commands).filter(command=>
    command.type==='world'&&command.command.kind==='remove'&&command.command.id===placement.id
    ||command.type==='flag'&&command.flag===placement.id);
  assert.equal(removals.length,2);
  restored.applyStoryCommands(removals);
  assert.equal(restored.visible(placement),false);
  assert.equal(restored.storyWorld.projectEntities(placement.map,[placement]).some(entity=>entity.actor===quest.giver),false);
});

test('a registered location moves an existing map actor without creating a second colliding instance',()=>{
  const session=new Session(campaign);
  const base={id:'native-elder',actor:'elder',x:24,y:24};
  session.storyWorld.apply({kind:'place',entity:{id:'quest-npc-located-elder',actor:'elder',map:'village',x:72,y:40}});
  const projected=session.storyWorld.projectEntities('village',[base]);
  assert.deepEqual(projected.map(entity=>[entity.id,entity.x,entity.y]),[['quest-npc-located-elder',72,40]]);
  assert.deepEqual(session.storyWorld.projectEntities('another-village',[base]),[base]);
  session.storyWorld.apply({kind:'remove',id:'quest-npc-located-elder'});
  assert.deepEqual(session.storyWorld.projectEntities('village',[base]),[base]);
});
