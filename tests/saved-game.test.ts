import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {prepareSavedGame,type SavedGameContent} from '../src/application/saved-game.ts';
import {newStorySession} from '../src/domain/story-class.ts';
import {SAVE_FORMAT,captureSaveGame,saveSummary} from '../src/domain/save-game.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
import {emptyShortcutRow} from '../src/domain/shortcut-bar.ts';
import type {WorldMap} from '../src/domain/content.ts';
import {WorldEnemyRoster} from '../src/domain/world-enemies.ts';
import {CompanionSkillProgression} from '../src/domain/companion-progression.ts';
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

test('format 57 preserves normal respawn deadlines and derives offscreen deadlines without changing the source',()=>{
  const saved=record();saved.format=57;
  saved.session.enemies=[['waiting',{deadUntil:90_000}],['elapsed',{deadUntil:30_000}],
    ['permanent',{deadUntil:'permanent'}],['alive',{health:123}]];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.enemyVitals('waiting'),{deadUntil:90_000,offscreenRespawnAt:50_000});
  assert.deepEqual(candidate.session.enemyVitals('elapsed'),{deadUntil:30_000,offscreenRespawnAt:0});
  assert.deepEqual(candidate.session.enemyVitals('permanent'),{deadUntil:'permanent'});
  assert.deepEqual(candidate.session.enemyVitals('alive'),{health:123});
  assert.deepEqual(saved,before);
});

test('format 50 merges party loot pity without losing the best progress',()=>{
  const saved=record();
  saved.format=50;
  saved.session.lootPity={version:2,members:[
    ['player',{equipmentMisses:2,uniqueMisses:18,epicMisses:5}],
    ['old-companion',{equipmentMisses:6,uniqueMisses:3,epicMisses:32}],
  ],chests:[],bossDefeats:['enemy-queen-spider-1']};
  const restored=prepareSavedGame(saved,content).session.lootPity.captureState();
  assert.deepEqual(restored.members,[['player',{equipmentMisses:6,uniqueMisses:18,epicMisses:32}]]);
  assert.deepEqual(restored.bossDefeats,['enemy-queen-spider-1']);
});

test('format 36 saves keep their cached stage appearances through the upgrade',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  const actor=content.world.actors[content.campaign.start.actor]!;
  const map=saved.world.location.map;
  saved.format=36;
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.version=2;
  runtime.runs=[{id:'legacy-visual-stage',script,occurrence:'legacy-visual',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',playerVisible:true,cast:[],
      bindings:[['player','player']],scene:{map,actors:[{id:'player',actor:actor.id,memberId:'player',
        x:saved.world.location.x,y:saved.world.location.y,facing:'west',visible:true,appearance:structuredClone(actor)}]}}}];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  const stage=candidate.session.runtimeState.runs[0]!.stage!;
  assert.equal(candidate.session.runtimeState.version,2,'旧档保留原来的完整快照版本');
  assert.deepEqual(stage.scene.actors[0]!.appearance,actor,'旧档的缓存外观仍可用于恢复');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 41 saves with the removed counterattack settings still restore',()=>{
  const saved=record();
  saved.format=41;
  const party=saved.session.party as unknown as {heroCounterattack?:number};
  party.heroCounterattack=1;
  const before=structuredClone(saved);
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.hero!.classId,saved.summary.classId);
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 43 saves drop quests removed from the campaign',()=>{
  const saved=record(),removed=['quest-8','quest-19','quest-20','quest-101','quest-451','quest-488','quest-504','quest-505','quest-506'];
  saved.format=43;
  for(const id of removed)saved.session.questBook.quests.push([id,{status:'locked',cycle:0,completedCycles:0,goals:{}}]);
  saved.session.trackedQuest=removed[0];
  saved.session.receipts.push({quest:removed[1],cycle:1,reward:{experience:0,money:0,items:[]}});
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content),state=candidate.session.captureState();
  assert.equal(state.questBook.quests.some(([id])=>removed.includes(id)),false,'旧档里的已删任务不再恢复');
  assert.equal(state.trackedQuest,undefined,'追踪到已删任务的旧档清除追踪');
  assert.equal(state.receipts.some(receipt=>removed.includes(receipt.quest)),false,'已删任务的结算回执一并清除');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

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

