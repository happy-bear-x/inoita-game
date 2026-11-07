import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Combatant} from '../src/domain/combat.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,SCREEN:1,ADD:2,MULTIPLY:3}}',shortCircuit:true}:next(specifier,context);}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');
const {createCharacter,setCharacterClip,showIdlePose}=await import('../src/rendering/characters.ts');
hook.deregister();

const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;
/** 用户实际卡死的那个敌人：四向攻击素材 7 帧，普攻周期 15 帧。 */
const soldier=catalog.enemies.find(enemy=>enemy.id==='enemy-berkel-soldier-4')!;
const caster:Combatant={id:'soldier',team:'hostile',position:{x:0,y:0},bounds:{x:-4,y:-4,width:8,height:8}};
const attack=()=>resolveBasicAttack(catalog,{actor:soldier.actor,basicAttack:soldier.basicAttack});
/** 替身独有的字段（停播次数、贴图键、当前帧号）不在 Phaser 类型里，断言时按替身读。 */
const asDisplay=(layers:readonly Phaser.GameObjects.Sprite[])=>layers as unknown as Display[];

interface Definition {key:string;frames:unknown[];frameRate:number}
const animations=new Map<string,Definition>();
/** 动画状态替身：记录 `stop` 次数，收尾有没有动过这批图层由它判定。 */
class State {
  isPlaying=false;accumulator=0;timeScale=1;currentFrame:{index:number}={index:1};stops=0;
  create(definition:Definition):Definition & {destroy():void}{
    const animation={...definition,destroy(){animations.delete(definition.key);}};
    animations.set(definition.key,animation);return animation;
  }
  stop():void{this.isPlaying=false;this.stops++;}
}
/**
 * Phaser `Sprite` 的替身。销毁行为与 4.2.1 的 `Sprite.preDestroy` 一致：`anims` 一并消失，
 * 旧的收尾实现直接调用起手时抓到的 Sprite，销毁之后就是在这里抛 `undefined is not an object`。
 */
class Display extends EventEmitter {
  scene: object | undefined = {};
  active=true;visible=true;alpha=1;key:string;frame:number|undefined;
  anims:State|undefined=new State();
  constructor(key:string){super();this.key=key;}
  setDepth(){return this;}setOrigin(){return this;}setBlendMode(){return this;}setScale(){return this;}setPosition(){return this;}
  setVisible(value:boolean){this.visible=value;return this;}
  setAlpha(value:number){this.alpha=value;return this;}
  setTexture(key:string,frame?:number){this.key=key;this.frame=frame;return this;}
  play():this{this.anims!.isPlaying=true;this.anims!.currentFrame={index:1};return this;}
  destroy():void{if(!this.active)return;this.active=false;this.emit('destroy');this.removeAllListeners();this.anims=undefined;this.scene=undefined;}
}
class Container extends Display {
  children:Display[]=[];
  addAt(child:Display,index:number):this{this.children.splice(index,0,child);return this;}
  getIndex(child:Display){return this.children.indexOf(child);}
  moveTo(child:Display,index:number){this.children.splice(this.children.indexOf(child),1);this.children.splice(index,0,child);return this;}
}
function setup(){
  const scene={events:new EventEmitter(),
    add:{container:()=>new Container('container'),sprite:(_x:number,_y:number,key:string)=>new Display(key)},
    anims:{exists:(key:string)=>animations.has(key),create:(definition:Definition)=>new State().create(definition),
      generateFrameNumbers:(_key:string,{start,end}:{start:number;end:number})=>Array.from({length:end-start+1},(_,i)=>i+start)},
  } as unknown as Phaser.Scene;
  const character=createCharacter(scene,soldier.actor,{id:'story-located-enemy-berkel-soldier-4',actor:soldier.actor.id,x:0,y:0});
  const presenter=new CombatPresenter(scene,catalog,id=>id===caster.id?character:undefined,()=>[caster]);
  return {scene,character,presenter};
}

test('动作收尾时画面已被换过就放手，不碰接手者的图层',()=>{
  const {scene,character,presenter}=setup();
  const cleanup=presenter.play({caster,facing:'south',basicAttack:attack()});
  const started=asDisplay(character.layers);
  assert.equal(character.clipName,'attack-south');
  assert.ok(started.length>0&&started.every(layer=>layer.anims!.isPlaying));

  // 新动作取得新的图层批次，即使 Sprite 复用，旧动作也不能停掉接手者。
  setCharacterClip(scene,character,'idle-south');
  const takenOver=asDisplay(character.layers);
  assert.notEqual(takenOver,started);
  assert.equal(takenOver[0],started[0]);
  assert.ok(started.every(layer=>layer.active));
  const stopsBefore=takenOver.map(layer=>layer.anims!.stops);

  cleanup();
  assert.deepEqual(takenOver.map(layer=>layer.anims!.stops),stopsBefore,'接手者正在播的动画不能被停');
  assert.ok(takenOver.every(layer=>layer.anims!.isPlaying));
  assert.equal(character.clipName,'idle-south');
});

test('画面没有被换过时，动作收尾照旧停掉自己起的动画',()=>{
  const {character,presenter}=setup();
  const cleanup=presenter.play({caster,facing:'south',basicAttack:attack()});
  const layers=asDisplay(character.layers);
  const stops=layers.map(layer=>layer.anims!.stops);
  cleanup();
  assert.ok(layers.every((layer,index)=>layer.anims!.stops===stops[index]+1&&!layer.anims!.isPlaying),'动作结束后画面不再自走');
  assert.equal(character.clipName,'attack-south','收尾只停动画，切回待机仍由 afterMovement 负责');
});

test('素材播完后画面交给待机，动作动画不再写回攻击素材',()=>{
  const {scene,character}=setup();
  const resolved=attack(),cycleFrames=resolved.sequence.south.length;
  const sourceFrames=character.actor.clips['attack-south']!.frames;
  const idleFrames=character.actor.clips['idle-south']!.frames;
  setCharacterClip(scene,character,'attack-south',true);
  const layers=asDisplay(character.layers);
  const stops=layers.map(layer=>layer.anims!.stops);
  assert.ok(layers.every(layer=>layer.anims!.isPlaying));

  // 计数还在素材内：画面照常由动作动画画，待机不介入。
  showIdlePose(character,'south',sourceFrames-1,sourceFrames);
  assert.ok(layers.every((layer,index)=>layer.anims!.isPlaying&&layer.anims!.stops===stops[index]));

  // 计数达到素材帧数：画面交给待机，动作动画必须停下，否则它会按自己的节奏写回攻击末帧。
  showIdlePose(character,'south',sourceFrames,sourceFrames);
  assert.ok(layers.every((layer,index)=>!layer.anims!.isPlaying&&layer.anims!.stops===stops[index]+1));
  assert.ok(layers.every(layer=>layer.key==='enemy-berkel-soldier-1-idle-south-normal'&&layer.frame===sourceFrames%idleFrames));

  // 后续逻辑帧继续换待机画面，不再重复停播。
  showIdlePose(character,'south',sourceFrames+1,sourceFrames);
  assert.ok(layers.every((layer,index)=>layer.anims!.stops===stops[index]+1&&layer.frame===(sourceFrames+1)%idleFrames));
  assert.ok(cycleFrames>sourceFrames,'这条用例依赖末帧补位把周期撑得比素材长');
});
