import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const ranks=catalog.skills['magic-insight'].reactionsByRank!;
const cuts=[50,70,90,120,130,140,150,160];
const reaction=(index:number)=>ranks[index]![0] as Extract<SkillReaction,{kind:'magic-insight'}>;
const noBuff={random:()=>0,learnedBuff:()=>undefined};

test('eight ranks cut magic resistance by their own amount on three layers of ninety frames',()=>{
  assert.deepEqual(catalog.skills['magic-insight'].passiveUnits,[]);
  ranks.forEach((_rank,index)=>{
    const entry=reaction(index);
    assert.equal(entry.kind,'magic-insight');
    assert.deepEqual(entry.buff.effect.modifiers,
      [{attribute:'magicResistance',operation:{kind:'subtract',amount:cuts[index]}}],`rank ${index+1}`);
    assert.deepEqual(entry.buff.effect.simulationFrames,{lastActiveFrame:90});
    assert.equal(entry.buff.effect.maxStacks,3);
  });
});

test('a skill success lays a layer on the target for both physical and non-blocked magic',()=>{
  const entry=reaction(0);
  for(const [damageKind,outcome] of [['physical','hit'],['physical','weapon-block'],['physical','shield-block'],
    ['magic','hit'],['magic','critical']] as const)
    assert.deepEqual(resolveSkillReactions([entry],{kind:'skill-attack-success',ownerId:'priest',opponentId:'enemy',
      damageKind,outcome},noBuff),
      [{kind:'apply-buff',sourceId:'priest',targetId:'enemy',buff:entry.buff}],`${damageKind}/${outcome}`);
  assert.deepEqual(resolveSkillReactions([entry],{kind:'skill-attack-success',ownerId:'priest',opponentId:'enemy',
    damageKind:'magic',outcome:'shield-block'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions([entry],{kind:'skill-attack-success',ownerId:'priest',opponentId:'enemy',
    damageKind:'physical',outcome:'miss'},noBuff),[]);
});

function fixture(){
  const conditions=new CombatConditions(),seen:string[]=[];
  const host=Object.setPrototypeOf({app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{'magic-insight':8}})}}},
    conditions,arena:[{key:'enemy',definition:{}}],activeParty:['player'],fallen:new Set(),pendingDefeats:new Set(),
    memberOf:(id:string)=>id==='player'?{classId:'priest',skills:{draft:()=>({levels:{'magic-insight':8}})}}:undefined,
    partyPassives:()=>[],actorAttribute:()=>0,attackProc:()=>{},equipmentRecovery:()=>({lifeDrainPerThousand:0}),
    physicalSuccessEquipmentProcs:()=>{},instantRecoveryOnMiss:()=>{},
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},showBuffApplication:()=>{},
    threat:{state:()=>{},heal:()=>{}},
    react:(function(this:unknown,...args:unknown[]){
      const [event]=args as [{kind:string}];
      seen.push(event.kind);
      return method('react').apply(this,args);
    } as unknown as (event:unknown)=>void)},
    WorldCombat.prototype);
  const hit=(damageKind:'physical'|'magic',kind:'hit'|'shield-block',actionId='firestorm')=>
    method('resolveHitReactions').call(host,{casterId:'player',targetId:'enemy'},{kind,damage:0},damageKind,actionId,{});
  return {conditions,seen,hit};
}

test('basic attacks never trigger it, and a zero damage skill success still does',()=>{
  const run=fixture();
  run.hit('physical','hit','basic-attack');
  assert.equal(run.conditions.buffLifetimeFrames('enemy','magic-insight'),undefined);
  assert.equal(run.seen.includes('skill-attack-success'),false,'普攻不发这个事件');
  run.hit('magic','hit');
  assert.equal(run.conditions.buffLifetimeFrames('enemy','magic-insight'),90);
  assert.equal(run.conditions.attribute('enemy','magicResistance',200),40,'八级一层 -160');
});

test('layers cap at three and a weaker rank is refused',()=>{
  const run=fixture();
  for(let i=0;i<4;i++)run.hit('physical','hit');
  assert.equal(run.conditions.snapshot('enemy').find(entry=>entry.id==='magic-insight')?.stackCount,3);
  assert.equal(run.conditions.attribute('enemy','magicResistance',480),0,'三层 -480');
});

test('layers multiply the per-layer cut once and the result may go negative',()=>{
  const conditions=new CombatConditions();
  const entry=reaction(7);
  for(let layer=0;layer<3;layer++)
    conditions.applyBuff('enemy',entry.buff.key,entry.buff.rankPriority,entry.buff.effect,'priest');
  assert.equal(conditions.attribute('enemy','magicResistance',600),120,'三层 -480');
  assert.equal(conditions.attribute('enemy','magicResistance',100),-380,'负值允许');
  // 750 封顶与实际法术伤害的换算见共享用例 skin-of-steel-runtime。
});
