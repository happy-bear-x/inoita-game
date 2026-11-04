import assert from 'node:assert/strict';
import test from 'node:test';
import {canTraverse,createPathSearch,findPath,type PathQuery,type PathSearchResult} from '../src/domain/pathfinding.ts';
import {NavigationWorld,type NavigationActor,type NavigationFaction} from '../src/domain/navigation-world.ts';
import {PathBudget} from '../src/domain/path-budget.ts';
import type {Point} from '../src/domain/navigation.ts';

const bounds={x:0,y:0,width:64,height:64};
function query(goal:Point,blocked:(point:Point)=>boolean=()=>false):PathQuery {
  return {bounds:{...bounds},canStand:point=>point.x>=0&&point.y>=0&&point.x<=64&&point.y<=64&&!blocked(point),
    isGoal:point=>point.x===goal.x&&point.y===goal.y,heuristic:point=>Math.hypot(point.x-goal.x,point.y-goal.y)};
}
function finish(search:ReturnType<typeof createPathSearch>,budget:number):PathSearchResult {
  for(let frame=0;frame<10000;frame++){
    const result=search.step(budget);
    assert.ok(result.expanded<=budget,'每次调用都必须遵守节点预算');
    if(result.status!=='pending')return result;
  }
  assert.fail('搜索未能结束');
}

test('slicing retains existing A* route order for open ground, walls, corners and non-grid starts',()=>{
  // 路径来自改造前的同步入口，固定次序也能发现等长路线的枚举变化。
  const fixtures=[
    {start:{x:8,y:8},goal:{x:40,y:40},blocked:()=>false,path:[[16,16],[24,24],[32,32],[40,40]]},
    {start:{x:8,y:8},goal:{x:40,y:8},blocked:(p:Point)=>p.x===24&&p.y<40,
      path:[[16,16],[16,24],[16,32],[16,40],[24,40],[32,40],[32,32],[40,24],[40,16],[40,8]]},
    {start:{x:11,y:13},goal:{x:40,y:40},blocked:()=>false,path:[[16,16],[24,24],[32,32],[40,40]]},
    {start:{x:8,y:8},goal:{x:16,y:16},blocked:(p:Point)=>(p.x>=12&&p.x<=20&&p.y>=4&&p.y<=12)||
      (p.x>=4&&p.x<=12&&p.y>=12&&p.y<=20),path:[[0,8],[0,16],[0,24],[8,24],[16,24],[16,16]]},
    {start:{x:8,y:8},goal:{x:40,y:8},blocked:(p:Point)=>p.x>=22&&p.x<=26,path:null},
  ];
  for(const fixture of fixtures){
    const expected=fixture.path?.map(([x,y])=>({x,y}))??null;
    assert.deepEqual(findPath(fixture.start,query(fixture.goal,fixture.blocked)),expected);
    for(const budget of [1,2,7,64]){
      const result=finish(createPathSearch(fixture.start,query(fixture.goal,fixture.blocked)),budget);
      assert.deepEqual(result.status==='found'?result.path:null,expected);
    }
  }
});

test('a spent budget stays pending until the search can prove found or unreachable',()=>{
  const search=createPathSearch({x:8,y:8},query({x:40,y:8},p=>p.x>=22&&p.x<=26));
  assert.deepEqual(search.step(0),{status:'pending',expanded:0});
  assert.deepEqual(search.step(1),{status:'pending',expanded:1});
  const completed=finish(search,1);
  assert.equal(completed.status,'unreachable');
  assert.deepEqual(search.step(64),{status:'unreachable',expanded:0});
  for(const invalid of [-1,NaN,1.5,-Infinity])assert.throws(()=>search.step(invalid),RangeError);
});

