import type { ActiveCombatAction, Combatant } from './combat.ts';
import { actionCues } from './skill-action.ts';

const RECENT_CONTACT_MS=1800;
interface SummonCombatObservation {
  actor:Combatant;
  action?:ActiveCombatAction;
  chasingTargetId?:string;
}

/** 无需目标的范围攻击也是敌对动作；施放条件不能用来判断动作性质。 */
export function isHostileAction(action:Pick<ActiveCombatAction,'skill'>):boolean {
  return !action.skill||actionCues(action.skill.action).some(cue=>
    cue.target==='current'||cue.target==='enemy'||cue.target==='area'||cue.target==='target-area');
}

/** 只记录真实交战信号，不把选中、接近或旧仇恨记录当成开战。 */
export class SummonCombatAwareness {
  private lastCombatAt:number;
  private readonly engaged=new Map<string,number>();
  private readonly attacks=new Map<string,{enemyId:string;targetId:string;at:number}>();
  private readonly friendlyTargets=new Map<string,{id:string;at:number}>();
  constructor(nowMs:number){this.lastCombatAt=nowMs;}
  contact(source:Combatant,target:Combatant,nowMs:number):void {
    if(source.team===target.team||(source.team!=='party'&&target.team!=='party'))return;
    this.lastCombatAt=nowMs;
    const enemy=source.team==='party'?target:source;
    this.engaged.set(enemy.id,nowMs);
    if(source.team==='party')this.friendlyTargets.set(source.id,{id:target.id,at:nowMs});
    else this.attacks.set(JSON.stringify([source.id,target.id]),{enemyId:source.id,targetId:target.id,at:nowMs});
  }
  action(source:Combatant,action:ActiveCombatAction,target:Combatant|undefined,nowMs:number):void {
    if(action.state!=='attacking'||!isHostileAction(action))return;
    if(source.team==='party')this.lastCombatAt=nowMs;
    if(target)this.contact(source,target,nowMs);
  }
  observe(nowMs:number,observations:readonly SummonCombatObservation[]):void {
    const actors=new Map(observations.map(entry=>[entry.actor.id,entry.actor]));
    for(const entry of observations){
      if(entry.action)this.action(entry.actor,entry.action,actors.get(entry.action.targetId??''),nowMs);
      if(entry.actor.team!=='party'&&entry.chasingTargetId){
        const target=actors.get(entry.chasingTargetId);
        if(target?.team==='party')this.contact(entry.actor,target,nowMs);
      }
    }
    for(const [id,at]of this.engaged)if(nowMs-at>RECENT_CONTACT_MS||!actors.has(id))this.engaged.delete(id);
    for(const [key,entry]of this.attacks)if(nowMs-entry.at>RECENT_CONTACT_MS||!actors.has(entry.enemyId)||!actors.has(entry.targetId))this.attacks.delete(key);
    for(const [id,entry]of this.friendlyTargets)if(nowMs-entry.at>RECENT_CONTACT_MS||!actors.has(id)||!actors.has(entry.id))this.friendlyTargets.delete(id);
  }
  tactics(ownerId:string,partyIds:readonly string[],focusTargetId?:string) {
    return {engagedTargetIds:[...this.engaged.keys()],ownerTargetId:this.friendlyTargets.get(ownerId)?.id,
      focusTargetId,partyIds,threats:[...this.attacks.values()].map(({enemyId,targetId})=>({enemyId,targetId}))};
  }
  quietFor(nowMs:number):number{return Math.max(0,nowMs-this.lastCombatAt);}
  /** 最近一次真实交战后仍算战斗中；没有交战记录时返回 false。 */
  inCombat(nowMs:number):boolean {
    for(const at of this.engaged.values())if(nowMs-at<=RECENT_CONTACT_MS)return true;
    return false;
  }
}
