import { LOGIC_FRAME_MS } from './battle.ts';

/** Original presentation names; source record numbers stay in the importer. */
export const COMBAT_OUTCOME_EFFECTS = ['energy-column', 'enemy-vanish', 'level-up-aura', 'level-up-light', 'level-up-burst'] as const;
export const ENEMY_DEFEAT_HOLD_MS = 60;
export const ENEMY_DEFEAT_FADE_MS = 600;
/** 消散表现和结算共用同一个时长，避免逻辑帧与 tween 漂移。 */
export const ENEMY_DEFEAT_SETTLE_FRAMES = (ENEMY_DEFEAT_HOLD_MS + ENEMY_DEFEAT_FADE_MS) / LOGIC_FRAME_MS;

/** A defeated enemy remains registered until its one settlement has completed. */
export class PendingEnemyDefeats {
  private readonly pending = new Map<string, {
    settle:(render:boolean)=>void;
    present?:(render:boolean)=>void;
    fail?:(error:unknown,render:boolean,phase:'settle'|'present')=>void;
  }>();
  private readonly completing = new Set<string>();
  has(key: string): boolean { return this.pending.has(key); }
  keys(): readonly string[] { return [...this.pending.keys()]; }
  add(key:string,settle:(render:boolean)=>void,present?:(render:boolean)=>void,
    fail?:(error:unknown,render:boolean,phase:'settle'|'present')=>void):boolean {
    if(this.pending.has(key))return false;
    this.pending.set(key,{settle,present,fail});return true;
  }
  complete(key:string,render=true):void {
    const ticket=this.pending.get(key);
    if(!ticket||this.completing.has(key))return;
    this.completing.add(key);
    // 先移除死亡单：结算或表现失败都不能留下永远无法完成的待办。
    this.pending.delete(key);
    try {
      try { ticket.settle(render); }
      catch(error) { this.reportFailure(ticket,error,render,'settle'); return; }
      try { ticket.present?.(render); }
      catch(error) { this.reportFailure(ticket,error,render,'present'); }
    } finally {
      this.completing.delete(key);
    }
  }
  private reportFailure(
    ticket:{fail?:(error:unknown,render:boolean,phase:'settle'|'present')=>void},
    error:unknown,render:boolean,phase:'settle'|'present'):void {
    // 兜底回调自己抛错也不能再冒回战斗帧。
    try { ticket.fail?.(error,render,phase); } catch { /* 保持帧循环和存档入口可用 */ }
  }
  clear():void {this.pending.clear();}
  flush():void {for(const key of [...this.pending.keys()])this.complete(key,false);}
}