test('completed tasks expose independent route points and do not repeat queries',()=>{
  let calls=0;
  const goal={x:40,y:40},original=query(goal);
  const search=createPathSearch({x:8,y:8},{...original,isGoal:point=>{calls++;return original.isGoal(point);}});
  const result=finish(search,2);
  assert.equal(result.status,'found');
  if(result.status!=='found')return;
  const expected=structuredClone(result.path),finishedCalls=calls;
  result.path[0].x=-100;
  const repeated=search.step(0);
  assert.deepEqual(repeated,{status:'found',path:expected,expanded:0});
  assert.equal(calls,finishedCalls);
  const alreadyThere=createPathSearch(goal,query(goal)).step(1);
  assert.deepEqual(alreadyThere,{status:'found',path:[],expanded:1});
});

test('navigation snapshots freeze own shape and dynamic occupancies while sharing the read-only terrain',()=>{
  const map={name:'snapshot',tileSize:8,columns:16,rows:16,blocked:Array<boolean>(256).fill(false)};
  map.blocked[6*16+6]=true;
  const world=new NavigationWorld(map);
  assert.equal(Object.isFrozen(map.blocked),true,'地形在构造时冻结，后续寻路直接共享');
  const ownPosition={x:16,y:16},ownCollision={x:-4,y:-4,width:8,height:8};
  const obstaclePosition={x:64,y:64},obstacleCollision={x:-4,y:-4,width:8,height:8};
  let obstacleEnabled=true,hiddenEnabled=false;
  const actor:NavigationActor={shape:()=>({collision:ownCollision}),position:()=>ownPosition,enabled:()=>true};
  const obstacle:NavigationActor={shape:()=>({collision:obstacleCollision}),position:()=>obstaclePosition,enabled:()=>obstacleEnabled};
  const hidden:NavigationActor={shape:()=>({collision:{x:-4,y:-4,width:8,height:8}}),position:()=>({x:80,y:80}),enabled:()=>hiddenEnabled};
  world.register(actor);const unregister=world.register(obstacle);world.register(hidden);
  const snapshot=world.captureStandability(actor);
  assert.equal(snapshot.canStand(ownPosition),true,'自身不阻挡查询');
  ownPosition.x=120;ownCollision.width=40;obstaclePosition.x=112;obstacleCollision.x=-40;obstacleEnabled=false;hiddenEnabled=true;
  world.bounds.width=64;unregister();
  world.register({shape:()=>({collision:{x:-4,y:-4,width:8,height:8}}),position:()=>({x:96,y:96}),enabled:()=>true});
  assert.deepEqual(snapshot.start,{x:16,y:16});
  assert.equal(snapshot.bounds.width,128);
  assert.equal(snapshot.terrain,map,'快照直接共享地形，不再复制 blocked');
  assert.equal(snapshot.canStand({x:64,y:64}),false,'已移动、禁用及注销的障碍仍保留捕获时占位');
  assert.equal(snapshot.canStand({x:80,y:80}),true,'捕获时隐藏的实体不参与查询');
  assert.equal(snapshot.canStand({x:96,y:96}),true,'后注册的实体不参与旧查询');
  assert.equal(snapshot.canStand({x:48,y:48}),false,'共享的阻挡格对快照和实时查询一致');
  assert.equal(snapshot.canStand({x:112,y:32}),true,'捕获后的边界与自身形状变化不改变旧查询');
  assert.equal(world.canStand(actor,{x:48,y:48}),false,'实时查询读同一份只读地形');
});

