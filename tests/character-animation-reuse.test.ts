import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire,registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import type Phaser from 'phaser';
import type {ActorDefinition} from '../src/domain/content.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3}}',shortCircuit:true}:next(specifier,context);}});
const {createCharacter,setCharacterClip,playCharacterSequence}=await import('../src/rendering/characters.ts');
const {setCharacterStealth}=await import('../src/rendering/character-visibility.ts');
const {retainLoadedSceneAssets}=await import('../src/rendering/scene-assets.ts');
hook.deregister();
const require=createRequire(import.meta.url);
const AnimationState=require('../node_modules/phaser/src/animations/AnimationState.js');
const Animation=require('../node_modules/phaser/src/animations/Animation.js');
const battle=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
const goblin=battle.enemies.find((enemy:{id:string})=>enemy.id==='enemy-goblin-1').actor as ActorDefinition;
const classes=JSON.parse(readFileSync(new URL('../public/content/story-classes.json',import.meta.url),'utf8')).classes as {id:string;previewActor:ActorDefinition}[];

function setup(actor:ActorDefinition=structuredClone(goblin)){
  const counts={sprites:0,destroyed:0,localAnimations:0};
  const textureMap=new Map<string,{key:string}>(),removed:string[]=[];
  for(const clip of Object.values(actor.clips))for(const layer of clip!.layers)textureMap.set(layer.key,{key:layer.key});
  const textures=Object.assign(new EventEmitter(),{exists:(key:string)=>textureMap.has(key),get:(key:string)=>textureMap.get(key),
    remove:(key:string)=>{removed.push(key);textureMap.delete(key);}});
  const definitions=new Map<string,Phaser.Animations.Animation>();
  const manager=Object.assign(new EventEmitter(),{globalTimeScale:1,getMix:()=>0,
    textureManager:{getFrame:(key:string,name:number)=>({texture:textureMap.get(key),name})},
    get:(key:string)=>definitions.get(key),exists:(key:string)=>definitions.has(key),
    remove:(key:string)=>{const animation=definitions.get(key);if(animation){manager.emit('removeanimation',key,animation);definitions.delete(key);}return animation;},
    create:(config:Phaser.Types.Animations.Animation):Phaser.Animations.Animation=>{
      const animation=new Animation(manager,config.key,config) as Phaser.Animations.Animation;definitions.set(config.key!,animation);return animation;},
    generateFrameNumbers:(key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,i)=>({key,frame:start+i}))});
  class Sprite extends EventEmitter {
    scene:unknown=scene;active=true;visible=true;alpha=1;x=0;y=0;scaleX=1;scaleY=1;originX=0;originY=0;blendMode=0;
    texture:{key:string}|undefined;frame:unknown;parentContainer?:Container;
    anims:Phaser.Animations.AnimationState|undefined;
    constructor(key:string){super();counts.sprites++;this.texture=textureMap.get(key);this.anims=new AnimationState(this);
      const create=this.anims!.create.bind(this.anims);
      this.anims!.create=config=>{counts.localAnimations++;return create(config);};}
    setTexture(key:string,frame=0){this.texture=textureMap.get(key);this.frame={texture:this.texture,name:frame};return this;}
    setSizeToFrame(){return this;}
    setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
    setOrigin(x:number,y:number){this.originX=x;this.originY=y;return this;}
    setBlendMode(mode:number){this.blendMode=mode;return this;}
    setScale(x:number,y=x){this.scaleX=x;this.scaleY=y;return this;}
    setVisible(value:boolean){this.visible=value;return this;}
    setAlpha(value:number){this.alpha=value;return this;}
    play(config:Phaser.Types.Animations.PlayAnimationConfig){this.anims!.play(config);return this;}
    destroy(){if(!this.scene)return;counts.destroyed++;this.anims!.destroy();this.anims=undefined;
      this.emit('destroy');this.removeAllListeners();this.parentContainer?.remove(this);this.scene=undefined;this.active=false;}
  }
  class Container {
    active=true;list:Sprite[]=[];
    setDepth(){return this;}
    addAt(sprite:Sprite,index:number){this.list.splice(index,0,sprite);sprite.parentContainer=this;return this;}
    getIndex(sprite:Sprite){return this.list.indexOf(sprite);}
    moveTo(sprite:Sprite,index:number){this.remove(sprite);this.list.splice(index,0,sprite);return this;}
    remove(sprite:Sprite){const index=this.list.indexOf(sprite);if(index>=0)this.list.splice(index,1);}
    destroy(){for(const sprite of [...this.list])sprite.destroy();this.active=false;}
  }
  const scene={textures,anims:manager,sys:{anims:manager},events:new EventEmitter(),
    add:{sprite:(_x:number,_y:number,key:string)=>new Sprite(key),container:()=>new Container()}} as unknown as Phaser.Scene;
  const character=createCharacter(scene,actor,{id:'goblin',actor:actor.id,x:0,y:0});
  const sprite=()=>character.layers[0] as unknown as Sprite;
  return {scene,character,sprite,counts,removed,textureMap,actor};
}

