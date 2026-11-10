import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {parseBattle} from '../src/application/content-validation.ts';
import {skillReactionEffects} from '../src/domain/skill-reactions.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['blood-thirst'];

test('Blood Thirst has eight parent strengths, a live life-drain rate and a fixed chance without enabling mana recovery',()=>{
  const parent=skill.action!.combatUnits![0];if(parent.effect!=='buff')throw new Error('missing Blood Thirst buff');
  assert.equal(parent.buff,'blood-thirst');
  assert.deepEqual(parent.ranks.map(rank=>rank.strength),[101,103,106,110,111,112,113,114]);
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(24));
  assert.equal(skill.action!.cooldownFrames,450);
  const rates=[221,261,321,401,421,441,461,481];
  parent.ranks.forEach((rank,index)=>{
    assert.equal(rank.chanceThreshold,1000);
    assert.deepEqual(rank.effect,{durationMs:9060,tickMs:0,states:[],
      simulationFrames:{lastActiveFrame:150},maxStacks:1,
      modifiers:[{attribute:'bloodThirstLifeDrainPerThousand',operation:{kind:'add',amount:rates[index]}},
        {attribute:'bloodThirstChance',operation:{kind:'add',amount:200}}],periodic:[]});
  });
  assert.deepEqual(skill.reactionsByRank,Array.from({length:8},()=>[
    {kind:'blood-thirst',lifeEffect:'life-drain',manaEffect:'mana-recovery'},
  ]));
});

test('Blood Thirst preloads both original recovery palettes and every thirteen-frame mana layer',()=>{
  assert.deepEqual(skillReactionEffects(skill).sort(),['life-drain','mana-recovery']);
  const life=catalog.attackEffects['life-drain'].clips.default;
  const mana=catalog.attackEffects['mana-recovery'].clips.default;
  assert.equal(mana.frames,13);assert.equal(mana.layers.length,12);
  assert.deepEqual([mana.frameWidth,mana.frameHeight,mana.originX,mana.originY],
    [life.frameWidth,life.frameHeight,life.originX,life.originY]);
  for(const layer of mana.layers){
    const png=readFileSync(sourceAssetPath(layer.file));
    assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16),mana.frameWidth*mana.frames);
    assert.equal(png.readUInt32BE(20),mana.frameHeight);
    assert.equal(layer.blend,'backdrop');assert.deepEqual(layer.operations,['add']);
  }
});

test('Blood Thirst asset declarations require both effects and all learned ranks',()=>{
  const data=structuredClone(catalog),ranks=data.skills['blood-thirst'].reactionsByRank!;
  const reaction=ranks[0][0];if(reaction.kind!=='blood-thirst')throw new Error('missing reaction');
  delete data.attackEffects['mana-recovery'];
  assert.throws(()=>parseBattle(data),/mana-recovery/);
  data.attackEffects['mana-recovery']=catalog.attackEffects['mana-recovery'];
  (reaction as unknown as Record<string,unknown>).manaEffect='life-drain';
  assert.throws(()=>parseBattle(data),/mana-recovery/);
  reaction.manaEffect='mana-recovery';ranks.pop();
  assert.throws(()=>parseBattle(data),/触发效果必须覆盖全部技能等级/);
});
