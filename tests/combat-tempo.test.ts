import {dispatchFrame,playCombat} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FakeSprite} from './support/fake-sprite.ts';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog,ResolvedBasicAttack} from '../src/domain/battle.ts';
import type {ActionPlayback,Combatant} from '../src/domain/combat.ts';
import {attackCycleFrames} from '../src/domain/combat-tempo.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import {skillSequence} from '../src/domain/skill-action.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3}}',shortCircuit:true}:next(specifier,context);
}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');phaser.deregister();
const catalog:BattleCatalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
const knight=catalog.classes.find(character=>character.id==='dark-knight')!;
const caster:Combatant={id:'knight',team:'party',position:{x:0,y:0},bounds:{x:0,y:0,width:16,height:16}};

class Sprite extends FakeSprite {
  scene={};
  stopped=false;
  definitions:{frames:{frame:number}[];frameRate:number}[]=[];
  anims={create:(definition:{frames:{frame:number}[];frameRate:number})=>{this.definitions.push(definition);return {...definition,destroy(){}};},
    stop:()=>{this.stopped=true;},timeScale:1,accumulator:0};
}

function playback(skillId?:string,onFrame?:(index:number)=>void,basicOverrides?:Partial<ResolvedBasicAttack>){
  let speed=1000,completed=0;
  const definition=skillId?catalog.skills[skillId]:undefined;
  const character={actor:knight.actor,entity:{id:'knight',actor:knight.actor.id},layers:[],clipName:null,
    container:{active:true,x:0,y:0,addAt:()=>{}}} as unknown as CharacterVisual;
  const timers:{delay:number;callback:()=>void;removed:boolean;remove:()=>void}[]=[];
  const scene={events:new EventEmitter(),add:{sprite:()=>new Sprite()},anims:{exists:()=>false,create:()=>{},generateFrameNumbers:()=>[]},
    time:{delayedCall:(delay:number,callback:()=>void)=>{
      const timer={delay,callback,removed:false,remove(){this.removed=true;}};timers.push(timer);return timer;
    }}} as unknown as Phaser.Scene;
  const action:ActionPlayback={caster,facing:'south',basicAttack:{...resolveBasicAttack(catalog,knight),...basicOverrides},getAttackSpeedRate:()=>speed,
    ...(definition?{skill:{id:definition.id,action:definition.action!,level:1}}:{})};
  // 重播技能借用同长度测试素材，事件计划仍来自实际技能定义。
  if(definition)action.skill!.clips={north:'attack-north',south:'attack-south',east:'attack-east',west:'attack-west'};
  const presenter=new CombatPresenter(scene,catalog,()=>character,()=>[]);
  const frames:number[]=[];
  const cancel=playCombat(presenter,action,index=>{frames.push(index);onFrame?.(index);},()=>completed++);
  const sprite=character.layers[0] as unknown as Sprite;
  return {action,presenter,sprite,timers,frames,cancel,setSpeed:(value:number)=>{speed=value;},completed:()=>completed,
    advance:(index:number)=>sprite.emit('animationupdate',{}, {index:index+1}),
    finish:()=>sprite.emit('animationcomplete'),character};
}

test('native attack duration truncates before addition and retains the strike frame at every speed',()=>{
  assert.equal(attackCycleFrames(11,1100,4),10);
  assert.equal(attackCycleFrames(11,900,4),12);
  assert.equal(attackCycleFrames(10,500,4),15);
  assert.equal(attackCycleFrames(10,-500,4),20);
  assert.equal(attackCycleFrames(10,2000,4),5);
  assert.equal(attackCycleFrames(12,2000,10),11);
  assert.equal(attackCycleFrames(10,4000,4),5);
});

test('ten wrath stacks shorten only recovery while the actual strike frame remains unchanged',()=>{
  assert.deepEqual(Array.from({length:11},(_,stacks)=>attackCycleFrames(10,1000+100*stacks,4)),[10,9,8,7,6,5,5,5,5,5,5]);
  const run=playback();run.setSpeed(2000);
  const animation=run.sprite.definitions[0];
  assert.equal(animation.frameRate,1000/60);assert.equal(animation.frames.length,20);
  assert.deepEqual(animation.frames.slice(0,6).map(frame=>frame.frame),[0,1,2,3,4,5]);
  run.advance(4);assert.deepEqual(run.frames,[1,2,3,4]);assert.equal(run.completed(),0);
  run.advance(5);assert.deepEqual(run.frames,[1,2,3,4]);assert.equal(run.completed(),1);
  assert.equal(run.sprite.stopped,true);assert.equal(run.timers[0].removed,true);
  run.finish();run.timers[0].callback();assert.equal(run.completed(),1);
});

