import type { Session, SessionState } from './session.ts';

interface CheckpointLocation { map:string; x:number; y:number }
interface CheckpointSnapshot<WorldState> { session:SessionState; location:CheckpointLocation; world:WorldState }

/** One in-memory checkpoint. Scene code supplies only its explicit, serializable world state. */
export class SessionCheckpoint<WorldState = undefined> {
  private snapshot?:CheckpointSnapshot<WorldState>;
  get available():boolean { return !!this.snapshot; }
  peek():CheckpointSnapshot<WorldState>|undefined { return this.snapshot?structuredClone(this.snapshot):undefined; }
  capture(session:Session,location:CheckpointLocation,world:WorldState):boolean {
    // 全灭状态不是安全点：保留上一份快照，别让死亡面板恢复回来又立刻全灭。
    if(!session.hasLivingMember)return false;
    const state=session.captureState();
    // 已拔出的古老武器是存档级进度；死亡检查点不回滚它，否则同一存档能反复拔同一把剑。
    delete state.legendaryWeapons;
    this.snapshot=structuredClone({session:state,location,world});
    return true;
  }
  restore(session:Session):{location:CheckpointLocation;world:WorldState}|undefined {
    if(!this.snapshot)return;
    const restored=structuredClone(this.snapshot);
    session.restoreState(restored.session);
    return {location:restored.location,world:restored.world};
  }
  clear():void { this.snapshot=undefined; }
}

/**
 * 检查点会话里上阵队伍是否至少还有一人活着。
 * 旧测试或损坏的局部快照没有血量的，按「无法判断」放行，让真正的存档校验去拒绝。
 */
export function hasLivingParty(state:SessionState|undefined):boolean {
  if(!state)return true;
  const heroHealth=state.hero?.health ?? state.player?.health;
  const party=state.party;
  if(!party)return heroHealth===undefined?true:heroHealth>0;
  const members=new Map(party.members.map(member=>[member.id,member.health]));
  const living=party.slots.some(id=>{
    if(!id)return false;
    if(id==='player')return (heroHealth??0)>0;
    return (members.get(id)??0)>0;
  });
  return living || (heroHealth===undefined?true:heroHealth>0);
}
