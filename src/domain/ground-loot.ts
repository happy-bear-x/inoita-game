import type { DropReward } from './drops.ts';
import type { Session } from './session.ts';

/** 每张地图保留的地面掉落上限；超出时先清最早生成的。 */
const MAX_GROUND_DROPS_PER_MAP = 64;
/** 拾取判定以脚点为中心的半格范围。 */
const GROUND_PICKUP_RADIUS_PX = 12;

export interface GroundDrop {
  id:string;
  map:string;
  x:number;
  y:number;
  reward:DropReward;
  createdAtMs?:number;
  flight?:{x:number;y:number;direction:number;remainingMs:number;durationMs:number};
}

export interface GroundLootState { nextId:number; drops:GroundDrop[] }

/** Ground rewards survive scene restarts because this store is tied to the story Session. */
export class GroundLootStore {
  private nextId=0;
  private readonly drops=new Map<string,GroundDrop>();
  /** 每张地图的掉落 id；拾取、推进和视图重建只扫当前图。 */
  private readonly byMap=new Map<string,Set<string>>();
  private readonly flyingByMap=new Map<string,Set<GroundDrop>>();
  private pickupCheck?:{map:string;x:number;y:number;revision:number;availability:number|string};
  /** 掉落内容/飞行状态的版本号；界面只在它变化时重建，避免每帧克隆整张表。 */
  revision=0;
  captureState():GroundLootState { return structuredClone({nextId:this.nextId,drops:[...this.drops.values()]}); }
  restoreState(state:GroundLootState):void {
    const restored=structuredClone(state);this.nextId=restored.nextId;this.drops.clear();this.byMap.clear();this.flyingByMap.clear();this.pickupCheck=undefined;
    for(const drop of restored.drops){this.drops.set(drop.id,drop);this.track(drop);}
    this.revision++;
  }
  add(map:string,x:number,y:number,rewards:readonly DropReward[],options:{nowMs?:number}={}):GroundDrop[] {
    const nowMs=options.nowMs;
    const added=rewards.map(reward=>{
      const drop:GroundDrop={id:`ground-${++this.nextId}`,map,x,y,reward:structuredClone(reward),
        ...(nowMs!==undefined?{createdAtMs:nowMs}:{})};
      this.drops.set(drop.id,drop);this.track(drop);
      return structuredClone(drop);
    });
    this.prune(map);
    if(added.length)this.revision++;
    return added;
  }
  /** 队伍掉落共用一张背包，但地面总量仍要封顶：每图最多 64 件，超出淘汰最旧的。 */
  private prune(map:string):void {
    const onMap=this.onMap(map);
    if(onMap.length<=MAX_GROUND_DROPS_PER_MAP)return;
    onMap.sort((left,right)=>(left.createdAtMs??Infinity)-(right.createdAtMs??Infinity));
    for(const drop of onMap.slice(0,onMap.length-MAX_GROUND_DROPS_PER_MAP))this.discard(drop);
  }
  private track(drop:GroundDrop):void {
    let ids=this.byMap.get(drop.map);
    if(!ids){ids=new Set();this.byMap.set(drop.map,ids);}
    ids.add(drop.id);
    if(drop.flight)this.trackFlight(drop);
  }
  private trackFlight(drop:GroundDrop):void {
    let flying=this.flyingByMap.get(drop.map);
    if(!flying)this.flyingByMap.set(drop.map,flying=new Set());
    flying.add(drop);
  }
  private untrackFlight(drop:GroundDrop):void {
    const flying=this.flyingByMap.get(drop.map);
    flying?.delete(drop);if(!flying?.size)this.flyingByMap.delete(drop.map);
  }
  private untrack(drop:GroundDrop):void {
    this.untrackFlight(drop);
    const ids=this.byMap.get(drop.map);if(!ids)return;
    ids.delete(drop.id);if(!ids.size)this.byMap.delete(drop.map);
  }
  /** 删除一条掉落并同步地图索引：所有删除路径共用，避免 drops/byMap 失步。 */
  private discard(drop:GroundDrop):void { this.drops.delete(drop.id);this.untrack(drop); }
  private onMap(map:string):GroundDrop[] {
    const ids=this.byMap.get(map);if(!ids)return [];
    const result:GroundDrop[]=[];
    for(const id of ids){const drop=this.drops.get(id);if(drop)result.push(drop);}
    return result;
  }
  addFlying(map:string,origin:{x:number;y:number},landing:{x:number;y:number;direction:number},item:string,durationMs:number):void {
    const [drop]=this.add(map,landing.x,landing.y,[{kind:'item',item,quantity:1}]);
    const flying=this.drops.get(drop.id)!;
    flying.flight={...origin,direction:landing.direction,remainingMs:durationMs,durationMs};
    this.trackFlight(flying);
  }
  advance(map:string,deltaMs:number):void {
    if(!Number.isFinite(deltaMs)||deltaMs<=0)return;
    const flying=this.flyingByMap.get(map);if(!flying)return;
    for(const drop of flying)if(drop.flight){
      drop.flight.remainingMs-=deltaMs;
      if(drop.flight.remainingMs<=0){delete drop.flight;this.untrackFlight(drop);this.revision++;}
    }
  }
  forMap(map:string):GroundDrop[] {return this.onMap(map).map(drop=>structuredClone(drop));}
  /**
   * 进入新地图时清掉其他地图的地面掉落；`retain` 返回 true 的保留（任务/剧情物品）。
   * 只按地图的 id 分组扫一遍，不复制掉落内容；当前地图的掉落完全不动。
   */
  clearOtherMaps(currentMap:string,retain:(drop:GroundDrop)=>boolean):number {
    let removed=0;
    for(const [map,ids] of this.byMap){
      if(map===currentMap)continue;
      for(const id of [...ids]){
        const drop=this.drops.get(id);
        if(!drop||retain(drop))continue;
        this.discard(drop);removed++;
      }
    }
    if(removed)this.revision++;
    return removed;
  }
  /**
   * 所有地图上已产出、尚未拾取的物品数量。
   * 任务掉落用它把地面存货计入有效持有量，避免连续击杀时同一只怪反复产出。
   */
  pendingItemCounts():Map<string,number> {
    const counts=new Map<string,number>();
    for(const drop of this.drops.values()){
      if(drop.reward.kind!=='item')continue;
      counts.set(drop.reward.item,(counts.get(drop.reward.item)??0)+drop.reward.quantity);
    }
    return counts;
  }
  /** 附近 12px 内的落地掉落：只有一张共享背包，谁走过来都能拾取。 */
  collectNearby(map:string,x:number,y:number,collect:(reward:DropReward)=>unknown,availabilityRevision?:number|string):GroundDrop[] {
    const previous=this.pickupCheck;
    if(availabilityRevision!==undefined&&previous?.map===map&&previous.x===x&&previous.y===y&&
      previous.revision===this.revision&&previous.availability===availabilityRevision)return [];
    const checkedRevision=this.revision;
    const nearby:GroundDrop[]=[];
    for(const id of this.byMap.get(map)??[]){
      const drop=this.drops.get(id)!;
      if(!drop.flight&&Math.abs(drop.x-x)<=GROUND_PICKUP_RADIUS_PX&&Math.abs(drop.y-y)<=GROUND_PICKUP_RADIUS_PX)nearby.push(drop);
    }
    const taken:GroundDrop[]=[];
    for(const drop of nearby){
      if(collect(structuredClone(drop.reward))===false)continue;
      this.discard(drop);taken.push(structuredClone(drop));
    }
    if(taken.length)this.revision++;
    this.pickupCheck=availabilityRevision===undefined||this.revision!==checkedRevision+(taken.length?1:0)
      ?undefined:{map,x,y,revision:this.revision,availability:availabilityRevision};
    return taken;
  }
  /**
   * 剧情接管前自动拾取本图全部地面掉落：包括飞行中的魔法宝石和尚未走到的物品。
   * 回调返回 false 时保留该掉落（例如背包拒收或没有可结算的战斗资源）。
   */
  collectAll(map:string,collect:(reward:DropReward)=>unknown):GroundDrop[] {
    const taken:GroundDrop[]=[];
    for(const drop of this.onMap(map)){
      if(collect(structuredClone(drop.reward))===false)continue;
      this.discard(drop);taken.push(structuredClone(drop));
    }
    if(taken.length)this.revision++;
    return taken;
  }
}

const stores=new WeakMap<Session,GroundLootStore>();
export function groundLootFor(session:Session):GroundLootStore {
  let store=stores.get(session);
  if(!store){store=new GroundLootStore();stores.set(session,store);}
  return store;
}
