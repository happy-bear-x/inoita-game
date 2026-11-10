import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read('battle') as BattleCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const skill=battle.skills['weapon-hitback'],action=skill.action!,units=action.combatUnits!;

test('Weapon Hitback preserves eight physical formulas and expands independent single-layer priorities',()=>{
  assert.deepEqual(units.map(unit=>unit.effect),['physical','buff']);
  const damage=units[0],buff=units[1];assert.ok(damage.effect==='physical'&&buff.effect==='buff');
  assert.equal(damage.source,'physicalAttack');
  assert.deepEqual(damage.attributeWeights,{strength:10,dexterity:12,vitality:0,intelligence:0,mentality:0});
  assert.deepEqual(damage.ranks,[2500,2700,2900,3100,3200,3300,3400,3500].map(ratePerThousand=>({
    fixedAddition:0,operation:{kind:'multiply-thousandth',ratePerThousand}})));
  assert.deepEqual(damage.ranks.map((_,index)=>actionDamage(damage,index+1,{physicalAttack:101,magicAttack:203,
    bestNormalDamage:203,maxHealth:1000,primaryAttributes:{strength:11,dexterity:17,vitality:0,intelligence:0,mentality:0}})),
    [330,356,382,409,422,435,448,462]);
  assert.deepEqual(buff.ranks.map(rank=>rank.strength),[4003,4005,4007,4009,4010,4011,4012,4013]);
  for(const rank of buff.ranks){
    assert.equal(rank.chanceThreshold,1000);
    assert.deepEqual(rank.effect,{durationMs:3660,tickMs:0,states:[],simulationFrames:{lastActiveFrame:60},maxStacks:1,
      modifiers:['physicalAttack','magicAttack'].map(attribute=>({attribute,operation:{kind:'multiply-thousandth',ratePerThousand:500}})),periodic:[]});
  }
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(44));assert.equal(action.cooldownFrames,120);
});

test('Weapon Hitback releases without a target and retains two distinct post-dispatch waves',()=>{
  assert.equal(action.requiresTarget,false);assert.equal(action.charge,undefined);
  assert.deepEqual(action.events.map(event=>[event.kind,event.frame]),[['units',2],['swing',2],['impact',2]]);
  const [direct,swing,impact]=action.events;assert.ok(direct.kind==='units'&&swing.kind==='swing'&&impact.kind==='impact');
  assert.deepEqual(direct.cues.map(cue=>[cue.target,cue.targetRangePx,cue.targetRangeMetric,cue.targetSelection]),[
    ['area',40,'octagonal-grid','search'],['area',40,'octagonal-grid','reuse-previous']]);
  assert.ok(direct.cues.every(cue=>cue.effects.length===0));
  assert.deepEqual(direct.dispatch,{breaksStealth:true,sound:'Wa_Defense'});
  assert.deepEqual(swing.effects,[{effect:'hitback-wave',recipient:'caster',placement:'above-characters'}]);
  assert.equal(impact.target,'self');
  assert.deepEqual(impact.effect,{effect:'hitback-wave',recipient:'target',placement:'above-characters'});
});

test('all existing weapon stances share the thirteen-frame pose and original five-frame wave assets',()=>{
  const warrior=battle.classes.find(entry=>entry.id==='warrior')!;
  for(const facing of ['north','south','east','west'] as const){
    const key=`skill-weapon-hitback-${facing}` as const;
    assert.equal(warrior.actor.clips[key]!.frames,13);
    const pose=wardrobe.skills.warrior[key];assert.ok(pose);
    const frames=wardrobe.poses[pose].frames;assert.equal(frames.length,13);
    for(const frame of frames.slice(8))assert.deepEqual(frame,frames[7]);
    for(const stance of Object.values(wardrobe.skillStances.warrior)){
      assert.equal(stance.actions['weapon-hitback'],undefined);assert.equal(stance.poses[key],undefined);
    }
  }
  for(const clip of Object.values(battle.attackEffects['hitback-wave'].clips)){
    assert.equal(clip.frames,5);assert.equal(clip.frameRate,1000/60);
    for(const layer of clip.layers){
      const png=readFileSync(sourceAssetPath(layer.file));
      assert.equal(png.readUInt32BE(16),clip.frameWidth*clip.frames);assert.equal(png.readUInt32BE(20),clip.frameHeight);
    }
  }
});
