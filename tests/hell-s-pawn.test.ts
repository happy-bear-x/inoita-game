import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog,SummonOwnerDerivation} from '../src/domain/battle.ts';
import {EnemyRoster} from '../src/domain/enemy-roster.ts';
import {SummonLifecycle} from '../src/domain/summon-lifecycle.ts';
import {summonOwnerStats} from '../src/domain/summon-stats.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const unit=catalog.skills['hell-s-pawn'].action!.combatUnits![0] as {
  effect:'summon';creature:string;ownerDerived:SummonOwnerDerivation;
  appearanceEffects:{effect:string;recipient:string;placement:string}[];
  ranks:{durationMs:number;simulationFrames?:{lastActiveFrame:number};attackRatePerThousand?:number}[]};
const frames=[180,240,330,450,480,510,540,570];
const rates=[1052,1152,1302,1502,1552,1602,1652,1702];

test('eight ranks keep the native lifetime input as frames and their magic attack rate',()=>{
  unit.ranks.forEach((rank,index)=>{
    assert.equal(rank.simulationFrames?.lastActiveFrame,frames[index],`rank ${index+1}`);
    assert.equal(rank.durationMs,(frames[index]+1)*60);
    assert.equal(rank.attackRatePerThousand,rates[index]);
  });
  assert.deepEqual(unit.ownerDerived,{attack:{attribute:'magicAttack',perLevel:4,flat:12},
    health:{perLevel:90,flat:800},physicalResistanceBonus:70,magicResistance:180});
  assert.deepEqual(unit.appearanceEffects,[{effect:'smoke-puff',recipient:'target',placement:'attached'},
    {effect:'slash-arc',recipient:'target',placement:'attached'}]);
  assert.equal(unit.creature,'enemy-hell-s-pawn-1');
});

test('the pawn derives attack, health and resistances from its owner level',()=>{
  assert.deepEqual(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},10),
    {magicAttack:54,maxHealth:1700,physicalResistanceBonus:70,magicResistance:180});
  assert.equal(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[7]},10).magicAttack,88);
  // 倍率本身不含 +1000：若按 2052 计算，10 级一级会得到 106 而不是 54。
  assert.notEqual(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:1052},10).magicAttack,106);
  assert.equal(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},1).magicAttack,16);
  assert.equal(summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},1).maxHealth,890);
});

test('a placed summon reports the derived stats over its own template',()=>{
  const definition=catalog.enemies.find(enemy=>enemy.id==='enemy-hell-s-pawn-1')!;
  const roster=new EnemyRoster(),placed=roster.placeEnemy(definition.id,0,0);
  placed.summonedBy='player';placed.level=10;
  const template=roster.enemySnapshot(placed.key,definition)!;
  placed.summonedStats=summonOwnerStats(unit.ownerDerived,{attackRatePerThousand:rates[0]},10);
  const derived=roster.enemySnapshot(placed.key,definition)!;
  assert.equal(derived.maxHealth,1700);assert.equal(derived.health,1700);
  assert.equal(derived.magicAttack,54);assert.equal(derived.physicalResistanceBonus,70);
  assert.equal(derived.magicResistance,180);
  assert.notEqual(template.maxHealth,derived.maxHealth);
  assert.equal(derived.physicalAttack,template.physicalAttack);
});

test('summoning clears every active summon of the same owner, not just the same skill',()=>{
  const removed:string[]=[];
  const summons=new SummonLifecycle();
  summons.register('player','a');summons.register('player','b');summons.register('ally','c');
  const host={summons,removeEnemy:(key:string)=>{removed.push(key);}};
  method('summonFactory').call(host).begin('player');
  assert.deepEqual(removed,['a','b']);
  assert.deepEqual(summons.capture(),[['player',[]],['ally',['c']]]);
});
