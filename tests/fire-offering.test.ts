import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {skillForGrowth,type BattleCatalog,type SkillGrowthProfile} from '../src/domain/battle.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatController,resolveCueTargets,type Combatant,type CombatPort,type SkillUnitHit} from '../src/domain/combat.ts';
import {resolvePeriodicEffect} from '../src/domain/combat-periodic.ts';

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
const skill=(growth:SkillGrowthProfile)=>skillForGrowth(catalog.skills['fire-offering'],growth);
const buff=(growth:SkillGrowthProfile,level:number)=>{
  const unit=skill(growth).action!.combatUnits![2];assert.equal(unit.effect,'buff');
  if(unit.effect!=='buff')throw new Error('Fire Offering buff missing');
  return unit.ranks[level-1];
};
const actor=(id:string,x:number,y=0,team='enemy'):Combatant=>({id,team,position:{x,y},bounds:{x:-4,y:-4,width:8,height:8}});

test('主角与佣兵八级烧伤保留魔法普通伤害来源，并使用原版90帧上限和30帧周期',()=>{
  const rates={hero:[225,245,265,295,305,315,325,335],companion:[225,245,265,285,295,305,315,325]};
  const strengths={hero:[1002,1004,1006,1009,1010,1011,1012,1013],companion:[1002,1004,1006,1008,1009,1010,1011,1012]};
  for(const growth of ['hero','companion'] as const)for(let level=1;level<=8;level++){
    const rank=buff(growth,level),effect=rank.effect;
    assert.equal(rank.strength,strengths[growth][level-1]);
    assert.deepEqual(effect.simulationFrames,{lastActiveFrame:90,pulseIntervalFrames:30});
    assert.equal(effect.durationMs,5460);assert.equal(effect.tickMs,1800);assert.equal(effect.maxStacks,1);
    assert.deepEqual(effect.periodic,[{kind:'attack-damage',source:'magic',operation:{kind:'multiply-thousandth',ratePerThousand:rates[growth][level-1]}}]);
    const commands=resolvePeriodicEffect(effect.periodic[0],{buffId:'fire-offering',stackCount:1,targetHealingRate:1000,
      source:{classId:'warlock',lifeFeastRate:0,attributeValue:()=>0,
        attributes:{physicalAttack:900,magicAttack:100,physicalDamageRate:0,magicDamageRate:500,stealthDamageRate:0,
          maxHealth:1000,primaryAttributes:{strength:0,dexterity:0,vitality:0,intelligence:0,mentality:0}}}});
    assert.deepEqual(commands,[{kind:'damage-target',amount:Math.trunc(150*rates[growth][level-1]/1000)}]);
  }
});

test('烧伤保留普通DOT年龄0首跳，90帧末跳后到下一帧才移除',()=>{
  for(const growth of ['hero','companion'] as const)for(let level=1;level<=8;level++){
    const conditions=new CombatConditions(),rank=buff(growth,level),times:number[]=[];
    assert.equal(conditions.applyBuff('enemy','fire-offering',rank.strength,rank.effect,'caster'),true);
    assert.equal(times.length,0,'施加瞬间尚未进入年龄0处理');
    for(let time=60;time<=5460;time+=60)conditions.update(60,tick=>{
      times.push(time);assert.equal(tick.sourceId,'caster');assert.equal(tick.stackCount,1);
    });
    assert.deepEqual(times,[60,1860,3660,5460]);
    assert.equal(conditions.hasBuff('enemy','fire-offering'),true);
    conditions.update(59);assert.equal(conditions.hasBuff('enemy','fire-offering'),true);
    conditions.update(1,()=>assert.fail('到期处理不能多跳'));assert.equal(conditions.hasBuff('enemy','fire-offering'),false);
  }
});

