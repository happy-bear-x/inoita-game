import assert from 'node:assert/strict';
import test from 'node:test';
import { StoryWorldState, storyExitId } from '../src/domain/story-world.ts';

test('a permanent story actor moves between maps while other instances keep their own positions',()=>{
  const world=new StoryWorldState(),base=[{id:'forest-darius',actor:'darius',x:216,y:136,hint:'mission',condition:{type:'flag' as const,flag:'visible'}},{id:'soldier',actor:'shadow-soldier',x:168,y:120}];
  world.apply({kind:'place',entity:{id:'forest-darius',actor:'darius',map:'camp',x:264,y:344,facing:'west'}});
  assert.deepEqual(world.projectEntities('forest',base).map(e=>e.id),['soldier']);
  const camp=world.projectEntities('camp',[],base);
  assert.equal(camp[0].id,'forest-darius');assert.equal(camp[0].x,264);
  assert.equal(camp[0].hint,'mission');assert.deepEqual(camp[0].condition,base[0].condition);
  world.apply({kind:'hide',id:'forest-darius'});
  assert.equal(world.visible('forest-darius'),false);
  assert.equal(world.visible('soldier'),true);
  const restored=new StoryWorldState();restored.restoreState(world.captureState());
  assert.deepEqual(restored.captureState(),world.captureState());
});

test('visit-scoped story actors expire with the map visit while registered locations persist',()=>{
  const world=new StoryWorldState(),at=(map:string)=>({map,x:8,y:8,facing:'south' as const});
  world.apply({kind:'travel',destination:at('cave')});
  world.apply({kind:'place',scope:'visit',entity:{id:'temp',map:'cave',actor:'npc',characterId:'npc-1',x:24,y:8}});
  world.apply({kind:'place',entity:{id:'quest-npc-located-npc-2',map:'cave',actor:'npc2',characterId:'npc-2',x:40,y:8}});
  assert.deepEqual(world.projectEntities('cave',[]).map(entity=>entity.id).sort(),['quest-npc-located-npc-2','temp']);
  world.apply({kind:'travel',destination:at('forest')});
  world.apply({kind:'travel',destination:at('cave')});
  assert.deepEqual(world.projectEntities('cave',[]).map(entity=>entity.id),['quest-npc-located-npc-2']);
});

test('a location registration replaces earlier cinematic instances of the same character on its map',()=>{
  const world=new StoryWorldState();
  world.apply({kind:'place',scope:'visit',entity:{id:'story-character-10-15',map:'hall',actor:'darius',characterId:'npc-40',x:552,y:472}});
  world.apply({kind:'place',entity:{id:'quest-npc-located-npc-40',map:'hall',actor:'darius',characterId:'npc-40',x:264,y:344}});
  assert.deepEqual(world.projectEntities('hall',[]).map(entity=>[entity.id,entity.x,entity.y]),
    [['quest-npc-located-npc-40',264,344]]);
  assert.equal(world.entity('story-character-10-15'),undefined,'登记接管后旧过场实例不再留在世界状态');
});

test('a location registration hides duplicate cinematic instances from an older save and removal keeps them hidden',()=>{
  const world=new StoryWorldState();
  world.restoreState({entities:[
    {id:'story-character-10-15',map:'hall',actor:'darius',characterId:'npc-40',x:552,y:472,visible:true},
    {id:'story-character-npc-40',map:'hall',actor:'darius',characterId:'npc-40',x:264,y:344,visible:true},
    {id:'quest-npc-located-npc-40',map:'hall',actor:'darius',characterId:'npc-40',x:264,y:344,visible:true},
  ],exits:[],flags:[],choices:[],encounters:[],mapVisit:0});
  assert.deepEqual(world.projectEntities('hall',[]).map(entity=>entity.id),['quest-npc-located-npc-40'],
    '旧档里的重复实例仍由投影收敛成一个卓拉德');
  world.apply({kind:'remove-character',characterId:'npc-40',map:'hall',all:false});
  assert.deepEqual(world.projectEntities('hall',[]),[],'撤下登记副本时不能把同图的过场副本露出来');
});

test('a later persistent registration clears the visit lifetime left by a temporary one',()=>{
  const world=new StoryWorldState(),at=(map:string)=>({map,x:8,y:8,facing:'south' as const});
  world.apply({kind:'travel',destination:at('cave')});
  world.apply({kind:'place',scope:'visit',entity:{id:'guide',map:'cave',actor:'npc',characterId:'npc-598',x:24,y:8}});
  world.apply({kind:'place',entity:{id:'guide',map:'cave',actor:'npc',characterId:'npc-598',x:32,y:8}});
  assert.equal(world.entity('guide')?.mapVisit,undefined,'常驻登记会清掉旧的访问寿命');
  world.apply({kind:'travel',destination:at('forest')});
  world.apply({kind:'travel',destination:at('cave')});
  assert.deepEqual(world.projectEntities('cave',[]).map(entity=>entity.id),['guide']);
});

