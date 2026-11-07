import {CombatRuntime} from '../src/domain/combat-runtime.ts';
import {playCombat} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FakeSprite} from './support/fake-sprite.ts';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog,SkillTransition} from '../src/domain/battle.ts';
import type {Combatant} from '../src/domain/combat.ts';
import type {Point} from '../src/domain/navigation.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3}}',shortCircuit:true}
  :next(specifier,context);}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

class Sprite extends FakeSprite {
  anims={accumulator:0,create:()=>({destroy(){}}),stop:()=>{}};repeat=0;
  override play(config:{repeat:number}){this.repeat=config.repeat;return this;}
}
class Effect extends EventEmitter {
  x:number;y:number;active=true;name='';list:Sprite[]=[];
  constructor(x:number,y:number){super();this.x=x;this.y=y;}
  get length(){return this.list.length;}
  setDepth(){return this;}setName(name:string){this.name=name;return this;}
  add(sprite:Sprite){this.list.push(sprite);return this;}
  removeAll(){this.list=[];return this;}
  destroy(){if(!this.active)return;this.active=false;this.emit('destroy');}
}
type Tween={targets:Effect;x:number;y:number;duration:number;onUpdate:()=>void;onComplete:()=>void};

function fixture(distance=11){
  const effects:Effect[]=[],tweens:Tween[]=[],contacts:Point[]=[];
  const timers:{delay:number;callback:()=>void;removed:boolean;remove:()=>void}[]=[];
  const target:Combatant={id:'enemy',team:'hostile',position:{x:distance,y:0},bounds:{x:0,y:0,width:16,height:16}};
  const container={x:distance,y:0,active:true};let present=true,paused=false;
  const actor=catalog.classes.find(character=>character.id==='ranger')!.actor;
  const character={actor,entity:{id:'player',actor:actor.id},layers:[],clipName:null,
    container:{active:true,x:0,y:0,addAt:()=>{}}} as unknown as CharacterVisual;
  const scene={events:new EventEmitter(),
    add:{container:(x:number,y:number)=>{const effect=new Effect(x,y);effects.push(effect);return effect;},sprite:()=>new Sprite(),
      layer:()=>({setDepth(){return this;},add(){},destroy(){}})},
    anims:{exists:()=>false,create:()=>{},generateFrameNumbers:()=>[]},
    tweens:{add:(tween:Tween)=>tweens.push(tween),killTweensOf:(effect:Effect)=>{
      for(let i=tweens.length-1;i>=0;i--)if(tweens[i].targets===effect)tweens.splice(i,1);
    }},
    time:{delayedCall:(delay:number,callback:()=>void)=>{
      const timer={delay,callback,removed:false,remove(){this.removed=true;}};timers.push(timer);return timer;
    }}} as unknown as Phaser.Scene;
  const presenter=new CombatPresenter(scene,catalog,id=>id==='player'?character:
    present&&id===target.id?{container} as CharacterVisual:undefined,()=>[]);
  let frame=0;const runtime=new CombatRuntime(()=>frame);
  return {presenter,effects,tweens,timers,contacts,target,container,character,runtime,clear:()=>{runtime.reset();presenter.clear();},
    start:(transition:SkillTransition)=>runtime.transition('player',transition,target,{x:0,y:0},{
      actor:id=>id===target.id&&present&&container.active?{...target,position:{x:container.x,y:container.y}}:undefined,
      emit:event=>presenter.renderFlight(event),effect:(name,position)=>presenter.renderEffect(name,'default',position),
    },center=>contacts.push(center)),
    removeTarget:()=>{present=false;},pause:()=>{paused=true;runtime.setPaused('menu',true);},resume:()=>{paused=false;runtime.setPaused('menu',false);},
    // 模拟场景补间调度边界；暂停期间不发送 Phaser 的完成回调。
    step:()=>{if(paused)return;const tween=tweens.shift();if(tween){
      tween.targets.x=tween.x;tween.targets.y=tween.y;tween.onUpdate();tween.onComplete?.();}runtime.step(++frame);}};
}

// REA-354 @0x26a244: distance < step invokes ProcessAction in this step;
// ACTTRANSMIT switchFrame is not read by ProcessTrace.
for(const id of ['multiple-shot','aimed-shot','spiritual-arrow']){
  test(`${id}: hero and companion trace contact occurs on arrival, without a six-frame timer`,()=>{
    for(const action of [catalog.skills[id].action!,catalog.skills[id].companion!.action!]){
      const transition=action.transition!;assert.equal(transition.kind,'trace');assert.equal(transition.switchFrame,6);
      const f=fixture(transition.stepDistancePx-1);f.start(transition);
      assert.equal(f.contacts.length,0);assert.equal(f.tweens[0].duration,60);
      const flight=f.effects[0];assert.equal(flight.list[0].repeat,-1);
      f.step();assert.deepEqual(f.contacts,[{x:transition.stepDistancePx-1,y:0}]);
      assert.deepEqual(f.timers,[]);assert.equal(flight.active,false);assert.equal(f.presenter.effects.size,0);
      assert.equal(f.tweens.length,0);
    }
  });
}

