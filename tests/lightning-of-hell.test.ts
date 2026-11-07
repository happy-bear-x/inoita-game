import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {actionDamage} from '../src/domain/action-damage.ts';
import {actionDamageSource} from '../src/domain/combat-damage-source.ts';
import type {BattleCatalog,NumericCombatUnit,SkillAction} from '../src/domain/battle.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const method=(name:string)=>Reflect.get(WorldCombat.prototype,name);

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const thresholds=[80,110,130,140,150,160,170,180];
const followUp=catalog.skills['lightning-of-hell'].followUpAction!;
const strike=followUp.combatUnits![0] as NumericCombatUnit;

test('the passive carries one chance per rank and an untagged private strike',()=>{
  catalog.skills['lightning-of-hell'].reactionsByRank!.forEach((rank,index)=>
    assert.deepEqual(rank,[{kind:'lightning-of-hell',chanceThreshold:thresholds[index]}],`rank ${index+1}`));
  assert.deepEqual(catalog.skills['lightning-of-hell'].passiveUnits,[]);
  // 私有动作 111 的自身训练行 max_level 为 0，任何等级都读 pointBase−1，主角列给出 3550‰。
  assert.deepEqual(strike.ranks,[{fixedAddition:0,operation:{kind:'multiply-thousandth',ratePerThousand:3550}}]);
  assert.deepEqual(strike.attributeWeights,{strength:0,dexterity:0,vitality:0,intelligence:12,mentality:0});
  assert.equal(strike.source,'magicAttack');
  assert.equal(followUp.usesSkillDamageBuff,false,'私有动作没有技能标记');
  assert.equal(followUp.hitEffectStyle,'weapon');
  // 私有动作没有自己的动作定义：过渡切换帧触发 Direct，cue 只给目标。
  assert.deepEqual(followUp.events,[{kind:'units',frame:0,cues:[
    {target:'current',targetRangePx:80,targetSelection:'search',effects:[]}]}]);
  assert.deepEqual(followUp.transition,{kind:'stationary',effect:'hell-lightning',actionEffect:null,
    switchFrame:1,stepDistancePx:12,offsetX:0,offsetY:0});
});

test('the strike applies the private multiplier to magic attack plus truncated intelligence',()=>{
  const attributes={physicalAttack:0,magicAttack:200,physicalDamageRate:0,magicDamageRate:0,stealthDamageRate:0,maxHealth:1000,
    primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:25,mentality:0}};
  const source=actionDamageSource(attributes);
  // 权重合计 trunc(25*12/10) = 30，基础 200+30 再乘 3550/1000。
  assert.equal(actionDamage(strike,1,source),816);
  assert.equal(actionDamage({...strike,attributeWeights:{...strike.attributeWeights,intelligence:0}},1,source),710);
});

/** 只装配落雷判定要用到的部分：已学等级、私有动作与一次命中结算。 */
function fixture(level=1,{strikes=[] as unknown[]}={}){
  const member={classId:'warlock',panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}},
    skills:{draft:()=>({levels:{'lightning-of-hell':level}})}};
  // 过渡本身另有用例；这里让它立即回调，结算路径仍走真实的 cue 选择与失败表。
  const roster:{[id:string]:unknown}={player:{id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
    enemy:{id:'enemy',team:'hostile',position:{x:64,y:0},bounds:{x:-4,y:-4,width:8,height:8}}};
  const host=Object.setPrototypeOf({
    app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{'lightning-of-hell':level}})}}},
    memberOf:(id:string)=>id==='player'?member:undefined,
    memberForPlayer:member,
    skillUnit:(event:unknown)=>{strikes.push(event);},
    pendingDefeats:new Set<string>(),closed:false,defeated:false,arena:[],
    combatant:(id:string)=>roster[id],combatants:()=>Object.values(roster),
    actorAttribute:()=>0,healScoreFor:()=>undefined,healCandidates:()=>[],
    runtime:{transition:(_owner:string,_definition:unknown,_target:unknown,_position:unknown,_port:unknown,arrive:()=>void)=>arrive()},
    presenterFor:()=>({playFollowUpTransition:(_c:string,_t:unknown,_id:string,contact:()=>void)=>contact(),
      showUnitFeedback:()=>{}}),
  },WorldCombat.prototype);
  host.app.session.skills.draft=()=>({levels:{'lightning-of-hell':level}});
  const fire=(casterId='player')=>method('lightningOfHellReaction').call(host,casterId,'enemy');
  return {host,fire,strikes,member};
}

/** 让判定抽到第 n 点（1…999）：原版掷整数 1…999，严格小于阈值才触发。 */
const roll=(point:number)=>()=>(point-0.5)/999;

