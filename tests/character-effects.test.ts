import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Combatant} from '../src/domain/combat.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {setCharacterStealth} from '../src/rendering/character-visibility.ts';
import {loadSceneAssets,type PendingAsset} from '../src/rendering/scene-assets.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');
const {CombatEffects}=await import('../src/rendering/combat-effects.ts');
const {effectAssets}=await import('../src/rendering/effects.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

interface Animation {key:string;frames:unknown[];frameRate:number;repeat?:number}
class Display extends EventEmitter {
  active=true;visible=true;alpha=1;name='';x=0;y=0;depth=0;age=0;playing=false;
  list:Display[]=[];parent?:Display;animation?:Animation;
  anims={accumulator:0,timeScale:1,stop:()=>{this.playing=false;}};
  get length(){return this.list.length;}
  setName(value:string){this.name=value;return this;}
  setDepth(value:number){this.depth=value;return this;}
  setVisible(value:boolean){this.visible=value;return this;}
  setAlpha(value:number){this.alpha=value;return this;}
  setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
  setOrigin(){return this;}setScale(){return this;}setBlendMode(){return this;}
  add(value:Display){value.parent?.remove(value);this.list.push(value);value.parent=this;return this;}
  addAt(value:Display){return this.add(value);}
  remove(value:Display){this.list=this.list.filter(child=>child!==value);value.parent=undefined;}
  removeAll(destroy=false){for(const child of [...this.list]){this.remove(child);if(destroy)child.destroy();}}
  destroy(){if(!this.active)return;this.active=false;this.parent?.remove(this);this.emit('destroy');this.removeAll(true);this.removeAllListeners();}
}

function setup(){
  const nodes:Display[]=[],animations=new Map<string,Animation>(),textures=new Map<string,Set<number>>(),removed:string[]=[],queued:PendingAsset[]=[];
  const make=(x=0,y=0)=>{const value=new Display();value.x=x;value.y=y;nodes.push(value);return value;};
  const load=Object.assign(new EventEmitter(),{
    spritesheet:(key:string,file:string,config:Phaser.Types.Loader.FileTypes.ImageFrameConfig)=>queued.push({kind:'spritesheet',key,file,config}),
    image:(key:string,file:string)=>queued.push({kind:'image',key,file}),
    start:()=>queueMicrotask(()=>{for(const asset of queued.splice(0))textures.set(asset.key,new Set(Array.from({length:asset.kind==='spritesheet'?Number(asset.config.endFrame)+1:1},(_,i)=>i)));load.emit('complete');}),
  });
  const scene={events:new EventEmitter(),load,
    textures:{exists:(key:string)=>textures.has(key),get:(key:string)=>({has:(frame:string)=>textures.get(key)!.has(Number(frame))}),remove:(key:string)=>{removed.push(key);textures.delete(key);}},
    anims:{exists:(key:string)=>animations.has(key),create:(value:Animation)=>{animations.set(value.key,value);return value;},
      generateFrameNumbers:(_key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,i)=>i+start),
      remove:(key:string)=>animations.delete(key)},
    add:{container:make,layer:()=>make(),sprite:()=>Object.assign(make(),{
      play(this:Display,config:{key:string}){this.animation=animations.get(config.key);this.age=0;this.playing=true;return this;},
    })},
    tweens:{killTweensOf:()=>{},add:()=>({remove:()=>{}})},time:{delayedCall:()=>({remove:()=>{}})},facing:'east',
  } as unknown as Phaser.Scene;
  const advance=(count:number)=>{for(let tick=0;tick<count;tick++)for(const node of [...nodes]){
    if(!node.active||!node.playing||!node.animation)continue;
    if(++node.age>=node.animation.frames.length){node.playing=false;node.emit('animationcomplete');}
    else node.emit('animationupdate',node.animation,{index:node.age+1});
  }};
  const character=(id:string)=>({entity:{id,actor:id,x:0,y:0},actor:{id,effectAnchor:{x:0,y:-8},clips:{}},container:make(),layers:[],clipName:null}) as unknown as CharacterVisual;
  const actor=(id:string):Combatant=>({id,team:'party',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}});
  const effects=(name:string)=>nodes.filter(node=>node.name===name&&node.active);
  return {scene,nodes,animations,textures,removed,character,actor,effects,advance};
}