test('a new speed stack during recovery ends the current attack at its next logical boundary',()=>{
  const run=playback();run.advance(6);run.setSpeed(1700);run.advance(7);
  assert.deepEqual(run.frames,[1,2,3,4,5,6]);assert.equal(run.completed(),1);
  assert.equal(run.sprite.listenerCount('animationupdate'),0);
});

test('slowing an ongoing attack extends its current recovery without delaying or repeating its strike',()=>{
  const run=playback();run.advance(4);run.setSpeed(500);run.advance(14);
  assert.equal(run.completed(),0);assert.equal(run.frames.filter(index=>index===4).length,1);
  run.advance(15);assert.equal(run.completed(),1);assert.equal(run.frames.at(-1),14);
});

test('skipped notifications evaluate each boundary and re-read changes caused by the strike',()=>{
  const run=playback(undefined,index=>{if(index===4)run.setSpeed(2000);});run.advance(14);
  assert.deepEqual(run.frames,[1,2,3,4]);assert.equal(run.completed(),1);
});

test('ordinary and repeating active skills keep their sequences and never read attack speed',()=>{
  for(const skillId of ['shield-bash','multiple-shot']){
    const run=playback(skillId);run.action.getAttackSpeedRate=()=>assert.fail('active skill consumed attack speed');
    run.advance(9);assert.deepEqual(run.frames,Array.from({length:Math.min(9,skillSequence(run.action.skill!.action,1,knight.actor.clips['attack-south']!.frames).length-1)},(_,index)=>index+1));
    if(run.action.skill!.action.repeat){
      assert.deepEqual(run.sprite.definitions[0].frames.map(frame=>frame.frame),
        skillSequence(run.action.skill!.action,1,knight.actor.clips['attack-south']!.frames));
      assert.equal(run.sprite.definitions[0].frameRate,1000/60);
    }
    run.finish();assert.equal(run.completed(),1);
  }
});

test('cancelling playback clears callbacks and the fallback cannot complete a cancelled action',()=>{
  const run=playback();run.advance(2);run.cancel();run.advance(8);run.finish();run.timers[0].callback();
  assert.equal(run.completed(),0);assert.deepEqual(run.frames,[1,2]);
  assert.equal(run.sprite.listenerCount('animationupdate'),0);assert.equal(run.sprite.listenerCount('animationcomplete'),0);
  assert.equal(run.timers[0].removed,true);
});

test('both dual strikes run their own contact and dispatch tail while retaining hand order',()=>{
  const order:string[]=[];
  const run=playback(undefined,index=>dispatchFrame(run.presenter,run.action,index,(_id,hand)=>order.push(`contact:${hand}`),()=>[],()=>{},(_definition,work)=>{
      order.push('begin');work();order.push('end');
    }),{cycleFrames:10,strikeFrame:2,swingFrame:null,swings:[],targetEffects:[],projectile:null,
    strikes:[{frame:2,hand:'main-hand'},{frame:5,hand:'offhand'}],
    dispatch:{breaksStealth:true,casterEffects:[{effect:'tail',recipient:'caster',placement:'attached'}]}});
  run.action.target={...caster,id:'enemy',team:'hostile'};
  Reflect.set(run.presenter,'pose',()=>{});
  Reflect.set(run.presenter,'visualEffect',()=>order.push('tail'));
  run.advance(5);
  assert.deepEqual(order,['begin','contact:main-hand','tail','end','begin','contact:offhand','tail','end']);
  assert.equal(run.completed(),0);
  run.advance(10);assert.equal(run.completed(),1);
  run.advance(20);assert.equal(order.length,8);
});

test('dual attacks can finish before the second strike when current speed shortens the cycle after the first',()=>{
  for(const [first,second] of [[1,3],[2,5]]){
    const contacts:string[]=[],dispatches:number[]=[];
    const run=playback(undefined,index=>dispatchFrame(run.presenter,run.action,index,(_id,hand)=>{
      contacts.push(hand!);run.setSpeed(2000);
    },()=>[],()=>{},(_definition,work)=>{dispatches.push(index);work();}),{
      cycleFrames:10,strikeFrame:first,swingFrame:null,swings:[],targetEffects:[],projectile:null,
      strikes:[{frame:first,hand:'main-hand'},{frame:second,hand:'offhand'}],dispatch:{breaksStealth:true},
    });
    run.action.target={...caster,id:'enemy',team:'hostile'};
    Reflect.set(run.presenter,'pose',()=>{});
    run.advance(20);
    assert.deepEqual(contacts,['main-hand']);assert.deepEqual(dispatches,[first]);
    assert.equal(run.completed(),1);assert.equal(run.frames.at(-1),first);
    assert.equal(run.sprite.listenerCount('animationupdate'),0);
  }
});
