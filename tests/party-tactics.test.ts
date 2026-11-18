import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { skillClips } from '../src/domain/skill-action.ts';
import { choosePartyAction } from '../src/domain/party-tactics.ts';
import type { PartyPort } from '../src/domain/party-ai.ts';
import type { Combatant } from '../src/domain/combat.ts';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';

const read=(name:string)=>JSON.parse(readFileSync(new URL('../public/content/'+name+'.json',import.meta.url),'utf8'));
const battle:BattleCatalog=read('battle'), companions:CompanionCatalog=read('companions');
const character=(id:string,team:string,x:number):Combatant=>({id,team,position:{x,y:80},bounds:{x:-8,y:-8,width:16,height:16}});
function fixture(...ids:string[]){
  const actor=character('mercenary','party',0), ally=character('leader','party',56);
  const enemy=character('enemy','enemy',48), second=character('second','enemy',780);
  const people=[actor,ally,enemy,second], vitals=new Map<string,{health:number;maxHealth:number;mana:number;maxMana:number}>();
  for(const person of [actor,ally])vitals.set(person.id,{health:100,maxHealth:100,mana:1000,maxMana:1000});
  const attackers=new Map<string,string>(),buffs=new Set<string>(), bosses=new Set<string>(),summons:Combatant[]=[];
  const skills=ids.map(id=>({id,name:id,clips:skillClips(id),level:1,frequency:1,manaCost:battle.skills[id].ranks[0].manaCost,action:battle.skills[id].action!}));
  const slots=()=>[actor,ally].map(actor=>({actor,hasDisplay:true,active:(vitals.get(actor.id)?.health??0)>0}));
  const port={
    skills:()=>skills,skillUses:(id:string)=>companions.autoSkills[id].uses,actor:(id:string)=>people.find(p=>p.id===id),
    targetOf:(id:string)=>attackers.get(id),attacking:(id:string)=>attackers.has(id),
    candidates:()=>people,attackRange:()=>11,partySlots:slots,
    healCandidates:()=>slots().map(slot=>({...slot,score:vitals.get(slot.actor.id)!.health})),
    isBoss:(id:string)=>bosses.has(id),ownedSummons:()=>summons,hasBuff:(id:string,buff:string)=>buffs.has(id+':'+buff),
    canSpendMana:(cost:number)=>vitals.get(actor.id)!.mana>=cost,vitals:(id:string)=>vitals.get(id)
  } satisfies Parameters<typeof choosePartyAction>[2];
  const choose=()=>choosePartyAction(actor,enemy,port,{skillReady:()=>true,canSelectSkill:()=>true});
  const skill=()=>{const action=choose();return action&&'skill' in action?action.skill.id:undefined;};
  return {actor,ally,enemy,second,vitals,attackers,buffs,bosses,summons,skills,port,choose,skill};
}

test('one ordinary target, a pack and an isolated boss favour different hunter actions',()=>{
  const h=fixture('rampage','multiple-shot');
  assert.equal(h.skill(),undefined);
  h.second.position.x=64;h.attackers.set('second','leader');
  assert.equal(h.skill(),'rampage');
  h.second.position.x=780;h.bosses.add('enemy');
  assert.equal(h.skill(),'multiple-shot');
  h.bosses.clear();h.skills[1].frequency=2;
  assert.equal(h.skill(),'multiple-shot');
  h.skills[1].frequency=0;
  assert.equal(h.skill(),undefined);
});

test('a warrior disarms an attacker at full party health; self block protects only its caster',()=>{
  const h=fixture('weapon-hitback','blade-deflection');
  h.enemy.position.x=32;h.attackers.set('enemy','leader');
  assert.equal(h.skill(),'weapon-hitback');
  h.attackers.set('enemy','mercenary');
  assert.equal(h.skill(),'blade-deflection');
  h.buffs.add('mercenary:blade-deflection');
  assert.equal(h.skill(),'weapon-hitback');
  h.buffs.add('enemy:weapon-hitback');
  assert.equal(h.skill(),undefined);
});

