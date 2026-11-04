import { LOGIC_FRAME_MS, type EnemyPlayableSkill } from './battle.ts';
import { attackDistance, targetDistance } from './basic-attack.ts';
import { CombatController, canTargetCombatant, type Combatant, type CombatPort } from './combat.ts';
import { combatStateCapabilities } from './combat-state.ts';
import { needsTarget } from './skill-action.ts';
import { canTraverse, createPathSearch, PATH_GRID_SIZE } from './pathfinding.ts';
import type { GameRectangle, Point } from './navigation.ts';

export type PartySkillKind = 'chance' | 'combat-chance' | 'heal' | 'ally-combat' | 'emergency-heal';
export interface PartyPort extends CombatPort {
  leader(): Combatant | undefined;
  /** 跟随队长时要走到的队形槽位；缺省时退回队长身边任意点。 */
  followGoal?(): Point | undefined;
  /** 窄路时沿主角最近走过的路径跟随的目标点；没有轨迹时退回队形目标。 */
  trailGoal?(): Point | undefined;
  focusTarget(): string | undefined;
  /** 主操作角色当前的战斗目标；队伍联动时让佣兵攻击同一个敌人。 */
  partyTarget?(): string | undefined;
  /** 整个队伍是否已进入战斗：有指派目标，或最近和敌人真实交战过。 */
  inCombat(): boolean;
  navigationBounds(): GameRectangle;
  /** 每渲染帧共享的寻路扩展预算；缺省时按单次上限同步搜索（测试与无场景调用）。 */
  pathBudget?:{take(owner:string,limit:number):number};
  followPath(next: () => Point | undefined): void;
  /** 跟随队长时长时间没有位移，让宿主把佣兵收拢到队长身边；无场景调用可省略。 */
  regroup?(): void;
  skills(): readonly EnemyPlayableSkill[];
  skillKind(id:string): PartySkillKind | undefined;
  vitals(id:string): {health:number;maxHealth:number} | undefined;
  attacking(id:string): boolean;
  attackRange():number;
}
interface PartyControllerState {
  accumulator:number;
  clock:number;
  nextPathAt:number;
  path:Point[];
  destination?:Point;
  destinationTarget?:string;
  destinationRange?:number;
}

/** 跟随距离按双方碰撞矩形之间的间隔计算，每个距离单位为八个地图像素。
 *  同队单位之间不碰撞，这个间隔负责让他们不贴脸、也不和玩家挤在同一点上。 */
const PARTY_FOLLOW_DISTANCE_UNITS = 4;
/** 队长走出 3 格才重算；贴脸 8px 会让跟随者每逻辑帧重开搜索。 */
const PARTY_REPATH_DISTANCE_PX = PATH_GRID_SIZE * 3;
/** 两次重算之间的最短间隔。 */
const PARTY_REPATH_INTERVAL_MS = 180;
/** 跟随是一次性同步搜索的上限；预算不足时下一帧再试。 */
const PARTY_SEARCH_CAP = 384;
/** 不可达后的重试间隔。 */
const PARTY_FAILED_PATH_MS = 600;
/** 跟随这么久没有任何位移，就当作被地形或人群卡住，不再干等寻路。 */
const PARTY_FOLLOW_STUCK_MS = 1500;
/** 追击目标被卡住并收拢后，先停一段时间，避免每次重选同一目标又立刻瞬移。 */
const PARTY_CHASE_RECOVERY_MS = 2400;
/** 位移超过这个距离才算“还在走”；碰撞抖动不算进展。 */
const PARTY_FOLLOW_PROGRESS_PX = 4;
/** 几乎贴脸时才不触发收拢；薄墙两侧 8px 以上也要能脱困。 */
const PARTY_REGROUP_MIN_DISTANCE_PX = 8;
/** 队形点连续不可站这么久后，改走主角走过的路径。 */
const PARTY_TRAIL_ENTER_MS = 350;
/** 队形点恢复可站这么久后再切回队形，避免门口来回抖。 */
const PARTY_TRAIL_EXIT_MS = 800;
/** 绕行比超过这个值、且直线距离够近时，认为队形点不自然。 */
const PARTY_TRAIL_DETOUR_RATIO = 1.6;
const PARTY_TRAIL_DETOUR_MAX_PX = 96;
/** 因绕行切到轨迹后，至少保持这么久再评估回队形，避免在连续拐角里来回切。 */
const PARTY_TRAIL_DETOUR_HOLD_MS = 1500;