test('the previous published save format restores without its missing scene snapshot and upgrades its runtime',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  saved.format=33;
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.version=1;
  runtime.runs=[{id:'legacy-run',script,occurrence:'legacy',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map:saved.world.location.map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',playerVisible:true,cast:[]}}];
  delete saved.world.scene;
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.money,321);
  assert.equal(candidate.session.runtimeState.version,2);
  assert.equal(candidate.session.runtimeState.runs[0]!.stage,undefined,'旧舞台没有场景与绑定，升级时丢弃');
  assert.equal(candidate.world.scene,undefined,'旧档没有场景快照，由地图重新投影');
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 34 and 33 duplicate skill shortcuts collapse to the last registered slot',()=>{
  for(const format of [34,33]){
    const saved=record(),skillId=content.battleCatalog.classes.find(value=>value.id===saved.summary.classId)!.skills[0]!;
    let playerRow=saved.session.bag.shortcuts.find(([owner])=>owner==='player')?.[1];
    if(!playerRow){playerRow=emptyShortcutRow();saved.session.bag.shortcuts.push(['player',playerRow]);}
    const original={kind:'skill' as const,id:skillId},row=emptyShortcutRow();
    row[0]={...original};row[9]={...original};
    for(let index=0;index<row.length;index++)playerRow[index]=row[index];
    saved.format=format;
    const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
    const restored=candidate.session.bag.captureState().shortcuts.find(([owner])=>owner==='player')![1];
    assert.equal(restored[0],null,'较早的副本被清掉');
    assert.deepEqual(restored[9],original,'保留数组里最后出现的技能槽');
    assert.deepEqual(saved,before,'迁移不改写原始存档');
  }
});

test('format 35 saves hide duplicate world actors and drop a duplicate story stage',()=>{
  const saved=record(),script=Object.keys(content.campaign.scripts)[0],definition=content.campaign.scripts[script];
  saved.format=35;
  const player=saved.world.scene!.actors[0]!,duplicate={...player,id:'duplicate-player'};
  saved.world.scene!.actors.push(duplicate);
  const runtime=saved.session.runtime as unknown as {version:number;runs:unknown[]};
  runtime.runs=[{id:'duplicate-stage',script,occurrence:'duplicate',cursor:{script,node:definition.entry},status:'running',
    stage:{type:'stage',map:saved.world.location.map,x:saved.world.location.x,y:saved.world.location.y,facing:'west',
      playerVisible:true,cast:[],bindings:[['player','player']],
      scene:{map:saved.world.location.map,actors:[player,{...player,id:'duplicate-player'}]}}}];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.world.scene!.actors.find(actor=>actor.id==='duplicate-player')!.visible,false);
  assert.equal(candidate.session.runtimeState.runs[0]!.stage,undefined,'重复演员的旧舞台不恢复');
  assert.deepEqual(saved,before,'迁移不改写原始存档');
});

test('format 40 saves gain an empty reserved drop state on upgrade',()=>{
  const saved=record();saved.format=40;
  const candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.captureState().reservedDrops,{unlockMisses:0,claimed:[]});
});

test('old saves containing removed expansion bags migrate to consumables',()=>{
  const saved=record(),bag=saved.session.bag;
  const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
  const entry=bag.instances.find(value=>!equipped.has(value.id))!;
  entry.item='handbag';
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.get(entry.id)?.item,'healing-potion-m');
  assert.deepEqual(saved,before,'旧档迁移不改写槽里的原件');
});

test('old infinity bags keep the existing elixir replacement',()=>{
  // 旧档保持原样：不因为 reservedItems 改动既有迁移结果，避免影响现有测试玩家。
  const saved=record(),bag=saved.session.bag;
  const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
  const entry=bag.instances.find(value=>!equipped.has(value.id))!;
  entry.item='infinity-bag';
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.get(entry.id)?.item,'elixir');
});

