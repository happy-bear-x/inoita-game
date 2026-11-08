import assert from 'node:assert/strict';
import test from 'node:test';
import {CombatConditions,type ResourceCapacities,type ResourceCapacityKey} from '../src/domain/combat-conditions.ts';
import type {BattleBuffEffect} from '../src/domain/battle.ts';
import {applyCombatOperation} from '../src/domain/combat-operation.ts';

const ordinary:BattleBuffEffect={durationMs:120,tickMs:0,modifiers:[],states:[],periodic:[]};
const enrage:BattleBuffEffect={...ordinary,
  modifiers:[{attribute:'maxHealth',operation:{kind:'increase-thousandth',ratePerThousand:160}}],
  onApply:[{kind:'restore-health-from-max-health',operation:{kind:'increase-thousandth',ratePerThousand:160}}]};

function fixture(){
  const current={health:100,mana:100},base={maxHealth:1000,maxMana:200};
  const events:{kind:'capture'|'apply';capacity:ResourceCapacities;buffPresent:boolean}[]=[];
  const deltas:number[]=[],computations:ResourceCapacityKey[]=[];
  const conditions=new CombatConditions({
    captureResourceCapacities:actorId=>{
      const capacity={maxHealth:read('maxHealth'),maxMana:read('maxMana')};
      events.push({kind:'capture',capacity:{...capacity},buffPresent:conditions.hasBuff(actorId,'enrage')});
      return capacity;
    },
    onApply:(actorId,effect,entry)=>{
      events.push({kind:'apply',capacity:{...entry},buffPresent:conditions.hasBuff(actorId,'enrage')});
      for(const action of effect.onApply??[]){
        if(action.kind!=='restore-health-from-max-health')continue;
        const delta=applyCombatOperation(entry.maxHealth,action.operation)-entry.maxHealth;
        if(delta<=0)continue;
        const capacity=read('maxHealth');
        current.health=Math.max(0,Math.min(current.health+delta,capacity));deltas.push(delta);
      }
    }
  });
  function read(key:ResourceCapacityKey):number{
    return conditions.readResourceCapacity('actor',key,()=>{
      computations.push(key);
      const value=Math.max(0,conditions.attribute('actor',key,base[key]));
      if(key==='maxHealth')current.health=Math.min(current.health,value);else current.mana=Math.min(current.mana,value);
      return value;
    });
  }
  return {conditions,current,base,events,deltas,computations,read};
}

test('first buff initialization distinguishes an empty resource cache from an already read maximum',()=>{
  const dirty=fixture();dirty.conditions.applyBuff('actor','enrage',1,enrage);
  assert.deepEqual(dirty.deltas,[185]);assert.equal(dirty.current.health,285);
  assert.deepEqual(dirty.events[0],{kind:'capture',capacity:{maxHealth:1160,maxMana:200},buffPresent:true});
  const warm=fixture();assert.equal(warm.read('maxHealth'),1000);
  warm.conditions.applyBuff('actor','enrage',1,enrage);
  assert.deepEqual(warm.deltas,[160]);assert.equal(warm.current.health,260);
  assert.equal(warm.read('maxHealth'),1160);
});

test('ordinary buff initialization warms both capacities while plain attribute projection does not',()=>{
  const projected=fixture();assert.equal(projected.conditions.attribute('actor','maxHealth',1000),1000);
  projected.conditions.applyBuff('actor','enrage',1,enrage);assert.deepEqual(projected.deltas,[185]);
  const warm=fixture();warm.conditions.applyBuff('actor','dark-strike',1,ordinary);
  assert.deepEqual(warm.computations,['maxHealth','maxMana']);
  warm.conditions.applyBuff('actor','enrage',1,enrage);assert.deepEqual(warm.deltas,[160]);
});

test('equal-strength refresh captures the linked old buff before unlink and the new buff before invalidation',()=>{
  const f=fixture();f.conditions.applyBuff('actor','enrage',2,enrage);
  f.events.length=0;f.deltas.length=0;f.computations.length=0;
  assert.equal(f.conditions.applyBuff('actor','enrage',2,enrage),true);
  assert.deepEqual(f.events,[
    {kind:'capture',capacity:{maxHealth:1160,maxMana:200},buffPresent:true},
    {kind:'capture',capacity:{maxHealth:1160,maxMana:200},buffPresent:true},
    {kind:'apply',capacity:{maxHealth:1160,maxMana:200},buffPresent:true}]);
  assert.deepEqual(f.deltas,[185]);assert.deepEqual(f.computations,['maxHealth','maxHealth']);
  f.events.length=0;f.computations.length=0;
  assert.equal(f.conditions.applyBuff('actor','enrage',1,enrage),false);
  assert.deepEqual(f.events,[]);assert.deepEqual(f.computations,[]);assert.deepEqual(f.deltas,[185]);
});

