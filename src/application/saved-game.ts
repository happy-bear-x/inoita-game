import {newStorySession,type StoryClassCatalog} from '../domain/story-class.ts';
import {SAVE_FORMAT,restoreSaveGame,type SaveGame} from '../domain/save-game.ts';
import {prepareCombatRestore} from '../domain/combat-snapshot.ts';
import type {Campaign} from '../domain/campaign.ts';
import type {WorldIndex} from '../domain/content.ts';
import type {ItemCatalog} from '../domain/items.ts';
import type {CharacterStatsCatalog} from '../domain/character-stats.ts';
import type {BattleCatalog} from '../domain/battle.ts';
import type {CompanionCatalog} from '../domain/party.ts';
import type {StoryWorldViewSnapshot} from './world-snapshot.ts';
import {validateSceneSnapshot} from '../domain/scene-snapshot.ts';

export interface SavedGameContent {
  campaign:Campaign;world:WorldIndex;storyClasses:StoryClassCatalog;items:ItemCatalog;
  characterStats:CharacterStatsCatalog;battleCatalog:BattleCatalog;companions:CompanionCatalog;
}
/** 旧版每图只留 64 件。采集物被挤出后，生成点仍保存着它的编号。 */
function evictedQuestPickups(game:SaveGame<StoryWorldViewSnapshot>):Set<string> {
  const {questItemGeneration:points,groundLoot,storyWorld}=game.session;
  const evicted=new Set<string>();
  if(game.format!==59||points.map!==game.world.location.map||points.mapVisit!==storyWorld.mapVisit||
    !points.generators.some(point=>point.dropId))return evicted;
  const present=new Set(groundLoot.drops.map(drop=>drop.id));
  const bound=new Set<string>();
  for(const point of points.generators){
    const id=point.dropId;
    if(!id)continue;
    // 重复绑定交给读档校验；同一个地面物品只能属于一个生成点。
    if(bound.has(id)){evicted.delete(id);continue;}
    bound.add(id);
    if(present.has(id)||point.exhausted||point.remainingFrames>0)continue;
    const serial=Number(/^ground-([1-9]\d*)$/.exec(id)?.[1]);
    if(Number.isSafeInteger(serial)&&Number.isSafeInteger(groundLoot.nextId)&&groundLoot.nextId-serial>=64)evicted.add(id);
  }
  return evicted;
}

export function prepareSavedGame(game:SaveGame<StoryWorldViewSnapshot>,content:SavedGameContent){
  if(game.format!==SAVE_FORMAT)throw new Error('存档版本不受支持');
  const selected=content.storyClasses.classes.find(entry=>entry.id===game.summary.classId);
  if(!selected)throw new Error('存档记录的职业在当前内容里不存在');
  const world=structuredClone(game.world),location=world?.location;
  const map=content.world.maps.find(entry=>entry.id===location?.map);
  if(!map||game.summary.mapId!==location.map||!Number.isFinite(location.x)||!Number.isFinite(location.y)||
    !['north','south','east','west'].includes(location.facing))throw new Error('存档记录的地图或位置无效');
  if(!Array.isArray(world.generatedEntities)||new Set(world.generatedEntities.map(entity=>entity.id)).size!==world.generatedEntities.length||
    world.generatedEntities.some(entity=>!content.world.actors[entity.actor]||!Number.isFinite(entity.x)||!Number.isFinite(entity.y)))throw new Error('存档记录的地图人物无效');
  // 缺场景快照时，位置由 `location` 与剧情世界状态重新投影。
  if(world.scene){
    validateSceneSnapshot(world.scene);
    if(world.scene.visit?.generatedEntities.some(entity=>!content.world.actors[entity.actor]))
      throw new Error('存档记录的地图人物无效');
    if(world.scene.visit){
      const enemyIds=new Set(content.battleCatalog.enemies.map(enemy=>enemy.id));
      if(world.scene.visit.roster.enemies.some(enemy=>!enemyIds.has(enemy.enemyId))||
        world.scene.visit.breakableRolls.some(([,enemyId])=>!enemyIds.has(enemyId)))
        throw new Error('存档记录的地图敌人无效');
    }
    const player=world.scene.actors.find(actor=>actor.id==='player');
    if(world.scene.map!==location.map||!player||player.x!==location.x||player.y!==location.y||player.facing!==location.facing)
      throw new Error('存档场景与主角位置不一致');
  }
  const session=newStorySession(content.campaign,content.world.actors[content.campaign.start.actor],selected,
    content.items,content.characterStats,content.battleCatalog,content.companions);
  const evicted=evictedQuestPickups(game);
  if(evicted.size){
    const points=structuredClone(game.session.questItemGeneration);
    for(const point of points.generators)if(point.dropId&&evicted.has(point.dropId))delete point.dropId;
    restoreSaveGame(session,{...game,session:{...game.session,questItemGeneration:points}});
  }else restoreSaveGame(session,game);
  // 读取时补齐已经拥有的解锁道具领取记录：不改背包，只避免一次性掉落再给一份。
  const seeded=new Set<string>();
  for(const entry of session.bag.entries){
    const definition=content.items.items[entry.item];
    if(definition?.use?.kind==='recipe'||definition?.use?.kind==='box'||entry.item.startsWith('sealed-skillbook'))
      seeded.add(entry.item);
  }
  for(const [id,definition] of Object.entries(content.items.items)){
    if(definition.use?.kind==='recipe'&&definition.use.recipes?.some(recipe=>session.bag.learnedRecipes.includes(recipe)))
      seeded.add(id);
  }
  session.seedReservedClaims(seeded);
  if(!session.hasLivingMember)throw new Error('存档没有存活队员');
  if(session.party&&!session.party.alive(session.party.controlledId)){
    session.party.switchControl(session.party.livingIds[0]!);
  }
  if(world.world)world.world=prepareCombatRestore(world.world,content.battleCatalog,session.party?.activeIds??[]);
  if(evicted.size)globalThis.storyDiagnostics?.record('save-repaired-evicted-quest-pickup',{map:map.id,count:evicted.size},false);
  return {session,world,map};
}