test('old saves containing removed items drop them and every reference',()=>{
  for(const legacyItem of ['standard-dice','stats-reset-spell','resurrection-prayer']){
    const saved=record(),bag=saved.session.bag;
    const equipped=new Set([...Object.values(bag.worn),...bag.companionEquipment.flatMap(([,equipment])=>Object.values(equipment))]);
    const entry=bag.instances.find(value=>!equipped.has(value.id))!;
    entry.item=legacyItem;
    if(!bag.shortcuts.length)bag.shortcuts.push(['player',emptyShortcutRow()]);
    const row=bag.shortcuts[0]![1];
    row[row.length-1]={kind:'item',id:legacyItem};
    const map=saved.world.location.map;
    saved.session.groundLoot.drops.push({id:'ground-legacy',map,x:16,y:24,reward:{kind:'item',item:legacyItem,quantity:1}});
    saved.session.shops.stock.push(['legacy-shop',[{id:'legacy-offer',instance:{id:'legacy-instance',item:legacyItem,quantity:1,enhancement:0,gems:[]},
      limited:true,concealed:false,sold:false}]]);
    const before=structuredClone(saved),candidate=prepareSavedGame(saved,content),state=candidate.session.bag.captureState();
    assert.equal(candidate.session.bag.get(entry.id),undefined,`${legacyItem} 实例被丢弃`);
    assert.ok(!state.allCells.includes(entry.id),`${legacyItem} 全部页不再引用被丢弃的实例`);
    for(const cells of Object.values(state.pouches))assert.ok(!cells.includes(entry.id),`${legacyItem} 分类袋不再引用被丢弃的实例`);
    for(const [,shortcut] of state.shortcuts)for(const slot of shortcut)assert.ok(!(slot?.kind==='item'&&slot.id===legacyItem),`${legacyItem} 快捷栏不再指向被删除的道具`);
    const restored=candidate.session.captureState();
    assert.ok(!restored.groundLoot.drops.some(drop=>drop.id==='ground-legacy'),`${legacyItem} 地面掉落被丢弃`);
    assert.ok(!restored.shops.stock.some(([,offers])=>offers.some(offer=>offer.instance.item===legacyItem)),`${legacyItem} 商店存货被丢弃`);
    assert.deepEqual(saved,before,'旧档迁移不改写槽里的原件');
  }
});

test('a save past the minotaur scene drops the stale fishcake everywhere',()=>{
  const saved=record(),bag=saved.session.bag,id='legacy-fishcake';
  bag.instances.push({id,item:'special-fishcake',quantity:1,enhancement:0,gems:[]});
  bag.pouches.quest.push(id);bag.allCells.push(id);
  const book=saved.session.questBook;
  book.quests.find(([quest])=>quest==='quest-252')![1].status='active';
  if(!book.runningQuestIds.includes('quest-252'))book.runningQuestIds.push('quest-252');
  const map=saved.world.location.map;
  saved.session.groundLoot.drops.push({id:'ground-fishcake',map,x:16,y:24,reward:{kind:'item',item:'special-fishcake',quantity:1}});
  if(!bag.shortcuts.length)bag.shortcuts.push(['player',emptyShortcutRow()]);
  bag.shortcuts[0]![1][bag.shortcuts[0]![1].length-1]={kind:'item',id:'special-fishcake'};
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content),state=candidate.session.captureState();
  assert.equal(candidate.session.bag.count('special-fishcake'),0,'背包里的过期任务道具被清掉');
  assert.ok(!state.groundLoot.drops.some(drop=>drop.reward.kind==='item'&&drop.reward.item==='special-fishcake'),'地面掉落一起清掉');
  for(const [,row] of state.bag.shortcuts)assert.ok(!row.some(slot=>slot?.kind==='item'&&slot.id==='special-fishcake'),'快捷栏不再指向已清理的道具');
  assert.deepEqual(saved,before,'旧档修复不改写槽里的原件');
  const second=prepareSavedGame(saved,content),secondState=second.session.captureState();
  assert.equal(second.session.bag.count('special-fishcake'),0,'同一旧档连续读两次仍然干净');
  assert.ok(!secondState.groundLoot.drops.some(drop=>drop.reward.kind==='item'&&drop.reward.item==='special-fishcake'),'第二次读取不会从原档恢复地面掉落');
});

