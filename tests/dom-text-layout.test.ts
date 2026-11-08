import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import type Phaser from 'phaser';
import { DomUi } from '../src/ui/dom/dom-ui.ts';
import { MenuTextLayer } from '../src/ui/dom/menu-text.ts';
import { installMenuDom } from './support/menu-dom.ts';

after(installMenuDom());

test('text follows translated viewports and anchor changes without recreating labels',()=>{
  const dom=new DomUi();let x=10,y=20;const labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(px,py)=>({x:x+px,y:y+py,scale:1}),()=>0);
  layer.register('page',writer=>writer.add({key:'title',text:'人物',x:30,y:40,style:{size:20}}));
  layer.renderPage('page');const label=labels[0];assert(label.element.style.transform.includes('40px, 60px'));
  x=100;y=200;layer.refresh();assert.equal(labels.length,1);assert(label.element.style.transform.includes('130px, 240px'));
  label.setAnchor(.5,1);assert(label.element.style.transform.includes('translate(-50%, -100%)'));
  layer.destroy();
});

test('reused menu text updates and clears its contrast shadow',()=>{
  const dom=new DomUi(),labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(x,y)=>({x,y,scale:1}),()=>0);
  let textShadow:string|undefined='1px 1px 0 #000';
  layer.register('page',writer=>writer.add({key:'value',text:'10 / 20',x:0,y:0,style:{size:17,textShadow}}));
  layer.renderPage('page');assert.equal(labels[0].element.style.textShadow,textShadow);
  textShadow='-1px -1px 0 #000';layer.renderPage('page');assert.equal(labels[0].element.style.textShadow,textShadow);
  textShadow=undefined;layer.renderPage('page');assert.equal(labels[0].element.style.textShadow,'');assert.equal(labels.length,1);
  layer.destroy();
});

test('world labels share measurements within a frame and follow camera and viewport changes',t=>{
  const dom=new DomUi(),frame=document.getElementById('game-frame')!;
  let frameRect={left:10,top:20,width:800,height:480},canvasRect={left:30,top:50,width:400,height:240};
  const frameRead=t.mock.method(frame,'getBoundingClientRect',()=>frameRect as DOMRect);
  let canvasReads=0;
  const canvas={getBoundingClientRect:()=>{canvasReads++;return canvasRect;}};
  const game={canvas,loop:{frame:1}},scale={width:800,height:480};
  const camera={scene:{game,scale},worldView:{x:100,y:200},zoom:2} as unknown as Phaser.Cameras.Scene2D.Camera;
  assert.deepEqual(dom.worldToScreen(camera,130,240),{x:50,y:70});
  assert.deepEqual(dom.frameSize(camera),{width:800,height:480});
  assert.equal(dom.storyUnit(camera),1);
  camera.worldView.x=110;camera.zoom=1;
  assert.deepEqual(dom.worldToScreen(camera,130,240),{x:30,y:50},'camera motion stays live');
  assert.equal(frameRead.mock.callCount(),1);assert.equal(canvasReads,1);
  frameRect={left:20,top:30,width:1000,height:600};canvasRect={left:60,top:70,width:800,height:480};
  game.loop.frame++;
  assert.deepEqual(dom.frameSize(camera),{width:1000,height:600});
  assert.deepEqual(dom.worldToScreen(camera,130,240),{x:60,y:80});
  assert.equal(frameRead.mock.callCount(),2);assert.equal(canvasReads,2);
  frameRect={...frameRect,width:900};dom.layout();
  assert.equal(dom.frameSize(camera).width,900,'layout invalidates measurements immediately');
  assert.equal(frameRead.mock.callCount(),3);assert.equal(canvasReads,3);
});

