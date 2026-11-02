import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {BasicAttackDefinition, BattleCatalog} from '../src/domain/battle.ts';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import type {PhysicalFighter} from '../src/domain/physical-hit.ts';
import {actionDamage} from '../src/domain/action-damage.ts';
import {actionDamageSource} from '../src/domain/combat-damage-source.ts';
import {rollPhysicalHit, rollMagicHit} from '../src/domain/physical-hit.ts';
import {parseBattle, parseWardrobe} from '../src/application/content-validation.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read('battle') as BattleCatalog;
const wardrobe=read('wardrobe') as WardrobeCatalog;
const primaryAttributes={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const attributes={physicalAttack:100,magicAttack:200,physicalDamageRate:500,magicDamageRate:0,
  stealthDamageRate:0,maxHealth:1000,primaryAttributes};
const fighter:PhysicalFighter={level:10,physicalAttack:100,magicAttack:200,physicalDamageRate:500,
  magicDamageRate:0,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,criticalRate:0,
  criticalResistance:0,criticalDamage:1000,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};

function hit(attack:BasicAttackDefinition,source=attributes):number {
  const damage=actionDamage(attack.damage,1,actionDamageSource(source));
  const attacker={...fighter,physicalAttack:source.physicalAttack,magicAttack:source.magicAttack,
    physicalDamageRate:source.physicalDamageRate,magicDamageRate:source.magicDamageRate};
  return attack.damage.effect==='physical'
    ?rollPhysicalHit(attacker,fighter,()=>.9,damage).damage
    :rollMagicHit(attacker,fighter,damage,()=>.9).damage;
}

test('weapon attacks select max normal damage before their physical or magical hit multiplier',()=>{
  for(const stance of ['unarmed:empty','dagger:empty','longsword:empty','bow:empty','crossbow:empty']){
    const attack=wardrobe.attacks[stance];
    assert.equal(attack.damage.effect,'physical',stance);
    assert.equal(attack.damage.source,'bestNormalDamage',stance);
    assert.equal(hit(attack),300,stance);
  }
  for(const stance of ['staff:empty','orb:empty']){
    const attack=wardrobe.attacks[stance];
    assert.equal(attack.damage.effect,'magic',stance);
    assert.equal(attack.damage.source,'bestNormalDamage',stance);
    assert.equal(hit(attack),200,stance);
  }
  // A stronger physical candidate is boosted at both native stages.
  assert.equal(hit(wardrobe.attacks['longsword:empty'],{...attributes,magicAttack:0}),225);
  assert.equal(hit(wardrobe.attacks['staff:empty'],{...attributes,magicDamageRate:500}),450);
});

test('all melee combo steps keep the same best-normal damage formula',()=>{
  for(const id of ['dark-knight','assassin','priest','warrior']){
    const character=battle.classes.find(value=>value.id===id)!;
    const first=resolveBasicAttack(battle,character);
    assert.equal(first.stepCount,3,id);
    for(const step of [1,2]){
      const attack=resolveBasicAttack(battle,character,undefined,step);
      assert.deepEqual(attack.damage,first.damage,`${id}/${step}`);
      assert.equal(attack.damage.source,'bestNormalDamage',`${id}/${step}`);
      assert.equal(hit(attack),hit(first),`${id}/${step}`);
    }
  }
});

test('monster actions retain raw attack sources and the summoned soldier gets its own damage profile',()=>{
  const expectations=[
    ['enemy-oogle-1','magic','magicAttack',200],
    ['enemy-snake-1','magic','physicalAttack',100],
    ['enemy-scorpion-1','physical','bestNormalDamage',300],
    ['enemy-hell-s-pawn-1','magic','magicAttack',200],
  ] as const;
  for(const [id,effect,source,expected] of expectations){
    const enemy=battle.enemies.find(enemy=>enemy.id===id)!;
    const attack=battle.basicAttacks[enemy.basicAttack!.profileId];
    assert.equal(attack.damage.effect,effect,id);
    assert.equal(attack.damage.source,source,id);
    assert.equal(hit(attack),expected,id);
  }
  const pawn=battle.enemies.find(enemy=>enemy.id==='enemy-hell-s-pawn-1')!;
  const mosquito=battle.enemies.find(enemy=>enemy.id==='enemy-mosquito-1')!;
  assert.notEqual(pawn.basicAttack!.profileId,mosquito.basicAttack!.profileId);
});

test('attack damage is evaluated from the current actor at contact time',()=>{
  const attack=wardrobe.attacks['longsword:empty'];
  assert.equal(hit(attack,{...attributes,physicalAttack:50,magicAttack:0,physicalDamageRate:0}),50);
  assert.equal(hit(attack,{...attributes,physicalAttack:50,magicAttack:0,physicalDamageRate:1000}),200);
  assert.equal(hit(wardrobe.attacks['orb:empty'],{...attributes,magicAttack:400}),400);
});

test('content validation requires an explicit, single-rank physical or magical default-attack formula',()=>{
  for(const damage of [undefined,{...battle.basicAttacks['longsword-slash'].damage,effect:'heal'},
    {...battle.basicAttacks['longsword-slash'].damage,ranks:[]},
    {...battle.basicAttacks['longsword-slash'].damage,source:'native-113'}]){
    const invalid=read('battle');invalid.basicAttacks['longsword-slash'].damage=damage;
    assert.throws(()=>parseBattle(invalid),/damage/);
    const equipment=read('wardrobe');equipment.attacks['unarmed:empty'].damage=damage;
    assert.throws(()=>parseWardrobe(equipment),/damage/);
  }
});
