import type Phaser from 'phaser';
import { UiNode,type UiPointer } from './node.ts';
import { UI_EVENTS } from '../../application/ui-events.ts';
const clamp=(value:number)=>Math.min(1,Math.max(0,Number.isFinite(value)?value:0));
export class VolumeSlider {
  readonly root:UiNode;readonly label:string;private current:number;
  private readonly fill:UiNode;private readonly knob:UiNode;private readonly width:number;
  private readonly changed:(value:number)=>void;private readonly scene:Phaser.Scene;
  private press?:number;
  constructor(scene:Phaser.Scene,parent:UiNode,label:string,x:number,y:number,width:number,value:number,onChange:(value:number)=>void){
    this.scene=scene;this.label=label;this.width=width;this.current=clamp(value);this.changed=onChange;
    this.root=new UiNode(scene,parent).setPosition(x,y).setData('volumeSlider',label);
    new UiNode(scene,this.root).setSize(width,8).setOrigin(0,.5).setFillStyle(0x4a3b28);
    this.fill=new UiNode(scene,this.root).setSize(width*this.current,8).setOrigin(0,.5).setFillStyle(0xc9ad78);
    this.knob=new UiNode(scene,this.root).setSize(18,30).setOrigin(.5).setFillStyle(0xf3deb0);
    const zone=new UiNode(scene,this.root).setPosition(-16,-20).setSize(width+32,40).setInteractive().setData('volumeSlider',label);
    const apply=(pointer:UiPointer)=>{const m=this.root.getWorldTransformMatrix();this.setValue((pointer.x-m.tx)/(m.scaleX*width));};
    zone.on('pointerdown',(pointer:UiPointer)=>{this.press=pointer.id;apply(pointer);});zone.on('pointermove',(pointer:UiPointer)=>{if(this.press===pointer.id)apply(pointer);});zone.on('pointerup',this.cancel).on('pointerupoutside',this.cancel);
    scene.game.events.on(UI_EVENTS.cancelInput,this.cancel);this.apply();
  }
  private cancel=()=>{this.press=undefined;};
  get value():number{return this.current;}
  setValue(value:number):void{const next=clamp(value);if(next===this.current)return;this.current=next;this.apply();this.changed(next);}
  private apply():void{this.fill.setSize(this.width*this.current,8);this.knob.setPosition(this.width*this.current,0);}
  destroy():void{this.scene.game.events.off(UI_EVENTS.cancelInput,this.cancel);this.root.destroy();}
}
