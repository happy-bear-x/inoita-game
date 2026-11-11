import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {EffectClip} from '../src/domain/content.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {EFFECT_ATLAS_BY_FILE,EFFECT_ATLAS_PAGES} from '../src/generated/effect-atlas.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3},Scenes:{Events:{SHUTDOWN:"shutdown"}}}',shortCircuit:true}
  :next(specifier,context);}});
const {EffectPool}=await import('../src/rendering/effects.ts');
const {CombatFeedback}=await import('../src/rendering/combat-feedback.ts');
const {CombatOutcomes}=await import('../src/rendering/combat-outcomes.ts');
hook.deregister();

interface Play {key:string;startFrame?:number;repeat?:number;delay?:number}

/** 特效层必须引用真实图集文件；两个不同的长条图用于验证两层各建一条动画。 */
const mappedFiles=Object.keys(EFFECT_ATLAS_BY_FILE);
const firstFile=mappedFiles.find(file=>EFFECT_ATLAS_BY_FILE[file]!.length>=10)!;
const secondFile=mappedFiles.find(file=>file!==firstFile&&EFFECT_ATLAS_BY_FILE[file]!.length>=10)!;

/** 被测代码只看 Phaser 的公开面，测试里换成同名替身。 */
const view=(value:Phaser.GameObjects.Container)=>value as unknown as Display;

class Display extends EventEmitter {
  active=true;visible=true;depth=0;x=0;y=0;
  textureKey:string;scene?:Phaser.Scene;
  list:Display[]=[];parentContainer?:Display;
  plays:Play[]=[];
  anims={accumulator:0,stop:()=>{this.anims.accumulator=0;}};
  constructor(textureKey='sheet',x=0,y=0){super();this.textureKey=textureKey;this.x=x;this.y=y;}
  get length(){return this.list.length;}
  get texture(){return {key:this.textureKey};}
  setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
  setDepth(value:number){this.depth=value;return this;}
  setVisible(value:boolean){this.visible=value;return this;}
  setActive(value:boolean){this.active=value;return this;}
  setOrigin(){return this;}setScale(){return this;}setBlendMode(){return this;}
  /** Phaser 的事件器允许只传事件名移除全部监听。 */
  override off(event:string,listener?:()=>void){if(listener)super.off(event,listener);else this.removeAllListeners(event);return this;}
  play(config:Play){this.plays.push(config);this.visible=true;return this;}
  add(child:Display){child.parentContainer?.remove(child);this.list.push(child);child.parentContainer=this;return this;}
  addAt(child:Display,index:number){child.parentContainer?.remove(child);this.list.splice(index,0,child);child.parentContainer=this;return this;}
  remove(child:Display){this.list=this.list.filter(value=>value!==child);child.parentContainer=undefined;return this;}
  removeAll(destroy=false){for(const child of [...this.list]){this.remove(child);if(destroy)child.destroy();}return this;}
  destroy(){if(!this.active)return;this.active=false;this.parentContainer?.remove(this);this.emit('destroy');this.removeAll(true);this.removeAllListeners();}
}

function fixture(){
  const containers:Display[]=[];const animations=new Map<string,{key:string;frames:unknown[];frameRate:number}>();
  const created:{key:string}[]=[];
  const scene={
    events:new EventEmitter(),
    textures:{exists:()=>true,remove:()=>{}},
    anims:{exists:(key:string)=>animations.has(key),get:(key:string)=>animations.get(key),
      create:(value:{key:string;frames:unknown[];frameRate:number})=>{created.push(value);animations.set(value.key,value);return value;},
      remove:(key:string)=>{animations.delete(key);},
      generateFrameNumbers:(_key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,index)=>start+index)},
    add:{container:(x:number,y:number)=>{const value=new Display('container',x,y);value.scene=scene;containers.push(value);return value;},
      sprite:(_x:number,_y:number,key:string)=>{const value=new Display(key);value.scene=scene;return value;}},
    time:{delayedCall:()=>({remove:()=>{}})},
  } as unknown as Phaser.Scene;
  const clip=(frames=3):EffectClip=>({version:1,frameWidth:16,frameHeight:16,frames,originX:.5,originY:.5,
    frameRate:10,mirrorX:false,layers:[{key:'test-effect',file:firstFile,blend:'normal',operations:[]},
      {key:'test-effect-add',file:secondFile,blend:'add',operations:[]}]});
  /** 让第一个精灵动画跑完，和 Phaser 的 animationcomplete 一致。 */
  const complete=(effect:Display)=>effect.list[0]!.emit('animationcomplete');
  return {scene,containers,created,clip,complete};
}

test('同一个特效片段回收后直接重播，不重建容器与图层',()=>{
  const f=fixture(),pool=new EffectPool(f.scene),clip=f.clip();
  const first=view(pool.acquire(clip,10,20));
  assert.equal(f.containers.length,1);
  assert.equal(first.list.length,2);
  const sprites=[...first.list];
  f.complete(first);
  assert.equal(first.visible,false,'回收后先隐藏');
  const again=view(pool.acquire(clip,30,40));
  assert.equal(again,first,'复用同一个容器');
  assert.equal(f.containers.length,1,'没有再建容器');
  assert.deepEqual(again.list,sprites,'图层原样保留');
  assert.deepEqual([again.x,again.y,again.visible],[30,40,true]);
  for(const sprite of again.list as unknown as Display[])
    assert.deepEqual(sprite.plays.at(-1),{key:sprite.plays.at(-1)!.key,startFrame:0,repeat:0},'从第 0 帧重播');
});