test('an unvisited point uses frozen occupancy and completed routes are checked against live movement',()=>{
  const world=new NavigationWorld({name:'frame',bounds:{x:0,y:0,width:160,height:160}});
  const start={x:16,y:16},target={x:128,y:128};
  const actor:NavigationActor={shape:()=>({collision:{x:-4,y:-4,width:8,height:8}}),position:()=>start,enabled:()=>true};
  const obstaclePosition={x:120,y:40};
  const obstacle:NavigationActor={shape:()=>({collision:{x:-4,y:-4,width:8,height:8}}),position:()=>obstaclePosition,enabled:()=>true};
  world.register(actor);world.register(obstacle);
  const snapshot=world.captureStandability(actor);
  const search=createPathSearch(snapshot.start,{bounds:snapshot.bounds,canStand:snapshot.canStand,
    isGoal:point=>point.x===target.x&&point.y===target.y,heuristic:point=>Math.hypot(point.x-target.x,point.y-target.y)});
  assert.equal(search.step(1).status,'pending');
  obstaclePosition.x=64;obstaclePosition.y=64;
  const completed=finish(search,1);
  assert.equal(completed.status,'found');
  if(completed.status!=='found')return;
  assert.ok(completed.path.some(point=>point.x===64&&point.y===64),'后续尚未展开的位置也必须使用冻结占位');
  let previous=snapshot.start;
  const liveRouteClear=completed.path.every(point=>{
    const allowed=canTraverse(previous,point,p=>world.canStand(actor,p));previous=point;return allowed;
  });
  assert.equal(liveRouteClear,false,'旧快照路线不能绕过当前动态碰撞检查');
});

function registerActor(world:NavigationWorld,team:NavigationFaction,
  collision:{x:number;y:number;width:number;height:number},position:Point,
  options:{enabled?:boolean;ghost?:boolean;bodyless?:boolean}={}):NavigationActor {
  const actor:NavigationActor={shape:()=>options.bodyless?{}:{collision},position:()=>position,
    enabled:()=>options.enabled??true,faction:()=>team};
  if(options.ghost)actor.ghost=()=>true;
  world.register(actor);
  return actor;
}

test('the 16px occupancy broad phase matches precise live standability at capture time',()=>{
  const tileSize=8,columns=28,rows=28;
  const blocked=new Array<boolean>(columns*rows).fill(false);
  // 贴墙与拐角：整列墙留一个缺口，外加一段不靠边的横墙。
  for(let row=0;row<rows;row++)if(row!==9)blocked[row*columns+12]=true;
  for(let col=0;col<columns;col++)if(col<16||col>20)blocked[18*columns+col]=true;
  const world=new NavigationWorld({name:'standability-equivalence',tileSize,columns,rows,blocked});
  const small=registerActor(world,'party',{x:-8,y:-8,width:16,height:16},{x:100,y:60});
  // 同阵营不阻挡：这个队友与 small 的路径完全重叠。
  registerActor(world,'party',{x:-8,y:-8,width:16,height:16},{x:92,y:60});
  // 人群缝隙：两只敌人之间只剩 4px，16px 的身体怎么站都会压到其中一只。
  registerActor(world,'hostile',{x:-8,y:-8,width:16,height:16},{x:76,y:156});
  registerActor(world,'hostile',{x:-8,y:-8,width:16,height:16},{x:96,y:156});
  // 大碰撞盒跨多个 16px 桶。
  registerActor(world,'neutral',{x:-24,y:-16,width:48,height:32},{x:150,y:40});
  registerActor(world,'hostile',{x:-16,y:-16,width:32,height:32},{x:56,y:120});
  registerActor(world,'hostile',{x:-8,y:-8,width:16,height:16},{x:40,y:40},{enabled:false});
  registerActor(world,'hostile',{x:-8,y:-8,width:16,height:16},{x:60,y:60},{ghost:true});
  const big=registerActor(world,'party',{x:-24,y:-16,width:48,height:32},{x:140,y:120});
  const ghost=registerActor(world,'party',{x:-8,y:-8,width:16,height:16},{x:20,y:20},{ghost:true});
  const bodyless=registerActor(world,'party',{x:0,y:0,width:0,height:0},{x:20,y:20},{bodyless:true});
  let compared=0;
  for(const actor of [small,big,ghost,bodyless]){
    const snapshot=world.captureStandability(actor);
    for(let x=-12;x<=world.bounds.width+12;x+=4)for(let y=-12;y<=world.bounds.height+12;y+=4){
      const point={x,y};
      assert.equal(snapshot.canStand(point),world.canStand(actor,point),`(${x},${y}) 的通行判定必须与精确判定一致`);
      compared++;
    }
  }
  assert.ok(compared>10000,'采样要覆盖地图边界、贴墙和人群缝隙');
});