test('trace impact animation starts on contact and lives until its own animation completes',()=>{
  const f=fixture();f.start({...catalog.skills['multiple-shot'].action!.transition!,actionEffect:'aimed-shot'});
  const flight=f.effects[0];f.step();
  assert.equal(f.contacts.length,1);assert.equal(flight.active,false);
  const impact=f.effects[1];assert.ok(impact);assert.equal(impact.active,true);assert.equal(impact.list[0].repeat,0);
  assert.deepEqual({x:impact.x,y:impact.y},{x:11,y:0});assert.equal(f.presenter.effects.size,1);
  flight.emit('destroy');assert.equal(impact.active,true);assert.equal(f.contacts.length,1);
  impact.list[0].emit('animationcomplete');assert.equal(impact.active,false);assert.equal(f.presenter.effects.size,0);
});

test('target removal during flight or on its arrival step suppresses contact and cleans up the projectile',()=>{
  for(const distance of [11,40])for(const removal of ['missing','inactive']){
    const f=fixture(distance);f.start(catalog.skills['multiple-shot'].action!.transition!);
    if(removal==='missing')f.removeTarget();else f.container.active=false;
    f.step();assert.deepEqual(f.contacts,[]);assert.deepEqual(f.timers,[]);
    assert.equal(f.effects[0].active,false);assert.equal(f.presenter.effects.size,0);assert.equal(f.tweens.length,0);
  }
});

test('clearing the scene invalidates an already queued arrival callback and destroys flight visuals',()=>{
  const f=fixture();f.start(catalog.skills['aimed-shot'].action!.transition!);
  const stale=f.tweens[0].onComplete;f.clear();stale?.();f.runtime.step(1);
  assert.deepEqual(f.contacts,[]);assert.deepEqual(f.timers,[]);assert.equal(f.tweens.length,0);
  assert.equal(f.effects[0].active,false);assert.equal(f.presenter.effects.size,0);
});

test('cancelling the casting animation preserves an already launched trace and its immediate contact',()=>{
  for(const id of ['multiple-shot','aimed-shot','spiritual-arrow']){
    const f=fixture(),action=catalog.skills[id].action!;
    const cancel=playCombat(f.presenter,{caster:{...f.target,id:'player',team:'party',position:{x:0,y:0}},
      target:f.target,facing:'east',skill:{id,action,level:1},
      basicAttack:resolveBasicAttack(catalog,catalog.classes.find(character=>character.id==='ranger')!)},()=>assert.fail('cancelled action advanced'),()=>assert.fail('cancelled action completed'));
    const sprite=f.character.layers[0] as unknown as Sprite;
    f.start(action.transition!);cancel();
    sprite.emit('animationupdate',{}, {index:20});sprite.emit('animationcomplete');f.timers[0].callback();
    assert.equal(f.timers[0].removed,true);assert.equal(f.effects[0].active,true);
    f.step();assert.deepEqual(f.contacts,[{x:11,y:0}]);assert.equal(f.timers.length,1);
  }
});

test('paused flight waits for logical time, then settles on the next resumed boundary',()=>{
  const f=fixture();f.start(catalog.skills['spiritual-arrow'].action!.transition!);
  f.pause();for(let i=0;i<10;i++)f.step();
  assert.deepEqual(f.contacts,[]);assert.deepEqual(f.timers,[]);assert.equal(f.effects[0].x,0);
  f.resume();f.step();assert.deepEqual(f.contacts,[{x:11,y:0}]);assert.deepEqual(f.timers,[]);
});

test('stationary transitions retain their switch-frame delay and finish their independent animation after contact',()=>{
  const f=fixture();f.start(catalog.skills['fire-offering'].action!.transition!);
  assert.deepEqual(f.contacts,[]);assert.equal(f.tweens.length,0);assert.equal(f.runtime.pendingCount,1);
  f.container.x=100;f.target.position.x=100;for(let index=0;index<5;index++)f.step();
  assert.deepEqual(f.contacts,[{x:11,y:0}]);assert.equal(f.effects[0].active,true);
  f.effects[0].list[0].emit('animationcomplete');assert.equal(f.effects[0].active,false);
});

test('position transitions retain travel and switch-frame snap rules with no post-arrival delay',()=>{
  const f=fixture(100);f.start({...catalog.skills['fire-offering'].action!.transition!,kind:'position',switchFrame:2});
  f.step();f.step();assert.deepEqual(f.contacts,[]);assert.equal(f.effects[0].active,true);
  f.container.x=200;f.target.position.x=200;f.step();
  assert.deepEqual(f.contacts,[{x:100,y:0}]);assert.deepEqual(f.timers,[]);assert.equal(f.effects[0].active,false);
});
