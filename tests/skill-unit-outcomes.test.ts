import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {CombatUnit,NumericCombatUnit} from '../src/domain/battle.ts';
import type {PhysicalFighter,PhysicalHit} from '../src/domain/physical-hit.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {resolveSkillUnitSequence} from '../src/domain/skill-unit-sequence.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const primary={strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0};
const damage=(effect:'physical'|'magic'='physical'):NumericCombatUnit=>({effect,source:'physicalAttack',attributeWeights:primary,
  ranks:[{fixedAddition:0,operation:{kind:'add',amount:0}}]});
const buff=(chanceThreshold=1000,strength=1):CombatUnit=>({effect:'buff',buff:'dark-strike',ranks:[{strength,chanceThreshold,
  effect:{durationMs:1000,tickMs:0,modifiers:[],states:[],periodic:[]}}]});
function fixture(){
  const fighter:PhysicalFighter={level:1,physicalAttack:100,hitBase:100,hitBonus:1000,evasionBase:0,evasionBonus:0,
    criticalRate:0,criticalResistance:0,criticalDamage:0,criticalDamageResistance:0,weaponBlock:0,shieldBlock:0,physicalResistance:0};
  const defender={...fighter},conditions=new CombatConditions(),hits:PhysicalHit[]=[],phases:string[]=[];
  const member={level:1,panel:{attributes:primary},player:{health:100,maxHealth:100,mana:0,maxMana:100},setHealth:()=>{}};
  const enemy={key:'enemy',definition:{},controller:{}};
  const host=Object.setPrototypeOf({hero:member,conditions,arena:[enemy],threat:{taunt:()=>phases.push('taunt'),state:()=>{}},pendingDefeats:new Set(),fallen:new Set(),
    roster:{isPresent:()=>true},
    memberOf:(id:string)=>id==='player'?member:undefined,partyFighter:()=>fighter,enemyFighter:()=>defender,
    actorAttribute:(_id:string,key:string)=>['physicalAttack','magicAttack','maxHealth'].includes(key)?100:0,
    actorAttributes:()=>({physicalAttack:100,magicAttack:100,maxHealth:100,physicalDamageRate:0,magicDamageRate:0,
      stealthDamageRate:0,primaryAttributes:primary}),combatant:()=>({position:{x:0,y:0}}),
    showHit:(_event:unknown,hit:PhysicalHit)=>hits.push(hit),settleHit:(_event:unknown,hit:PhysicalHit)=>hits.push(hit),
    resolveHitReactions:()=>phases.push('reactions'),dropMana:()=>{},resistsState:()=>false,
    syncCombatResourceLimits:()=>{},applyStateConsequences:()=>phases.push('state'),
  },WorldCombat.prototype);
  const run=(units:CombatUnit[],targets=(_index:number)=>['enemy'])=>resolveSkillUnitSequence(units,{
    targets,unit:(cueIndex,targetId)=>Reflect.get(WorldCombat.prototype,'skillUnit').call(host,
      {casterId:'player',targetId,cueIndex,skill:{id:'test',level:1,action:{combatUnits:units}}}),
  });
  return {host,fighter,defender,conditions,hits,phases,run};
}

test('real damage results gate later units, including positive physical and magic blocks',t=>{
  t.mock.method(Math,'random',()=>0.1);
  for(const kind of ['physical','magic'] as const)for(const outcome of ['miss','zero','hit','weapon-block','shield-block'] as const){
    if(kind==='magic'&&outcome==='weapon-block')continue;
    const f=fixture();
    if(outcome==='miss'){f.fighter.hitBonus=0;f.fighter.hitBase=0;f.defender.evasionBonus=750;}
    if(outcome==='zero'){f.defender.physicalResistance=1000;f.defender.magicResistance=1000;}
    if(outcome==='weapon-block')f.defender.weaponBlock=500;
    if(outcome==='shield-block')f.defender.shieldBlock=500;
    const result=f.run([damage(kind),buff(),{effect:'taunt'}]);
    const succeeds=outcome!=='miss'&&outcome!=='zero';
    assert.deepEqual(result.map(row=>row.outcome),succeeds?['success','success','success']:['failure','skipped','skipped'],`${kind}/${outcome}`);
    assert.equal(f.conditions.hasBuff('enemy','dark-strike'),succeeds);
    assert.equal(f.phases.includes('taunt'),succeeds);
    assert.equal(f.hits[0].kind,outcome==='zero'?'hit':outcome);
  }
});

test('chance failure consumes its roll, guaranteed weak buff rejection remains successful',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0.1;});
  const f=fixture();
  assert.deepEqual(f.run([buff(0),{effect:'taunt'}]).map(row=>row.outcome),['failure','skipped']);
  assert.equal(rolls,1);
  f.run([buff(1000,10)]);assert.equal(rolls,1);
  assert.deepEqual(f.run([buff(1000,1),{effect:'taunt'}]).map(row=>row.outcome),['success','success']);
  assert.equal(rolls,1);assert.equal(f.phases.at(-1),'taunt');
});

test('enemy damage immunity rejects before rolls and reactions; self buff remains allowed',t=>{
  t.mock.method(Math,'random',()=>assert.fail('immune entry must not draw'));
  const f=fixture();f.conditions.applyState('enemy','damage-immune',1000,'enemy');
  assert.deepEqual(f.run([damage(),buff()]).map(row=>row.outcome),['failure','skipped']);
  assert.deepEqual(f.hits,[{kind:'hit',damage:0}]);assert.deepEqual(f.phases,[]);
  f.conditions.applyState('player','damage-immune',1000,'player');
  assert.equal(f.run([buff()],()=>['player'])[0].outcome,'success');
});

test('state probability and rejection block following units, refreshing an accepted state succeeds',t=>{
  let rolls=0;t.mock.method(Math,'random',()=>{rolls++;return 0.1;});
  const f=fixture(),state:CombatUnit={effect:'state',state:'stun',ranks:[{chanceThreshold:0,durationMs:1000}]};
  assert.deepEqual(f.run([state,{effect:'taunt'}]).map(row=>row.outcome),['failure','skipped']);assert.equal(rolls,1);
  state.ranks[0].chanceThreshold=1000;f.host.arena[0].definition.stateRules={immuneStates:['stun']};
  assert.equal(f.run([state])[0].outcome,'failure');assert.equal(rolls,1);
  f.host.arena[0].definition.stateRules=undefined;
  assert.equal(f.run([state])[0].outcome,'success');
  assert.equal(f.run([state,{effect:'taunt'}])[1].outcome,'success');
});