test('the shared path budget reserves a per-initiator slice so later searchers are not starved',()=>{
  const budget=new PathBudget(512);
  // 首帧没有历史：按 4 个发起者预留，队伍一次请求 384 也只能拿 128。
  assert.equal(budget.take('party',384),128);
  assert.equal(budget.take('party',384),0,'同一发起者本帧的份额已经用完');
  assert.equal(budget.take('enemy-1',1024),128);
  assert.equal(budget.take('enemy-2',1024),128);
  assert.equal(budget.take('enemy-3',1024),128);
  assert.equal(budget.take('enemy-4',1024),0,'每帧总量仍是 512');
  budget.reset();
  const owners=['party','enemy-1','enemy-2','enemy-3','enemy-4'];
  const grants=owners.map(owner=>budget.take(owner,1024));
  assert.ok(grants.every(grant=>grant===102),`上一帧的每个发起者这一帧都有均分份额：${grants}`);
  const late=budget.take('late-joiner',1024);
  assert.equal(grants.reduce((total,grant)=>total+grant,0)+late,512,'新人不能突破每帧总上限');

  const many=new PathBudget(512),searchers=Array.from({length:10},(_,index)=>`searcher-${index}`);
  for(let frame=0;frame<6;frame++){
    many.reset();
    const frameGrants=searchers.map(owner=>many.take(owner,512));
    assert.ok(frameGrants.reduce((total,grant)=>total+grant,0)<=512,'每帧总上限不变');
    if(frame>0)assert.ok(frameGrants.every(grant=>grant>0),`第 ${frame+1} 帧每个搜索者都能推进`);
  }
});

test('a party member and a friendly summon plan concurrently from frozen views while sharing the budget',()=>{
  const world=new NavigationWorld({name:'concurrent-planning',bounds:{x:0,y:0,width:160,height:160}});
  const blockerPosition={x:80,y:80};
  const party=registerActor(world,'party',{x:-8,y:-8,width:16,height:16},{x:16,y:16});
  const summon=registerActor(world,'party',{x:-8,y:-8,width:16,height:16},{x:16,y:144});
  registerActor(world,'hostile',{x:-8,y:-8,width:16,height:16},blockerPosition);
  const tasks=[{owner:'companion',view:world.captureStandability(party),goal:{x:144,y:16}},
    {owner:'summon',view:world.captureStandability(summon),goal:{x:144,y:144}}].map(task=>({...task,done:false,
    search:createPathSearch(task.view.start,{bounds:task.view.bounds,canStand:task.view.canStand,
      isGoal:(point:Point)=>point.x===task.goal.x&&point.y===task.goal.y,
      heuristic:(point:Point)=>Math.hypot(point.x-task.goal.x,point.y-task.goal.y)})}));
  const budget=new PathBudget(12);
  let frames=0;
  while(frames<400&&tasks.some(task=>!task.done)){
    budget.reset();frames++;
    for(const task of tasks){
      if(task.done)continue;
      const granted=budget.take(task.owner,8);
      assert.ok(granted>0,`${task.owner} 每一帧都应该分到预算`);
      if(task.search.step(granted).status!=='pending')task.done=true;
    }
  }
  assert.ok(tasks.every(task=>task.done),`队友和召唤物都应在 ${frames} 帧内算出路径`);
  // 捕获之后才移动的障碍只影响实时世界，已经开始的搜索仍读冻结占位。
  blockerPosition.x=112;
  assert.equal(tasks[0].view.canStand({x:80,y:80}),false,'冻结快照仍保留捕获时的占位');
  assert.equal(world.canStand(party,{x:80,y:80}),true,'实时世界已经看到障碍移开');
});