test('the chance comes from the learned rank and uses the strict one-to-nine-hundred-ninety-nine roll',()=>{
  const run=fixture(1);
  const original=Math.random;
  Math.random=roll(80);
  try{
    run.fire();
    assert.equal(run.strikes.length,0,'一级阈值 80：抽到 80 不触发');
  }finally{Math.random=original;}
  Math.random=roll(79);
  try{
    run.fire();
    assert.equal(run.strikes.length,1);
    const event=run.strikes[0] as {casterId:string;targetId:string;cueIndex:number;skill:{id:string;level:number;action:SkillAction}};
    assert.equal(event.casterId,'player');
    assert.equal(event.targetId,'enemy');
    assert.equal(event.cueIndex,0);
    assert.equal(event.skill.action,followUp,'执行的是导出时那份私有动作');
  }finally{Math.random=original;}
});

test('every rank uses its own threshold and an unlearned rank never fires',()=>{
  const original=Math.random;
  try{
    for(const [level,threshold] of thresholds.entries()){
      const run=fixture(level+1);
      Math.random=roll(threshold);
      run.fire();assert.equal(run.strikes.length,0,`${level+1} 级阈值 ${threshold}：抽到它本身不触发`);
      Math.random=roll(threshold-1);
      run.fire();assert.equal(run.strikes.length,1,`${level+1} 级差一点就触发`);
    }
    const unlearned=fixture(0);
    Math.random=roll(1);
    unlearned.fire();
    assert.equal(unlearned.strikes.length,0,'没学过这条被动就不判定');
  }finally{Math.random=original;}
});

test('a caster outside the party never rolls',()=>{
  const run=fixture();
  const original=Math.random;Math.random=()=>0;
  try{
    method('lightningOfHellReaction').call(run.host,'outsider','enemy');
    assert.equal(run.strikes.length,0);
  }finally{Math.random=original;}
});

test('only a magic critical reaches the roll inside the success chain',()=>{
  const seen:string[]=[];
  const host={lightningOfHellReaction:(caster:string,target:string)=>seen.push(`${caster}:${target}`),
    physicalSuccessEquipmentProcs:()=>{},
    holySacrificeTransfer:()=>{},reactToBuff:()=>{},react:()=>{},partySide:()=>false,summonOwnerReactions:()=>{},disturbanceReaction:()=>{},
    actorAttribute:()=>0,equipmentRecovery:()=>({lifeDrainPerThousand:0}),attackProc:()=>{},
    fallen:new Set<string>(),pendingDefeats:new Set<string>(),arena:[],
    conditions:{activeBuffReactions:()=>[],removeState:()=>{},snapshot:()=>[]}};
  for(const [kind,damageKind,expected] of [['critical','magic',1],['hit','magic',0],['critical','physical',0]] as const){
    seen.length=0;
    method('resolveHitReactions').call(host,{casterId:'hero',targetId:'enemy'},{kind,damage:10},damageKind,'probe',{});
    assert.equal(seen.length,expected,`${damageKind}/${kind}`);
    if(expected)assert.deepEqual(seen,['hero:enemy']);
  }
});

test('落雷先播私有过渡，切换帧到达后才结算，且不替换主动作',()=>{
  const order:string[]=[];
  const roster:{[id:string]:unknown}={player:{id:'player',team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}},
    enemy:{id:'enemy',team:'hostile',position:{x:64,y:0},bounds:{x:-4,y:-4,width:8,height:8}}};
  const member={classId:'warlock',panel:{attributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}},
    skills:{draft:()=>({levels:{'lightning-of-hell':8}})}};
  const host=Object.setPrototypeOf({
    app:{battleCatalog:catalog,session:{skills:{draft:()=>({levels:{'lightning-of-hell':8}})}}},
    memberOf:(id:string)=>id==='player'?member:undefined,
    pendingDefeats:new Set<string>(),closed:false,defeated:false,arena:[],
    combatant:(id:string)=>roster[id],combatants:()=>Object.values(roster),
    actorAttribute:()=>0,healScoreFor:()=>undefined,healCandidates:()=>[],
    runtime:{transition:(_owner:string,transition:{effect:string;switchFrame:number},_target:unknown,_position:unknown,_port:unknown,arrive:()=>void)=>{order.push(`transition:${transition.effect}@${transition.switchFrame}`);arrive();}},
    presenterFor:()=>({
      playFollowUpTransition:(_c:string,transition:{effect:string;switchFrame:number},_id:string,contact:()=>void)=>{
        order.push(`transition:${transition.effect}@${transition.switchFrame}`);contact();},
      showUnitFeedback:()=>order.push('feedback')}),
    skillUnit:(event:{skill:{id:string}})=>order.push(`unit:${event.skill.id}`),
  },WorldCombat.prototype);
  const original=Math.random;Math.random=()=>0.5/999;
  try{method('lightningOfHellReaction').call(host,'player','enemy');}finally{Math.random=original;}
  assert.deepEqual(order,['transition:hell-lightning@1','unit:lightning-of-hell','feedback'],
    '先过渡、再按 cue 结算一次；私有动作不经过控制器，也就不扣蓝、不重设冷却');
});