test('all class selection actors play their full idle animation continuously',()=>{
  for(const entry of classes){
    const f=setup(entry.previewActor),clip=entry.previewActor.clips['idle-south']!,state=f.sprite().anims!;
    assert.equal(f.character.clipName,'idle-south',entry.id);
    assert.equal(state.isPlaying,true,entry.id);
    assert.equal(state.currentAnim?.frames.length,clip.frames,entry.id);
    assert.equal(state.currentAnim?.repeat,-1,entry.id);
    f.character.container.destroy();assert.equal(f.counts.destroyed,clip.layers.length);
  }
});

test('repeated real goblin attacks reuse sprites and one local Phaser animation while batches still change',()=>{
  const f=setup(),body=f.sprite(),frames=[0,1,2,3,4,5,6];
  setCharacterStealth(f.character,true);
  for(let index=0;index<100;index++){
    const previous=f.character.layers;
    playCharacterSequence(f.scene,f.character,'attack-south',frames,60);
    assert.notEqual(f.character.layers,previous);assert.equal(f.sprite(),body);
    setCharacterClip(f.scene,f.character,'idle-south');assert.equal(body.alpha,.5);
  }
  assert.deepEqual(f.counts,{sprites:1,destroyed:0,localAnimations:1});
  setCharacterStealth(f.character,false);assert.equal(body.alpha,1);
  f.character.container.destroy();assert.equal(f.counts.destroyed,1);
});

test('local Phaser sequences change with timing and frames, keep their texture alive and release after Sprite preDestroy',()=>{
  const f=setup(),keys=[...f.textureMap.keys()];
  const owner=retainLoadedSceneAssets(f.scene,keys);
  playCharacterSequence(f.scene,f.character,'attack-south',[0,1,2],60);
  const sprite=f.sprite(),first=sprite.anims!.currentAnim!;
  owner.release();const attackKey=f.actor.clips['attack-south']!.layers[0].key;
  assert.ok(f.textureMap.has(attackKey),'local cached frames retain their source texture');
  playCharacterSequence(f.scene,f.character,'attack-south',[0,2,1],30);
  const second=sprite.anims!.currentAnim!;
  assert.notEqual(second,first);assert.equal(first.frames.length,0);
  assert.equal(sprite.anims!.get('character-action'),second);
  assert.deepEqual(second.frames.map(frame=>frame.textureFrame),[0,2,1]);assert.equal(second.frameRate,1000/30);
  playCharacterSequence(f.scene,f.character,'attack-south',[0,2,1],30);
  assert.equal(f.counts.localAnimations,2);assert.ok(f.textureMap.has(attackKey));
  assert.doesNotThrow(()=>sprite.destroy());assert.equal(second.frames.length,0);
  assert.equal(f.removed.filter(key=>key===attackKey).length,1);assert.equal(f.textureMap.has(attackKey),false);
});

test('dynamic outfit textures keep their OutfitPool ownership when cached local animations end',()=>{
  const actor=structuredClone(goblin);for(const clip of Object.values(actor.clips))for(const layer of clip!.layers)layer.file='';
  const f=setup(actor);playCharacterSequence(f.scene,f.character,'attack-south',[0,1,2],60);
  const old=f.sprite().anims!.currentAnim!;
  f.character.actor={...actor};setCharacterClip(f.scene,f.character,'idle-south',true);
  assert.equal(old.frames.length,0);assert.deepEqual(f.removed,[]);
  f.character.container.destroy();assert.deepEqual(f.removed,[]);
});

test('layer count changes keep existing sprites, reset old completion callbacks and preserve attached effects order',()=>{
  const actor=structuredClone(goblin),attack=actor.clips['attack-south']!;
  attack.layers.push({...attack.layers[0]});
  const f=setup(actor),body=f.sprite();let completed=0;
  const attachment={} as Phaser.GameObjects.GameObject;
  f.character.container.addAt(attachment,1);
  body.once('animationcomplete',()=>completed++);body.setVisible(false);
  setCharacterClip(f.scene,f.character,'attack-south',true);
  assert.equal(f.sprite(),body);assert.equal(body.visible,true);assert.equal(f.counts.sprites,2);
  body.emit('animationcomplete');assert.equal(completed,0);
  const added=f.character.layers[1];
  setCharacterClip(f.scene,f.character,'idle-south');
  assert.equal(f.sprite(),body);assert.equal(added.active,false);assert.equal(f.counts.destroyed,1);
  assert.deepEqual(f.character.container.list,[...f.character.layers,attachment]);
});

test('walking direction changes preserve real Phaser animation frame and elapsed time',()=>{
  const f=setup();setCharacterClip(f.scene,f.character,'walk-south');
  const sprite=f.sprite(),animation=sprite.anims!.currentAnim!;
  sprite.anims!.setCurrentFrame(animation.frames[2]);sprite.anims!.accumulator=17;
  setCharacterClip(f.scene,f.character,'walk-west');
  assert.equal(f.sprite(),sprite);assert.equal(sprite.anims!.currentFrame!.index,3);assert.equal(sprite.anims!.accumulator,17);
});
