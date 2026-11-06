import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type Phaser from 'phaser';
import { groundLootAssets, GroundLootView } from '../src/rendering/ground-loot.ts';
import { pickupMessageAssets, PickupMessages, type PickupAnchor } from '../src/rendering/pickup-messages.ts';
import type { DomUi } from '../src/ui/dom/dom-ui.ts';
import { parseItemCatalog } from '../src/application/content-validation.ts';

const items=parseItemCatalog(JSON.parse(fs.readFileSync(new URL('../public/content/items.json',import.meta.url),'utf8')));
const imageSize=(file:string)=>{
  const png=fs.readFileSync(new URL(`../public/${file}`,import.meta.url));
  assert.equal(png.toString('ascii',12,16),'IHDR',file);
  return {width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
};

test('ground sprite metadata matches shipped artwork, including currency outside the item catalogue',()=>{
  for(const item of Object.values(items.items)){
    assert.notEqual(item.icon,item.groundSprite.file);
    assert.deepEqual(imageSize(item.groundSprite.file),{width:item.groundSprite.width,height:item.groundSprite.height});
  }
  const potion=Object.values(items.items).find(item=>item.name==='恢复药水（小）')!;
  assert.deepEqual({...potion.groundSprite,file:undefined},{file:undefined,width:10,height:15,anchorX:4,anchorY:6});
  assert.deepEqual(imageSize('assets/ui/items/money-ground.png'),{width:16,height:12});
  for(const asset of pickupMessageAssets())assert.deepEqual(imageSize(asset.file),{width:31,height:29});
  const assets=groundLootAssets(items);
  assert.equal(new Set(assets.map(asset=>asset.key)).size,assets.length);
  assert.equal(new Set(assets.map(asset=>asset.file)).size,assets.length);
});

class Visual {
  x=0;y=0;width=0;visible=true;active=true;depth=0;name='';origin=[0,0];scale=1;
  children:Visual[]=[];
  readonly kind:string;readonly value:string;
  constructor(kind:string,value=''){this.kind=kind;this.value=value;}
  setPosition(x:number,y:number){this.x=x;this.y=y;return this;}
  setOrigin(x:number,y=x){this.origin=[x,y];return this;}
  setDisplayOrigin(x:number,y:number){return this.setOrigin(x,y);}
  setScale(value:number){this.scale=value;return this;}
  setDepth(value:number){this.depth=value;return this;}
  setName(value:string){this.name=value;return this;}
  setVisible(value:boolean){this.visible=value;return this;}
  add(value:Visual){this.children.push(value);return this;}
  destroy(){this.active=false;this.children.forEach(child=>child.destroy());}
}
interface Timer {paused:boolean;removed:boolean;delay:number;fire():void;remove():void}
interface Tween {paused:boolean;removed:boolean;delay:number;duration:number;finish():void;pause():void;resume():void;remove():void}

class FakeElement {
  className='';hidden=false;textContent='';src='';alt='';removed=false;
  readonly style:Record<string,string>={};
  children:FakeElement[]=[];
  parent?:FakeElement;
  readonly tagName:string;
  constructor(tagName:string){this.tagName=tagName;}
  append(...nodes:FakeElement[]):void{for(const node of nodes)this.appendChild(node);}
  appendChild(node:FakeElement):FakeElement{node.parent=this;this.children.push(node);return node;}
  getBoundingClientRect(){const text=this.textContent||this.children.map(child=>child.textContent).join('');return{width:Math.max(8,text.length*8),height:16,left:0,top:0};}
  remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
}

const documentStub={createElement:(tag:string)=>new FakeElement(tag)};
(globalThis as unknown as {document:unknown}).document=documentStub;

function sceneHarness(){
  const visuals:Visual[]=[],timers:Timer[]=[],tweens:Tween[]=[];
  const listeners=new Map<()=>void,()=>void>();
  const domLayer=new FakeElement('div');
  const domUi={
    layer:()=>domLayer,
    storyUnit:()=>1,
    frameSize:()=>({width:800,height:480}),
    worldToScreen:(_camera:unknown,x:number,y:number)=>({x,y}),
  } as unknown as DomUi;
  const create=(kind:string,x=0,y=0,value='')=>{const visual=new Visual(kind,value).setPosition(x,y);visuals.push(visual);return visual;};
  const scene={
    add:{
      layer:()=>create('layer'),container:(x:number,y:number)=>create('container',x,y),
      image:(x:number,y:number,key:string)=>create('image',x,y,key),
      text:(x:number,y:number,value:string)=>{const visual=create('text',x,y,value);visual.width=value.length*4;return visual;},
    },
    time:{delayedCall:(delay:number,callback:()=>void)=>{
      const timer:Timer={delay,paused:false,removed:false,fire(){if(!this.paused&&!this.removed){this.removed=true;callback();}},remove(){this.removed=true;}};
      timers.push(timer);return timer;
    }},
    tweens:{add:(config:{delay:number;duration:number;onComplete:()=>void})=>{
      const tween:Tween={delay:config.delay,duration:config.duration,paused:false,removed:false,
        finish(){if(!this.paused&&!this.removed)config.onComplete();},pause(){this.paused=true;},resume(){this.paused=false;},remove(){this.removed=true;}};
      tweens.push(tween);return tween;
    }},
    events:{on:(_event:string,callback:()=>void,context:unknown)=>listeners.set(callback,()=>callback.call(context)),
      off:(_event:string,callback:()=>void)=>listeners.delete(callback)},
    scale:{width:800,height:480},
    cameras:{main:{zoom:1,worldView:{x:0,y:0,width:320,height:213}}},
  };
  return {scene:scene as unknown as Phaser.Scene,domUi,domLayer,visuals,timers,tweens,
    update:()=>listeners.forEach(listener=>listener()),
    messages:()=>domLayer.children.filter(child=>child.className==='dom-pickup'&&!child.removed)};
}

test('ground rewards draw preloaded native sprites in a layer below all characters',()=>{
  const h=sceneHarness(),view=new GroundLootView(h.scene,items,()=>{throw new Error('unexpected flight');});
  const item=Object.keys(items.items)[0],sprite=items.items[item].groundSprite;
  const drops=[{id:'item',map:'cave',x:100,y:90,reward:{kind:'item' as const,item,quantity:1 as const}},
    {id:'money',map:'cave',x:100,y:90,reward:{kind:'money' as const,amount:4}}];
  view.sync(drops);view.sync(drops);
  const images=h.visuals.filter(visual=>visual.kind==='image');
  assert.equal(images.length,2);
  assert.deepEqual(images.map(image=>[image.x,image.y]),[[100,90],[100,90]]);
  assert.deepEqual(images[0].origin,[sprite.anchorX,sprite.anchorY]);
  assert.deepEqual(images[1].origin,[7,4]);
  assert.ok(h.visuals[0].depth<.5);
  view.sync([drops[1]]);assert.equal(images[0].active,false);assert.equal(images[1].active,true);
  view.destroy();assert.equal(images[1].active,false);
});

const reward={kind:'item' as const,item:'ectoplasm',quantity:1 as const};
const hero:PickupAnchor={x:100,y:100,headAnchor:{x:-5,y:-20}};
const at=(element:FakeElement,x:number,y:number)=>element.style.transform===`translate3d(${x}px, ${y}px, 0)`;

test('pickup messages remain separate, follow their own recipient, and reuse expired rows',()=>{
  const h=sceneHarness(),anchors:Record<string,PickupAnchor>={hero:{...hero},ally:{...hero,x:200}};
  const view=new PickupMessages(h.scene,items,{anchor:id=>anchors[id],domUi:h.domUi});
  view.enqueue([reward,reward],'hero');
  assert.equal(h.messages().length,1);
  assert.equal(h.messages()[0].children[0].textContent,items.items.ectoplasm.name);
  assert.ok(at(h.messages()[0],115,43));
  assert.equal(h.timers[0].delay,120);h.timers[0].fire();
  assert.ok(at(h.messages()[1],115,55));
  anchors.hero.x=110;h.update();assert.ok(h.messages().every(message=>message.style.transform?.includes('125px')));
  assert.equal(h.tweens[0].delay+h.tweens[0].duration,2400);
  h.tweens[0].finish();h.timers[1].fire();
  view.enqueue([reward],'ally');
  assert.ok(at(h.messages()[0],125,55));
  assert.ok(at(h.messages()[1],215,43));
  delete anchors.hero;h.update();assert.equal(h.messages().length,1);
  view.destroy();assert.equal(h.messages().length,0);
});

test('pickup messages hide and stop timers while paused; destruction cancels queued rewards',()=>{
  const h=sceneHarness(),view=new PickupMessages(h.scene,items,{anchor:()=>hero,domUi:h.domUi});
  view.enqueue([reward,reward,reward],'hero');view.setPaused(true);
  assert.equal(h.messages()[0].style.display,'none');
  h.timers[0].fire();h.tweens[0].finish();assert.equal(h.messages().length,1);
  view.setPaused(false);assert.equal(h.messages()[0].style.display,'flex');
  h.timers[0].fire();assert.equal(h.messages().length,2);
  view.destroy();h.timers.forEach(timer=>timer.fire());
  assert.equal(h.messages().length,0);assert.ok(h.tweens.every(tween=>tween.removed));
});

test('money pickup uses small gold silver copper icons and omits zero units',()=>{
  const h=sceneHarness(),view=new PickupMessages(h.scene,items,{anchor:()=>hero,domUi:h.domUi});
  view.enqueue([{kind:'money',amount:10203},{kind:'money',amount:4}],'hero');
  assert.deepEqual(h.messages()[0].children.map(child=>child.textContent||child.src),
    ['1','./assets/ui/items/pickup-money-gold.png','2','./assets/ui/items/pickup-money-silver.png','3','./assets/ui/items/pickup-money-copper.png']);
  h.timers[0].fire();
  assert.deepEqual(h.messages()[1].children.map(child=>child.textContent||child.src),['4','./assets/ui/items/pickup-money-copper.png']);
  view.destroy();
});