test('expiry captures while linked, invalidates afterward, and waits for the next real read to clamp',()=>{
  const f=fixture();f.conditions.applyBuff('actor','enrage',1,enrage);
  f.current.health=1150;f.events.length=0;f.deltas.length=0;
  f.conditions.update(120);
  assert.equal(f.conditions.hasBuff('actor','enrage'),false);
  assert.deepEqual(f.events,[{kind:'capture',capacity:{maxHealth:1160,maxMana:200},buffPresent:true}]);
  assert.deepEqual(f.deltas,[]);assert.equal(f.current.health,1150);
  assert.equal(f.conditions.attribute('actor','maxHealth',1000),1000);assert.equal(f.current.health,1150);
  assert.equal(f.read('maxHealth'),1000);assert.equal(f.current.health,1000);
});

test('only an explicit application restoration heals, including an active zero-health actor',()=>{
  const capacityOnly=fixture();capacityOnly.current.health=0;
  capacityOnly.conditions.applyBuff('actor','enrage',1,{...enrage,onApply:undefined});
  assert.equal(capacityOnly.read('maxHealth'),1160);assert.equal(capacityOnly.current.health,0);
  capacityOnly.conditions.applyBuff('actor','enrage',1,enrage);
  assert.equal(capacityOnly.current.health,185);
});

test('resource cache and semantic inputs survive deep-copy snapshots and invalidate only changed capacities',()=>{
  const f=fixture();f.conditions.setResourceCapacityInputs('actor','maxHealth',1000);
  f.conditions.setResourceCapacityInputs('actor','maxMana',200);
  f.read('maxHealth');f.read('maxMana');
  const state=f.conditions.captureState(),restored=fixture();restored.conditions.restoreState(state);
  state.resourceCapacities![0][1][0][1]=999;
  state.resourceCapacityInputs![0][1][0][1]=1500;
  restored.conditions.setResourceCapacityInputs('actor','maxHealth',1000);
  assert.equal(restored.read('maxHealth'),1000);assert.deepEqual(restored.computations,[]);
  restored.base.maxHealth=1100;restored.conditions.setResourceCapacityInputs('actor','maxHealth',1100);
  assert.equal(restored.read('maxHealth'),1100);assert.equal(restored.read('maxMana'),200);
  assert.deepEqual(restored.computations,['maxHealth']);
  const older=fixture(),oldState=f.conditions.captureState();delete oldState.resourceCapacities;delete oldState.resourceCapacityInputs;
  older.conditions.restoreState(oldState);older.read('maxHealth');assert.deepEqual(older.computations,['maxHealth']);
});

test('first semantic inputs preserve a valid zero cache and capacity invalidation clears temporary overrides',()=>{
  const conditions=new CombatConditions(),unexpected=()=>assert.fail('must use valid cached capacity');
  assert.equal(conditions.readResourceCapacity('actor','maxHealth',()=>0),0);
  conditions.setResourceCapacityInputs('actor','maxHealth',1000);
  assert.equal(conditions.readResourceCapacity('actor','maxHealth',unexpected),0);
  conditions.setTemporaryAttribute('actor','maxHealth',-5);
  assert.equal(conditions.readResourceCapacity('actor','maxHealth',unexpected),-5);
  conditions.setResourceCapacityInputs('actor','maxHealth',1100);
  assert.equal(conditions.readResourceCapacity('actor','maxHealth',()=>200),200);
  conditions.setTemporaryAttribute('actor','physicalAttack',12);conditions.clearTemporary('actor');
  assert.equal(conditions.readResourceCapacity('actor','maxHealth',unexpected),200);
  conditions.setTemporaryAttribute('actor','maxHealth',20);conditions.clearTemporary('actor');
  assert.equal(conditions.readResourceCapacity('actor','maxHealth',()=>300),300);
});

test('actor removal and world clearing discard capacities and their input history',()=>{
  const f=fixture();f.conditions.setResourceCapacityInputs('actor','maxHealth',1000);f.read('maxHealth');
  f.conditions.remove('actor');f.base.maxHealth=1300;
  assert.equal(f.read('maxHealth'),1300);
  f.conditions.setResourceCapacityInputs('actor','maxHealth',1200);
  assert.equal(f.read('maxHealth'),1300);assert.equal(f.computations.length,2);
  f.conditions.clear();f.base.maxHealth=1400;assert.equal(f.read('maxHealth'),1400);
});
