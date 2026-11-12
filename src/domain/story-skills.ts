import type { BattleCatalog, SkillLoadout } from './battle.ts';
import type { BattleCharacter } from './character-stats.ts';
import { SkillConfiguration } from './skill-configuration.ts';
import { ShortcutBar, defaultShortcutRow, type ShortcutRow } from './shortcut-bar.ts';
import { SKILL_POINT_ITEM } from './items.ts';

/** 正式游戏的已学技能与快捷栏，同一份状态供菜单和战斗读取。 */
export class StorySkillProgression extends SkillConfiguration {
  private resetRevision=0;
  get resetVersion():number {return this.resetRevision;}
  private readonly hero?: BattleCharacter;
  private readonly catalog?: BattleCatalog;
  constructor(hero?: BattleCharacter, catalog?: BattleCatalog) { super();this.hero=hero;this.catalog=catalog; }

  override draft(catalog: BattleCatalog, classId: string): SkillLoadout {
    this.draftCallCount++;
    const existing=this.loadouts.get(classId);
    if(existing)return structuredClone(existing);
    const character=catalog.classes.find(entry=>entry.id===classId);
    if(!character)throw new Error('职业不存在');
    const starter=character.skills[0];
    if(!starter||catalog.skills[starter]?.kind!=='active')throw new Error('职业缺少初始主动技能');
    return {levels:Object.fromEntries(character.skills.map(id=>[id,id===starter?1:0]))};
  }

  override save(catalog: BattleCatalog, classId: string, draft: SkillLoadout): void {
    const character=catalog.classes.find(entry=>entry.id===classId);
    if(!character||classId!==this.hero?.classId)throw new Error('技能配置无效');
    if(character.skills.some(id=>draft.levels[id]!==this.draft(catalog,classId).levels[id])||
      Object.keys(draft.levels).some(id=>!character.skills.includes(id)))throw new Error('技能等级只能通过学习改变');
    this.loadouts.set(classId,structuredClone(draft));this.markChanged();
  }

  /** 主角自己的快捷栏。默认内容按当前已学会的主动技能与开局消耗品算，见 `shortcut-bar.ts`。 */
  bar(): ShortcutBar {
    if(!this.catalog||!this.hero)throw new Error('技能进度不可用');
    return ShortcutBar.for(this.hero.bag,'player',this.activeSkills(this.catalog,this.hero.classId),this.hero.bag.catalog.startingShortcut);
  }
  private defaults():ShortcutRow {
    return defaultShortcutRow(this.activeSkills(this.catalog!,this.hero!.classId),this.hero!.bag.catalog.startingShortcut);
  }

