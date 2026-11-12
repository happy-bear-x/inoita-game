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

test('HUD controls stop pointer starts before they reach the game window listeners',()=>{
  const dom=new DomUi(),hud=dom.layer('hud')!,button=document.createElement('button');
  hud.appendChild(button);
  let handled=0,windowed=0;button.addEventListener('mousedown',()=>handled++);
  const onWindow=()=>windowed++;window.addEventListener('mousedown',onWindow);
  button.dispatchEvent(new Event('mousedown',{bubbles:true}));
  button.dispatchEvent(new Event('touchstart',{bubbles:true}));
  window.removeEventListener('mousedown',onWindow);
  assert.equal(handled,1,'控件自己的按下处理照常执行');
  assert.equal(windowed,0,'不再冒泡到 Phaser 的 window 监听');
});

test('dimmed page text stays in the DOM and only clips the side covered by the popup',()=>{
  const dom=new DomUi(),labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(x,y)=>({x,y,scale:1}),()=>0);
  layer.register('page',writer=>{
    writer.add({key:'page',text:'装备说明',x:10,y:10,style:{size:20,width:100},dim:true,
      occlude:{left:60,top:0,right:200,bottom:40}});
    writer.add({key:'popup',text:'确认',x:10,y:60,style:{size:20}});
  });
  layer.renderPage('page');
  const page=labels[0]!,popup=labels[1]!;
  assert.equal(page.element.style.opacity,'0.35','页面文字整体压暗');
  assert.equal(page.element.style.clipPath,'inset(0 50.00px 0 0)','只裁掉弹层盖住的右边一段');
  assert.equal(popup.element.style.opacity,'','弹层文字保持原亮度');
  assert.equal(popup.element.style.clipPath,'');
  layer.destroy();
});

test('full-width popups clip only the covered rows of a multi-line label',()=>{
  const dom=new DomUi(),labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(x,y)=>({x,y,scale:1}),()=>0);
  layer.register('page',writer=>writer.add({key:'page',text:'第一行第二行第三行',x:10,y:10,
    style:{size:20,width:100},dim:true,occlude:{left:0,top:30,right:200,bottom:60}}));
  layer.renderPage('page');
  assert.equal(labels[0]!.element.style.clipPath,'inset(0 0 30.00px 0)','只裁掉被横带盖住的下半段');
  assert.equal(labels[0]!.element.style.opacity,'0.35');
  layer.destroy();
});

test('a corner-covered multi-line label keeps the rows outside the popup',()=>{
  const dom=new DomUi(),labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(x,y)=>({x,y,scale:1}),()=>0);
  layer.register('page',writer=>writer.add({key:'page',text:'第一行第二行第三行',x:10,y:10,
    style:{size:20,width:100},dim:true,occlude:{left:60,top:30,right:200,bottom:60}}));
  layer.renderPage('page');
  assert.equal(labels[0]!.element.style.clipPath,
    'polygon(0 0, 100px 0, 100px 20px, 50px 20px, 50px 50px, 0 50px)','只切掉右下角被盖住的一块');
  layer.destroy();
});

test('a label partially outside a scroll viewport stays visible for the browser to clip',()=>{
  const dom=new DomUi(),labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(x,y)=>({x,y,scale:1}),()=>0);
  layer.register('page',writer=>writer.add({key:'page',text:'刚滚出上沿',x:10,y:10,
    style:{size:20,width:100},scroll:'list',clip:{top:20,bottom:100}}));
  layer.renderPage('page');
  assert.equal(labels[0]!.element.hidden,false,'标签顶部只露出一点时仍交给裁剪容器');
  layer.destroy();
});

test('reused menu text updates and clears its contrast background',()=>{
  const dom=new DomUi(),labels:ReturnType<DomUi['label']>[]=[];
  const layer=new MenuTextLayer({label:(...args)=>{const label=dom.label(...args);labels.push(label);return label;}},(x,y)=>({x,y,scale:1}),()=>0);
  let contrastBackground=true;
  layer.register('page',writer=>writer.add({key:'value',text:'10 / 20',x:0,y:0,style:{size:17,contrastBackground}}));
  layer.renderPage('page');assert.equal(labels[0].element.style.background,'rgba(0,0,0,.8)');
  contrastBackground=false;layer.renderPage('page');assert.equal(labels[0].element.style.background,'');
  assert.equal(labels[0].element.style.padding,'');assert.equal(labels.length,1);
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

