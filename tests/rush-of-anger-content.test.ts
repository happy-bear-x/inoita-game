import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import {costumeRecipe,type WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read('battle') as BattleCatalog,items=read('items') as ItemCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const skill=battle.skills['rush-of-anger'],action=skill.action!,units=action.combatUnits!;
const facings=['south','west','north','east'] as const;

test('Rush of Anger preserves all eight physical formulas, mana costs, cooldown frames and stun profiles',()=>{
  assert.deepEqual(units.map(unit=>unit.effect),['physical','state']);
  const damage=units[0],state=units[1];assert.ok(damage.effect==='physical'&&state.effect==='state');
  assert.equal(damage.source,'physicalAttack');
  assert.deepEqual(damage.attributeWeights,{strength:12,dexterity:0,vitality:0,intelligence:0,mentality:0});
  assert.deepEqual(damage.ranks,[2105,2305,2605,3005,3105,3205,3305,3405].map(ratePerThousand=>({
    fixedAddition:0,operation:{kind:'multiply-thousandth',ratePerThousand}})));
  assert.deepEqual(damage.ranks.map((_,index)=>actionDamage(damage,index+1,{physicalAttack:101,magicAttack:999,
    bestNormalDamage:999,maxHealth:1000,primaryAttributes:{strength:13,dexterity:0,vitality:0,intelligence:0,mentality:0}})),
    [244,267,302,348,360,371,383,394]);
  assert.equal(state.state,'stun');
  assert.deepEqual(state.ranks,Array.from({length:8},()=>({chanceThreshold:1000,durationMs:960,
    stateDurationProfile:{normal:{lastActiveFrame:15},targetShortened:{lastActiveFrame:7}}})));
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(40));assert.equal(action.cooldownFrames,60);
  assert.equal(action.requiresTarget,true);assert.equal(action.requiredOffhand,undefined);
  assert.equal(action.approachDistanceUnits,11);assert.equal(action.searchRadiusPx,88);
  assert.equal(action.usesSkillDamageBuff,true);assert.equal(action.afterimages,undefined);
});

test('real one-handed and two-handed wardrobe recipes use different poses with nine frames and one strike',()=>{
  const poses:string[]=[];
  for(const kind of ['longsword','two-handed']){
    const weapon=Object.entries(items.items).find(([,item])=>item.kind===kind&&item.equipment)?.[0];assert.ok(weapon);
    const recipe=costumeRecipe(wardrobe,items,{'main-hand':weapon},'warrior');
    const effective=recipe.actions['rush-of-anger']??action;
    assert.deepEqual(effective.charge,{arrivalFrame:2,closeDistanceUnits:2,lungeDistancePx:8,stoppingDistanceUnits:3,gridSizePx:8});
    assert.equal(effective.cooldownFrames,60);assert.equal(effective.events.length,1);
    assert.equal(effective.events[0].kind,'units');assert.equal(effective.events[0].frame,3);
    for(const facing of facings){
      const pose=recipe.poses[`skill-rush-of-anger-${facing}`];assert.ok(pose);
      const frames=wardrobe.poses[pose].frames;assert.equal(frames.length,9);
      for(const frame of frames.slice(4))assert.deepEqual(frame,frames[3]);
      if(facing==='south')poses.push(pose);
    }
  }
  assert.notEqual(poses[0],poses[1]);
  const warrior=battle.classes.find(entry=>entry.id==='warrior')!;
  for(const facing of facings)assert.equal(warrior.actor.clips[`skill-rush-of-anger-${facing}`]!.frames,9);
});

test('Rush of Anger keeps its successful-target aura and one post-Direct feedback sequence',()=>{
  const event=action.events[0];assert.equal(event.kind,'units');if(event.kind!=='units')throw new Error('Missing Direct');
  assert.deepEqual(event.cues.map(cue=>[cue.target,cue.targetSelection]),[['current','search'],['current','reuse-previous']]);
  assert.deepEqual(event.cues[0].effects,[{effect:'rage-aura',recipient:'target',placement:'attached'}]);
  assert.deepEqual(event.cues[1].effects,[]);
  assert.deepEqual(event.dispatch,{breaksStealth:true,shake:true,vibrationMs:150,sound:'Wa_Anger_Rush'});
  const clip=battle.attackEffects['rage-aura'].clips.default;
  assert.equal(clip.frames,7);assert.equal(clip.frameRate,1000/60);
  assert.deepEqual(clip.layers.map(layer=>[layer.blend,layer.operations]),[
    ['normal',[]],['multiply',['hard-light']],['add',['hard-light']],
  ]);
  for(const layer of clip.layers){
    const png=readFileSync(sourceAssetPath(layer.file));
    assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(png.readUInt32BE(16),clip.frameWidth*clip.frames);assert.equal(png.readUInt32BE(20),clip.frameHeight);
  }
});