test('a story-placed treasure chest persists across map visits',()=>{
  const world=new StoryWorldState(),at=(map:string)=>({map,x:8,y:8,facing:'south' as const});
  world.apply({kind:'travel',destination:at('boss-room')});
  world.apply({kind:'place',entity:{id:'story-object-1-2',map:'boss-room',actor:'chest',characterId:'npc-212',x:24,y:8}});
  assert.equal(world.isPlaced('story-object-1-2'),true);
  world.apply({kind:'travel',destination:at('village')});
  world.apply({kind:'travel',destination:at('boss-room')});
  assert.deepEqual(world.projectEntities('boss-room',[]).map(entity=>entity.id),['story-object-1-2']);
});

test('removing the last story instance also hides the static copies of that character',()=>{
  const world=new StoryWorldState(),at=(map:string)=>({map,x:8,y:8,facing:'south' as const});
  const base=[{id:'static-door-0',actor:'door',characterId:'npc-9',x:8,y:8},
    {id:'static-door-1',actor:'door',characterId:'npc-9',x:24,y:8},
    {id:'bystander',actor:'npc-10',characterId:'npc-10',x:40,y:8}];
  world.apply({kind:'travel',destination:at('hall')});
  world.apply({kind:'place',scope:'visit',entity:{id:'story-door',map:'hall',actor:'door',characterId:'npc-9',x:8,y:8}});
  assert.deepEqual(world.projectEntities('hall',base).map(entity=>entity.id).sort(),
    ['bystander','static-door-0','static-door-1','story-door']);
  world.apply({kind:'remove-character',characterId:'npc-9',map:'hall',all:true});
  assert.deepEqual(world.projectEntities('hall',base).map(entity=>entity.id),['bystander'],
    '静态副本不能因为剧情实例先匹配过就留下来');
  world.apply({kind:'travel',destination:at('forest')});
  world.apply({kind:'travel',destination:at('hall')});
  assert.deepEqual(world.projectEntities('hall',base).map(entity=>entity.id),['bystander'],
    '访问实例过期后，移除标记仍要挡住静态副本');
});

test('an explicit visible placement clears an earlier removal flag, including visit scope',()=>{
  const world=new StoryWorldState(),at=(map:string)=>({map,x:8,y:8,facing:'south' as const});
  const base=[{id:'static-door',actor:'door',characterId:'npc-9',x:8,y:8}];
  world.apply({kind:'travel',destination:at('hall')});
  world.apply({kind:'remove-character',characterId:'npc-9',map:'hall',all:true});
  assert.equal(world.actorVisible('hall','door','npc-9'),false);
  world.apply({kind:'place',scope:'visit',entity:{id:'story-door',map:'hall',actor:'door',characterId:'npc-9',x:24,y:8}});
  assert.equal(world.actorVisible('hall','door','npc-9'),true,'重新登场时不能被上次移除的标记挡住');
  assert.deepEqual(world.projectEntities('hall',base).map(entity=>entity.id).sort(),['static-door','story-door']);
});

test('removing one instance with all:false keeps the remaining copies visible',()=>{
  const world=new StoryWorldState(),at=(map:string)=>({map,x:8,y:8,facing:'south' as const});
  world.apply({kind:'travel',destination:at('hall')});
  world.apply({kind:'place',entity:{id:'first',map:'hall',actor:'guard',characterId:'npc-8',x:8,y:8}});
  world.apply({kind:'place',entity:{id:'second',map:'hall',actor:'guard',characterId:'npc-8',x:24,y:8}});
  world.apply({kind:'remove-character',characterId:'npc-8',map:'hall',all:false});
  assert.equal(world.actorVisible('hall','guard','npc-8'),true,'还有实例在场时不记录整图缺席');
  assert.equal(world.projectEntities('hall',[]).length,1);
});

test('story exit gates and encounter terminal results survive a stable snapshot',()=>{
  const world=new StoryWorldState(),exit={x:64,y:0,width:16,height:48,destination:'hall',spawn:{x:8,y:8},facing:'south' as const,exitFacing:'any' as const};
  world.apply({kind:'exit',id:storyExitId('camp',exit),enabled:false});
  world.apply({kind:'encounter',encounter:{id:'earl-battle',map:'cave',status:'active',spawns:[{id:'earl',enemyId:'earl',x:100,y:100}]}});
  world.apply({kind:'encounter-result',id:'earl-battle',result:'won'});
  world.apply({kind:'encounter-result',id:'earl-battle',result:'won'});
  assert.throws(()=>world.apply({kind:'encounter-result',id:'earl-battle',result:'lost'}),/结果冲突/);
  const copy=new StoryWorldState();copy.restoreState(world.captureState());
  assert.equal(copy.exitEnabled('camp',exit),false);assert.equal(copy.encounter('earl-battle')?.status,'won');
  assert.equal(copy.activeEncounters.length,0);
});