/** 队形点能站，但寻路要绕很远时，下一帧改走主角路径。 */
export function shouldUseTrailByDetour(pathLength:number, straightDistance:number):boolean {
  return straightDistance>0&&straightDistance<=PARTY_TRAIL_DETOUR_MAX_PX&&pathLength/straightDistance>PARTY_TRAIL_DETOUR_RATIO;
}

/** 自动施法抽取 1 至 99 的整数，严格小于阈值时通过。 */
export function partySkillThreshold(kind:PartySkillKind,frequency:number,following:boolean):number {
  const high=frequency===2;
  if(kind==='chance')return high?100:30;
  if(kind==='combat-chance')return following?(high?100:50):(high?50:30);
  if(kind==='heal')return high?70:50;
  if(kind==='emergency-heal')return high?40:20;
  return high?80:60;
}

/** Party intent is independent of monster awareness and wandering. */
export class PartyController {
  private readonly id:string;
  private readonly port:PartyPort;
  readonly combatController:CombatController;
  private readonly random:()=>number;
  private accumulator=0;
  private clock=0;
  private nextPathAt=0;
  private path:Point[]=[];
  /** 跨帧推进的寻路搜索；每帧只领一段预算，不能在预算用完时丢掉重来。 */
  private search?:ReturnType<typeof createPathSearch>;
  /** 旧路线第一步失效时立刻重算，但别每个逻辑帧都重开搜索。 */
  private pathRetryAt=0;
  /** 跟随队长时的最近一次真实位移，用来判断是不是一直站着。 */
  private followProgress?:Point;
  private followProgressAt=0;
  /** 追击敌人或自动接近时的最近一次真实位移；和队长跟随分开记录，战斗状态不会互相清零。 */
  private chaseProgress?:{targetId:string;position:Point;since:number};
  private chaseRecoveryUntil=0;
  private followMode:'formation'|'trail'='formation';
  private formationBlockedSince=0;
  private formationUsableSince=0;
  private trailHoldUntil=0;
  private searchKind:'follow-formation'|'follow-trail'|'chase'|undefined;
  private destination?:Point;
  private destinationTarget?:string;
  private destinationRange?:number;
  private disposed=false;
  constructor(id:string,port:PartyPort,combat:CombatController,random= Math.random){
    this.id=id;this.port=port;this.combatController=combat;this.random=random;
  }
  snapshot(){return this.combatController.snapshot();}
  /** 只读动作阶段；不需要冷却快照时用这个。 */
  actionState(){return this.combatController.actionState();}
  selectedTargetId(){return this.combatController.selectedTargetId();}
  captureState():PartyControllerState {
    return {accumulator:this.accumulator,clock:this.clock,nextPathAt:this.nextPathAt,
      path:this.path.map(point=>({...point})),destination:this.destination?{...this.destination}:undefined,
      destinationTarget:this.destinationTarget,destinationRange:this.destinationRange};
  }
  restoreState(state:PartyControllerState):void {
    this.accumulator=state.accumulator;this.clock=state.clock;this.nextPathAt=state.nextPathAt;
    this.path=state.path.map(point=>({...point}));this.destination=state.destination?{...state.destination}:undefined;
    this.destinationTarget=state.destinationTarget;this.destinationRange=state.destinationRange;
    // 搜索持有的是旧场地的闭包，读档后必须重新开始。
    this.search=undefined;this.pathRetryAt=0;this.followProgress=undefined;this.followProgressAt=0;
    this.chaseProgress=undefined;this.chaseRecoveryUntil=0;
    this.followMode='formation';this.formationBlockedSince=0;this.formationUsableSince=0;this.trailHoldUntil=0;this.searchKind=undefined;
  }
  targetRemoved(targetId:string):void {
    this.combatController.targetRemoved(targetId);
    if(this.destinationTarget!==targetId)return;
    this.path=[];this.search=undefined;this.pathRetryAt=0;this.followProgress=undefined;this.followProgressAt=0;
    this.destination=undefined;this.destinationTarget=undefined;this.destinationRange=undefined;this.nextPathAt=0;this.port.stop();
  }
  cancel():void {this.combatController.cancel(true);this.path=[];this.search=undefined;this.pathRetryAt=0;
    this.followProgress=undefined;this.followProgressAt=0;this.chaseProgress=undefined;this.chaseRecoveryUntil=0;
    this.destination=undefined;this.destinationTarget=undefined;this.destinationRange=undefined;
    this.nextPathAt=0;this.accumulator=0;this.followMode='formation';this.formationBlockedSince=0;
    this.formationUsableSince=0;this.trailHoldUntil=0;this.searchKind=undefined;this.port.stop();}
  disable():void {this.cancel();}
  reset():void {this.cancel();this.combatController.reset();}
  dispose():void {this.cancel();this.disposed=true;this.combatController.dispose();}
  update(deltaMs:number):void {
    if(this.disposed||!Number.isFinite(deltaMs)||deltaMs<=0)return;
    this.accumulator+=deltaMs;
    while(this.accumulator>=LOGIC_FRAME_MS){this.accumulator-=LOGIC_FRAME_MS;this.step();}
  }
  /** 宿主按共有逻辑帧派发，寻路时间每次只推进一步。 */
  step():void {
    if(this.disposed)return;
    this.clock+=LOGIC_FRAME_MS;this.tick();
  }
  private tick():void {
    const actor=this.port.actor(this.id);
    if(!actor){this.port.stop();return;}
    this.combatController.update();
    if(!combatStateCapabilities(actor.states??[]).canAct){this.path=[];this.port.stop();this.followProgress=undefined;this.followProgressAt=0;return;}
    const actionState=this.combatController.actionState();
    // 默认普攻由 CombatController 直线接近目标；撞上剧情障碍时不会自己寻路。
    // 这里只在接近阶段做无进展检测，取消接近后交给下面的收拢兜底。
    if(actionState==='approaching'){
      this.trackChaseProgress(actor,this.combatController.selectedTargetId()??'approach');
      return;
    }
    if(actionState!=='idle')return;
    const inCombat=this.port.inCombat();
    const recovering=this.clock<this.chaseRecoveryUntil;
    // 佣兵只跟随主角的攻击：显式集火优先，其次主操作角色当前攻击的目标。
    // 不自己索敌，也不因为挨打还手；主角没有目标时只跟随。
    const target=recovering?undefined:this.hostileTarget(actor,[
      this.port.focusTarget(),
      this.port.partyTarget?.()
    ]);
    // 重新选中目标时清掉旧的队长跟随计时；没有目标但处于战斗时仍走队长跟随，
    // 这条计时不能被 inCombat 每帧清零，否则掉队收拢在战斗中永远等不到触发。
    if(target){this.followProgress=undefined;this.followProgressAt=0;this.formationBlockedSince=0;this.formationUsableSince=0;}
    // 队伍未进入战斗时只跟随，不放任何主动技能；召唤物之类的无目标技能也不例外。
    if(inCombat){
      const cooldowns=this.combatController.snapshot().cooldowns;
      for(const skill of this.port.skills()){
        const frequency=skill.frequency??1,kind=this.port.skillKind(skill.id);
        if(!frequency||!kind||cooldowns[skill.id]||!this.combatController.canSelectSkill(skill)||this.port.canSpendMana?.(skill.manaCost??0)===false)continue;
        if(needsTarget(skill.action)&&(!target||attackDistance(actor.position,actor.bounds,target.position,target.bounds)>skill.action.approachDistanceUnits))continue;
        const threshold=partySkillThreshold(kind,frequency,!target);
        let ready=false;
        if(kind==='heal'||kind==='emergency-heal'){
          ready=this.port.candidates().some(ally=>{
            const hp=this.port.vitals(ally.id);
            return ally.team===actor.team&&!!hp&&hp.health>0&&hp.health<Math.trunc(hp.maxHealth*threshold/100)
              &&targetDistance(actor.position,ally.position)<=skill.action.searchRadiusPx;
          });
        }else if(kind==='ally-combat'){
          ready=this.port.candidates().some(ally=>ally.id!==actor.id&&ally.team===actor.team&&this.port.attacking(ally.id)&&this.roll(threshold));
        }else ready=this.roll(threshold);
        if(ready&&this.combatController.request(skill,target?.id)==='started'){this.path=[];return;}
      }
    }
    if(target){
      const range=this.port.attackRange();
      if(attackDistance(actor.position,actor.bounds,target.position,target.bounds)<=range){
        this.chaseProgress=undefined;this.path=[];this.combatController.requestTarget(target.id);
      }else{
        if(this.trackChaseProgress(actor,target.id))return;
        this.follow(actor,target,range);
      }
      return;
    }
    this.chaseProgress=undefined;
    const leader=this.port.leader();
    const formation=this.port.followGoal?.();
    this.updateFollowMode(formation);
    const goal=this.followMode==='trail'?this.port.trailGoal?.()??formation:formation;
    // 有队形槽位时按「离自己的槽位点多远」判断到没到，而不是离队长多远；
    // 否则槽位点在队长的跟随半径内，佣兵会在到达槽位前就停下。
    if(!leader||leader.id===actor.id||(goal
      ?targetDistance(actor.position,goal)<=8
      :attackDistance(actor.position,actor.bounds,leader.position,leader.bounds)<PARTY_FOLLOW_DISTANCE_UNITS)){
      this.path=[];this.port.stop();this.followProgress=undefined;this.followProgressAt=0;return;
    }
    this.follow(actor,leader,PARTY_FOLLOW_DISTANCE_UNITS-1,true,goal);
  }
  /** 按优先级取第一个仍可攻击的敌对目标；这里只接收主角侧给出的目标。 */
  private hostileTarget(actor:Combatant,ids:readonly (string|undefined)[]):Combatant|undefined {
    for(const id of ids){
      const candidate=id?this.port.actor(id):undefined;
      if(candidate&&candidate.team!==actor.team&&canTargetCombatant(actor,candidate))return candidate;
    }
    return undefined;
  }
  private roll(threshold:number):boolean{return 1+Math.floor(this.random()*99)<threshold;}
  /**
   * 追击敌人或自动接近时，连续一段时间没有真实位移就收拢一次。
   *
   * 目标追击和默认普攻的直线接近都不走“跟随队长”分支；如果没有这条兜底，
   * 被剧情障碍封在入口的佣兵会一直重算同一条不可达路线。收拢后短暂停手，
   * 避免目标仍然不可达时每 1.5 秒重复瞬移。
   */
  private trackChaseProgress(actor:Combatant,targetId:string):boolean {
    if(!this.port.regroup||this.clock<this.chaseRecoveryUntil)return false;
    const previous=this.chaseProgress;
    if(!previous||previous.targetId!==targetId){
      this.chaseProgress={targetId,position:{...actor.position},since:this.clock};
      return false;
    }
    if(Math.hypot(actor.position.x-previous.position.x,actor.position.y-previous.position.y)>=PARTY_FOLLOW_PROGRESS_PX){
      previous.position={...actor.position};previous.since=this.clock;return false;
    }
    // 路径搜索还在跨帧推进时先不算卡住；搜索结束后如果仍没动，计时继续。
    if(this.search)return false;
    if(this.clock-previous.since<PARTY_FOLLOW_STUCK_MS)return false;
    this.chaseProgress=undefined;
    this.path=[];this.search=undefined;this.pathRetryAt=0;this.destination=undefined;
    this.destinationTarget=undefined;this.destinationRange=undefined;this.nextPathAt=0;
    this.combatController.cancel(true);this.port.stop();this.port.regroup?.();
    // 宿主的收拢会调用本控制器的 cancel()；冷却必须放在收拢之后，否则会被清掉。
    this.chaseRecoveryUntil=this.clock+PARTY_CHASE_RECOVERY_MS;
    return true;
  }
  /** 队形点连续不可站就切轨迹；恢复可站一段时间后再切回，避免门口反复切换。 */
  private updateFollowMode(formation?:Point):void {
    if(!formation)return;
    const usable=this.port.canStand(formation);
    if(this.followMode==='formation'){
      this.formationUsableSince=0;
      if(usable){this.formationBlockedSince=0;return;}
      if(!this.formationBlockedSince)this.formationBlockedSince=this.clock;
      else if(this.clock-this.formationBlockedSince>=PARTY_TRAIL_ENTER_MS)this.switchFollowMode('trail');
      return;
    }
    this.formationBlockedSince=0;
    if(!usable){this.formationUsableSince=0;return;}
    if(this.clock<this.trailHoldUntil){this.formationUsableSince=0;return;}
    if(!this.formationUsableSince)this.formationUsableSince=this.clock;
    else if(this.clock-this.formationUsableSince>=PARTY_TRAIL_EXIT_MS)this.switchFollowMode('formation');
  }
  /** 切换跟随方式时丢掉旧路线，下一帧从新目标重新找路。 */
  private switchFollowMode(mode:'formation'|'trail',holdMs=0):void {
    if(this.followMode===mode)return;
    this.followMode=mode;
    this.trailHoldUntil=mode==='trail'?this.clock+holdMs:0;
    this.formationBlockedSince=0;this.formationUsableSince=0;
    this.path=[];this.search=undefined;this.searchKind=undefined;this.destination=undefined;
    this.pathRetryAt=0;this.nextPathAt=0;
  }
  private follow(actor:Combatant,leader:Combatant,range:number,regroup=false,goal?:Point):void {
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(actor.team!==leader.team&&!capabilities.canAutoApproach)){
      this.port.stop();this.followProgress=undefined;this.followProgressAt=0;return;
    }
    if(this.destinationTarget!==leader.id||this.destinationRange!==range){
      this.path=[];this.search=undefined;this.pathRetryAt=0;this.followProgress=undefined;this.followProgressAt=0;
      this.destination=undefined;this.nextPathAt=0;
      this.destinationTarget=leader.id;this.destinationRange=range;
    }
    if(regroup){
      if(this.trackFollowProgress(actor,leader))return;
      // 第一步已经走不通（通常是角色被碰撞挤偏，路线起点对不上了）。
      // 不要等下次固定重算：立刻丢掉旧路线，从当前真实位置重新找路。
      if(!this.search&&this.path.length&&this.clock>=this.pathRetryAt&&!this.nextWaypoint()){
        this.path=[];this.search=undefined;this.nextPathAt=this.clock;
        this.pathRetryAt=this.clock+PARTY_REPATH_INTERVAL_MS;
      }
    } else {this.followProgress=undefined;this.followProgressAt=0;}
    // 搜索跨帧推进：寻路一次算不完时保留现场、下一帧接着算。以前每次重开搜索，
    // 超过单帧预算的长路（远距离或要绕墙）永远算不出来，佣兵就停在原地不跟随。
    const followTarget=goal??leader.position;
    // 槽位目标变化通常小于队长移动阈值；用更小的重算距离，交换槽位或 90° 转向才不会继续走旧位置。
    const repathDistance=goal?16:PARTY_REPATH_DISTANCE_PX;
    if(this.search)this.advanceSearch(actor);
    else if(this.clock>=this.nextPathAt&&(!this.destination
      ||targetDistance(this.destination,followTarget)>=repathDistance
      ||!this.path.length||!this.nextWaypoint())){
      // 先领预算再建查询：没有预算的帧连地图边界都不该读。
      const granted=this.port.pathBudget?.take(this.id,PARTY_SEARCH_CAP)??PARTY_SEARCH_CAP;
      if(granted>0)this.beginSearch(actor,leader,range,granted,goal);
      else this.nextPathAt=this.clock+LOGIC_FRAME_MS;
    }
    if(this.nextWaypoint())this.port.followPath(this.nextWaypoint);else this.port.stop();
  }
  /**
   * 跟随队长时的掉队保护：连续一段时间一步没挪，就不再继续等寻路结果，
   * 让宿主把佣兵放到队长旁边的合法落点。走不通的路线可以重算，但人不能永远留在原地。
   */
  private trackFollowProgress(actor:Combatant,leader:Combatant):boolean {
    if(!this.port.regroup)return false;
    // 寻路还在跨帧推进时角色本来就不该移动，不能把它当成卡住。
    if(this.search)return false;
    const previous=this.followProgress;
    if(!previous||Math.hypot(actor.position.x-previous.x,actor.position.y-previous.y)>=PARTY_FOLLOW_PROGRESS_PX){
      this.followProgress={...actor.position};this.followProgressAt=this.clock;return false;
    }
    if(this.clock-this.followProgressAt<PARTY_FOLLOW_STUCK_MS)return false;
    // 只有几乎贴脸时才不触发收拢；薄墙两侧 8~48px 的不可达位置也要能脱困。
    if(Math.hypot(actor.position.x-leader.position.x,actor.position.y-leader.position.y)<PARTY_REGROUP_MIN_DISTANCE_PX){
      this.followProgressAt=this.clock;return false;
    }
    this.followProgress={...actor.position};this.followProgressAt=this.clock;
    this.path=[];this.search=undefined;this.pathRetryAt=0;this.destination=undefined;this.nextPathAt=0;
    this.port.stop();this.port.regroup?.();
    return true;
  }
  private beginSearch(actor:Combatant,leader:Combatant,range:number,granted:number,goal?:Point):void {
    const target=goal??leader.position;
    this.searchKind=goal?(this.followMode==='trail'?'follow-trail':'follow-formation'):'chase';
    this.nextPathAt=this.clock+PARTY_REPATH_INTERVAL_MS;this.destination={...target};
    const canStand=(point:Point)=>this.port.canStand(point);
    const radius=Math.hypot(actor.bounds.width+leader.bounds.width,actor.bounds.height+leader.bounds.height)+range*8;
    this.search=createPathSearch(actor.position,{bounds:this.port.navigationBounds(),canStand,
      // 有槽位时走到槽位点附近；追击敌人仍用原来的「进入攻击距离」目标。
      isGoal:point=>canStand(point)&&(goal
        ?targetDistance(point,goal)<=4
        :attackDistance(point,actor.bounds,leader.position,leader.bounds)<=range),
      heuristic:point=>Math.max(0,Math.hypot(point.x-target.x,point.y-target.y)-radius)});
    this.stepSearch(actor,granted);
  }
  private advanceSearch(actor:Combatant):void {
    const granted=this.port.pathBudget?.take(this.id,PARTY_SEARCH_CAP)??PARTY_SEARCH_CAP;
    if(granted>0)this.stepSearch(actor,granted);
  }
  private stepSearch(actor:Combatant,granted:number):void {
    const search=this.search;if(!search)return;
    const result=search.step(granted);
    if(result.status==='pending')return;
    const kind=this.searchKind;this.searchKind=undefined;
    this.search=undefined;
    if(result.status==='unreachable'){this.path=[];this.nextPathAt=this.clock+PARTY_FAILED_PATH_MS;return;}
    // 搜索跨了几帧，角色可能被其他系统挪过；从离当前位置最近的点继续，别掉头走回起点。
    let start=0,nearest=Infinity;
    for(let index=0;index<result.path.length;index++){
      const point=result.path[index]!,distance=Math.hypot(point.x-actor.position.x,point.y-actor.position.y);
      if(distance>=nearest)break;
      start=index;nearest=distance;
    }
    const path=result.path.slice(start);
    // 队形点能站但路要绕很远时，下一帧改走主角路径；只在短距离内判断，避免长路误伤。
    if(kind==='follow-formation'&&this.destination){
      let pathLength=0,previous=actor.position;
      for(const point of path){pathLength+=Math.hypot(point.x-previous.x,point.y-previous.y);previous=point;}
      if(shouldUseTrailByDetour(pathLength,targetDistance(actor.position,this.destination))){this.switchFollowMode('trail',PARTY_TRAIL_DETOUR_HOLD_MS);return;}
    }
    this.path=path;
  }
  private readonly nextWaypoint=():Point|undefined=>{
    const actor=this.port.actor(this.id);if(!actor||this.disposed)return;
    const target=this.destinationTarget?this.port.actor(this.destinationTarget):undefined;
    const capabilities=combatStateCapabilities(actor.states??[]);
    if(!capabilities.canMove||(target&&actor.team!==target.team&&(!capabilities.canAutoApproach||!canTargetCombatant(actor,target))))return;
    while(this.path.length){
      const point=this.path[0];
      if(Math.hypot(actor.position.x-point.x,actor.position.y-point.y)>.5)break;
      // 脚点离网格点很近，但还没真正对齐。若从当前位置走不到下一个点，
      // 这个点就是用来把身体拉回网格的，不能提前丢掉，否则会永远卡在障碍边缘。
      const following=this.path[1];
      if(following&&!canTraverse(actor.position,following,point=>this.port.canStand(point)))break;
      this.path.shift();
    }
    const next=this.path[0];return next&&canTraverse(actor.position,next,point=>this.port.canStand(point))?next:undefined;
  };
}
