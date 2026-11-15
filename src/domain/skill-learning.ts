import type { BattleCatalog, SkillDefinition } from './battle.ts';

export interface SkillLearningProgression {
  level(id:string):number;
  points():number;
  learningRequirements(id:string):ReturnType<typeof skillLearningRequirements>;
  learningProblem(id:string):string|undefined;
  learn(id:string):number;
  reset():void;
}

export function investedSkillPoints(catalog:BattleCatalog,classId:string,levels:Record<string,number>):number {
  return (catalog.classes.find(value=>value.id===classId)?.skills??[]).reduce((total,id)=>{
    const level=levels[id]??0,ranks=catalog.skills[id].ranks;
    return total+(level>0?(ranks[level-1]?.investedSkillPoints??ranks.slice(0,level).reduce((sum,rank)=>sum+rank.pointCost,0)):0);
  },0);
}

export function skillLearningRequirements(skill:SkillDefinition,level:number,points:number,invested:number,maximum=skill.normalMaxLevel) {
  const cost=skill.ranks[level]?.pointCost??0,requiredInvested=skill.requiredInvestedSkillPoints??0;
  return {level,cost,invested,requiredInvested,atLimit:level>=maximum,
    conditionMet:invested>=requiredInvested,pointsAvailable:points>=cost};
}

export function skillLearningProblem(state:ReturnType<typeof skillLearningRequirements>):string|undefined {
  if(state.atLimit)return '已达到普通学习上限';
  if(!state.conditionMet)return `条件：投入${state.requiredInvested}技能点`;
  if(!state.pointsAvailable)return `需要 ${state.cost} 个技能点`;
}
