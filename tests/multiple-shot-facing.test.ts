import {playCombat} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {FakeSprite} from './support/fake-sprite.ts';
import {readFileSync} from 'node:fs';
import {createRequire,registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {ActionPlayback} from '../src/domain/combat.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {characterFrameList} from '../src/rendering/character-atlas.ts';
import {CHARACTER_ATLAS_ALIASES} from '../tools/character-atlas-aliases.ts';

// 使用项目安装版本的真实 AnimationState；场景只替换贴图和渲染对象。
const require=createRequire(import.meta.url);
const AnimationState=require('../node_modules/phaser/src/animations/AnimationState.js') as new(parent:unknown)=>Phaser.Animations.AnimationState;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3}}',shortCircuit:true}
  :next(specifier,context);}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

class Sprite extends FakeSprite {
  scene:unknown;anims:Phaser.Animations.AnimationState;scaleX=1;originX=0;originY=0;
  frame:{texture:{key:string};name:string|number}|undefined;
  constructor(scene:unknown){super();this.scene=scene;this.anims=new AnimationState(this);}
  override setOrigin(x:number,y:number){this.originX=x;this.originY=y;return this;}
  override setScale(x:number){this.scaleX=x;return this;}
  setSizeToFrame(){return this;}
  override play(config:Phaser.Types.Animations.PlayAnimationConfig){this.anims.play(config);return this;}
}

function setup(){
  const actor=structuredClone(catalog.classes.find(character=>character.id==='ranger')!.actor);
  // 内容构建把原始路径改写成图集规范路径；运行时只认规范路径。
  for(const clip of Object.values(actor.clips))for(const layer of clip!.layers)
    if(layer.file)layer.file=CHARACTER_ATLAS_ALIASES[layer.file]??layer.file;
  // 原默认图集合成一层；换装版身体/武器分层，夹具为每向增加独立武器层。
  for(const direction of ['north','south','east','west'] as const){
    const clip=actor.clips[`skill-multiple-shot-${direction}`]!;
    clip.layers.push({...clip.layers[0],key:`weapon-${direction}`});
  }
  const manager=Object.assign(new EventEmitter(),{getMix:()=>0,globalTimeScale:1,
    textureManager:{getFrame:(key:string,name:number)=>({texture:{key},name})}});
  const timers:{callback:()=>void;removed:boolean;remove:()=>void}[]=[];
  const scene={sys:{anims:manager},events:new EventEmitter(),add:{sprite:()=>new Sprite(scene)},
    time:{delayedCall:(_delay:number,callback:()=>void)=>{
      const timer={callback,removed:false,remove(){this.removed=true;}};timers.push(timer);return timer;
    }}} as unknown as Phaser.Scene;
  const character={actor,entity:{id:'player',actor:actor.id},layers:[],clipName:null,
    container:{active:true,x:0,y:0,addAt:()=>{}}} as unknown as CharacterVisual;
  const action:ActionPlayback={caster:{id:'player',team:'party',position:{x:0,y:0},bounds:{x:0,y:0,width:16,height:16}},
    facing:'east',basicAttack:null,skill:{id:'multiple-shot',action:catalog.skills['multiple-shot'].action!,level:1}};
  const presenter=new CombatPresenter(scene,catalog,()=>character,()=>[]);
  const frames:number[]=[];let completed=0,time=0;
  const cancel=playCombat(presenter,action,index=>{
    frames.push(index);if(index===3)action.facing='north';if(index===6)action.facing='west';
  },()=>completed++);
  const layers=character.layers as unknown as Sprite[];
  return {action,character,layers,frames,timers,cancel,completed:()=>completed,
    advance:(delta:number)=>{time+=delta;for(const layer of layers)layer.anims.update(time,delta);}};
}

// 通过 frameRate 换算每帧时长会留下浮点尾数，相位断言只比较到微秒级。
function assertPhase(accumulator:number,expected:number):void{
  assert.ok(Math.abs(accumulator-expected)<1e-6,`accumulator ${accumulator}`);
}

test('real Phaser animation changes body and weapon direction while preserving per-layer phase and total lifetime',()=>{
  const f=setup(),originalLayers=[...f.layers];
  f.advance(130);f.advance(60);
  assert.deepEqual(f.frames,[1,2,3]);assert.equal(f.character.clipName,'skill-multiple-shot-north');
  for(const [index,layer]of f.layers.entries()){
    assert.equal(layer,originalLayers[index]);assert.equal(layer.anims.currentFrame!.index,4);
    assertPhase(layer.anims.accumulator,10);
    const northClip=f.character.actor.clips['skill-multiple-shot-north']!;
    const northFrame=characterFrameList(northClip.layers[index]!.file,northClip.frames)[0]!;
    assert.equal(layer.frame!.name,northFrame.frame);
    assert.equal(layer.frame!.texture.key,northFrame.key);
    assert.equal(layer.scaleX,1);
  }
  f.advance(60);
  for(const [index,layer]of f.layers.entries()){
    const northClip=f.character.actor.clips['skill-multiple-shot-north']!;
    const northFrame=characterFrameList(northClip.layers[index]!.file,northClip.frames)[1]!;
    assert.equal(layer.anims.currentFrame!.index,5);
    assert.equal(layer.frame!.name,northFrame.frame);assert.equal(layer.frame!.texture.key,northFrame.key);
  }
  f.advance(120);assert.equal(f.character.clipName,'skill-multiple-shot-west');
  for(const [index,layer]of f.layers.entries()){
    const clip=f.character.actor.clips['skill-multiple-shot-west']!;
    const westFrames=characterFrameList(clip.layers[index]!.file,clip.frames);
    assert.equal(layer.anims.currentFrame!.index,7);
    assert.ok(westFrames.some(frame=>frame.key===layer.frame!.texture.key&&frame.frame===layer.frame!.name),
      '当前贴图仍是这一层的图集帧');
    assert.equal(layer.originX,clip.originX);assert.equal(layer.originY,clip.originY);assert.equal(layer.scaleX,1);
  }
  for(let i=0;i<13;i++)f.advance(60);
  assert.equal(f.completed(),1);assert.equal(f.timers.length,1);assert.equal(f.timers[0].removed,true);
  assert.deepEqual(f.frames,Array.from({length:18},(_,index)=>index+1));
});

test('paused Phaser animations keep their phase through facing changes; cancellation prevents more action events',()=>{
  const f=setup();f.advance(130);
  for(const layer of f.layers)layer.anims.pause();f.advance(1000);
  assert.deepEqual(f.frames,[1,2]);
  for(const layer of f.layers)layer.anims.resume();f.advance(60);
  assert.deepEqual(f.frames,[1,2,3]);
  for(const layer of f.layers){assert.equal(layer.anims.currentFrame!.index,4);assertPhase(layer.anims.accumulator,10);}
  f.cancel();f.advance(120);f.timers[0].callback();
  assert.deepEqual(f.frames,[1,2,3]);assert.equal(f.completed(),0);assert.equal(f.timers[0].removed,true);
});
