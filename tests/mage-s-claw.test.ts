import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillReactions,type SkillReaction} from '../src/domain/skill-reactions.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=catalog.skills['mage-s-claw'];
const amounts=[1,2,3,4,4,5,5,5];
const noBuff={random:()=>0,learnedBuff:()=>undefined};

test('eight ranks carry the fixed mana amount and no passive modifier',()=>{
  assert.deepEqual(skill.passiveUnits,[]);
  skill.reactionsByRank!.forEach((rank,index)=>assert.deepEqual(rank,
    [{kind:'owner-mana-restore',effect:'mana-recovery',amount:amounts[index]}],`rank ${index+1}`));
});

test('physical and magic summon successes restore a fixed amount, blocked and missed ones do not',()=>{
  const rank=(index:number)=>skill.reactionsByRank![index] as readonly SkillReaction[];
  const event={kind:'summon-attack-success',ownerId:'warlock',opponentId:'enemy',outcome:'hit'} as const;
  for(const damageKind of ['physical','magic'] as const)
    assert.deepEqual(resolveSkillReactions(rank(7),{...event,damageKind},noBuff),
      [{kind:'restore-mana',targetId:'warlock',amount:5},
       {kind:'play-effect',targetId:'warlock',effect:'mana-recovery'}],damageKind);
  // 物理武器格挡算成功（与共用成功判定一致），魔法盾挡和落空都不算。
  assert.equal(resolveSkillReactions(rank(0),{...event,damageKind:'physical',outcome:'weapon-block'},noBuff).length,2);
  assert.deepEqual(resolveSkillReactions(rank(0),{...event,damageKind:'magic',outcome:'shield-block'},noBuff),[]);
  assert.deepEqual(resolveSkillReactions(rank(0),{...event,damageKind:'physical',outcome:'miss'},noBuff),[]);
  // 零值不执行。
  assert.deepEqual(resolveSkillReactions([{kind:'owner-mana-restore',effect:'mana-recovery',amount:0}],
    {...event,damageKind:'physical'},noBuff),[]);
  // 计算后 0 伤仍算成功，回魔不看伤害。
  assert.equal(resolveSkillReactions(rank(0),{...event,damageKind:'physical'},noBuff).length,2);
});

test('a summon that lands a magic skill hit reaches the same owner reaction',()=>{
  const order:string[]=[];
  const fighter={level:10,physicalAttack:100,magicAttack:100,baseDefense:0,defense:0,defenseRate:0,
    maxHealth:1000,maxMana:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,
    criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0};
  const unit={effect:'magic',source:'magicAttack',attributeWeights:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},
    ranks:[{fixedAddition:0,operation:{kind:'keep'}}]};
  const host=Object.setPrototypeOf({
    hero:{level:10},conditions:new CombatConditions(),pendingDefeats:new Set(),allies:[],
    roster:{isPresent:()=>true},
    arena:[{key:'pawn',summonedBy:'warlock',definition:{},visual:{}}],
    memberOf:(id:string)=>['warlock','player'].includes(id)
      ?{classId:'warlock',skills:{draft:()=>({levels:{'mage-s-claw':8}})}}:undefined,
    partyFighter:()=>fighter,enemyFighter:()=>fighter,actorAttributes:()=>fighter,actorAttribute:()=>100,
    combatant:()=>({position:{x:0,y:0}}),app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{}})}}},
    // 主人链现在归成功链管：这里按生产接线调用同一个方法。
    resolveHitReactions:(event:unknown,hit:PhysicalHit,damageKind:'physical'|'magic')=>
      method('summonOwnerReactions').call(host,event,hit,damageKind),
    settleHit:()=>{},dropMana:()=>{},showHit:()=>{},
    restoreMana:(id:string,amount:number)=>order.push(`mana:${id}+${amount}`),
    presenterFor:()=>({showEffects:()=>order.push('effect')}),
  },WorldCombat.prototype);
  const outcome=method('skillUnit').call(host,{casterId:'pawn',targetId:'player',cueIndex:0,
    skill:{id:'monster-hell-scream',level:1,action:{combatUnits:[unit]}}});
  assert.equal(outcome,'success');
  assert.deepEqual(order,['mana:warlock+5','effect']);
});

