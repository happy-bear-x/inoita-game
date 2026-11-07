import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {BattleCatalog} from '../src/domain/battle.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const thresholds=[170,230,270,290,310,330,350,370];

test('eight ranks carry the trigger chance and no fallback action is exported',()=>{
  catalog.skills['god-of-justice'].reactionsByRank!.forEach((rank,index)=>
    assert.deepEqual(rank,[{kind:'god-of-justice',chanceThreshold:thresholds[index]}],`rank ${index+1}`));
  assert.deepEqual(catalog.skills['god-of-justice'].passiveUnits,[]);
  // 私有动作 188 的动作行 +8 是 0xff：ACTTRANSSYSTEM_Make 直接返回，既无过渡也无 Direct，
  // 所以未学天之怒雷时没有可执行的追加动作，内容里也不该再留这份导出。
  assert.equal(catalog.skills['god-of-justice'].followUpAction,undefined);
});

/** 只装配判定要用到的部分：已学等级、施法者与敌人、被替换的单元执行和定时器。 */
function fixture(level=1,{celestial}:{celestial?:number}={}){
  const levels:{[id:string]:number}={ 'god-of-justice':level };
  if(celestial!==undefined)levels['celestial-lightning']=celestial;
  const draft=()=>({levels:{...levels}});
  const member={classId:'priest',panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}},skills:{draft}};
  const casts:{cueIndex:number;targetId:string;id:string;level:number}[]=[];
  const castRows=()=>casts.map(cast=>[cast.cueIndex,cast.targetId,cast.id,cast.level] as const);
  const strikes:{casterId:string;count:number}[]=[];
  const timers:{ms:number;callback:()=>void}[]=[];
  const actor=(id:string,x:number)=>({id,team:id==='player'?'party':'hostile',position:{x,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  const roster=[actor('player',0),actor('enemy',64)];
  const host=Object.setPrototypeOf({
    app:{battleCatalog:catalog,session:{skills:{draft}}},
    memberOf:(id:string)=>id==='player'?member:undefined,
    combatant:(id:string)=>roster.find(entry=>entry.id===id),
    combatants:()=>roster,
    partyBuffSlots:()=>[],
    actorAttribute:()=>0,
    healScoreFor:()=>undefined,
    healCandidates:()=>[],
    presenterFor:()=>({playCasterStrikes:(casterId:string,strikes0:{offsets:unknown[]})=>
      strikes.push({casterId,count:strikes0.offsets.length}),showUnitFeedback:()=>{}}),
    skillUnit:(event:{cueIndex:number;targetId:string;skill:{id:string;level:number}})=>{
      casts.push({cueIndex:event.cueIndex,targetId:event.targetId,id:event.skill.id,level:event.skill.level});
      return 'success';
    },
    dispatcherFor:()=>({casterStrikes:(casterId:string,strikes0:{offsets:unknown[]})=>strikes.push({casterId,count:strikes0.offsets.length})}),
    runtime:{schedule:(_owner:string,frames:number,callback:()=>void)=>{timers.push({ms:frames*60,callback});return ()=>{};}},
    scene:{time:{delayedCall:(ms:number,callback:()=>void)=>{timers.push({ms,callback});return {remove(){}};}}},
    closed:false,defeated:false,
  },WorldCombat.prototype);
  const fire=(casterId='player')=>method('godOfJusticeReaction').call(host,casterId,'enemy');
  const runTimers=()=>{const pending=[...timers];timers.length=0;for(const timer of pending)timer.callback();};
  return {host,fire,casts,castRows,strikes,timers,runTimers};
}

/** 让判定抽到第 n 点（1…999）：原版掷整数 1…999，严格小于阈值才触发。 */
const roll=(point:number)=>()=>(point-0.5)/999;

test('the threshold gates the roll for every rank',()=>{
  const original=Math.random;
  try{
    for(const [index,threshold] of thresholds.entries()){
      const run=fixture(index+1,{celestial:1});
      Math.random=roll(threshold);
      run.fire();assert.deepEqual(run.strikes,[],`${index+1} 级阈值 ${threshold}：抽到它本身不触发`);
      Math.random=roll(threshold-1);
      run.fire();assert.equal(run.strikes.length,1,`${index+1} 级差一点就触发`);
    }
  }finally{Math.random=original;}
});

test('an unlearned Celestial Lightning produces nothing, not even the private action',()=>{
  const original=Math.random;
  try{
    const unlearned=fixture(8);
    Math.random=roll(1);
    unlearned.fire();
    assert.deepEqual(unlearned.casts,[]);assert.deepEqual(unlearned.strikes,[]);assert.deepEqual(unlearned.timers,[]);
    const unranked=fixture(0,{celestial:5});
    unranked.fire();assert.deepEqual(unranked.casts,[],'没学被动就没有这一抽');
  }finally{Math.random=original;}
});

test('a learned Celestial Lightning strikes around the caster and settles on the enemy at the switch frame',()=>{
  const original=Math.random;
  try{
    const run=fixture(1,{celestial:5});
    Math.random=roll(1);
    run.fire();
    assert.deepEqual(run.strikes,[{casterId:'player',count:12}],'十二道雷击画在施法者周围');
    assert.equal(run.casts.length,0,'切换帧之前不结算');
    assert.deepEqual(run.timers.map(timer=>timer.ms),[8*60],'过渡第 8 帧执行 Direct');
    run.runTimers();
    assert.deepEqual(run.castRows(),
      [[0,'player','celestial-lightning',5],[1,'enemy','celestial-lightning',5],[2,'player','celestial-lightning',5]],
      '自身单元落在施法者，伤害中心留在原敌人；等级取已学等级');
  }finally{Math.random=original;}
});

test('a departed target keeps the caster units on the caster only',()=>{
  const original=Math.random;
  try{
    const run=fixture(1,{celestial:1});
    run.host.combatant=(id:string)=>id==='player'?{id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}}:undefined;
    run.host.combatants=()=>[run.host.combatant('player')!];
    Math.random=roll(1);
    run.fire();
    run.runTimers();
    assert.deepEqual(run.castRows().map(row=>row[1]),['player','player'],'敌人已离场时只剩自身两个单元');
  }finally{Math.random=original;}
});

test('only a critical from Divine Strike or Hammer of Wrath reaches the roll',()=>{
  const seen:string[]=[];
  const host={godOfJusticeReaction:(caster:string,target:string)=>seen.push(`${caster}:${target}`),
    physicalSuccessEquipmentProcs:()=>{},
    lightningOfHellReaction:()=>{},holySacrificeTransfer:()=>{},reactToBuff:()=>{},react:()=>{},partySide:()=>false,
    summonOwnerReactions:()=>{},disturbanceReaction:()=>{},actorAttribute:()=>0,equipmentRecovery:()=>({lifeDrainPerThousand:0}),attackProc:()=>{},
    fallen:new Set<string>(),pendingDefeats:new Set<string>(),arena:[],
    conditions:{activeBuffReactions:()=>[],removeState:()=>{},snapshot:()=>[]}};
  const cases=[['divine-strike','critical',1],['hammer-of-wrath','critical',1],['divine-strike','hit',0],
    ['firestorm','critical',0],['basic-attack','critical',0]] as const;
  for(const [actionId,kind,expected] of cases){
    seen.length=0;
    method('resolveHitReactions').call(host,{casterId:'priest',targetId:'enemy'},{kind,damage:10},'physical',actionId,{});
    assert.equal(seen.length,expected,`${actionId}/${kind}`);
  }
});

test('the passive keeps no castable action of its own',()=>{
  assert.equal(catalog.skills['god-of-justice'].action,null,'被动的主动作只有反应，没有单元');
});
