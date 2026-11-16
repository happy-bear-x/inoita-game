import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import {Session} from '../src/domain/session.ts';
import {CompanionSkillProgression} from '../src/domain/companion-progression.ts';
import type {CompanionCatalog} from '../src/domain/party.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {emptyShortcutRow} from '../src/domain/shortcut-bar.ts';
import {validateCompanions} from '../src/application/content-validation.ts';
import type {WorldIndex} from '../src/domain/content.ts';
import {plainDescription} from '../src/domain/description-text.ts';
import {skillLearningParts} from '../src/ui/skill-detail-lines.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const stats=read<CharacterStatsCatalog>('character-stats'),items=read<ItemCatalog>('items'),battle=read<BattleCatalog>('battle'),
  companions=read<CompanionCatalog>('companions'),campaign=read<Campaign>('campaign');

test('story companion next skill requirement matches automatic growth and respects the cap',()=>{
  const skill='firestorm',progression=new CompanionSkillProgression({[skill]:4},companions.generation.training);
  progression.updateLevel(87);
  assert.equal(progression.skillLevels()[skill],3);
  const next=progression.nextAutomaticLevel(skill);
  assert.equal(next,88);
  assert.match(plainDescription(skillLearningParts('火焰风暴',3,undefined,next)),/学习级别： LV 88/);
  progression.updateLevel(88);
  assert.equal(progression.skillLevels()[skill],4);
  assert.equal(progression.nextAutomaticLevel(skill),undefined);
  assert.equal(progression.book(skill,battle),5);
  assert.equal(progression.nextAutomaticLevel(skill),undefined);
  progression.unlockSkill('sword-of-hell',battle);
  assert.equal(progression.nextAutomaticLevel('sword-of-hell'),undefined);
});

test('companion training rejects levels outside the character range',()=>{
  const catalog=structuredClone(companions);
  catalog.definitions={};
  const training=catalog.generation.training['firestorm'];
  training.requiredLevels[training.requiredLevels.length-1]=stats.maxLevel+1;
  assert.throws(()=>validateCompanions(catalog,{} as WorldIndex,battle,stats),/伙伴技能成长等级超出角色等级范围/);
  training.requiredLevels[training.requiredLevels.length-1]=88;
  training.requiredLevels[0]=0;
  assert.throws(()=>validateCompanions(catalog,{} as WorldIndex,battle,stats),/伙伴技能成长等级超出角色等级范围/);
});
function fixture(highLevel=true){
  const hero=new BattleCharacter('dark-knight',stats,items);
  if(highLevel)hero.addExperience(Number.MAX_SAFE_INTEGER);
  const session=new Session(campaign,undefined,undefined,items,hero,battle,stats,companions),party=session.party!;
  const recruit=()=>{session.bag.add('mercenary-emblem-black-knight');return party.recruit(session.bag.entries.find(entry=>entry.item==='mercenary-emblem-black-knight')!.id,()=>0).member;};
  return {session,hero,party,recruit};
}

test('mercenaries start at zero and spend their own points using hero costs and invested requirements',()=>{
  const low=fixture(false),beginner=low.recruit();
  assert.equal(beginner.skills.points(),0);
  assert.throws(()=>beginner.skills.learn('dark-strike'),/技能点/);
  beginner.addExperience(beginner.player.nextLevelExperience);
  assert.equal(beginner.skills.points(),1);assert.equal(beginner.skills.level('dark-strike'),0);
  beginner.skills.learn('dark-strike');assert.equal(beginner.skills.points(),0);

  const {session,hero,recruit}=fixture(),member=recruit(),other=recruit(),points=member.skills.points();
  assert.equal(points,(member.level-1)*stats.skillPointsPerLevel);
  assert(Object.values(member.skills.skillLevels()).every(level=>level===0));
  if(!member.skills.available('phantom-clash'))member.skills.unlockSkill('phantom-clash',battle);
  assert.throws(()=>member.skills.learn('phantom-clash'),/投入6技能点/);
  for(let level=0;level<3;level++){
    assert.equal(member.skills.learningRequirements('dark-strike').cost,battle.skills['dark-strike'].ranks[level].pointCost);
    member.skills.learn('dark-strike');
  }
  assert.equal(member.skills.points(),points-6);
  member.skills.learn('phantom-clash');assert.equal(member.skills.points(),points-8);
  assert.equal(other.skills.level('dark-strike'),0);
  assert.equal(hero.skillPoints,(hero.level-1)*stats.skillPointsPerLevel);
  assert.equal(session.skills.level('dark-strike'),1);
});

test('random caps restrict normal learning and unopened class skills require an unlock',()=>{
  const progression=new CompanionSkillProgression({'dark-strike':2},companions.generation.training,{
    classId:'dark-knight',catalog:battle,pointsPerLevel:1,changed:()=>{},clearShortcuts:()=>{},
  });
  progression.updateLevel(40);
  assert.throws(()=>progression.learn('demon-s-shield'),/未开放/);
  progression.learn('dark-strike');progression.learn('dark-strike');
  assert.throws(()=>progression.learn('dark-strike'),/上限/);
  assert.equal(progression.book('dark-strike',battle),3);
  progression.unlockSkill('demon-s-shield',battle);
  assert.equal(progression.level('demon-s-shield'),0);
  assert.throws(()=>progression.unlockSkill('demon-s-shield',battle),/已开放/);
  assert.throws(()=>progression.book('demon-s-shield',battle),/达到 4 级/);
  assert.equal(progression.normalMaximum('demon-s-shield',battle),4);
});