test('the owner gets the mana before the taunt, and each summon answers to its own owner',t=>{
  t.mock.method(Math,'random',()=>0);
  // 吸血脚爪是黑魔导的、完美配合是暗影猎手的，出厂内容里同一个主人不会同时有两条；
  // 这里给暗影猎手也挂上吸血脚爪，只为观察两者的先后。
  const data=structuredClone(catalog);
  data.classes.find(character=>character.id==='ranger')!.skills.push('mage-s-claw');
  const order:string[]=[];
  const member=(id:string,levels:Record<string,number>)=>({classId:id,skills:{draft:()=>({levels})}});
  const host=Object.setPrototypeOf({
    arena:[{key:'pawn',summonedBy:'warlock',summonTauntChance:1000},
           {key:'beast',summonedBy:'ranger',summonTauntChance:0}],
    threat:{taunt:(source:string)=>order.push(`taunt:${source}`)},
    enemyTarget:()=>'ally',
    memberOf:(id:string)=>id==='warlock'?member('warlock',{'mage-s-claw':8}):
      id==='ranger'?member('ranger',{'mage-s-claw':1,'clever-fellow':1}):undefined,
    restoreMana:(id:string,amount:number)=>order.push(`mana:${id}+${amount}`),
    presenterFor:()=>({showEffects:()=>order.push('effect')}),
    resetActorCooldowns:(id:string)=>order.push(`cooldowns:${id}`),
    app:{battleCatalog:data,session:{skills:{draft:()=>({levels:{}})}}},
  },WorldCombat.prototype);
  method('summonOwnerReactions').call(host,{casterId:'pawn',targetId:'enemy'},{kind:'hit',damage:9},'magic');
  // 黑魔导没学完美配合，所以只到回魔、表现、嘲讽三步。
  assert.deepEqual(order,['mana:warlock+5','effect','taunt:pawn']);
  order.length=0;
  // 暗影猎手的召唤物：回魔按自己的一级（+1），完美配合按自己的已学等级清自己的冷却。
  method('summonOwnerReactions').call(host,{casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.deepEqual(order,['mana:ranger+1','effect','cooldowns:ranger']);
});

test('召唤物命中的嘲讽阈值按主人当前等级重读，不冻结创建时的快照',t=>{
  const order:string[]=[];
  const levels:Record<string,number>={'beast-companion':8};
  const member={classId:'ranger',skills:{draft:()=>({levels:{...levels}})}};
  const host=Object.setPrototypeOf({
    // 创建时快照是 0（一级之外没记），主人现在是八级，原表阈值 170。
    arena:[{key:'beast',summonedBy:'ranger',summonTauntChance:0,summonedBySkill:'beast-companion'}],
    threat:{taunt:(source:string)=>order.push(`taunt:${source}`)},
    enemyTarget:()=>'ally',
    memberOf:(id:string)=>id==='ranger'?member:undefined,
    restoreMana:()=>{},presenterFor:()=>undefined,resetActorCooldowns:()=>{},
    app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{}})}}},
  },WorldCombat.prototype);
  const roll=(point:number)=>t.mock.method(Math,'random',()=>(point-0.5)/999);
  roll(99);
  method('summonOwnerReactions').call(host,{casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.deepEqual(order,['taunt:beast'],'99 低于八级阈值 170，应当嘲讽');
  order.length=0;
  levels['beast-companion']=1;
  roll(99);
  method('summonOwnerReactions').call(host,{casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.deepEqual(order,[],'降回一级后阈值 40，99 不再触发');
  delete levels['beast-companion'];
  roll(1);
  method('summonOwnerReactions').call(host,{casterId:'beast',targetId:'enemy'},{kind:'hit',damage:9},'physical');
  assert.deepEqual(order,[],'主人忘掉技能后不再嘲讽');
});