test('回收的特效从角色容器里摘下，再取时能换到别的位置',()=>{
  const f=fixture(),pool=new EffectPool(f.scene),clip=f.clip();
  const holder=new Display('holder');
  const effect=view(pool.acquire(clip,0,0));
  holder.add(effect);
  f.complete(effect);
  assert.equal(effect.parentContainer,undefined,'播放完从角色身上摘下');
  assert.deepEqual(holder.list,[]);
  const moved=view(pool.acquire(clip,7,8));
  assert.equal(moved.parentContainer,undefined);
  assert.deepEqual([moved.x,moved.y],[7,8]);
});

test('同片段空闲容器有上限，超出的直接销毁',()=>{
  const f=fixture(),pool=new EffectPool(f.scene),clip=f.clip();
  const live=Array.from({length:20},()=>view(pool.acquire(clip,0,0)));
  for(const effect of live)f.complete(effect);
  const destroyed=live.filter(effect=>!effect.active);
  assert.equal(destroyed.length,4,'每个片段最多留 16 个');
  assert.equal(f.containers.filter(value=>value.active).length,16);
  pool.destroy();
  assert.equal(f.containers.filter(value=>value.active).length,0,'销毁池时清掉空闲容器');
});

test('预热先建好容器和动画，首次播放不再现建',()=>{
  const f=fixture(),pool=new EffectPool(f.scene),clip=f.clip();
  pool.warm(clip);
  assert.equal(f.containers.length,1,'预热建一个容器');
  assert.equal(f.containers[0]!.visible,false,'预热后先隐藏');
  const animations=f.created.length;
  assert.equal(animations,2,'两层动画都已建好');
  const effect=view(pool.acquire(clip,30,40));
  assert.equal(effect,f.containers[0],'首次播放复用预热容器');
  assert.equal(f.containers.length,1,'没有再建容器');
  assert.equal(f.created.length,animations,'没有再建动画');
  assert.deepEqual([effect.x,effect.y,effect.visible],[30,40,true]);
  pool.destroy();
});

test('战斗开始预热结算特效，升级只复用并按角色挂载',()=>{
  const f=fixture();
  const names=['enemy-vanish','energy-column','level-up-aura','level-up-light','level-up-burst'] as const;
  const attackEffects=Object.fromEntries(names.map(name=>[name,{clips:{default:f.clip()}}]));
  const catalog={attackEffects} as unknown as BattleCatalog;
  const outcomes=new CombatOutcomes(f.scene,catalog);
  outcomes.warm();
  assert.equal(f.containers.length,5,'五个结算片段各预热一个容器');
  const animations=f.created.length;
  const body=new Display('body'),container=new Display('character');container.add(body);
  const character={layers:[body],container,
    actor:{id:'hero',effectAnchor:{x:5,y:6}}} as unknown as CharacterVisual;
  outcomes.levelUp(character);
  assert.equal(f.containers.length,5,'升级没有再建容器');
  assert.equal(f.created.length,animations,'升级没有再建动画');
  assert.equal(character.container.list.length,3,'两个效果挂在角色上，一个独立播放');
  const visible=f.containers.filter(effect=>effect.visible);
  assert.equal(visible.length,3);
  for(const effect of visible)f.complete(effect);
  assert.ok(f.containers.every(effect=>!effect.visible),'播完回池并隐藏');
  outcomes.destroy();
  assert.equal(f.containers.filter(effect=>effect.active).length,0,'销毁战斗时清掉池');
});

test('数字动画按序列只建一次，重复命中复用同一个数字容器',()=>{
  const f=fixture();
  const clips:Record<string,EffectClip>={default:f.clip()};
  for(let digit=0;digit<10;digit++)clips[String(digit)]={...f.clip(10),
    layers:[{key:`digit-${digit}`,file:firstFile,blend:'normal',operations:[]}]};
  const catalog={attackEffects:{enemy:{clips}},feedback:{shakeOffsets:[]}} as unknown as BattleCatalog;
  const target={layers:[],actor:{effectAnchor:{x:0,y:0}},container:new Display('player')} as unknown as CharacterVisual;
  const feedback=new CombatFeedback(f.scene,catalog);
  const event={hit:{kind:'hit',damage:7},style:'weapon',periodic:false,casterControlled:true,
    targetFriendly:false,targetParty:false,involvesControlled:true} as const;
  feedback.show(event,target,{impacts:[],digitEffect:'enemy'});
  const digits=()=>f.containers.filter(value=>value.list.some(sprite=>sprite.plays.some(play=>play.key.startsWith('damage:'))));
  const digit=digits()[0]!;
  assert.equal(digit.list.length,1,'一个数字一个精灵');
  const digitPages=[...new Set(EFFECT_ATLAS_BY_FILE[firstFile]!.slice(0,10).map(ref=>EFFECT_ATLAS_PAGES[ref.page]!.key))];
  assert.equal(digit.list[0]!.plays.at(-1)!.key,
    `damage:${firstFile}:${digitPages.join('+')}:10:0.1.2.3.4.5.6.7.8.9`,'按文件、图集页与帧序列取动画键');
  const createdOnce=f.created.filter(value=>value.key.startsWith('damage:')).length;
  assert.equal(createdOnce,1);
  f.complete(digit);
  assert.equal(digit.visible,false,'数字播完回池');
  feedback.show(event,target,{impacts:[],digitEffect:'enemy'});
  assert.equal(digits().length,1,'同一个数字容器复用');
  assert.equal(digit.visible,true);
  assert.equal(f.created.filter(value=>value.key.startsWith('damage:')).length,createdOnce,'动画没有重复创建');
  feedback.destroy();
  assert.equal(digit.active,false,'销毁反馈时清掉数字容器');
});
