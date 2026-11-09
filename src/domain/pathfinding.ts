import type { GameRectangle, Point } from './navigation.ts';

export const PATH_GRID_SIZE = 8;

export interface PathQuery {
  bounds: GameRectangle;
  canStand(position: Point): boolean;
  /** 数值入口：有它时搜索不再为每个采样点创建 Point。 */
  canStandXY?(x: number, y: number): boolean;
  isGoal(position: Point): boolean;
  /** 到任意可接受终点的距离下界，单位为像素。 */
  heuristic(position: Point): number;
}

export type PathSearchResult = (
  {status:'pending'} | {status:'unreachable'} | {status:'found';path:Point[]}
) & {
  /** 本次取出的搜索节点数，包含已过期的队列项；不超过本次预算。 */
  expanded:number;
};

export interface PathSearch {
  /** 跨帧调用时，查询函数必须始终读取创建任务时的同一份地图与目标快照。 */
  step(maxExpanded:number):PathSearchResult;
}

/** 路段沿途检查实体范围；斜行还检查两个相邻方向，禁止从障碍角穿过。 */
export function canTraverse(from: Point, to: Point, canStand: (point: Point) => boolean): boolean {
  const dx=to.x-from.x,dy=to.y-from.y;
  const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/4));
  for(let i=1;i<=steps;i++) {
    const point={x:from.x+dx*i/steps,y:from.y+dy*i/steps};
    const previous={x:from.x+dx*(i-1)/steps,y:from.y+dy*(i-1)/steps};
    if(!canStand(point))return false;
    if(dx&&dy&&(!canStand({x:point.x,y:previous.y})||!canStand({x:previous.x,y:point.y})))return false;
  }
  return true;
}

