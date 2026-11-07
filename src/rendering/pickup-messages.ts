import type Phaser from 'phaser';
import type { DropReward } from '../domain/drops.ts';
import type { ItemCatalog } from '../domain/items.ts';
import { splitMoney } from '../domain/money.ts';
import { itemNameColor } from '../ui/item-name-color.ts';
import type { DomUi } from '../ui/dom/dom-ui.ts';
import type { PendingAsset } from './scene-assets.ts';

const MESSAGE_LIMIT=32;
const MESSAGE_SPACING_MS=120;
/** 多条拾取提示的纵向行距：字号 20，留 4 像素空隙，避免同一时刻的两条文字压在一起。 */
const MESSAGE_ROW_STEP=24;
/** 上浮距离必须小于行距，否则旧消息上浮后仍会压住刚复用的下一行。 */
const MESSAGE_LIFT=4;
const units=['gold','silver','copper'] as const;
const textureKey=(unit:typeof units[number]):string=>`pickup-money-${unit}`;

export function pickupMessageAssets():PendingAsset[] {
  return units.map(unit=>({kind:'image',key:textureKey(unit),file:`assets/ui/items/pickup-money-${unit}.png`}));
}

export interface PickupAnchor {x:number;y:number;headAnchor:{x:number;y:number}}
interface PendingMessage {reward:DropReward;recipientId:string}
interface ActiveMessage {
  dom:HTMLDivElement;
  width:number;
  recipientId:string;
  row:number;
  lift:number;
  tween?:Phaser.Tweens.Tween;
}

/** Each pickup follows its recipient and keeps its own native lifetime. */
export class PickupMessages {
  private readonly scene:Phaser.Scene;
  private readonly items:ItemCatalog;
  private readonly anchor:(recipientId:string)=>PickupAnchor|undefined;
  private readonly domUi?:DomUi;
  private readonly visible:()=>boolean;
  private readonly active=new Set<ActiveMessage>();
  private readonly pending:PendingMessage[]=[];
  private next?:Phaser.Time.TimerEvent;
  private paused=false;
  private destroyed=false;

  constructor(scene:Phaser.Scene,items:ItemCatalog,options:{anchor:(recipientId:string)=>PickupAnchor|undefined;domUi?:DomUi;visible?:()=>boolean}) {
    this.scene=scene;this.items=items;this.anchor=options.anchor;this.domUi=options.domUi;this.visible=options.visible??(()=>true);
    scene.events.on('postupdate',this.update,this);
  }
  enqueue(rewards:readonly DropReward[],recipientId:string):void {
    if(this.destroyed)return;
    for(const reward of rewards){
      if(this.pending.length+this.active.size>=MESSAGE_LIMIT)break;
      this.pending.push({reward,recipientId});
    }
    this.startNext();
  }
  setPaused(paused:boolean):void {
    if(this.destroyed||this.paused===paused)return;
    this.paused=paused;
    if(this.next)this.next.paused=paused;
    for(const entry of this.active){
      entry.dom.style.display=paused?'none':'flex';
      if(paused)entry.tween?.pause();else entry.tween?.resume();
    }
    if(!paused)this.startNext();
  }
  private startNext():void {
    if(this.destroyed||this.paused||this.next)return;
    let message:PendingMessage|undefined;
    while((message=this.pending.shift())){
      if(!this.anchor(message.recipientId))continue;
      this.show(message);
      this.next=this.scene.time.delayedCall(MESSAGE_SPACING_MS,()=>{this.next=undefined;this.startNext();});
      break;
    }
  }
  private show({reward,recipientId}:PendingMessage):void {
    const occupied=new Set([...this.active].map(entry=>entry.row));
    let row=0;while(occupied.has(row))row++;
    if(!this.domUi)return;
    {
      const layer=this.domUi.layer('world');if(!layer)return;
      const unit=this.domUi.storyUnit();
      const dom=document.createElement('div');dom.className='dom-pickup';
      Object.assign(dom.style,{position:'absolute',left:'0',top:'0',display:'flex',alignItems:'center',
        gap:`${4*unit}px`,fontSize:`${20*unit}px`,lineHeight:'1',whiteSpace:'nowrap',pointerEvents:'none',
        color:'#ffffff',textShadow:'0 1px 2px rgba(0,0,0,.7)'});
      if(reward.kind==='money'){
        const amount=splitMoney(reward.amount);
        for(const key of units){
          if(!amount[key])continue;
          const text=document.createElement('span');text.textContent=String(amount[key]);
          const icon=document.createElement('img');icon.src=`./assets/ui/items/pickup-money-${key}.png`;icon.alt='';
          icon.style.cssText=`width:${Math.max(8,16*unit)}px;height:auto;image-rendering:pixelated`;
          dom.append(text,icon);
        }
      }else{
        const text=document.createElement('span');text.textContent=this.items.items[reward.item].name;
        const color=itemNameColor(reward.roll?.rarity);if(color)text.style.color=color;dom.appendChild(text);
      }
      layer.appendChild(dom);
      const entry:ActiveMessage={dom,width:dom.getBoundingClientRect().width,recipientId,row,lift:0};
      this.active.add(entry);this.position(entry);
      entry.tween=this.scene.tweens.add({targets:entry,lift:MESSAGE_LIFT,delay:1440,duration:960,ease:'Linear',
        onComplete:()=>this.remove(entry)});
    }
  }
  private position(entry:ActiveMessage):void {
    const anchor=this.anchor(entry.recipientId);
    if(!anchor){this.remove(entry);return;}
    if(!this.domUi)return;
    const camera=this.scene.cameras.main,point=this.domUi.worldToScreen(camera,anchor.x,anchor.y+anchor.headAnchor.y);
    const zoom=camera.zoom,unit=this.domUi.storyUnit(),width=entry.width||entry.dom.getBoundingClientRect().width;
    if(!entry.width)entry.width=width;
    const right=point.x+anchor.headAnchor.x*zoom+20*zoom;
    const x=right+width>this.domUi.frameSize().width-8?point.x-anchor.headAnchor.x*zoom-20*zoom-width:right;
    const y=point.y+(entry.row*MESSAGE_ROW_STEP-37-entry.lift)*unit;
    entry.dom.style.transform=`translate3d(${x}px, ${y}px, 0)`;
    entry.dom.style.display=this.visible()?'flex':'none';
  }
  private update():void {for(const entry of this.active)this.position(entry);}
  private remove(entry:ActiveMessage):void {
    if(!this.active.delete(entry))return;
    entry.tween?.remove();entry.dom.remove();
  }
  destroy():void {
    if(this.destroyed)return;
    this.destroyed=true;this.next?.remove(false);this.next=undefined;this.pending.length=0;
    this.scene.events.off('postupdate',this.update,this);
    for(const entry of this.active)this.remove(entry);
  }
}
