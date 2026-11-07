import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { UiNode, UiImage } from '../src/ui/dom/node.ts';
import { UiSurface } from '../src/ui/dom/surface.ts';
import { CharacterPreview } from '../src/ui/dom/character-preview.ts';
import { domAssets } from '../src/ui/dom/assets.ts';
import { SceneUiAssets } from '../src/ui/phaser/ui-asset-host.ts';
import type { ActorDefinition } from '../src/domain/content.ts';
import { installMenuDom, domEvent, domWindow, MenuElement } from './support/menu-dom.ts';

after(installMenuDom());
function fixture() {
  const events=new EventEmitter(), scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  const scene={events,scale,game:{events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({left:0,top:0,width:1024,height:640})}}} as unknown as Phaser.Scene;
  const surface=new UiSurface(scene,1024,640);
  const pointer={id:1,x:30,y:30,isDown:true};
  const send=(node:UiNode,name:string,x=30,y=30,down=name!=='pointerup'&&name!=='pointercancel')=>domEvent(node.element,name,Object.assign(pointer,{x,y,isDown:down}));
  return {scene,surface,pointer,send,cleanup:()=>{surface.destroy();events.emit('shutdown');}};
}

test('DOM buttons reject guarded input, cancel captures on hide and blur, and keep static keyboard navigation',t=>{
  const f=fixture();t.after(f.cleanup);let calls=0,enabled=false;
  const button=f.surface.button('',10,10,80,40,()=>calls++,{bare:true,guard:()=>enabled});
  f.send(button,'pointerdown');f.send(button,'pointerup');assert.equal(calls,0);
  enabled=true;f.send(button,'pointerdown');assert(button.element.hasPointerCapture(1));
  f.surface.visible(false);assert(!button.element.hasPointerCapture(1));
  f.surface.visible(true);f.send(button,'pointerup');assert.equal(calls,0);
  f.send(button,'pointerdown');domWindow.dispatchEvent(new Event('blur'));f.send(button,'pointerup');assert.equal(calls,0);
  f.send(button,'pointerdown');f.scene.events.emit('pause');assert(!button.element.hasPointerCapture(1));
  f.scene.events.emit('resume');f.send(button,'pointerup');assert.equal(calls,0);
  f.send(button,'pointerdown');f.send(button,'pointerup');assert.equal(calls,1);
  f.surface.staticLayer('tabs',()=>f.surface.button('',0,0,20,20,()=>calls++,{bare:true,parent:f.surface.staticRoot}));
  f.surface.clear();
  f.surface.key({key:'Tab',preventDefault(){}} as KeyboardEvent);f.surface.key({key:'Enter',preventDefault(){}} as KeyboardEvent);
  assert.equal(calls,2,'重绘正文后静态页签仍能用键盘操作');
});

test('scrolling cancels nested button holds, suppresses release clicks and accepts the next tap',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();t.after(f.cleanup);let calls=0;
  const scroll=f.surface.scroll(0,0,200,200);scroll.setHeight(1000);
  const group=f.surface.container(0,0,scroll.content);
  const button=f.surface.button('',10,10,80,40,()=>calls++,{bare:true,parent:group,guard:scroll.guard,hold:{delayMs:350,intervalMs:80}});
  f.send(button,'pointerdown');f.send(button,'pointermove',30,10);t.mock.timers.tick(500);f.send(button,'pointerup',30,10);
  assert.equal(calls,0);assert(scroll.scrollTop>0);assert(!button.element.hasPointerCapture(1));
  f.send(button,'pointerdown');f.send(button,'pointerup');assert.equal(calls,1);
  f.send(button,'pointerdown');t.mock.timers.tick(350);assert.equal(calls,2);
  domWindow.dispatchEvent(new Event('blur'));t.mock.timers.tick(500);assert.equal(calls,2);
});

