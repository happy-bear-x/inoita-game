import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BattleBuffEffect,BattleCatalog} from '../src/domain/battle.ts';
import {calculateCharacter,effectiveCharacterPanel,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import type {ItemCatalog,ItemInstance} from '../src/domain/items.ts';
import {passiveModifiers,type PassiveModifier} from '../src/domain/passive-skills.ts';
import {rollPhysicalHit,type PhysicalFighter} from '../src/domain/physical-hit.ts';
import {hasOffhandShield} from '../src/domain/wardrobe.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const catalog=read('battle') as BattleCatalog,items=read('items') as ItemCatalog,stats=read('character-stats') as CharacterStatsCatalog;
const entry=(item:string):ItemInstance=>({id:item,item,quantity:1,enhancement:0,gems:[]});
const shieldAmounts=[70,90,110,130,140,150,160,170],apostleAmounts=[125,145,165,195,205,215,225,235];
const base:PhysicalFighter={level:10,physicalAttack:1000,defense:260,defenseRate:0,physicalResistance:500,magicResistance:200,
  hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,criticalResistance:0,criticalDamage:0,
  criticalDamageResistance:0,weaponBlock:0,shieldBlock:0};
const divineArms=(rank:number,weapon:string)=>passiveModifiers(catalog,'priest',{levels:{'divine-arms':rank}},weapon);
const apostleUnit=catalog.skills['apostles-of-light'].action!.combatUnits![0] as {effect:'buff';ranks:{strength:number;effect:BattleBuffEffect}[]};
const apostle=(rank:number):BattleBuffEffect=>apostleUnit.ranks[rank-1]!.effect;
const fighter=(conditions:CombatConditions,passives:ReturnType<typeof divineArms>,offhandShield:boolean)=>
  conditions.fighter('owner',base,passives,{offhandShield});

test('shield block only survives while the real offhand is a shield',()=>{
  const conditions=new CombatConditions();
  for(let rank=1;rank<=8;rank++)for(const weapon of ['mace','sword','unarmed']){
    const amount=shieldAmounts[rank-1];
    assert.deepEqual(divineArms(rank,weapon).filter(modifier=>modifier.attribute==='shieldBlock'),
      [{attribute:'shieldBlock',operation:{kind:'add',amount}}]);
    assert.equal(fighter(conditions,divineArms(rank,weapon),true).shieldBlock,amount);
    assert.equal(fighter(conditions,divineArms(rank,weapon),false).shieldBlock,0);
  }
});

test('the mace conditions still decide hit and critical independently of the shield',()=>{
  const conditions=new CombatConditions(),rank=3,amount=110;
  const maceShield=fighter(conditions,divineArms(rank,'mace'),true);
  assert.equal(maceShield.shieldBlock,amount);assert.equal(maceShield.hitBonus,1030);assert.equal(maceShield.criticalRate,amount);
  const maceOnly=fighter(conditions,divineArms(rank,'mace'),false);
  assert.equal(maceOnly.shieldBlock,0);assert.equal(maceOnly.hitBonus,1030);assert.equal(maceOnly.criticalRate,amount);
  const swordShield=fighter(conditions,divineArms(rank,'sword'),true);
  assert.equal(swordShield.shieldBlock,amount);assert.equal(swordShield.hitBonus,1000);assert.equal(swordShield.criticalRate,0);
  const unarmed=fighter(conditions,divineArms(rank,'unarmed'),false);
  assert.equal(unarmed.shieldBlock,0);assert.equal(unarmed.hitBonus,1000);assert.equal(unarmed.criticalRate,0);
});

test('apostles of light keeps its divine strike chance without a shield',()=>{
  const conditions=new CombatConditions();
  for(let rank=1;rank<=8;rank++){
    const effect=apostle(rank),amount=apostleAmounts[rank-1];
    assert.equal(effect.simulationFrames?.lastActiveFrame,300);
    assert.deepEqual(effect.modifiers,[{attribute:'divineStrikeChance',operation:{kind:'add',amount}},
      {attribute:'shieldBlock',operation:{kind:'add',amount}}]);
    conditions.applyBuff('owner','apostles-of-light',1000+rank,effect);
    assert.equal(fighter(conditions,[],true).shieldBlock,amount);
    assert.equal(conditions.attribute('owner','divineStrikeChance',0),amount);
    const blocked=fighter(conditions,[],false);
    assert.equal(blocked.shieldBlock,0);
    assert.equal(conditions.attribute('owner','divineStrikeChance',0),amount);
    conditions.removeBuff('owner','apostles-of-light');
  }
});

test('the skill passive and the buff add shield block once each',()=>{
  const conditions=new CombatConditions(),rank=4;
  conditions.applyBuff('owner','apostles-of-light',1004,apostle(rank));
  assert.equal(fighter(conditions,divineArms(rank,'mace'),true).shieldBlock,shieldAmounts[rank-1]+apostleAmounts[rank-1]);
  assert.equal(fighter(conditions,divineArms(rank,'mace'),false).shieldBlock,0);
});

test('the character panel reports the real offhand shield and the wardrobe keeps its costume fallback',()=>{
  const panel=(offhand?:string)=>calculateCharacter(stats,items,'priest',10,
    {strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0},offhand?{'off-hand':entry(offhand)}:{});
  assert.equal(panel('wooden-shield').offhandShield,true);
  assert.equal(panel('short-sword').offhandShield,false);
  assert.equal(panel().offhandShield,false);
  assert.equal(panel('wooden-shield').shieldBlock>0,true);
  assert.equal(hasOffhandShield(items,{'off-hand':'wooden-shield'}),true);
  assert.equal(hasOffhandShield(items,{'off-hand':'short-sword'}),false);
  assert.equal(hasOffhandShield(items,{}),false);
  assert.equal(hasOffhandShield(items,{},true),true);
});

test('an equipment shield-block roll without a real shield never reaches the panel',()=>{
  const zero={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
  const rolled:ItemInstance={...entry('crystal-ring'),numbers:{modifiers:[{stat:'shieldBlock',value:20}],gemModifiers:[],magicPercent:0,sockets:0,enhancementUses:0}};
  const panel=(equipment:Partial<Record<string,ItemInstance>>)=>calculateCharacter(stats,items,'priest',10,zero,equipment);
  const ringOnly=panel({ring:rolled});
  assert.equal(ringOnly.offhandShield,false);
  assert.equal(ringOnly.shieldBlock,0,'戒指词条加不出虚拟盾');
  const shieldOnly=panel({'off-hand':entry('wooden-shield')});
  assert.equal(panel({ring:rolled,'off-hand':entry('wooden-shield')}).shieldBlock,shieldOnly.shieldBlock+20);
  const shieldPassive:PassiveModifier={attribute:'shieldBlock',operation:{kind:'add',amount:30}};
  assert.equal(effectiveCharacterPanel(ringOnly,10,[shieldPassive]).shieldBlock,0);
  assert.equal(effectiveCharacterPanel({...ringOnly,offhandShield:true},10,[shieldPassive]).shieldBlock,30);
});

test('without a real shield accumulated shield block cannot produce a block outcome',()=>{
  const conditions=new CombatConditions();
  const target=conditions.fighter('owner',{...base,shieldBlock:300},[],{offhandShield:false});
  assert.equal(target.shieldBlock,0);
  for(let roll=0;roll<1000;roll++)assert.notEqual(rollPhysicalHit(base,target,()=>roll/1000).kind,'shield-block');
});
