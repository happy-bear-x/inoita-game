import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBattle, parseCampaign, parseCharacterStats, parseItemCatalog } from '../src/application/content-validation.ts';
import { BattleCharacter } from '../src/domain/character-stats.ts';
import { Session } from '../src/domain/session.ts';
import { passiveModifiers } from '../src/domain/passive-skills.ts';

const read=(name:string)=>JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=parseBattle(read('battle')),items=parseItemCatalog(read('items')),
  stats=parseCharacterStats(read('character-stats')),campaign=parseCampaign(read('campaign'));
function start(classId='dark-knight'){
  const hero=new BattleCharacter(classId,stats,items);
  const session=new Session(campaign,undefined,{classId,appearance:battle.classes.find(entry=>entry.id===classId)!.actor},items,hero,battle);
  return {hero,session};
}

test('six story classes start with their first active skill equipped for free',()=>{
  for(const character of battle.classes){
    const {hero,session}=start(character.id),page=session.skills.bar().page(0);
    const starter=character.skills[0];
    assert.equal(hero.skillPoints,0);
    assert.equal(battle.skills[starter].kind,'active');
    // 默认快捷栏：初始主动技能占第一格，开局的消耗品占第六格，其余空格。
    assert.deepEqual(page[0],{kind:'skill',id:starter});
    assert(page.slice(1,5).every(slot=>slot===null));
    assert.deepEqual(page[5],{kind:'item',id:items.startingShortcut});
    assert(character.skills.every(id=>session.skills.draft(battle,character.id).levels[id]===(id===starter?1:0)));
    assert(session.skills.isEquipped(starter));
    assert.equal(session.skills.points(),0);
  }
});

test('learning checks native invested points and point costs, and only learned active skills may be equipped',()=>{
  const {hero,session}=start(),skills=session.skills;
  assert.match(skills.learningProblem('demon-s-shield')!,/技能点/);
  assert.match(skills.learningProblem('dark-strike')!,/技能点/);
  hero.addExperience(hero.player.nextLevelExperience);
  assert.match(skills.learningProblem('phantom-clash')!,/投入6技能点/);
  assert.equal(skills.learn('demon-s-shield'),1);
  assert.equal(hero.skillPoints,0);
  assert.throws(()=>skills.learn('dark-strike'),/技能点/);
  hero.addExperience(hero.catalog.experience.slice(hero.level-1,hero.level-1+2).reduce<number>((a,b)=>a+(b??0),0));
  assert.equal(skills.learn('dark-strike'),2);
  assert.equal(hero.skillPoints,0,'second rank costs two native skill points');
  skills.bar().assign(0,0,{kind:'skill',id:'dark-strike'});
  assert(skills.isEquipped('dark-strike'));
  assert(!skills.isEquipped('phantom-clash'));
  const forged=skills.draft(battle,hero.classId);forged.levels['dark-strike']=8;
  assert.throws(()=>skills.save(battle,hero.classId,forged),/等级/);
});

test('native invested threshold counts free skill ranks and unlocks independently of character level',()=>{
  const {hero,session}=start(),skills=session.skills;
  assert.equal(skills.investedPoints(),1,'免费首项一级参与原版累计统计');
  hero.addExperience(hero.catalog.experience.slice(0,8).reduce<number>((sum,value)=>sum+(value??0),0));
  assert.equal(hero.level,9);
  assert.match(skills.learningProblem('phantom-clash')!,/投入6技能点/,'等级和剩余点数不能替代投入门槛');
  skills.learn('dark-strike');assert.equal(skills.investedPoints(),3);
  skills.learn('dark-strike');assert.equal(skills.investedPoints(),6);
  assert.equal(skills.learningProblem('phantom-clash'),undefined);
  const before=hero.skillPoints;assert.equal(skills.learn('phantom-clash'),1);
  assert.equal(hero.skillPoints,before-2);
  assert.equal(skills.investedPoints(),8);
});

test('passives activate on learning; books, elixir and skill reset update the same progression',()=>{
  const {hero,session}=start(),skills=session.skills,bag=hero.bag;
  let version=skills.version;
  const before=passiveModifiers(battle,hero.classId,skills.draft(battle,hero.classId),'longsword');
  hero.addExperience(hero.catalog.experience.slice(hero.level-1,hero.level-1+20).reduce<number>((a,b)=>a+(b??0),0));
  skills.learn('improved-defense');
  assert(skills.version>version);version=skills.version;
  assert(passiveModifiers(battle,hero.classId,skills.draft(battle,hero.classId),'longsword').length>before.length);
  bag.add('skillbook');let book=bag.entries.find(entry=>entry.item==='skillbook')!;
  assert.throws(()=>bag.use(book.id,undefined,'dark-strike'),/技能达到 4 级/);
  assert.equal(bag.count('skillbook'),1,'invalid book use keeps the item');
  for(let rank=2;rank<=4;rank++)assert.equal(skills.learn('dark-strike'),rank);
  const remaining=hero.skillPoints;
  skills.bar().assign(0,0,{kind:'skill',id:'dark-strike'});
  assert.equal(bag.use(book.id,undefined,'dark-strike').skill,'dark-strike');
  assert(skills.version>version);version=skills.version;
  assert.equal(skills.level('dark-strike'),5);
  assert.equal(skills.investedPoints(),battle.skills['dark-strike'].ranks[4].investedSkillPoints!+battle.skills['improved-defense'].ranks[0].investedSkillPoints!);
  assert.equal(hero.skillPoints,remaining,'skill books do not spend points');
  for(let rank=6;rank<=8;rank++){
    bag.add('skillbook');book=bag.entries.find(entry=>entry.item==='skillbook')!;
    bag.use(book.id,undefined,'dark-strike');
    assert.equal(skills.level('dark-strike'),rank);
  }
  bag.add('skillbook');book=bag.entries.find(entry=>entry.item==='skillbook')!;
  assert.throws(()=>bag.use(book.id,undefined,'dark-strike'),/最高等级/);
  assert.equal(bag.count('skillbook'),1);
  bag.add('supreme-elixir');const elixir=bag.entries.find(entry=>entry.item==='supreme-elixir')!;
  bag.use(elixir.id);assert.equal(hero.skillPoints,remaining+1);
  skills.setShortcutPage(hero.classId,1);
  assert(skills.version>version);version=skills.version;
  skills.reset();
  assert(skills.version>version);
  assert.equal(hero.skillPoints,20,'reset refunds spent points and clears the elixir bonus');
  assert.equal(skills.level('dark-strike'),1);
  assert.equal(skills.level('improved-defense'),0);
  assert.equal(skills.investedPoints(),1,'初始化恢复免费一级的累计值');
  // 免费初始化把快捷栏也退回默认：初始技能回到第一格，第二组清空。
  assert(skills.isEquipped('dark-strike'));
  assert.deepEqual(skills.bar().page(0)[0],{kind:'skill',id:'dark-strike'});
  assert(skills.bar().page(1).every(slot=>slot===null));
  assert.equal(skills.shortcutPage(hero.classId),0);
});

test('skill configuration versions advance on save and restore without entering snapshots',()=>{
  const {hero,session}=start(),skills=session.skills,saved=skills.captureState();
  const before=skills.version;skills.save(battle,hero.classId,skills.draft(battle,hero.classId));assert(skills.version>before);
  const changed=skills.version;skills.restoreState(saved);assert(skills.version>changed);
  assert.deepEqual(skills.captureState(),saved);
});
