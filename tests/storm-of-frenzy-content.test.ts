import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {parseBattle,parseWardrobe} from '../src/application/content-validation.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const wardrobe=JSON.parse(readFileSync(new URL('../public/content/wardrobe.json',import.meta.url),'utf8')) as WardrobeCatalog;

test('Storm of Frenzy exports all eight parent ranks and their own five-layer party power',()=>{
  const skill=battle.skills['storm-of-frenzy'],unit=skill.action!.combatUnits![0];
  if(unit.effect!=='buff')throw new Error('missing parent buff');
  assert.equal(unit.buff,'storm-of-frenzy');
  assert.deepEqual(unit.ranks.map(rank=>rank.strength),[4003,4005,4007,4009,4010,4011,4012,4013]);
  assert.equal(skill.action!.cooldownFrames,450);
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(28));
  const ages=[90,105,120,135,135,150,150,165],chances=[150,170,190,210,220,230,240,250];
  unit.ranks.forEach((rank,index)=>{
    assert.equal(rank.chanceThreshold,1000);
    assert.deepEqual(rank.effect,{durationMs:(ages[index]+1)*60,tickMs:0,states:[],periodic:[],
      simulationFrames:{lastActiveFrame:ages[index]},maxStacks:1,
      modifiers:[{attribute:'offhandAttackChance',operation:{kind:'add',amount:chances[index]}}],
      reactions:[{kind:'physical-success-party',buff:{key:'storm-of-frenzy-power',rankPriority:[4003,4005,4007,4009,4010,4011,4012,4013][index],
        effect:{durationMs:1860,tickMs:0,simulationFrames:{lastActiveFrame:30},maxStacks:5,
          modifiers:[{attribute:'physicalDamageRate',operation:{kind:'add',amount:80}},
            {attribute:'magicDamageRate',operation:{kind:'add',amount:80}}],states:[],periodic:[]}}}]});
  });
  assert.equal(skill.reactionsByRank,undefined);
  const event=skill.action!.events.find(event=>event.kind==='units');
  assert.equal(event?.frame,7);
  if(event?.kind!=='units')throw new Error('missing dispatch');
  assert.deepEqual(event.dispatch,{breaksStealth:true,casterEffects:[
    {effect:'crimson-wings',recipient:'caster',placement:'attached'},
    {effect:'aura-ring',recipient:'caster',placement:'attached'}],shake:true,vibrationMs:150,sound:'Wa_Storm'});
});

test('Dual-wield costume recipes retain first-strike cycle bounds and two distinct strike times',()=>{
  assert.equal(Object.keys(wardrobe.dualWieldAttacks!).length,16);
  for(const [key,attack]of Object.entries(wardrobe.dualWieldAttacks!)){
    const fast=key.startsWith('dagger:'),frames=fast?[1,3]:[2,5];
    assert.deepEqual(attack.strikes,[{frame:frames[0],hand:'main-hand'},{frame:frames[1],hand:'offhand'}]);
    assert.equal(attack.strikeFrame,frames[0]);assert.equal(attack.swingFrame,fast?0:1);
    assert.deepEqual(attack.dispatch,{breaksStealth:true});
    assert.equal(attack.damage.source,'physicalAttack');assert.deepEqual(attack.damage.ranks,[{fixedAddition:0,operation:{kind:'add',amount:0}}]);
    assert.deepEqual(attack.swings,[fast?'dual-dagger-swing':'dual-blade-swing']);
    for(const facing of ['south','north','west','east'] as const){
      const pose=wardrobe.poses[wardrobe.stances[key][attack.clips[facing]]!];
      assert.equal(pose.frames.length,fast?5:7);
      assert.equal(pose.mirrorX,facing==='east');
    }
  }
  assert.equal(wardrobe.dualWieldAttacks!['longsword:shield'],undefined);
  for(const [name,frames]of [['dual-dagger-swing',4],['dual-blade-swing',6]] as const)
    for(const clip of Object.values(battle.attackEffects[name].clips)){
      assert.equal(clip.frames,frames);
      for(const layer of clip.layers){const bytes=readFileSync(sourceAssetPath(layer.file));
        assert.equal(bytes.readUInt32BE(16),clip.frameWidth*frames);assert.equal(bytes.readUInt32BE(20),clip.frameHeight);}
    }
});

test('Storm child definitions and dual-wield pose references are validated',()=>{
  const invalid=structuredClone(battle),unit=invalid.skills['storm-of-frenzy'].action!.combatUnits![0];
  if(unit.effect!=='buff')throw new Error('missing buff');
  const reaction=unit.ranks[0].effect.reactions![0];assert.ok('buff' in reaction);
  reaction.buff.rankPriority=0;
  assert.throws(()=>parseBattle(invalid),/rankPriority/);
  const missing=structuredClone(wardrobe);delete missing.stances['dagger:dagger']['dual-quick-attack-north'];
  assert.throws(()=>parseWardrobe(missing),/双持人物动作缺失/);
  const swapped=structuredClone(wardrobe);swapped.dualWieldAttacks!['dagger:dagger'].strikes![0].hand='offhand';
  assert.throws(()=>parseWardrobe(swapped),/双持出手顺序无效/);
});


test('Every eligible companion has both actual static dual-wield animation bindings',()=>{
  const companions=JSON.parse(readFileSync(new URL('../public/content/companions.json',import.meta.url),'utf8'));
  const world=JSON.parse(readFileSync(new URL('../public/content/world.json',import.meta.url),'utf8'));
  const actors=new Set<string>();
  for(const definition of Object.values(companions.definitions) as {classId:string;actor:string}[]){
    if(!['assassin','warrior'].includes(definition.classId))continue;
    actors.add(definition.actor);
    for(const [stance,frames]of [['dagger:dagger',5],['longsword:dagger',7]] as const){
      const profile=wardrobe.dualWieldAttacks![stance];
      for(const facing of ['south','north','west','east'] as const){
        const clip=world.actors[definition.actor].clips[profile.clips[facing]];
        assert.ok(clip,`${definition.actor}/${profile.clips[facing]}`);assert.equal(clip.frames,frames);
        assert.equal(clip.mirrorX,facing==='east');
        for(const layer of clip.layers){
          const bytes=readFileSync(sourceAssetPath(layer.file));
          assert.equal(bytes.readUInt32BE(16),clip.frameWidth*frames);assert.equal(bytes.readUInt32BE(20),clip.frameHeight);
        }
      }
    }
  }
  assert.ok(actors.size>=10);
});