test('烧伤随公共逻辑帧相位开始，弱施加保持旧年龄，同强刷新重新从年龄0起',()=>{
  const conditions=new CombatConditions(),strong=buff('hero',8),weak=buff('companion',8);
  // 空的状态表会让 update 提前返回、不推进共享帧余量；放一条长寿增益让时钟保持推进。
  conditions.applyBuff('clock','attack-stun',1,{durationMs:60000,tickMs:0,states:[],modifiers:[],periodic:[]});
  conditions.update(30);
  conditions.applyBuff('enemy','fire-offering',strong.strength,strong.effect,'caster');
  let ticks=0;const tick=()=>{ticks++;};
  conditions.update(29,tick);assert.equal(ticks,0);conditions.update(1,tick);assert.equal(ticks,1);
  conditions.update(600,tick);const saved=conditions.captureState();
  assert.equal(conditions.applyBuff('enemy','fire-offering',weak.strength,weak.effect,'other'),false);
  assert.deepEqual(conditions.captureState(),saved);
  assert.equal(conditions.applyBuff('enemy','fire-offering',strong.strength,strong.effect,'caster'),true);
  conditions.update(60,tick);assert.equal(ticks,2);
  assert.equal(conditions.snapshot('enemy')[0].stackCount,1);
});

test('火祭落点范围使用整数脚点八方向距离，主角佣兵均覆盖轴向及斜向边界',()=>{
  const origin=actor('caster',100,100,'party');
  const targets=[actor('axis-in',147,100),actor('axis-out',148,100),actor('diagonal-in',134,134),actor('diagonal-out',135,134),
    actor('friendly',101,100,'party'),{...actor('hidden',101,100),states:['stealthed' as const]}];
  targets[1].bounds={x:-100,y:-100,width:200,height:200};
  for(const growth of ['hero','companion'] as const){
    const event=skill(growth).action!.events.find(event=>event.kind==='units')!;
    if(event.kind!=='units')throw new Error('units missing');
    for(const cue of event.cues.slice(1,3)){
      assert.equal(cue.targetRangeMetric,'octagonal-grid');assert.equal(cue.targetRangePx,40);
      assert.deepEqual(resolveCueTargets(cue,origin,targets[1],targets).map(actor=>actor.id),['axis-in','diagonal-in']);
    }
    assert.equal(event.cues[2].targetSelection,'reuse-previous');
  }
});

test('到达后按固定落点选最多16人，失败目标不受烧伤且始终清理施法者临时项',()=>{
  const action=skill('hero').action!,event=action.events.find(event=>event.kind==='units')!;
  if(event.kind!=='units')throw new Error('units missing');
  const caster=actor('caster',0,0,'party'),selected=actor('selected',16);
  const targets=Array.from({length:17},(_,index)=>actor(`enemy-${index}`,63));
  const actors=new Map([caster,selected,...targets].map(actor=>[actor.id,actor]));
  const hits:SkillUnitHit[]=[];let frame=(_index:number)=>{},arrive=()=>{};
  const port:CombatPort={cooldowns:new CombatCooldownStore(()=>0).forActor(caster.id),
    actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'east',
    moveToward:()=>{},stop:()=>{},canStand:()=>true,relocate:()=>{},clearEffects:()=>{},
    play:(_action,onFrame)=>{frame=onFrame;return ()=>{};},
    frame:(_action,index,_contact,ready)=>{if(index===event.frame)arrive=()=>{ready({event,impactCenter:{x:16,y:0},selectedTargetId:selected.id});};},
    unit:hit=>{hits.push(hit);return hit.cueIndex===1&&hit.targetId==='enemy-0'?'failure':'success';}};
  const combat=new CombatController(caster.id,null,port);
  assert.equal(combat.request({id:'fire-offering',action,level:1},selected.id),'started');
  frame(event.frame);assert.equal(hits.length,0);
  caster.position.x=1000;selected.position.x=500;arrive();
  assert.deepEqual(hits.filter(hit=>hit.cueIndex===1).map(hit=>hit.targetId),targets.slice(0,16).map(actor=>actor.id));
  assert.deepEqual(hits.filter(hit=>hit.cueIndex===2).map(hit=>hit.targetId),targets.slice(1,16).map(actor=>actor.id));
  assert.deepEqual(hits.filter(hit=>hit.targetId==='caster').map(hit=>hit.cueIndex),[0,3]);
});
