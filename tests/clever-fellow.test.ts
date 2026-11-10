import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['clever-fellow'];
const thresholds=[30,50,80,120,130,140,150,160];
const noBuff={random:()=>0,learnedBuff:()=>undefined};

test('eight ranks carry only the cooldown reset chance',()=>{
  assert.deepEqual(skill.passiveUnits,[]);
  skill.reactionsByRank!.forEach((rank,index)=>
    assert.deepEqual(rank,[{kind:'clever-fellow',chanceThreshold:thresholds[index]}],`rank ${index+1}`));
});

test('only a successful physical summon hit draws the chance and resets the owner cooldowns',()=>{
  const reactions=skill.reactionsByRank![0] as readonly SkillReaction[];
  const event={kind:'summon-physical-success',ownerId:'player',opponentId:'enemy',damageKind:'physical',outcome:'hit'} as const;
  assert.deepEqual(resolveSkillReactions(reactions,event,{random:()=>0,learnedBuff:()=>undefined}),
    [{kind:'reset-skill-cooldowns',targetId:'player'}]);
  // 阈值相等失败：抽到 30 时 30 不通过。
  assert.deepEqual(resolveSkillReactions(reactions,event,{random:()=>29/999,learnedBuff:()=>undefined}),[]);
  assert.deepEqual(resolveSkillReactions(reactions,{...event,outcome:'miss'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions(reactions,{...event,damageKind:'magic' as const},noBuff),[]);
  assert.deepEqual(resolveSkillReactions([{kind:'clever-fellow',chanceThreshold:0}],event,noBuff),[]);
});

test('the owner reaction runs after the summon taunt and uses the owners learned rank',t=>{
  t.mock.method(Math,'random',()=>0);
  const order:string[]=[];
  let version=0,draft:()=>{levels:Record<string,number>}=()=>({levels:{'clever-fellow':1}});
  const skills={get version(){return version;},draft:()=>draft()};
  const host=Object.setPrototypeOf({
    arena:[{key:'beast',summonedBy:'player',summonTauntChance:1000}],
    threat:{taunt:(source:string,target:string)=>order.push(`taunt:${source}->${target}`)},
    enemyTarget:()=>'ally',
    memberOf:(id:string)=>id==='player'?{classId:'ranger'}:undefined,
    resetActorCooldowns:(id:string)=>order.push(`cooldowns:${id}`),
    app:{battleCatalog:catalog,session:{skills}},
  },WorldCombat.prototype);
  method('summonOwnerReactions').call(host,{casterId:'beast',targetId:'enemy'},{kind:'hit',damage:5},'physical');
  assert.deepEqual(order,['taunt:beast->enemy','cooldowns:player']);

  order.length=0;
  draft=()=>({levels:{}});version++;
  method('summonOwnerReactions').call(host,{casterId:'beast',targetId:'enemy'},{kind:'hit',damage:5},'physical');
  assert.deepEqual(order,['taunt:beast->enemy'],'没学就不清冷却');
});
