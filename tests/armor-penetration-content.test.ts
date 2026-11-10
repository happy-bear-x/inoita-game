import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {parseBattle} from '../src/application/content-validation.ts';
import {skillReactionEffects} from '../src/domain/skill-reactions.ts';
import {sourceAssetPath} from '../tools/asset-source.ts';

const data=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=data.skills['armor-penetration'];

test('Armor Penetration exports the parent chance separately from all eight learned child definitions',()=>{
  const parent=skill.action!.combatUnits![0];assert.equal(parent.effect,'buff');
  if(parent.effect!=='buff')throw new Error('missing parent buff');
  assert.equal(parent.buff,'armor-penetration');
  assert.deepEqual(skill.ranks.map(rank=>rank.manaCost),Array(8).fill(28));
  assert.equal(skill.action!.cooldownFrames,270);
  const chances=[260,300,340,400,420,440,460,480];
  assert.equal(skill.reactionsByRank!.length,8);
  parent.ranks.forEach((rank,index)=>{
    assert.equal(rank.chanceThreshold,1000);
    assert.deepEqual(rank.effect,{durationMs:10860,tickMs:0,states:[],
      simulationFrames:{lastActiveFrame:180},maxStacks:1,
      modifiers:[{attribute:'armorBreakChance',operation:{kind:'add',amount:chances[index]}}],periodic:[]});
    const reactions=skill.reactionsByRank![index];assert.equal(reactions.length,1);
    const reaction=reactions[0];assert.equal(reaction.kind,'armor-penetration');
    if(reaction.kind!=='armor-penetration')throw new Error('missing learned reaction');
    assert.equal(reaction.buff.key,'armor-break');assert.equal(reaction.buff.rankPriority,[2002,2004,2006,2009,2010,2011,2012,2013][index]);
    assert.deepEqual(reaction.buff.effect,{durationMs:3660,tickMs:0,states:[],
      simulationFrames:{lastActiveFrame:60},maxStacks:1,applicationEffect:'armor-break-impact',
      modifiers:[{attribute:'defense',operation:{kind:'multiply-thousandth',ratePerThousand:0}},
        {attribute:'physicalResistanceBonus',operation:{kind:'multiply-thousandth',ratePerThousand:0}}],periodic:[]});
  });
});

test('Armor Break application uses the five-frame source effect and both exported compositing layers',()=>{
  assert.ok(skillReactionEffects(skill).includes('armor-break-impact'));
  const clip=data.attackEffects['armor-break-impact'].clips.default;
  assert.equal(clip.frames,5);assert.equal(clip.layers.length,2);
  for(const layer of clip.layers){
    const bytes=readFileSync(sourceAssetPath(layer.file));
    assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16),clip.frameWidth*clip.frames);
    assert.equal(bytes.readUInt32BE(20),clip.frameHeight);
  }
});

test('learned Armor Break requires its child key, all ranks and existing application asset',()=>{
  const copy=structuredClone(data),reactions=copy.skills['armor-penetration'].reactionsByRank!;
  const reaction=reactions[0];if(reaction[0].kind!=='armor-penetration')throw new Error('missing reaction');
  reaction[0].buff.effect.applicationEffect='missing-armor-impact';
  assert.throws(()=>parseBattle(copy),/missing-armor-impact/);
  reaction[0].buff.effect.applicationEffect='armor-break-impact';
  reaction[0].buff.key='armor-penetration';
  assert.throws(()=>parseBattle(copy),/armor-break/);
  reaction[0].buff.key='armor-break';reactions.pop();
  assert.throws(()=>parseBattle(copy),/触发效果必须覆盖全部技能等级/);
});
