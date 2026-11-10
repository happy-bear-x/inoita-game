import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {passiveModifiers} from '../src/domain/passive-skills.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read('battle') as BattleCatalog,wardrobe=read('wardrobe') as WardrobeCatalog;
const skill=battle.skills.whist,action=skill.action!;
const ages=[90,105,135,165,165,180,180,195];
const rates=[736,870,1070,1336,1403,1470,1536,1603];
const accuracy=[230,290,380,500,530,560,590,620];

test('Whist exports every accepted rank as one complete stealth owner with independent ordered priorities',()=>{
  assert.equal(skill.kind,'active');assert.equal(action.combatUnits!.length,1);
  const unit=action.combatUnits![0];assert.ok(unit.effect==='buff');assert.equal(unit.buff,'whist');
  assert.deepEqual(unit.ranks.map(rank=>rank.strength),[101,103,106,110,111,112,113,114]);
  for(const [index,rank] of unit.ranks.entries()){
    const age=ages[index],effect=rank.effect;
    assert.equal(rank.chanceThreshold,1000);assert.equal(effect.maxStacks,1);
    assert.deepEqual(effect.simulationFrames,{lastActiveFrame:age});assert.equal(effect.durationMs,(age+1)*60);
    assert.deepEqual(effect.states,['stealthed']);
    assert.deepEqual(effect.stateDurationProfiles!.stealthed,{
      normal:{lastActiveFrame:Math.trunc(age*1.5)},targetShortened:{lastActiveFrame:Math.trunc((age>>1)*1.5)},
      buffShortened:{lastActiveFrame:Math.trunc((age>>1)*1.5)},
      buffAndTargetShortened:{lastActiveFrame:Math.trunc((age>>2)*1.5)},
    });
    assert.deepEqual(effect.modifiers,[{attribute:'stealthDamageRate',operation:{kind:'add',amount:rates[index]}},
      {attribute:'stealthAttackEnabled',operation:{kind:'set',amount:1}}]);
    assert.deepEqual(effect.invalidatesAttributes,['criticalRate','assassinSwordHitAdjustment']);
    assert.deepEqual(effect.periodic,[]);assert.equal(effect.tickMs,0);
    assert.equal(effect.applicationEffect,undefined);assert.equal(effect.loopEffects,undefined);
    assert.equal(effect.appearanceColors,undefined);
  }
});

test('Whist retains its no-target second-frame dispatch, resource costs and sixteen-frame source pose',()=>{
  assert.equal(action.requiresTarget,false);assert.equal(action.cooldownFrames,180);
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(24));
  assert.deepEqual(action.events,[{kind:'units',frame:2,cues:[{target:'self',targetRangePx:0,effects:[],targetSelection:'search'}],
    dispatch:{breaksStealth:false,casterEffects:[{effect:'smoke-puff',recipient:'caster',placement:'attached'}],sound:'A_Skill_05'}}]);
  const actor=battle.classes.find(row=>row.id==='assassin')!.actor;
  for(const facing of ['north','south','east','west'] as const){
    const clip=`skill-whist-${facing}` as const;
    assert.equal(actor.clips[clip]!.frames,16);
    const poseId=wardrobe.skills.assassin[clip];assert.ok(poseId);
    const pose=wardrobe.poses[poseId];assert.equal(pose.frames.length,16);
    for(const frame of pose.frames.slice(11))assert.deepEqual(frame,pose.frames[10]);
    for(const stance of Object.values(wardrobe.skillStances.assassin)){
      const override=stance.actions.whist;if(override)assert.deepEqual(override.events,action.events);
    }
  }
});

test('learning the active skill supplies its own constant assassination accuracy without casting or sharing actor ranks',()=>{
  assert.deepEqual(skill.passiveUnits,[{attribute:'assassinSwordHitAdjustment',condition:'always',
    ranks:accuracy.map(amount=>({kind:'add',amount}))}]);
  for(let rank=1;rank<=8;rank++)for(const weapon of ['','dagger','longsword','two-handed','staff']){
    const loadout={levels:{whist:rank}};
    assert.deepEqual(passiveModifiers(battle,'assassin',loadout,weapon),[
      {attribute:'assassinSwordHitAdjustment',operation:{kind:'add',amount:accuracy[rank-1]}}]);
  }
  assert.deepEqual(passiveModifiers(battle,'assassin',{levels:{}},'dagger'),[]);
  assert.deepEqual(passiveModifiers(battle,'warrior',{levels:{whist:8}},'dagger'),[]);
  assert.deepEqual(passiveModifiers(battle,'assassin',{levels:{whist:1}},'dagger'),[
    {attribute:'assassinSwordHitAdjustment',operation:{kind:'add',amount:230}}]);
});

test('smoke preserves its six source frames and uses feet attachment with a character-owned lifetime',()=>{
  const smoke=battle.attackEffects['smoke-puff'];
  assert.equal(smoke.attachmentPoint,'feet');assert.equal(smoke.attachedLifetime,'character');
  for(const clip of Object.values(smoke.clips)){
    assert.equal(clip.frames,6);assert.equal(clip.frameWidth,40);assert.equal(clip.frameHeight,62);
    for(const layer of clip.layers){
      const png=readFileSync(sourceAssetPath(layer.file));
      assert.equal(png.readUInt32BE(16),clip.frameWidth*clip.frames);assert.equal(png.readUInt32BE(20),clip.frameHeight);
    }
  }
  assert.equal(Object.entries(battle.attackEffects).filter(([,effect])=>effect.attachedLifetime==='character').length,1);
});