test('holy flash heals a group in one action; recovery plans a short rescue just outside true healing reach',()=>{
  const h=fixture('prayer-of-recovery','blinding-flash');
  h.vitals.get('leader')!.health=15;h.vitals.get('mercenary')!.health=25;
  assert.equal(h.skill(),'blinding-flash');
  h.vitals.get('mercenary')!.health=100;
  h.skills[1].frequency=0;h.ally.position.x=112;
  const action=h.choose();assert.ok(action&&'rescue' in action);
  assert.equal(action.rescue.id,'leader');assert.equal(action.range,11);
  // 正式治疗候选的取整边界；加成作用在选择治疗对象的范围上。
  const bonus:Pick<PartyPort,'rangeBonusUnits'>={rangeBonusUnits:()=>4};
  Object.assign(h.port,bonus);
  assert.equal(h.skill(),'prayer-of-recovery');
});

test('ordinary attacks preserve enough mana for recovery and release that reserve against a boss',()=>{
  const h=fixture('prayer-of-recovery','multiple-shot');
  h.skills[1].frequency=2;
  h.vitals.get('mercenary')!.mana=h.skills[1].manaCost;
  assert.equal(h.skill(),undefined);
  h.bosses.add('enemy');assert.equal(h.skill(),'multiple-shot');
  h.vitals.get('mercenary')!.mana=0;
  assert.equal(h.skill(),undefined);
});

test('self buffs and summons start only in usable range, even on high frequency with a focused boss',()=>{
  for(const id of ['molten-armor','beast-companion']){
    const h=fixture(id);h.skills[0].frequency=2;h.bosses.add('enemy');
    h.enemy.position.x=400;
    assert.equal(h.skill(),undefined);
    h.enemy.position.x=48;h.attackers.set('enemy','mercenary');
    assert.equal(h.skill(),id);
    h.summons.push(character('hound','party',32));h.buffs.add('mercenary:molten-armor');
    assert.equal(h.skill(),undefined);
  }
});

test('recovering mana by spending health and refreshing regeneration have observable beneficiaries',()=>{
  const mana=fixture('pain-overture');mana.skills[0].frequency=2;
  assert.equal(mana.skill(),undefined);
  mana.vitals.get('mercenary')!.mana=100;assert.equal(mana.skill(),'pain-overture');
  mana.vitals.get('mercenary')!.health=20;assert.equal(mana.skill(),undefined);
  const hot=fixture('light-command');
  hot.vitals.get('leader')!.health=40;assert.equal(hot.skill(),'light-command');
  hot.enemy.position.x=400;hot.skills[0].frequency=2;hot.vitals.get('leader')!.health=20;
  assert.equal(hot.skill(),undefined,'持续增益即使在高频档也等交战进入有效距离');
  hot.enemy.position.x=48;assert.equal(hot.skill(),'light-command');
  hot.buffs.add('leader:light-command');assert.equal(hot.skill(),undefined);
});

test('ambush waits for a basic shot even when rampage reaches the enemy',()=>{
  const h=fixture('ambush','rampage');
  h.port.attackRange=()=>12;
  h.skills[0].frequency=2;
  h.enemy.position.x=112;
  h.attackers.set('enemy','leader');
  assert.equal(h.skill(),undefined);
  h.enemy.position.x=96;
  assert.equal(h.skill(),'ambush');
});

for(const id of ['shield-bash','dark-attack']){
  test(id+' rates enemies from the reachable landing point',()=>{
    const h=fixture(id);
    h.skills[0].action=battle.skills[id].companion!.action!;
    h.skills[0].frequency=2;
    h.actor.position.x=320;
    h.enemy.position.x=392;
    h.enemy.facing='west';
    h.bosses.add(h.enemy.id);
    let open=true;
    Object.assign(h.port,{canPlaceBody:()=>open});
    assert.equal(h.skill(),id);
    open=false;
    assert.equal(h.skill(),undefined);
  });
}
