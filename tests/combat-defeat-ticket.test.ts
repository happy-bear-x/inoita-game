import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { EnemyRoster } from '../src/domain/enemy-roster.ts';
import { PendingEnemyDefeats } from '../src/domain/combat-outcomes.ts';
import { CombatHitResolution } from '../src/domain/combat-hit-resolution.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}},Scenes:{Events:{SHUTDOWN:\'shutdown\'}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
const {WorldScene}=await import('../src/scenes/world-scene.ts');
hook.deregister();

const invoke=(host:object,name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
const battle=JSON.parse(fs.readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
const wolf=battle.enemies.find((enemy:{id:string})=>enemy.id==='enemy-wolf-1');

test('roster reports a zero only after an explicit zero write',()=>{
  const roster=new EnemyRoster();
  const placed=roster.placeEnemy(wolf.id,0,0);
  assert.equal(roster.hasZeroHealth(placed.key),false,'未写入过血量按满血处理');
  roster.setEnemyHealth(placed.key,0,wolf);
  assert.equal(roster.hasZeroHealth(placed.key),true);
  roster.setEnemyHealth(placed.key,1,wolf);
  assert.equal(roster.hasZeroHealth(placed.key),false);
});

test('restore and spawn boundaries open a ticket only for zero-health enemies',()=>{
  const zero={key:'zero',definition:{id:'enemy-wolf-1'},visual:{container:{x:0,y:0}}};
  const live={key:'live',definition:{id:'enemy-wolf-1'},visual:{container:{x:0,y:0}}};
  const calls:[string,string][]=[];
  const host=Object.setPrototypeOf({
    roster:{enemies:[{key:'zero',health:0},{key:'live'}],
      enemy(key:string){return this.enemies.find((entry:{key:string})=>entry.key===key);}},
    arena:[zero,live],closed:false,
    beginEnemyDefeat:(enemy:{key:string},cause:string)=>{calls.push([enemy.key,cause]);return true;}
  },WorldCombat.prototype);
  invoke(host,'reconcileZeroHealthEnemies','restored');
  assert.deepEqual(calls,[['zero','restored']]);
  calls.length=0;
  invoke(host,'reconcileZeroHealthEnemies','spawned',['live','zero']);
  assert.deepEqual(calls,[['zero','spawned']]);
});

test('zero-health and awaiting-defeat enemies stay out of the combatant list',()=>{
  const collision={x:0,y:0,width:8,height:8};
  const visual={container:{active:true},actor:{collision}};
  const enemy={key:'zero',definition:{id:'enemy-wolf-1'},visual};
  const host=(zero:boolean,awaiting:boolean)=>Object.setPrototypeOf({
    pendingDefeats:{has:()=>false},memberOf:()=>undefined,activeParty:[],allies:[],
    app:{session:{combatTick:0}},
    visualOf:(id:string)=>id==='zero'?visual:undefined,
    roster:{hasZeroHealth:()=>zero,isPresent:()=>true},arena:[enemy],
    hitResolution:{isAwaitingDefeat:()=>awaiting},
    conditions:{revision:0,activeStates:()=>[]},
    movement:{position:()=>({x:0,y:0}),actor:()=>({shape:()=>({collision})})},
    scene:{facing:'south'}
  },WorldCombat.prototype);
  assert.deepEqual(invoke(host(true,false),'combatants'),[],'0 血敌人不能进入候选名单');
  assert.deepEqual(invoke(host(false,true),'combatants'),[],'同串命中里等待死亡结算的敌人也不能进入候选名单');
  assert.equal((invoke(host(false,false),'combatants') as unknown[]).length,1,'正常敌人照常返回');
  assert.ok(invoke(host(true,false),'combatant','zero'),'单点查询不按血量过滤，保留反伤与友方救援语义');
});

test('a lethal hit opens one defeat ticket through the shared entry',()=>{
  const target={key:'wolf',definition:{id:'enemy-wolf-1'},visual:{container:{x:3,y:4}}};
  const state={health:10,maxHealth:10,level:3,elite:false};
  const calls:unknown[]=[];
  const host=Object.setPrototypeOf({
    closed:false,pendingDefeats:new PendingEnemyDefeats(),
    conditions:{canLoseHealth:()=>true,removeState(){}},
    app:{session:{storyWorld:{visible:()=>true},isOneHitKill:()=>false,enemyVitals:()=>({})},director:undefined},
    memberOf:()=>undefined,
    roster:{isPresent:()=>true,enemySnapshot:()=>({...state}),setEnemyHealth:()=>{state.health=0;}},
    hitResolution:new CombatHitResolution(),
    beginEnemyDefeat:(enemy:{key:string},cause:string,before:unknown,caster:string)=>{
      calls.push([enemy.key,cause,before,caster]);return true;
    },
    showHit(){},diagnosticHits:0,diagnosticTotalHits:0,diagnosticDamageDealt:0,diagnosticTotalDamageDealt:0,
    combatantsCache:{tick:0,revision:0,value:[]},
    dealtDamage:new Set(),threat:undefined
  },WorldCombat.prototype);
  const hero={level:3};
  host.hitResolution.run(()=>invoke(host,'settleHit',{casterId:'player',targetId:'wolf'},{kind:'hit',damage:10},hero,target));
  assert.equal(calls.length,1,'致死命中只开一张死亡单');
  assert.equal(host.combatantsCache,undefined,'致死命中立刻让候选名单缓存失效');
  assert.deepEqual(calls[0],['wolf','hit',{health:10,maxHealth:10,level:3,elite:false},'player']);
  host.hitResolution.run(()=>invoke(host,'settleHit',{casterId:'player',targetId:'wolf'},{kind:'hit',damage:10},hero,target));
  assert.equal(calls.length,1,'已经 0 血的敌人不会重复开单');
});

test('save settlement flushes the queue before capturing',()=>{
  let flushes=0;
  const host=Object.setPrototypeOf({pendingDefeats:{flush(){flushes++;}},partyDefeatWork:new Map(),
    roster:{enemies:[]},arena:[],closed:false},WorldCombat.prototype);
  host.settleForSave();
  assert.equal(flushes,1);
});

test('rollback discards pending defeats without settling them',()=>{
  const settled:string[]=[],cancelled:string[]=[],runtimeCancelled:string[]=[];
  const host=Object.setPrototypeOf({
    pendingDefeats:{keys:()=>['wolf','bat'],clear(){settled.push('cleared');}},
    outcomes:{cancelDeath:(key:string)=>cancelled.push(key)},
    runtime:{cancel:(key:string)=>runtimeCancelled.push(key)},
    partyDefeatWork:new Map([['player',()=>settled.push('party')]]),
    combatantsCache:{}
  },WorldCombat.prototype);
  invoke(host,'discardPendingDefeats');
  assert.deepEqual(cancelled,['wolf','bat'],'取消消散表现');
  assert.deepEqual(runtimeCancelled,['defeat:wolf','defeat:bat'],'取消排定的结算');
  assert.deepEqual(settled,['cleared'],'不执行死亡结算');
  assert.equal(host.combatantsCache,undefined);
});

test('checkpoints settle pending defeats before capturing session and world',()=>{
  let flushed=0,captured=0;
  const host=Object.setPrototypeOf({
    app:{pressureMode:false,session:{debugFocusQuest:false,hasWaitingStoryRun:false,hasLivingMember:true},
      gm:undefined,checkpoint:{available:false,capture:()=>{captured++;return true;}}},
    combat:{settleForSnapshot:()=>{flushed++;}},
    worldReady:()=>true,map:{id:'camp'},movement:{position:()=>({x:0,y:0})},player:{},
    captureStoryWorld:()=>({location:{map:'camp'},generatedEntities:[]}),
    checkpointWaitLogged:false,checkpointPending:true
  },WorldScene.prototype);
  assert.equal(Reflect.get(WorldScene.prototype,'captureCheckpoint').call(host),true);
  assert.equal(flushed,1,'捕获检查点前先结算死亡单');
  assert.equal(captured,1);
});
