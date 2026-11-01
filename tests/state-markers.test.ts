import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3},Scenes:{Events:{UPDATE:"update"}}}',shortCircuit:true}
  :next(specifier,context);}});
const {StateMarkers}=await import('../src/rendering/state-markers.ts');hook.deregister();
const catalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8')) as BattleCatalog;

class Container {
  active=true;visible=true;name='';x=0;y=0;list:unknown[]=[];
  private parent?:Container;
  constructor(x=0,y=0,children:unknown[]=[]){this.x=x;this.y=y;for(const child of children)this.add(child);}
  get length(){return this.list.length;}
  add(child:unknown){this.list.push(child);if(child instanceof Container)child.parent=this;return this;}
  addAt(child:unknown,index:number){this.list.splice(index,0,child);if(child instanceof Container)child.parent=this;return this;}
  bringToTop(child:unknown){const index=this.list.indexOf(child);if(index>=0){this.list.splice(index,1);this.list.push(child);}return this;}
  removeAll(){for(const child of this.list)if(child instanceof Container)child.parent=undefined;this.list=[];return this;}
  setName(name:string){this.name=name;return this;}
  setDepth(){return this;}
  setVisible(visible:boolean){this.visible=visible;return this;}
  setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
  destroy(){this.active=false;if(this.parent){const index=this.parent.list.indexOf(this);if(index>=0)this.parent.list.splice(index,1);this.parent=undefined;}}
}
class Sprite {
  repeat=0;origin={x:0,y:0};key='';
  constructor(key=''){this.key=key;}
  anims={
    accumulator:0,paused:false,currentFrame:{index:1},currentAnim:{frames:[{index:1}]},
    pause(){this.paused=true;},resume(){this.paused=false;},setCurrentFrame(){}
  };
  setOrigin(x:number,y:number){this.origin={x,y};return this;}
  setScale(){return this;}
  setBlendMode(){return this;}
  play(config:{repeat:number}){this.repeat=config.repeat;return this;}
}
function sceneFixture():Phaser.Scene {
  return {
    events:{on(){},off(){}},
    add:{
      container:(x=0,y=0,children?:unknown[])=>new Container(x,y,children),
      sprite:(_x=0,_y=0,key='')=>new Sprite(key)
    },
    anims:{
      exists:()=>false,
      create:()=>{},
      generateFrameNumbers:(_key:string,config:{start:number;end:number})=>
        Array.from({length:config.end-config.start+1},(_,index)=>({index:config.start+index}))
    }
  } as unknown as Phaser.Scene;
}
function fixture(){
  const scene=sceneFixture();
  const container=new Container();
  const visual={container,layers:[],actor:{headAnchor:{x:0,y:-24}},entity:{},clipName:null,facing:null} as unknown as CharacterVisual;
  const conditions=new CombatConditions();
  const markers=new StateMarkers(scene,catalog);
  const sync=(visible=true)=>markers.sync('actor',visual,conditions.activeStates('actor'),visible);
  const marker=(name:string)=>container.list.find(child=>child instanceof Container&&child.name===name) as Container|undefined;
  const clip=(name:string)=>catalog.attackEffects[name]!.clips.default;
  return {container,visual,conditions,markers,sync,marker,clip};
}

test('applying sleep creates one looping state-sleep effect attached to the character',()=>{
  const f=fixture();
  f.conditions.applyState('actor','stealthed',1000);
  f.sync();
  assert.equal(f.container.list.length,0,'不画表现的状态不应建标记');
  f.conditions.applyState('actor','sleep',1000);
  f.sync();
  const marker=f.marker('state-marker:sleep');
  assert.ok(marker,'睡眠状态缺少标记');
  assert.equal(marker.length,1);
  const sprite=marker.list[0] as Sprite;
  assert.equal(sprite.key,f.clip('state-sleep').layers[0]!.key,'睡眠标记应播放 state-sleep 的素材');
  assert.equal(sprite.repeat,-1,'状态特效应循环播放');
  assert.deepEqual([marker.x,marker.y],[0,0],'标记挂在角色容器里，随角色移动');
  f.sync();
  assert.equal(f.container.list.filter(child=>child instanceof Container&&child.name==='state-marker:sleep').length,1,'重复同步不应重建标记');
});

test('sleep marker is removed when the state expires, wakes from damage, or the character hides',()=>{
  const f=fixture();
  f.conditions.applyState('actor','sleep',1000,'enemy');
  f.sync();
  const marker=f.marker('state-marker:sleep')!;
  // 受伤唤醒：战斗结算删掉 sleep 节点，下一帧同步拆掉表现。
  f.conditions.removeState('actor','sleep');
  f.sync();
  assert.equal(marker.active,false);
  assert.equal(f.marker('state-marker:sleep'),undefined);

  f.conditions.applyState('actor','sleep',1000,'enemy');
  f.sync();
  const expired=f.marker('state-marker:sleep')!;
  f.conditions.update(1000);
  f.sync();
  assert.equal(expired.active,false,'状态自然到期应销毁标记');

  f.conditions.applyState('actor','sleep',1000,'enemy');
  f.sync();
  const hidden=f.marker('state-marker:sleep')!;
  f.container.visible=false;
  f.sync();
  assert.equal(hidden.active,false,'角色隐藏时应销毁标记');
  f.container.visible=true;
  f.sync();
  assert.ok(f.marker('state-marker:sleep'),'角色重新显示后按仍在的状态重建标记');
});

test('stun creates a looping state-stun effect and follows the performance visibility switch',()=>{
  const f=fixture();
  f.conditions.applyState('actor','stun',1000);
  f.sync();
  const marker=f.marker('state-marker:stun');
  assert.ok(marker,'眩晕状态缺少标记');
  const sprite=marker.list[0] as Sprite;
  assert.equal(sprite.key,f.clip('state-stun').layers[0]!.key,'眩晕标记应播放 state-stun 的素材');
  assert.equal(sprite.repeat,-1,'状态特效应循环播放');
  assert.equal(marker.visible,true);
  f.sync(false);
  assert.equal(marker.visible,false,'性能隐藏时标记跟着隐藏');
  f.conditions.removeState('actor','stun');
  f.sync();
  assert.equal(marker.active,false);
});

test('sleep and stun markers coexist inside the character container',()=>{
  const f=fixture();
  f.conditions.applyState('actor','sleep',1000);
  f.conditions.applyState('actor','stun',1000);
  f.sync();
  assert.ok(f.marker('state-marker:sleep'));
  assert.ok(f.marker('state-marker:stun'));
  assert.equal(f.container.list.length,2,'两个标记都挂在角色容器里');
});

test('combat teardown clears markers even when the state nodes remain',()=>{
  const f=fixture();
  f.conditions.applyState('actor','sleep',1000);
  f.sync();
  const marker=f.marker('state-marker:sleep')!;
  f.markers.clear();
  assert.equal(marker.active,false);
  assert.equal(f.container.list.length,0);
});
