import type { SkillCharge } from './battle.ts';
import type { Combatant } from './combat.ts';
import type { Point } from './navigation.ts';
import { attackDistance } from './basic-attack.ts';

const MAX_PATH_SEARCH_STEPS = 101;
const MAX_VERIFY_ATTEMPTS = 2;

export interface ChargePlan { destination: Point; close: boolean }

/** 查找可达的近敌落点。场景提供物理世界的占用查询，规则只处理网格路径。 */
export function planCharge(caster: Combatant, target: Combatant, charge: SkillCharge,
  canStand: (point: Point) => boolean,
  canReach: (point: Point) => boolean = () => true,
  verify: (point: Point) => boolean = () => true): ChargePlan | undefined {
  if (attackDistance(caster.position,caster.bounds,target.position,target.bounds)-2 < charge.closeDistanceUnits) {
    return {destination:{...caster.position},close:true};
  }
  const size=charge.gridSizePx;
  const start={x:Math.floor(caster.position.x/size),y:Math.floor(caster.position.y/size)};
  const goal={x:Math.floor(target.position.x/size),y:Math.floor(target.position.y/size)};
  const distance=(p:Point)=>Math.abs(p.x-goal.x)+Math.abs(p.y-goal.y);
  const key=(p:Point)=>`${p.x},${p.y}`;
  const open=[{...start,cost:0}], costs=new Map([[key(start),0]]);
  let verifyAttempts=0;
  for(let visited=0;open.length&&visited<MAX_PATH_SEARCH_STEPS;visited++){
    open.sort((a,b)=>(a.cost+distance(a))-(b.cost+distance(b)));
    const current=open.shift()!;
    if(current.cost!==costs.get(key(current)))continue;
    const destination={x:current.x*size,y:current.y*size};
    if(distance(current)<=charge.stoppingDistanceUnits&&canStand(destination)&&canReach(destination)){
      // 搜索中即时复核：通过就用这个点，不通过就继续找下一个。
      if(verifyAttempts>=MAX_VERIFY_ATTEMPTS)break;
      verifyAttempts++;
      if(verify(destination))return {destination,close:false};
    }
    for(const [dx,dy] of [[-1,0],[0,-1],[0,1],[1,0]]){
      const next={x:current.x+dx,y:current.y+dy,cost:current.cost+1};
      if(next.cost>=(costs.get(key(next))??Infinity))continue;
      const point={x:next.x*size,y:next.y*size};
      if(!canStand(point)||!canReach(point))continue;
      costs.set(key(next),next.cost);open.push(next);
    }
  }
  return forwardFallback(caster,target,charge,canStand);
}

/** 朝目标方向逐格退到最远的可站点；原地也站不住时返回 undefined。 */
function forwardFallback(caster: Combatant, target: Combatant, charge: SkillCharge,
  canStand: (point: Point) => boolean): ChargePlan | undefined {
  if(!canStand(caster.position))return undefined;
  const dx=target.position.x-caster.position.x, dy=target.position.y-caster.position.y;
  const distance=Math.hypot(dx,dy);
  if(distance<=0)return {destination:{...caster.position},close:false};
  const step=charge.gridSizePx;
  const steps=Math.floor(distance/step);
  let landing={...caster.position};
  for(let index=1;index<=steps;index++){
    const point={x:caster.position.x+dx/distance*step*index,y:caster.position.y+dy/distance*step*index};
    if(!canStand(point))break;
    landing=point;
  }
  return {destination:landing,close:false};
}