test('DOM drag hit guards use centered local geometry and cancellation releases capture',t=>{
  const f=fixture();t.after(f.cleanup);let enabled=false,starts=0,ends=0;
  const node=f.surface.container(100,100).setSize(80,60).setInteractive({x:-40,y:-30,width:80,height:60},()=>enabled).draggable();
  node.on('dragstart',()=>starts++).on('dragend',()=>ends++);
  f.send(node,'pointerdown',130,120);assert.equal(starts,0);
  enabled=true;f.send(node,'pointerdown',130,120);assert.equal(starts,1);
  f.send(node,'pointercancel',130,120);assert(!node.element.hasPointerCapture(1));f.send(node,'pointerup',130,120);assert.equal(ends,0);
  f.send(node,'pointerdown',145,120);assert.equal(starts,1,'矩形外侧不能开始拖动');
});

test('volume dragging updates its value and stops when cancelled or covered',t=>{
  const f=fixture();t.after(f.cleanup);const values:number[]=[];
  const slider=f.surface.slider('music',50,50,100,.5,value=>values.push(value));
  const zone=slider.root.list.find(node=>node.input)!;
  f.send(zone,'pointerdown',75,50);f.send(zone,'pointermove',125,50);
  assert.deepEqual(values,[.25,.75]);
  f.send(zone,'pointercancel',125,50);f.send(zone,'pointermove',140,50);assert.equal(slider.value,.75);
  f.surface.enabled=()=>false;f.send(zone,'pointerdown',90,50);assert.equal(slider.value,.75);
  f.surface.enabled=()=>true;f.send(zone,'pointerdown',90,50);assert.equal(slider.value,.4);
  f.surface.visible(false);f.send(zone,'pointermove',130,50);assert.equal(slider.value,.4);
});

test('image size is available before loading and flipping preserves the outer anchor',t=>{
  const f=fixture();t.after(f.cleanup);
  const image=new UiImage(f.scene,f.surface.root).resize(240,38).setOrigin(0,1);
  assert.deepEqual([image.width,image.height],[240,38]);
  image.applySource({url:'source.png',width:400,height:200,frame:{x:40,y:30,width:120,height:19}}).setFlipY(true);
  assert.equal(image.element.style.transformOrigin,'0 0');
  assert(image.element.style.transform.includes('translate(0%,-100%)'));
  const picture=(image.element as unknown as MenuElement).children[0];assert.equal(picture.style.transform,'scale(1,-1)');
  const sourceWidth=picture.style.width;
  image.setCrop(0,0,120,38);
  assert.equal(image.width,240);assert.equal(picture.style.width,sourceWidth,'资源条裁边时保持原图倍率');
  assert.equal(image.element.style.clipPath,'inset(0px 120px 0px 0px)');
});

test('character preview reuses source pixels, follows its target box and releases detached images',t=>{
  const f=fixture();t.after(f.cleanup);
  let exports=0;const source={width:200,height:200,toDataURL:()=>{exports++;return 'data:image/png;base64,source';}};
  Object.assign(f.scene,{textures:{get:()=>({get:()=>({cutX:20,cutY:40}),getSourceImage:()=>source})}});
  const actor={clips:{'idle-south':{frameWidth:40,frameHeight:80,originX:.5,originY:1,mirrorX:true,layers:[{key:'body',blend:'normal'}]}}} as unknown as ActorDefinition;
  const preview=new CharacterPreview(f.scene);preview.show(f.surface,actor,{x:0,y:0,width:80,height:160});
  const image=f.surface.root.list.at(-1)!;assert.deepEqual([image.x,image.y,image.scaleX],[40,160,2]);
  preview.detach();assert(!image.visible);preview.show(f.surface,actor,{x:100,y:50,width:40,height:80});
  assert.deepEqual([image.x,image.y,image.scaleX],[120,130,1]);assert.equal(exports,1);
  preview.destroy();assert(!image.active);
});

test('menu preloads share caller cancellation and release the retained DOM images',async t=>{
  const f=fixture();t.after(f.cleanup);const request=new AbortController();let signal:AbortSignal|undefined,released=0;
  t.mock.method(domAssets,'preloadFiles',async(_files:readonly string[],input:AbortSignal)=>{signal=input;input.throwIfAborted();return {release:()=>released++};});
  const host=new SceneUiAssets(f.scene);await host.preloadFiles(['portrait.png'],request.signal,()=>{});
  assert.equal(signal,request.signal);host.releaseContent();host.releaseContent();assert.equal(released,1);
  request.abort();await assert.rejects(host.preloadFiles(['portrait.png'],request.signal,()=>{}),{name:'AbortError'});
});
