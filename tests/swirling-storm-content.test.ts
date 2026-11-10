import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog,SkillAction} from '../src/domain/battle.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read('battle') as BattleCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const skill=battle.skills['swirling-storm'],action=skill.action!;

function checkTimeline(value:SkillAction){
  assert.equal(value.requiresTarget,true);assert.equal(value.cooldownFrames,90);
  assert.equal(value.approachDistanceUnits,8);assert.equal(value.searchRadiusPx,64);
  assert.deepEqual(value.events[0],{kind:'impact',frame:0,target:'self',effect:{effect:'swirl-ring',recipient:'target',placement:'above-characters'}});
  const units=value.events.filter(event=>event.kind==='units');
  assert.equal(value.events.length,6);assert.deepEqual(units.map(event=>event.frame),[3,6,9,12,15]);
  for(const event of units){
    assert.deepEqual(event.cues,[{target:'area',targetRangePx:72,effects:[],targetSelection:'search',targetRangeMetric:'octagonal-grid'}]);
    assert.deepEqual(event.dispatch,{breaksStealth:true,shake:true,vibrationMs:300,sound:'Wa_Wheel_Wind'});
  }
}

test('Swirling Storm preserves eight formulas, skill damage semantics and one mana/cooldown configuration',()=>{
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(60));
  assert.equal(action.usesSkillDamageBuff,true);assert.equal(action.hitEffectStyle,'skill');assert.equal(action.manaGemDrop,'skill');
  assert.equal(action.combatUnits!.length,1);const damage=action.combatUnits![0];assert.ok(damage.effect==='physical');
  assert.equal(damage.source,'physicalAttack');
  assert.deepEqual(damage.attributeWeights,{strength:10,dexterity:12,vitality:0,intelligence:0,mentality:0});
  assert.deepEqual(damage.ranks,[530,590,630,650,670,690,710,730].map(ratePerThousand=>({fixedAddition:0,
    operation:{kind:'multiply-thousandth',ratePerThousand}})));
  assert.deepEqual(damage.ranks.map((_,index)=>actionDamage(damage,index+1,{physicalAttack:101,magicAttack:999,
    bestNormalDamage:999,maxHealth:1000,primaryAttributes:{strength:11,dexterity:17,vitality:0,intelligence:0,mentality:0}})),
    [69,77,83,85,88,91,93,96]);
  checkTimeline(action);
});

test('all exported wardrobe stances use the same reviewed five-query contract and complete twenty-four-frame poses',()=>{
  const variants=new Set<string>();const warrior=battle.classes.find(entry=>entry.id==='warrior')!;
  for(const facing of ['north','south','east','west'] as const)assert.equal(warrior.actor.clips[`skill-swirling-storm-${facing}`]!.frames,24);
  for(const stance of Object.keys(wardrobe.stances)){
    const override=wardrobe.skillStances.warrior[stance];
    checkTimeline(override?.actions['swirling-storm']??action);
    for(const facing of ['north','south','east','west'] as const){
      const key=`skill-swirling-storm-${facing}` as const;
      const pose=override?.poses[key]??wardrobe.skills.warrior[key];assert.ok(pose);
      const frames=wardrobe.poses[pose].frames;assert.equal(frames.length,24);
      for(const frame of frames.slice(19))assert.deepEqual(frame,frames[18]);
      if(facing==='south')variants.add(pose);
    }
  }
  assert.equal(variants.size,2);
});

test('the sole frame-zero Swirling Storm world effect keeps its independent twenty-six-frame source atlas',()=>{
  const clip=battle.attackEffects['swirl-ring'].clips.default;
  assert.equal(clip.frames,26);assert.equal(clip.frameRate,1000/60);
  assert.ok(clip.frames>24);
  for(const layer of clip.layers){
    const png=readFileSync(sourceAssetPath(layer.file));
    const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
    assert.equal(width%clip.frameWidth,0);assert.equal(height%clip.frameHeight,0);
    const columns=width/clip.frameWidth,rows=height/clip.frameHeight;
    assert.ok(columns*rows>=clip.frames);assert.ok(columns*(rows-1)<clip.frames);
  }
  assert.equal(action.events.filter(event=>event.kind==='impact').length,1);
});