test('failed world restore validates before replacing the live world',()=>{
  const world=new StoryWorldState();world.apply({kind:'flag',id:'opened',value:true});
  world.apply({kind:'choice',id:'lesson',value:'skills'});
  const before=world.captureState(),bad=structuredClone(before);bad.entities=[{id:'duplicate'},{id:'duplicate'}];
  assert.throws(()=>world.restoreState(bad),/重复/);assert.deepEqual(world.captureState(),before);
  const external=world.captureState();external.flags.length=0;assert.equal(world.hasFlag('opened'),true);
});

test('active encounters only read the live index after a long settled history',()=>{
  const world=new StoryWorldState();
  for(let index=0;index<200;index++){
    const id=`settled-${index}`;
    world.apply({kind:'encounter',encounter:{id,map:'cave',status:'active',spawns:[{id:'enemy',enemyId:'wolf',x:index,y:index}]}});
    world.apply({kind:'encounter-result',id,result:index%2===0?'won':'lost'});
  }
  world.apply({kind:'encounter',encounter:{id:'prepared',map:'cave',status:'prepared',spawns:[{id:'enemy',enemyId:'wolf',x:0,y:0}]}});
  world.apply({kind:'encounter',encounter:{id:'current-a',map:'cave',status:'active',spawns:[{id:'a',enemyId:'wolf',x:1,y:1}]}});
  world.apply({kind:'encounter',encounter:{id:'current-b',map:'hall',status:'active',spawns:[{id:'b',enemyId:'wolf',x:2,y:2}]}});

  assert.deepEqual(world.activeEncounters.map(encounter=>encounter.id),['current-a','current-b'],
    '活动列表只含进行中的遭遇，顺序与加入顺序一致');
  assert.equal(world.captureState().encounters.length,203,'已结算遭遇仍保留在历史表里');
  assert.equal(world.encounterStatuses().size,203,'完整状态查询保持原语义');

  const clone=world.activeEncounters[0]!;clone.status='won';
  assert.equal(world.encounter('current-a')?.status,'active','读取活动列表仍返回克隆');

  world.apply({kind:'encounter-result',id:'current-a',result:'won'});
  assert.deepEqual(world.activeEncounters.map(encounter=>encounter.id),['current-b'],'结算后立刻移出活动索引');
  assert.throws(()=>world.apply({kind:'encounter-result',id:'current-a',result:'lost'}),/结果冲突/);
  assert.deepEqual(world.activeEncounters.map(encounter=>encounter.id),['current-b'],'冲突结果不改变活动索引');
  world.apply({kind:'encounter-result',id:'current-b',result:'lost'});
  assert.deepEqual(world.activeEncounters,[]);
});

test('restoring a snapshot rebuilds the active encounter index',()=>{
  const world=new StoryWorldState();
  for(let index=0;index<100;index++){
    const id=`history-${index}`;
    world.apply({kind:'encounter',encounter:{id,map:'cave',status:'active',spawns:[{id:'enemy',enemyId:'wolf',x:index,y:index}]}});
    world.apply({kind:'encounter-result',id,result:'won'});
  }
  world.apply({kind:'encounter',encounter:{id:'active-a',map:'cave',status:'active',spawns:[{id:'a',enemyId:'wolf',x:1,y:1}]}});
  world.apply({kind:'encounter',encounter:{id:'active-b',map:'hall',status:'active',spawns:[{id:'b',enemyId:'wolf',x:2,y:2}]}});
  const snapshot=world.captureState();

  const restored=new StoryWorldState();
  restored.apply({kind:'encounter',encounter:{id:'stale',map:'cave',status:'active',spawns:[{id:'stale',enemyId:'wolf',x:9,y:9}]}});
  restored.restoreState(snapshot);
  assert.deepEqual(restored.activeEncounters.map(encounter=>encounter.id),['active-a','active-b'],
    '整份恢复按快照顺序重建索引，旧世界的活动遭遇不能残留');

  restored.apply({kind:'encounter-result',id:'active-a',result:'won'});
  assert.deepEqual(restored.activeEncounters.map(encounter=>encounter.id),['active-b'],'恢复后的结算仍同步索引');

  const settled=structuredClone(snapshot);
  settled.encounters.find(encounter=>encounter.id==='active-b')!.status='won';
  restored.restoreState(settled);
  assert.deepEqual(restored.activeEncounters.map(encounter=>encounter.id),['active-a'],
    '恢复时按快照里的状态重建，而不是沿用当前索引');

  const empty=structuredClone(snapshot);empty.encounters=[];
  restored.restoreState(empty);
  assert.equal(restored.activeEncounters.length,0,'快照删掉遭遇后索引同步清空');

  restored.restoreState(snapshot);
  const before=restored.activeEncounters.map(encounter=>encounter.id);
  const duplicate=structuredClone(snapshot);duplicate.encounters.push(structuredClone(duplicate.encounters[0]!));
  assert.throws(()=>restored.restoreState(duplicate),/重复/);
  assert.deepEqual(restored.activeEncounters.map(encounter=>encounter.id),before,'校验失败时不改动活动索引');
});
