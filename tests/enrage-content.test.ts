import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {needsTarget} from '../src/domain/skill-action.ts';
import {parseBattle} from '../src/application/content-validation.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=battle.skills.enrage;

test('Enrage exports eight independent health-limit modifiers and application operations',()=>{
  const unit=skill.action!.combatUnits![0];if(unit.effect!=='buff')throw new Error('missing Enrage buff');
  assert.equal(unit.buff,'enrage');
  assert.deepEqual(unit.ranks.map(rank=>rank.strength),[2002,2004,2006,2009,2010,2011,2012,2013]);
  const speed=[260,300,340,400,420,440,460,480],health=[160,240,320,440,480,520,560,600];
  unit.ranks.forEach((rank,index)=>{
    assert.equal(rank.chanceThreshold,1000);
    assert.deepEqual(rank.effect,{durationMs:9060,tickMs:0,simulationFrames:{lastActiveFrame:150},maxStacks:1,
      appearanceColors:[100,120,140,160,140,120,100].map(red=>({red,green:0,blue:0})),
      modifiers:[{attribute:'attackSpeedRate',operation:{kind:'add',amount:speed[index]}},
        {attribute:'maxHealth',operation:{kind:'increase-thousandth',ratePerThousand:health[index]}}],
      onApply:[{kind:'restore-health-from-max-health',operation:{kind:'increase-thousandth',ratePerThousand:health[index]}}],
      states:[],periodic:[]});
  });
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(28));
  assert.equal(skill.action!.cooldownFrames,450);assert.equal(needsTarget(skill.action!),false);
});

test('Enrage preserves its existing cast, actor frames, red cycle and dispatch feedback assets',()=>{
  assert.deepEqual(skill.action!.events,[
    {kind:'impact',frame:0,target:'self',effect:{effect:'armor-ember',recipient:'target',placement:'above-characters'}},
    {kind:'units',frame:7,cues:[{target:'self',targetRangePx:0,effects:[],targetSelection:'search'}],
      dispatch:{breaksStealth:true,casterEffects:[{effect:'aura-ring',recipient:'caster',placement:'attached'}],
        shake:true,vibrationMs:150,sound:'Wa_Boom'}},
  ]);
  const actor=battle.classes.find(character=>character.id==='warrior')!.actor;
  for(const facing of ['south','north','west','east'] as const)assert.equal(actor.clips[`skill-enrage-${facing}`]!.frames,23);
  for(const [name,frames]of [['armor-ember',17],['aura-ring',8]] as const){
    const clip=battle.attackEffects[name].clips.default;assert.equal(clip.frames,frames);
    for(const layer of clip.layers){const png=readFileSync(sourceAssetPath(layer.file));
      assert.equal(png.readUInt32BE(16),clip.frameWidth*frames);assert.equal(png.readUInt32BE(20),clip.frameHeight);}
  }
});

test('Application restoration requires its exact named resource behavior and operation operand',()=>{
  const data=structuredClone(battle),unit=data.skills.enrage.action!.combatUnits![0];
  if(unit.effect!=='buff')throw new Error('missing Enrage buff');
  const action=unit.ranks[0].effect.onApply![0] as unknown as Record<string,unknown>;
  action.kind='unknown-application';assert.throws(()=>parseBattle(data),/未知 kind/);
  action.kind='restore-health-from-max-health';action.operation={kind:'increase-thousandth'};
  assert.throws(()=>parseBattle(data),/ratePerThousand/);
  // 回魔是另一种具名行为：它只带定值，不再要求「按生命上限的某个运算」。
  delete action.operation;action.kind='add-mana';action.value=3;
  const parsed=parseBattle(data),applied=parsed.skills.enrage.action!.combatUnits![0];
  if(applied.effect!=='buff')throw new Error('missing Enrage buff');
  assert.deepEqual(applied.ranks[0]!.effect.onApply,[{kind:'add-mana',value:3}]);
});