/** 八邻接 A*。每次保留搜索前沿，预算耗尽时等待下一步，不能视为无路。 */
export function createPathSearch(start:Point,query:PathQuery):PathSearch {
  const bounds={...query.bounds};
  const columns=Math.floor(bounds.width/PATH_GRID_SIZE)+1;
  // 通行缓存按 0.25 像素量化成整数键；采样点都是有限的小坐标，整数键不会撞车。
  const standability=new Map<number,boolean>();
  const standKey=(x:number,y:number)=>Math.round((x-bounds.x)*4+4096)*1_000_000+Math.round((y-bounds.y)*4+4096);
  const canStandXY=(x:number,y:number)=>{
    const key=standKey(x,y);
    let result=standability.get(key);
    if(result===undefined){result=query.canStandXY?query.canStandXY(x,y):query.canStand({x,y});standability.set(key,result);}
    return result;
  };
  const canTraverseXY=(fromX:number,fromY:number,toX:number,toY:number)=>{
    const dx=toX-fromX,dy=toY-fromY;
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/4));
    for(let i=1;i<=steps;i++){
      const x=fromX+dx*i/steps,y=fromY+dy*i/steps;
      const previousX=fromX+dx*(i-1)/steps,previousY=fromY+dy*(i-1)/steps;
      if(!canStandXY(x,y))return false;
      if(dx&&dy&&(!canStandXY(x,previousY)||!canStandXY(previousX,y)))return false;
    }
    return true;
  };
  const pointOf=(key:number):Point=>key===-1?{...start}:{x:bounds.x+(key%columns)*PATH_GRID_SIZE,y:bounds.y+Math.floor(key/columns)*PATH_GRID_SIZE};
  const inBounds=(x:number,y:number)=>x>=bounds.x&&y>=bounds.y&&x<=bounds.x+bounds.width&&y<=bounds.y+bounds.height;
  const column=(start.x-bounds.x)/PATH_GRID_SIZE,row=(start.y-bounds.y)/PATH_GRID_SIZE;
  const aligned=Number.isInteger(column)&&Number.isInteger(row);
  const originKey=aligned?Math.round(row)*columns+Math.round(column):-1;
  const costs=new Map<number,number>([[originKey,0]]);
  const parents=new Map<number,number>();
  // 堆里同时保存每个条目的代价和分数；旧条目保留入堆时的分数，和原先 Node 堆的顺序一致。
  const heapKeys:number[]=[],heapCosts:number[]=[],heapScores:number[]=[];
  const push=(key:number,cost:number,score:number)=>{
    heapKeys.push(key);heapCosts.push(cost);heapScores.push(score);
    let index=heapKeys.length-1;
    while(index>0){
      const parent=(index-1)>>1;
      if(heapScores[parent]<=score)break;
      heapKeys[index]=heapKeys[parent];heapCosts[index]=heapCosts[parent];heapScores[index]=heapScores[parent];
      index=parent;
    }
    heapKeys[index]=key;heapCosts[index]=cost;heapScores[index]=score;
  };
  let poppedKey=0,poppedCost=0;
  const pop=()=>{
    poppedKey=heapKeys[0];poppedCost=heapCosts[0];
    const lastKey=heapKeys.pop()!,lastCost=heapCosts.pop()!,lastScore=heapScores.pop()!;
    if(heapKeys.length){
      let index=0;
      while(index*2+1<heapKeys.length){
        let child=index*2+1;
        if(child+1<heapKeys.length&&heapScores[child+1]<heapScores[child])child++;
        if(lastScore<=heapScores[child])break;
        heapKeys[index]=heapKeys[child];heapCosts[index]=heapCosts[child];heapScores[index]=heapScores[child];
        index=child;
      }
      heapKeys[index]=lastKey;heapCosts[index]=lastCost;heapScores[index]=lastScore;
    }
  };
  push(originKey,0,query.heuristic(start));
  let completed:{status:'unreachable'}|{status:'found';path:Point[]}|undefined;
  const result=(expanded:number):PathSearchResult=>completed?.status==='found'
    ?{status:'found',path:completed.path.map(point=>({...point})),expanded}
    :{status:completed?.status??'pending',expanded};
  return {step(maxExpanded){
    if(maxExpanded!==Infinity&&(!Number.isSafeInteger(maxExpanded)||maxExpanded<0))throw new RangeError('寻路节点预算必须是非负整数');
    if(completed)return result(0);
    let expanded=0;
    while(heapKeys.length&&expanded<maxExpanded){
      pop();expanded++;
      const currentKey=poppedKey,currentCost=poppedCost;
      if(currentCost!==costs.get(currentKey))continue;
      const currentPoint=pointOf(currentKey);
      if(query.isGoal(currentPoint)){
        const path:Point[]=[];
        let key=currentKey;
        while(key!==-1){
          const parent=parents.get(key);
          if(parent===undefined)break;
          path.push(pointOf(key));key=parent;
        }
        completed={status:'found',path:path.reverse()};
        return result(expanded);
      }
      if(currentKey===-1&&!aligned){
        const columnsAround=[...new Set([Math.floor(column),Math.ceil(column)])];
        const rowsAround=[...new Set([Math.floor(row),Math.ceil(row)])];
        for(const nextColumn of columnsAround)for(const nextRow of rowsAround){
          const x=bounds.x+nextColumn*PATH_GRID_SIZE,y=bounds.y+nextRow*PATH_GRID_SIZE;
          if(!inBounds(x,y))continue;
          const key=nextRow*columns+nextColumn;
          const cost=currentCost+Math.hypot(x-currentPoint.x,y-currentPoint.y);
          if(cost>=(costs.get(key)??Infinity))continue;
          if(!canTraverseXY(currentPoint.x,currentPoint.y,x,y))continue;
          costs.set(key,cost);parents.set(key,currentKey);
          push(key,cost,cost+query.heuristic({x,y}));
        }
        continue;
      }
      for(const [dx,dy] of [[0,-1],[-1,0],[1,0],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]] as const){
        const x=currentPoint.x+dx*PATH_GRID_SIZE,y=currentPoint.y+dy*PATH_GRID_SIZE;
        if(!inBounds(x,y))continue;
        const key=currentKey+dx+dy*columns;
        const cost=currentCost+Math.hypot(dx*PATH_GRID_SIZE,dy*PATH_GRID_SIZE);
        if(cost>=(costs.get(key)??Infinity))continue;
        if(dx&&dy&&(!canStandXY(x,currentPoint.y)||!canStandXY(currentPoint.x,y)))continue;
        if(!canTraverseXY(currentPoint.x,currentPoint.y,x,y))continue;
        costs.set(key,cost);parents.set(key,currentKey);
        push(key,cost,cost+query.heuristic({x,y}));
      }
    }
    if(!heapKeys.length)completed={status:'unreachable'};
    return result(expanded);
  }};
}

/** 同步查询沿用同一搜索核、枚举顺序与斜角检查，一次完成全部搜索。 */
export function findPath(start:Point,query:PathQuery,maxExpanded=Infinity):Point[]|null {
  const result=createPathSearch(start,query).step(maxExpanded);
  return result.status==='found'?result.path:null;
}