test('Whist smoke attaches to moving feet at full opacity and survives the next action clear until its sixth frame',async()=>{
  const f=setup(),effects=new CombatEffects(f.scene),visual=f.character('player'),caster=f.actor('player');
  const lease=await loadSceneAssets(f.scene,effectAssets({'smoke-puff':catalog.attackEffects['smoke-puff']}),()=>{});
  const body=f.scene.add.sprite(0,0,'body');visual.layers.push(body);visual.container.add(body);
  visual.container.setPosition(24,40);
  setCharacterStealth(visual,true);assert.equal(body.alpha,0.5);
  const presenter=new CombatPresenter(f.scene,catalog,()=>visual,()=>[caster],effects);
  dispatchFrame(presenter,{caster,facing:'east',basicAttack:null,skill:{id:'whist',action:catalog.skills.whist.action!,level:1}},2);
  const smoke=f.effects('smoke-puff')[0];assert.ok(smoke);
  assert.equal(smoke.parent,visual.container);assert.deepEqual({x:smoke.x,y:smoke.y},{x:0,y:0});
  assert.equal(smoke.alpha,1);assert.ok(smoke.list.every(layer=>layer.alpha===1));
  assert.equal(visual.container.alpha,1,'stealth only changes the body sprites');
  visual.container.setPosition(72,96);
  assert.deepEqual({x:smoke.x+smoke.parent!.x,y:smoke.y+smoke.parent!.y},{x:72,y:96});
  presenter.clear();assert.equal(smoke.active,true);
  dispatchFrame(presenter,{caster,facing:'east',basicAttack:null,skill:{id:'whist',action:catalog.skills.whist.action!,level:1}},0);
  f.advance(5);assert.equal(smoke.active,true);f.advance(1);assert.equal(smoke.active,false);
  assert.equal(visual.container.active,true);effects.clear();lease.release();
});

test('character-owned smoke retains loaded textures across action cancellation and releases them on natural completion or owner destruction',async()=>{
  for(const end of ['animation','character','world'] as const){
    const f=setup(),effects=new CombatEffects(f.scene),visual=f.character('player'),caster=f.actor('player');
    const assets=effectAssets({'smoke-puff':catalog.attackEffects['smoke-puff']});
    const lease=await loadSceneAssets(f.scene,assets,()=>{});
    const presenter=new CombatPresenter(f.scene,catalog,()=>visual,()=>[caster],effects);
    presenter.showEffects('player',[{effect:'smoke-puff',recipient:'caster',placement:'attached'}]);
    const smoke=f.effects('smoke-puff')[0];assert.ok(smoke);let destroyed=0;smoke.on('destroy',()=>destroyed++);
    presenter.clear();lease.release();
    for(const asset of assets)assert.equal(f.textures.has(asset.key),true,`${end}: texture retained by smoke`);
    if(end==='animation')f.advance(6);
    else if(end==='character')visual.container.destroy();
    else effects.clear();
    assert.equal(smoke.active,false,end);assert.equal(destroyed,1,end);
    for(const asset of assets){assert.equal(f.textures.has(asset.key),false,asset.key);assert.equal(f.animations.has(asset.key),false,asset.key);}
    presenter.clear();effects.clear();visual.container.destroy();
    assert.equal(destroyed,1);assert.equal(new Set(f.removed).size,f.removed.length);
  }
});

test('character lifetime is specific to generated smoke and does not retain ordinary attached or in-flight action visuals',async()=>{
  const f=setup(),effects=new CombatEffects(f.scene),visual=f.character('player'),caster=f.actor('player');
  const lease=await loadSceneAssets(f.scene,effectAssets({'smoke-puff':catalog.attackEffects['smoke-puff']}),()=>{});
  const presenter=new CombatPresenter(f.scene,catalog,()=>visual,()=>[caster],effects);
  presenter.showEffects('player',[{effect:'smoke-puff',recipient:'caster',placement:'attached'},
    {effect:'life-drain',recipient:'caster',placement:'attached'}]);
  const smoke=f.effects('smoke-puff')[0],attached=f.effects('life-drain')[0];
  const flight=Reflect.get(CombatPresenter.prototype,'effect').call(presenter,'smoke-puff','default',{x:0,y:0},true) as Display;
  presenter.clear();assert.equal(smoke.active,true);assert.equal(attached.active,false);assert.equal(flight.active,false);
  visual.container.destroy();assert.equal(smoke.active,false);effects.clear();lease.release();
});
