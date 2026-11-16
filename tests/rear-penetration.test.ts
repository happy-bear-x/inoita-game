import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {PhysicalHit} from '../src/domain/physical-hit.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const rates=[100,140,180,240,260,280,300,320];

test('eight ranks carry the physical damage rate bonus and nothing else',()=>{
  const passive=catalog.skills['rear-penetration'].passiveUnits![0] as {attribute:string;ranks:{kind:string;amount:number}[]};
  assert.equal(passive.attribute,'rearPenetrationRate');
  assert.deepEqual(passive.ranks,rates.map(amount=>({kind:'add',amount})));
});

const physicalProfile=catalog.basicAttacks[catalog.classes[0]!.basicAttack.profileId]!;
const magicProfile=Object.values(catalog.basicAttacks).find(attack=>attack.damage.effect==='magic')!;

function fixture({rank=8,targetTarget='someone-else',magic=false}={}){
  const conditions=new CombatConditions(),hits:{damageKind:string;extra:number}[]=[];
  const host=Object.setPrototypeOf({app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{'rear-penetration':rank}})}}},
    roster:{isPresent:()=>true},
    conditions,arena:[{key:'enemy',definition:{basicAttack:{profileId:'a'},commandAction:undefined}}],
    activeParty:['caster'],fallen:new Set(),pendingDefeats:new Set(),
    memberOf:(id:string)=>id==='caster'?{classId:'assassin',skills:{draft:()=>({levels:{'rear-penetration':rank}})}}:undefined,
    partyPassives:()=>[],rearPenetrationBonus:(function(this:unknown,...args:unknown[]){
      return method('rearPenetrationBonus').apply(this,args);
    } as unknown as (...args:unknown[])=>number),
    actorAttribute:(_id:string,key:string)=>key==='rearPenetrationRate'?rates[rank-1]??0:0,
    actorAttributes:()=>({physicalAttack:100,magicAttack:100,maxHealth:100,physicalDamageRate:0,magicDamageRate:0,
      stealthDamageRate:0,primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}}),
    // 目标当前在打谁，就是这项技能唯一的条件。
    currentTargetOf:()=>targetTarget,
    enemyTarget:()=>targetTarget,
    partyControllers:new Map(),
    equipmentAttack:()=>magic?magicProfile:physicalProfile,
    visualOf:()=>({actor:{}}),memberBag:undefined,
    combatant:()=>({position:{x:0,y:0}}),
    partyFighter:()=>({level:1,physicalAttack:100,magicAttack:100,baseDefense:0,defense:0,defenseRate:0,maxHealth:100,
      hitBase:0,hitBonus:0,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
      criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0}),
    enemyFighter:()=>({level:1,physicalAttack:0,magicAttack:0,baseDefense:0,defense:0,defenseRate:0,maxHealth:100,
      hitBase:0,hitBonus:0,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
      criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0,magicResistance:0}),
    hero:{level:1},equipmentRecovery:()=>({lifeDrainPerThousand:0}),attackProc:()=>{},
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>{},showBuffApplication:()=>{},threat:undefined,
    resolveHitReactions:()=>{},dropMana:()=>{},summonOwnerReactions:()=>{},scene:{events:{emit:()=>{}}},allies:[]},
    WorldCombat.prototype);
  // attack-contact 处理器里读到的物理命中参数：把额外伤害率记下来即可判断有没有加成。
  Reflect.set(host,'settleHit',(_e:unknown,hit:PhysicalHit)=>hits.push({damageKind:magic?'magic':'physical',extra:hit.damage}));
  const contact=()=>method('attackContact').call(host,{casterId:'caster',targetId:'enemy'});
  return {contact,hits,conditions,host};
}

test('the bonus applies when the target is not attacking the attacker',t=>{
  t.mock.method(Math,'random',()=>0.99);
  const run=fixture({targetTarget:'someone-else'});
  run.contact();
  assert.equal(run.hits.length,1,'命中确实结算了');
  // 目标在打别人：额外伤害率 320‰ 生效，普攻基数 100 → 132。
  assert.equal(run.hits[0]!.extra,132);
});

test('the bonus disappears once the target turns on the attacker, and magic never gets it',t=>{
  t.mock.method(Math,'random',()=>0.99);
  const facing=fixture({targetTarget:'caster'});
  facing.contact();
  assert.equal(facing.hits[0]!.extra,100,'目标正在打攻击者就不加');
  const noTarget=fixture({targetTarget:undefined});
  noTarget.contact();
  assert.equal(noTarget.hits[0]!.extra,132,'目标没有目标也算');
  // 魔法根本不会去读这一项：直接看它有没有被调用。
  const spell=fixture({targetTarget:'someone-else',magic:true});
  let reads=0;
  Reflect.set(spell.host,'rearPenetrationBonus',()=>{reads++;return 320;});
  spell.contact();
  assert.equal(reads,0,'魔法不读背后渗透');
  const unlearned=fixture({rank:0,targetTarget:'someone-else'});
  unlearned.contact();
  assert.equal(unlearned.hits[0]!.extra,100,'没学就没有加成');
});
