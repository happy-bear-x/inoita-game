import { LOGIC_FRAME_MS } from './battle.ts';

/** Original presentation names; source record numbers stay in the importer. */
export const COMBAT_OUTCOME_EFFECTS = ['energy-column', 'enemy-vanish', 'level-up-aura', 'level-up-light', 'level-up-burst'] as const;
export const ENEMY_DEFEAT_HOLD_MS = 60;
export const ENEMY_DEFEAT_FADE_MS = 600;
/** 消散表现和结算共用同一个时长，避免逻辑帧与 tween 漂移。 */
export const ENEMY_DEFEAT_SETTLE_FRAMES = (ENEMY_DEFEAT_HOLD_MS + ENEMY_DEFEAT_FADE_MS) / LOGIC_FRAME_MS;

/** A defeated enemy remains registered until its one settlement has completed. */
export class PendingEnemyDefeats {
  private readonly pending = new Map<string, {settle:(render:boolean)=>void;present?:(render:boolean)=>void}>();
  private readonly completing = new Set<string>();
  has(key: string): boolean { return this.pending.has(key); }
  keys(): readonly string[] { return [...this.pending.keys()]; }
  add(key:string,settle:(render:boolean)=>void,present?:(render:boolean)=>void):boolean {
    if(this.pending.has(key))return false;
    this.pending.set(key,{settle,present});return true;
  }
  complete(key:string,render=true):void {
    const ticket=this.pending.get(key);
    if(!ticket||this.completing.has(key))return;
    this.completing.add(key);
    try{ticket.settle(render);this.pending.delete(key);}
    finally{this.completing.delete(key);}
    ticket.present?.(render);
  }
  clear():void {this.pending.clear();}
  flush():void {for(const key of [...this.pending.keys()])this.complete(key,false);}
}