test('free reset refunds ordinary points once, drops book levels and only clears that mercenary shortcuts',()=>{
  const {session,party,recruit}=fixture(),member=recruit(),other=recruit(),points=member.skills.points();
  const caps=structuredClone(member.generated.skillCaps),groups=[...member.generated.groupSkills];
  while(member.skills.level('dark-strike')<member.generated.skillCaps['dark-strike'])member.skills.learn('dark-strike');
  session.bag.add('skillbook');const book=session.bag.entries.find(entry=>entry.item==='skillbook')!;
  session.bag.use(book.id,undefined,'dark-strike',Math.random,member.id);
  const missing=battle.classes.find(value=>value.id===member.classId)!.skills.find(id=>!member.skills.available(id))!;
  member.skills.unlockSkill(missing,battle);other.skills.learn('dark-strike');
  member.aiFrequency.set('dark-strike',2);
  const row=emptyShortcutRow();row[0]={kind:'skill',id:'dark-strike'};row[7]={kind:'skill',id:'phantom-clash'};
  session.bag.setShortcuts(member.id,row);session.bag.setShortcuts(other.id,row);member.skills.setShortcutPage(member.classId,1);
  const otherBefore=other.captureState(),heroBefore=session.skills.captureState(),bagBefore=session.bag.entries.map(entry=>({...entry})),money=session.money;
  member.skills.reset();
  assert.equal(member.skills.points(),points);assert.equal(member.skills.resetVersion,1);
  assert(Object.values(member.skills.skillLevels()).every(level=>level===0));
  assert.equal(member.skills.available(missing),true);assert.deepEqual(member.skills.bookState(),{});
  assert.equal(member.skills.shortcutPage(member.classId),0);
  assert.deepEqual(session.bag.captureState().shortcuts.find(([id])=>id===member.id)?.[1],emptyShortcutRow());
  assert.deepEqual(other.captureState(),otherBefore);assert.deepEqual(session.skills.captureState(),heroBefore);
  assert.equal(member.aiFrequency.get('dark-strike'),2);assert.deepEqual(member.generated.skillCaps,caps);assert.deepEqual(member.generated.groupSkills,groups);
  assert.equal(session.money,money);assert.deepEqual(session.bag.entries,bagBefore);
  member.skills.reset();assert.equal(member.skills.points(),points);
  const saved=party.captureState();party.restoreState(saved);assert.equal(party.get(member.id)!.skills.available(missing),true);
  assert.equal(party.get(member.id)!.skills.points(),points);
});

test('skill point validation rejects corrupt checkpoints before changing the live party',()=>{
  const {session,recruit}=fixture(),member=recruit();member.skills.learn('dark-strike');
  const before=session.captureState();
  for(const change of [
    (state:typeof before)=>{state.party!.members[0].skillPoints!.spentPoints=-1;},
    (state:typeof before)=>{state.party!.members[0].skillPoints!.spentPoints=0;},
    (state:typeof before)=>{state.party!.members[0].skillPoints!.allocations['dark-strike']=9;},
    (state:typeof before)=>{delete state.party!.members[0].skillPoints;},
  ]){
    const invalid=structuredClone(before);change(invalid);
    assert.throws(()=>session.restoreState(invalid),/佣兵技能/);assert.deepEqual(session.captureState(),before);
  }
});

test('skill point restore requires the exact cost of the allocated ranks',()=>{
  const progression=new CompanionSkillProgression({'shield-bash':3},companions.generation.training,{
    classId:'dark-knight',catalog:battle,pointsPerLevel:1,changed:()=>{},clearShortcuts:()=>{},
  });
  progression.updateLevel(40);
  // 盾击各级花费是 3/2/2，三级实际花 7 点；只按最少/最多区间校验会放过少报的 6 点。
  assert.throws(()=>progression.restorePoints({allocations:{'shield-bash':3},spentPoints:6,legacyBonusPoints:0}),/花费/);
  progression.restorePoints({allocations:{'shield-bash':3},spentPoints:7,legacyBonusPoints:0});
});

test('GM skill levels do not become refundable points and story companions keep automatic growth',()=>{
  const {party,recruit}=fixture(),member=recruit(),points=member.skills.points();
  member.skills.maxAll(battle,member.classId);assert.equal(member.skills.level('dark-strike'),8);
  const saved=party.captureState();party.restoreState(saved);
  const restored=party.get(member.id)!;assert.equal(restored.skills.level('dark-strike'),8);
  restored.skills.reset();assert.equal(restored.skills.points(),points);assert.equal(restored.skills.level('dark-strike'),0);
  const story=party.joinStory('mercenary-portia');
  assert.equal(story.skills.manual,false);assert.equal(story.skills.points(),0);
  assert(Object.values(story.skills.skillLevels()).some(level=>level>0));
  assert.throws(()=>story.skills.reset(),/不能初始化/);
});