  private skill(id:string){
    const skill=this.catalog?.skills[id];
    const character=this.catalog?.classes.find(entry=>entry.id===this.hero?.classId);
    if(!skill||!character?.skills.includes(id))throw new Error('请选择本职业的技能');
    return skill;
  }
  level(id:string):number {this.skill(id);return this.draft(this.catalog!,this.hero!.classId).levels[id];}
  points():number {return this.hero?.skillPoints??0;}
  /** 按每门技能当前等级的累计行统计，免费初始技能和技能书等级也参与。 */
  investedPoints():number {
    const character=this.catalog?.classes.find(entry=>entry.id===this.hero?.classId);
    if(!character)return 0;
    return character.skills.reduce((total,id)=>{
      const rank=this.level(id),ranks=this.catalog!.skills[id].ranks;
      return total+(rank>0?(ranks[rank-1].investedSkillPoints??ranks.slice(0,rank).reduce((sum,value)=>sum+value.pointCost,0)):0);
    },0);
  }
  learningRequirements(id:string) {
    const skill=this.skill(id),level=this.level(id),cost=skill.ranks[level]?.pointCost??0,
      invested=this.investedPoints(),requiredInvested=skill.requiredInvestedSkillPoints??0,
      atLimit=level>=skill.normalMaxLevel;
    return {level,cost,invested,requiredInvested,atLimit,conditionMet:invested>=requiredInvested,pointsAvailable:this.points()>=cost};
  }
  learningProblem(id:string):string|undefined {
    const state=this.learningRequirements(id);
    if(state.atLimit)return '已达到普通学习上限';
    if(!state.conditionMet)return `条件：投入${state.requiredInvested}技能点`;
    if(!state.pointsAvailable)return `需要 ${state.cost} 个技能点`;
  }
  learn(id:string):number {
    const problem=this.learningProblem(id);if(problem)throw new Error(problem);
    const skill=this.skill(id),next=this.level(id)+1;
    const draft=this.draft(this.catalog!,this.hero!.classId);
    draft.levels[id]=next;this.loadouts.set(this.hero!.classId,draft);this.markChanged();
    this.hero!.spendSkillPoints(skill.ranks[next-1].pointCost);
    return next;
  }
  bookProblem(id:string):string|undefined {
    const skill=this.skill(id),rank=this.level(id);
    if(rank<skill.normalMaxLevel)return `技能达到 ${skill.normalMaxLevel} 级后才能使用技能书`;
    if(rank>=skill.ranks.length)return '技能已达到最高等级';
  }
  book(id:string):number {
    const problem=this.bookProblem(id);if(problem)throw new Error(problem);
    const draft=this.draft(this.catalog!,this.hero!.classId),next=draft.levels[id]+1;
    draft.levels[id]=next;this.loadouts.set(this.hero!.classId,draft);this.markChanged();
    return next;
  }
  /**
   * GM 调试：把主角本职业的全部技能直接拉到最高等级，未学的也一并学会。
   * 不扣技能点，也不改变快捷栏；普通玩法仍只能通过 `learn` / `book` 提升。
   */
  maxAll(): { learned: number; maxed: number } {
    if(!this.catalog||!this.hero)throw new Error('技能进度不可用');
    const character=this.catalog.classes.find(entry=>entry.id===this.hero!.classId);
    if(!character)throw new Error('职业不存在');
    const draft=this.draft(this.catalog,this.hero.classId);
    let learned=0,maxed=0;
    for(const id of character.skills){
      const skill=this.catalog.skills[id];
      if(!skill)continue;
      const from=draft.levels[id]??0,to=skill.ranks.length;
      if(to<=from)continue;
      if(from===0)learned++;else maxed++;
      draft.levels[id]=to;
    }
    this.loadouts.set(this.hero.classId,draft);this.markChanged();
    return {learned,maxed};
  }
  /** 初始化技能点：清等级与技能点，快捷栏也退回默认（初始技能在第一格、其它格清空）。 */
  reset():void {
    if(!this.catalog||!this.hero)throw new Error('技能进度不可用');
    this.resetRevision++;
    this.loadouts.delete(this.hero.classId);this.markChanged();
    this.setShortcutPage(this.hero.classId,0);
    this.hero.bag.setShortcuts('player',this.defaults());
    this.hero.resetSkillPoints();
  }
  /** 该技能是否登记在主角的快捷栏上；手动技能只允许快捷栏里的技能起手。 */
  isEquipped(id:string):boolean {
    return this.level(id)>0&&this.bar().assigned('skill',id);
  }
  applyItem(itemId:string,skillId?:string):string|undefined {
    if(!this.catalog||!this.hero)throw new Error('技能进度不可用');
    const item=this.hero.bag.catalog.items[itemId];
    if(item.use?.kind==='learn'){
      if(!skillId)throw new Error('请选择本职业的技能');
      const rank=this.book(skillId);
      return `${this.skill(skillId).name}提升至 ${rank} 级`;
    }
    if(item.use?.kind==='reset-skills'){
      this.reset();return '已初始化技能与技能点';
    }
    if(itemId===SKILL_POINT_ITEM){
      this.hero.grantSkillPoint();return '获得 1 个技能点';
    }
  }
}
