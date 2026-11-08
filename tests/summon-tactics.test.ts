import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {SummonCombatAwareness,isHostileAction} from '../src/domain/summon-tactics.ts';
import type {Combatant} from '../src/domain/combat.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const player:Combatant={id:'player',team:'party',position:{x:32,y:32},bounds:{x:-4,y:-4,width:8,height:8}};
const monster:Combatant={...player,id:'monster',team:'hostile',position:{x:64,y:32}};

test('selection, friendly approach and self buff do not admit an unengaged enemy',()=>{
  const memory=new SummonCombatAwareness(0);
  memory.observe(600,[{actor:player,action:{state:'approaching',targetId:monster.id}},{actor:monster}]);
  assert.deepEqual(memory.tactics(player.id,[player.id],monster.id).engagedTargetIds,[]);
  memory.observe(1200,[{actor:player,action:{state:'attacking',skill:{id:'demon-s-shield',action:catalog.skills['demon-s-shield'].action!}}},{actor:monster}]);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[]);
  assert.equal(memory.quietFor(3000),3000);
});

test('untargeted hostile spells are combat, but their victims qualify only after actual contact',()=>{
  const memory=new SummonCombatAwareness(0),skill={id:'summon-hellfire',action:catalog.skills['summon-hellfire'].action!};
  assert.equal(isHostileAction({skill}),true);
  memory.observe(1200,[{actor:player,action:{state:'attacking',skill}},{actor:monster}]);
  assert.equal(memory.quietFor(1200),0);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[]);
  memory.contact(player,monster,1260);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[monster.id]);
});

test('actual attacks and hostile pursuit qualify targets and refresh the quiet timer',()=>{
  const memory=new SummonCombatAwareness(0);
  memory.observe(3000,[{actor:player},{actor:monster,chasingTargetId:player.id}]);
  assert.equal(memory.quietFor(3000),0);
  assert.deepEqual(memory.tactics(player.id,[player.id]).threats,[{enemyId:monster.id,targetId:player.id}]);
  memory.observe(3060,[{actor:player,action:{state:'attacking',targetId:monster.id}},{actor:monster}]);
  assert.equal(memory.tactics(player.id,[player.id]).ownerTargetId,monster.id);
  memory.observe(4860,[{actor:player},{actor:monster}]);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[monster.id]);
  memory.observe(4920,[{actor:player},{actor:monster}]);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[]);
  assert.deepEqual(memory.tactics(player.id,[player.id]).threats,[]);
  assert.equal(memory.quietFor(6060),3000);
});

test('friendly attacks admit the enemy without pretending that it is attacking its attacker',()=>{
  const memory=new SummonCombatAwareness(0);
  memory.contact(player,monster,60);
  assert.deepEqual(memory.tactics(player.id,[player.id]).threats,[]);
  memory.contact(monster,player,120);
  assert.equal(memory.tactics(player.id,[player.id]).threats.length,1);
  memory.observe(180,[{actor:player}]);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[monster.id],'敌人不在名单里，1.8 秒内仍算刚交战');
  memory.observe(1980,[{actor:player}]);
  assert.deepEqual(memory.tactics(player.id,[player.id]).engagedTargetIds,[],'超过 1.8 秒自然过期');
  assert.deepEqual(memory.tactics(player.id,[player.id]).threats,[]);
});

test('forget clears a removed enemy from every contact list',()=>{
  const memory=new SummonCombatAwareness(0);
  memory.contact(player,monster,60);
  memory.contact(monster,player,120);
  assert.equal(memory.tactics(player.id,[player.id]).ownerTargetId,monster.id);
  memory.forget(monster.id);
  const tactics=memory.tactics(player.id,[player.id]);
  assert.deepEqual(tactics.engagedTargetIds,[]);
  assert.deepEqual(tactics.threats,[]);
  assert.equal(tactics.ownerTargetId,undefined);
});