test('a save before the minotaur scene keeps its fishcake',()=>{
  const saved=record(),bag=saved.session.bag,id='legacy-fishcake';
  bag.instances.push({id,item:'special-fishcake',quantity:1,enhancement:0,gems:[]});
  bag.pouches.quest.push(id);bag.allCells.push(id);
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.bag.count('special-fishcake'),1,'还没走过那段剧情时保留任务道具');
});

test('a save written with a wiped party is repaired before it enters the world',()=>{
  const saved=record();
  saved.session.hero!.health=0;
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.hasLivingMember,true);
  assert.equal(candidate.session.hero!.player.health,candidate.session.hero!.player.maxHealth);
  assert.equal(candidate.session.hero!.player.mana,candidate.session.hero!.player.maxMana);
  assert.equal(saved.session.hero!.health,0,'修复只发生在候选会话，不改写槽里的原件');
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

test('scene visit actors are validated before installation for current and previous saves',()=>{
  for(const format of [47,48,49,50]){
    const saved=record();saved.format=format;
    saved.world.scene!.visit={generatedEntities:[{id:'visitor',actor:'missing',x:0,y:0}],
      breakableRolls:[],roster:{enemies:[],sequence:0,partySize:1}};
    const before=structuredClone(saved);
    assert.throws(()=>prepareSavedGame(saved,content),/存档记录的地图人物无效/);
    assert.deepEqual(saved,before);
    saved.world.scene!.visit.generatedEntities[0]!.actor=content.campaign.start.actor;
    assert.equal(prepareSavedGame(saved,content).world.scene!.visit!.generatedEntities[0]!.actor,content.campaign.start.actor);
  }
});

test('scene visit enemy roster and breakable rolls are validated before installation',()=>{
  const enemy=content.battleCatalog.enemies[0]!.id;
  for(const format of [47,48,49,50])for(const invalid of ['roster','roll']){
    const saved=record();saved.format=format;
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

test('format 48 keeps saved enemy appearances when upgraded',()=>{
  const saved=record();saved.format=48;
  saved.world.scene!.actors.push({id:'enemy:wolf',actor:'wolf',enemyKey:'wolf',enemyId:'wolf',x:40,y:50,
    facing:'south',visible:true,appearance:structuredClone(content.world.actors[content.campaign.start.actor])});
  const before=structuredClone(saved);
  assert.deepEqual(prepareSavedGame(saved,content).world.scene!.actors[1]!.appearance,saved.world.scene!.actors[1]!.appearance);
  assert.deepEqual(saved,before);
});

test('format 37 pity counters migrate to unique and epic counters',()=>{
  const saved=record();saved.format=37;
  const pity=saved.session.lootPity as unknown as {
    version:number;
    members:[string,{equipmentMisses:number;rarePlusMisses:number}][];
    chests:[string,{equipmentMisses:number;rarePlusMisses:number}][];
    bossDefeats:string[];
  };
  pity.version=1;
  pity.members=[['player',{equipmentMisses:3,rarePlusMisses:7}]];
  pity.chests=[['ordinary',{equipmentMisses:2,rarePlusMisses:5}]];
  pity.bossDefeats=['enemy-boss'];
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  const state=candidate.session.lootPity.captureState();
  assert.equal(state.version,2);
  assert.deepEqual(state.members.find(([id])=>id==='player')?.[1],{equipmentMisses:3,uniqueMisses:7,epicMisses:0});
  assert.deepEqual(state.chests.find(([id])=>id==='ordinary')?.[1],{equipmentMisses:2,uniqueMisses:0,epicMisses:0});
  assert.deepEqual(state.bossDefeats,['enemy-boss']);
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 38 saves gain an empty consumed-sword set on upgrade',()=>{
  const saved=record();saved.format=38;delete (saved.session as {legendaryWeapons?:unknown}).legendaryWeapons;
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.legendaryWeapons.captureState(),{used:[]});
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('current saves keep the per-map consumed sword list',()=>{
  const saved=record();saved.session.legendaryWeapons={used:['map-a:sword-001','map-a:sword-005']};
  const candidate=prepareSavedGame(saved,content);
  assert.deepEqual(candidate.session.legendaryWeapons.captureState(),{used:['map-a:sword-001','map-a:sword-005']});
});

const HALL_MAP='noxious-sanctum-main-hall-2e80d907',CURSED_GHOST='enemy-cursed-ghost-1';
const ghostSpawns=Array.from({length:7},(_,index)=>`${HALL_MAP}-spawn-${String(index+1).padStart(3,'0')}`);
const hallMap=read<WorldMap>(`maps/${HALL_MAP}`);
const permanent=(id:string):[string,{health:number;deadUntil:'permanent'}]=>[id,{health:0,deadUntil:'permanent'}];
/** 复现 39 版旧档：event-115 的 remove-enemy 把这 7 只写成了永久死亡。 */
function legacyGhostSave(runtime:(saved:ReturnType<typeof record>)=>void){
  const saved=record();saved.format=39;
  saved.session.enemies.push(...ghostSpawns.map(permanent),permanent('enemy-boss-permanent'));
  saved.session.storyWorld.entities.push(...ghostSpawns.map(id=>({id,removed:true})));
  saved.session.storyWorld.enemyRemovals=[
    {enemyId:CURSED_GHOST,map:HALL_MAP,all:true},
    {enemyId:'enemy-other-map',map:'another-map',all:true},
  ];
  saved.session.storyWorld.flags.push(...[...ghostSpawns,CURSED_GHOST]
    .map(enemyId=>JSON.stringify(['absent-enemy',HALL_MAP,enemyId])));
  runtime(saved);
  return saved;
}

test('format 39 saves restore event-115 hall ghosts after the event completed',()=>{
  const saved=legacyGhostSave(value=>{value.session.runtime.completedEvents.push('event-115');});
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content);
  for(const id of ghostSpawns)assert.equal(candidate.session.enemyVitals(id).deadUntil,undefined);
  assert.equal(candidate.session.enemyVitals('enemy-boss-permanent').deadUntil,'permanent','其他敌人的永久死亡保持不变');
  assert.equal(candidate.session.storyWorld.enemyAvailable(HALL_MAP,CURSED_GHOST),true);
  for(const id of ghostSpawns)assert.equal(candidate.session.storyWorld.entity(id),undefined);
  assert.deepEqual(candidate.session.storyWorld.pendingEnemyRemovals,
    [{enemyId:'enemy-other-map',map:'another-map',all:true}],'只清掉大厅的清场命令');
  const roster=new WorldEnemyRoster(candidate.session,hallMap,[],1,undefined,()=>0.9);
  assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),[...ghostSpawns].sort());
  assert.deepEqual(saved,before,'升级不改写槽里的原件');
});

test('format 39 saves taken during event-115 keep the hall ghosts suppressed',()=>{
  const saved=legacyGhostSave(value=>{
    value.session.runtime.runs.push({id:'legacy-event-115',eventId:'event-115',occurrence:'region:event-115',
      cursor:{script:'event-115',node:'done'},status:'running'});
  });
  const candidate=prepareSavedGame(saved,content);
  for(const id of ghostSpawns)assert.equal(candidate.session.enemyVitals(id).deadUntil,undefined);
  assert.equal(candidate.session.storyWorld.enemyAvailable(HALL_MAP,CURSED_GHOST),false);
  assert.equal(candidate.session.enemyVitals('enemy-boss-permanent').deadUntil,'permanent');
  assert.deepEqual(new WorldEnemyRoster(candidate.session,hallMap,[],1,undefined,()=>0.9).spawns,[]);
});

test('format 39 saves that never started event-115 restore the hall ghosts without suppression',()=>{
  const saved=legacyGhostSave(()=>{});
  const candidate=prepareSavedGame(saved,content);
  assert.equal(candidate.session.storyWorld.enemyAvailable(HALL_MAP,CURSED_GHOST),true);
  assert.equal(candidate.session.enemyVitals('enemy-boss-permanent').deadUntil,'permanent');
  const roster=new WorldEnemyRoster(candidate.session,hallMap,[],1,undefined,()=>0.9);
  assert.deepEqual(roster.spawns.map(spawn=>spawn.id).sort(),[...ghostSpawns].sort());
});

test('format 44 equipment defaults unlocked and current equipment locks round trip',()=>{
  const legacy=record();legacy.format=44;
  for(const entry of legacy.session.bag.instances)delete entry.locked;
  const candidate=prepareSavedGame(legacy,content);
  assert.ok(candidate.session.bag.captureState().instances.every(entry=>!entry.locked));
  const saved=record(),equipment=saved.session.bag.instances.find(entry=>content.items.items[entry.item].equipment)!;
  equipment.locked=true;
  const loaded=prepareSavedGame(saved,content);
  assert.equal(loaded.session.bag.get(equipment.id)!.locked,true);
});

 test('format 46 held poses retain their finish policy and do not mutate the old save',()=>{
  const saved=record(); saved.format=46;
  const player=saved.world.scene!.actors[0]!;
  Object.assign(player,{clip:'lie-side-west',animationProgress:1,animationPlaying:false});
  const before=structuredClone(saved);
  const restored=prepareSavedGame(saved,content);
  assert.equal(restored.world.scene!.actors[0]!.storyPoseHold,true);
  assert.deepEqual(saved,before);
 });

test('format 46 repairs a hidden player only in the affected same-map event',()=>{
  for (const event of [352,4]) {
    const saved=record();saved.format=46;
    const script=`event-${event}`,map=saved.world.location.map;
    const player=structuredClone(saved.world.scene!.actors[0]!);player.visible=false;
    const runtime=saved.session.runtime as unknown as {runs:unknown[]};
    runtime.runs=[{id:'visibility',script,eventId:script,occurrence:'visibility',cursor:{script,node:content.campaign.scripts[script]!.entry},status:'running',
      stage:{type:'stage',map,x:player.x,y:player.y,facing:player.facing,playerVisible:false,cast:[],bindings:[['player','player']],scene:{map,actors:[player]}}}];
    const stage=prepareSavedGame(saved,content).session.runtimeState.runs[0]!.stage!;
    assert.equal(stage.playerVisible,event===352);
    assert.equal(stage.scene.actors[0]!.visible,event===352);
  }
});


test('format 51 mercenaries gain empty skill book progress on upgrade',()=>{
  const saved=record();
  const character=content.storyClasses.classes[0],session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],character,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  session.bag.add('mercenary-emblem-assassin');
  const member=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-assassin')!.id,()=>0).member;
  saved.session.party=session.party!.captureState();
  const previous=saved.session.party.members[0]!;
  delete previous.skillBookLevels;saved.format=51;
  delete previous.skillPoints;
  const restored=prepareSavedGame(saved,content).session.party!.get(member.id)!;
  const legacy=new CompanionSkillProgression(member.generated.skillCaps,content.companions.generation.training);legacy.updateLevel(member.level);
  assert.deepEqual(restored.skills.bookState(),{});
  assert.deepEqual(restored.generated.skillCaps,member.generated.skillCaps);
  assert.deepEqual(restored.skills.skillLevels(),legacy.skillLevels());
  assert.equal(restored.skills.manual,true);
});

test('format 56 turns bound books and mercenary unlocks into shared knowledge without changing training or the source save',()=>{
  const base=record(),character=content.storyClasses.classes[0],session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],character,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  session.hero!.addExperience(Number.MAX_SAFE_INTEGER);
  session.bag.add('mercenary-emblem-black-knight');
  const member=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  const missing=content.items.classSkills[member.classId]!.filter(id=>!member.skills.available(id));
  const learned=missing[0]!,bound=missing[1]!;
  member.skills.unlockSkill(learned,content.battleCatalog);
  const natural=Object.keys(member.generated.skillCaps)[0]!,cap=member.generated.skillCaps[natural];
  while(member.skills.level(natural)<cap)member.skills.learn(natural);
  session.bag.add('skillbook',1);
  session.bag.use(session.bag.entries.find(entry=>entry.item==='skillbook')!.id,undefined,natural,Math.random,member.id);
  session.bag.add('skillbook',2,bound);session.bag.add('sealed-skillbook-black-knight',3);
  const saved=captureSaveGame(session,base.world,base.summary);saved.format=56;
  delete (saved.session.party as Partial<NonNullable<typeof saved.session.party>>).sharedUnlockedSkills;
  const book=saved.session.bag.instances.find(entry=>entry.item==='skillbook'&&entry.skill===bound)!;
  book.item='skill-unlock-book';
  const before=structuredClone(saved),candidate=prepareSavedGame(saved,content),restored=candidate.session.party!.get(member.id)!;
  assert.deepEqual(saved,before,'迁移保留槽里的原存档');
  assert.equal(candidate.session.bag.count('sealed-skillbook-black-knight'),3);
  assert.equal(candidate.session.bag.get(book.id),undefined);
  assert.equal(candidate.session.bag.allCells.some(entry=>entry?.id===book.id),false);
  assert.equal(candidate.session.bag.pouchCells.consumable.some(entry=>entry?.id===book.id),false);
  assert.deepEqual(new Set(candidate.session.party!.captureState().sharedUnlockedSkills),new Set([learned,bound]));
  assert.deepEqual(restored.skills.pointsState(),member.skills.pointsState());
  assert.deepEqual(restored.skills.bookState(),member.skills.bookState());
  assert.equal(restored.skills.level(natural),member.skills.level(natural));
  assert.equal(restored.skills.level(bound),0);assert.equal(restored.skills.available(bound),true);
  candidate.session.bag.add('mercenary-emblem-black-knight');
  const future=candidate.session.party!.recruit(candidate.session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
  assert.equal(future.skills.available(learned),true);assert.equal(future.skills.available(bound),true);
  const current=captureSaveGame(candidate.session,candidate.world,saved.summary),again=prepareSavedGame(current,content).session;
  assert.equal(current.format,SAVE_FORMAT);assert.equal(again.party!.hasSharedSkill(bound),true);
  assert.deepEqual(again.party!.get(member.id)!.skills.pointsState(),member.skills.pointsState());
});

test('format 56 preserves bound book knowledge even when no mercenaries have been recruited',()=>{
  const saved=record(),skill=content.items.classSkills.ranger![0]!,groundSkill=content.items.classSkills.ranger![1]!,
    id=`item-${++saved.session.bag.serial}`,legacyBook='skill-unlock-book';
  saved.format=56;
  delete (saved.session.party as Partial<NonNullable<typeof saved.session.party>>).sharedUnlockedSkills;
  saved.session.bag.instances.push({id,item:legacyBook,quantity:4,enhancement:0,gems:[],skill});
  saved.session.bag.allCells.push(id);saved.session.bag.pouches.consumable.push(id);
  if(!saved.session.bag.shortcuts.length)saved.session.bag.shortcuts.push(['player',emptyShortcutRow()]);
  saved.session.bag.shortcuts[0]![1][0]={kind:'item',id:legacyBook};
  saved.session.groundLoot.drops.push({id:'legacy-ground-book',map:saved.world.location.map,x:16,y:24,
    reward:{kind:'item',item:legacyBook,quantity:1,instance:{id:'legacy-ground-instance',item:legacyBook,quantity:1,enhancement:0,gems:[],skill:groundSkill}}});
  saved.session.shops.stock.push(['legacy-shop',[{id:'legacy-book-offer',instance:{id:'legacy-offer-instance',item:legacyBook,quantity:1,enhancement:0,gems:[]},
    limited:true,concealed:false,sold:false}]]);
  const before=structuredClone(saved);
  const restored=prepareSavedGame(saved,content).session;
  assert.deepEqual(saved,before);
  assert.deepEqual(new Set(restored.party!.captureState().sharedUnlockedSkills),new Set([skill,groundSkill]));
  assert.equal(restored.bag.get(id),undefined);restored.bag.verifyConsistency();
  const state=restored.captureState();
  assert.equal(state.bag.shortcuts.some(([,row])=>row.some(slot=>slot?.kind==='item'&&slot.id===legacyBook)),false);
  assert.equal(state.groundLoot.drops.some(drop=>drop.id==='legacy-ground-book'),false);
  assert.equal(state.shops.stock.some(([,offers])=>offers.some(offer=>offer.instance.item===legacyBook)),false);
});

test('format 55 keeps mercenary ranks and book gains, funds historical ranks once and saves manual allocation',()=>{
  for(const level of [1,105]){
    const base=record(),character=content.storyClasses.classes[0],session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],character,
      content.items,content.characterStats,content.battleCatalog,content.companions);
    session.bag.add('mercenary-emblem-black-knight');
    const member=session.party!.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;
    const saved=captureSaveGame(session,base.world,{...base.summary,level:session.hero!.level});saved.format=55;
    const previous=saved.session.party!.members[0];previous.level=level;delete previous.skillPoints;
    const missing=content.battleCatalog.classes.find(value=>value.id===member.classId)!.skills.find(id=>!previous.generated.skillCaps[id]&&content.battleCatalog.skills[id].normalMaxLevel===4)!;
    previous.unlockedSkills={[missing]:3};previous.skillBookLevels=level>1?{'dark-strike':2}:{};
    const legacy=new CompanionSkillProgression(previous.generated.skillCaps,content.companions.generation.training);
    legacy.restoreBooks(previous.skillBookLevels,level);legacy.restoreUnlocked(previous.unlockedSkills);
    const expected=legacy.skillLevels(),before=structuredClone(saved);
    const candidate=prepareSavedGame(saved,content),restored=candidate.session.party!.get(member.id)!;
    assert.deepEqual(restored.skills.skillLevels(),expected);assert.deepEqual(saved,before,'迁移不改写旧档');
    assert.equal(restored.skills.bookState()[missing],2,'解锁书首级以外的等级仍属于技能书提升');
    const state=restored.skills.pointsState()!,budget=(level-1)*content.characterStats.skillPointsPerLevel;
    assert.equal(state.legacyBonusPoints,Math.max(0,state.spentPoints-budget));
    assert.equal(restored.skills.points(),Math.max(0,budget-state.spentPoints));
    if(level===1)assert(state.legacyBonusPoints>0,'旧档的免费首级会得到一次性点数补齐');
    const normalCost=Object.entries(state.allocations).reduce((sum,[id,rank])=>sum+content.battleCatalog.skills[id].ranks.slice(0,rank).reduce((total,value)=>total+value.pointCost,0),0);
    assert.equal(state.spentPoints,normalCost,'技能书等级不计入普通投入');
    const current=captureSaveGame(candidate.session,candidate.world,saved.summary);
    assert.equal(current.format,SAVE_FORMAT);
    const loaded=prepareSavedGame(current,content),again=loaded.session.party!.get(member.id)!;
    assert.deepEqual(again.skills.pointsState(),state);assert.deepEqual(again.skills.skillLevels(),expected);
    if(level===105){
      const points=again.skills.points(),cost=content.battleCatalog.skills[missing].ranks[3].pointCost;
      again.skills.learn(missing);assert.equal(again.skills.points(),points-cost);
      assert.equal(again.skills.bookState()[missing],2,'继续普通加点保留已有技能书提升');
      const updated=captureSaveGame(loaded.session,loaded.world,saved.summary),roundTrip=prepareSavedGame(updated,content).session.party!.get(member.id)!;
      assert.equal(roundTrip.skills.level(missing),4);assert.equal(roundTrip.skills.points(),points-cost);
    }
    again.skills.reset();assert.equal(again.skills.points(),budget+state.legacyBonusPoints);
    assert.equal(again.skills.available(missing),true);assert.equal(again.skills.level(missing),0);
    assert.deepEqual(again.skills.bookState(),{});
    again.skills.reset();assert.equal(again.skills.points(),budget+state.legacyBonusPoints,'再次初始化不会重复返还');
  }
});

test('format 54 restores map-default posture and new saves retain explicit hero posture', () => {
  const legacy = record();
  legacy.format = 54;
  assert.equal(prepareSavedGame(legacy, content).world.scene!.actors[0].townPose, undefined);
  const current = record();
  current.world.scene!.actors[0].townPose = false;
  assert.equal(prepareSavedGame(current, content).world.scene!.actors[0].townPose, false);
});
