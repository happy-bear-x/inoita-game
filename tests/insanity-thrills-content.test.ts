import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {ClipName,WorldIndex} from '../src/domain/content.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {CompanionCatalog} from '../src/domain/party.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {passiveModifiers} from '../src/domain/passive-skills.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read('battle') as BattleCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const world=read('world') as WorldIndex,companions=read('companions') as CompanionCatalog;
const chances=[170,230,270,290,310,330,350,370];
const variants={
  'frenzy-blade':{frames:8,strike:4,swing:3,effect:'sword-swing'},
  'frenzy-two-handed':{frames:12,strike:4,swing:4,effect:'heavy-swing'},
  'frenzy-dagger':{frames:5,strike:2,swing:2,effect:'dagger-swing'},
  'frenzy-staff':{frames:8,strike:7,swing:null,effect:null},
};
const facings=['north','south','east','west'] as const;

test('Insanity Thrills exports only its eight learned frenzy chance values',()=>{
  const skill=battle.skills['insanity-thrills'];
  assert.deepEqual(skill.passiveUnits,[{attribute:'frenzyAttackChance',condition:'always',ranks:chances.map(amount=>({kind:'add',amount}))}]);
  for(let i=0;i<8;i++)assert.deepEqual(passiveModifiers(battle,'warrior',{levels:{'insanity-thrills':i+1}},'longsword'),[
    {attribute:'frenzyAttackChance',operation:{kind:'add',amount:chances[i]}},
  ]);
  assert.deepEqual(passiveModifiers(battle,'warrior',{levels:{}},'longsword'),[]);
});

test('frenzy profiles preserve four fixed animations, source damage, area dispatch and post-strike swing order',()=>{
  const profiles=wardrobe.frenzyAttacks!;assert.equal(Object.keys(profiles).length,27);
  for(const [stance,attack]of Object.entries(profiles)){
    const prefix=attack.clips.south.slice(0,-6) as keyof typeof variants,expected=variants[prefix];assert.ok(expected);
    assert.equal(attack.timing,'fixed-animation');assert.equal(attack.cycleFrames,expected.frames);
    assert.equal(attack.strikeFrame,expected.strike);assert.equal(attack.swingFrame,expected.swing);
    assert.equal(attack.swingOrder,'after-strike');assert.deepEqual(attack.swings,expected.effect?[expected.effect]:[]);
    assert.deepEqual(attack.targeting,{target:'area',targetRangePx:32,targetRangeMetric:'octagonal-grid'});
    assert.deepEqual(attack.dispatch,{breaksStealth:true});assert.equal(attack.manaGemDrop,'weapon');assert.equal(attack.projectile,null);
    assert.deepEqual(attack.damage,{effect:'physical',source:'physicalAttack',
      attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},
      ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]});
    for(const facing of facings){
      const pose=wardrobe.poses[wardrobe.stances[stance][attack.clips[facing]]!];assert.ok(pose);assert.equal(pose.frames.length,expected.frames);
    }
    for(const effect of attack.swings)assert.ok(battle.attackEffects[effect]);
  }
});

test('frenzy uses the real staff condition and explicit no-animation waits for source definitions with no matching pose',()=>{
  const profiles=wardrobe.frenzyAttacks!;
  assert.equal(profiles['staff:empty'].clips.south,'frenzy-staff-south');
  assert.equal(profiles['unarmed:empty'].clips.south,'frenzy-blade-south');
  const items=read('items') as ItemCatalog;
  const kinds=new Set(Object.values(items.items).filter(item=>item.equipment?.slot==='main-hand'&&item.equipment.classes.includes('warrior')).map(item=>item.kind));
  for(const stance of Object.keys(wardrobe.stances)){
    const [main]=stance.split(':');
    if(kinds.has(main)||stance==='unarmed:empty')assert.ok(profiles[stance],stance);
  }
  for(const stance of ['orb:empty','bow:empty','crossbow:empty','unarmed:shield']){
    assert.equal(profiles[stance],undefined);assert.equal(wardrobe.frenzyWaitFrames?.[stance],128);
  }
});

test('every actual warrior companion has all four frenzy poses with valid source-sized PNG atlases',()=>{
  const actors=new Set(Object.values(companions.definitions).filter(member=>member.classId==='warrior').map(member=>member.actor));
  assert.ok(actors.size>0);
  for(const id of actors)for(const [prefix,expected]of Object.entries(variants))for(const facing of facings){
    const clip=world.actors[id].clips[`${prefix}-${facing}` as ClipName];assert.ok(clip,`${id}:${prefix}:${facing}`);
    assert.equal(clip.frames,expected.frames);assert.ok(clip.layers.length);
    for(const layer of clip.layers){
      const bytes=readFileSync(sourceAssetPath(layer.file));
      assert.equal(bytes.subarray(1,4).toString(),'PNG');
      const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
      assert.equal(width%clip.frameWidth,0);assert.equal(height%clip.frameHeight,0);
      assert.ok(width/clip.frameWidth*(height/clip.frameHeight)>=clip.frames);
    }
  }
});
