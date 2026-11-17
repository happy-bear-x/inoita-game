import type { UiPointer } from './dom/node.ts';

interface DragGhost {
  setPosition(x:number,y:number):unknown;
  destroy():void;
}

interface DragScroll {
  contains(pointer:UiPointer):boolean;
  cancelGesture():void;
}

interface DragGesture {
  entry:string;
  scroll:DragScroll;
  activate():DragGhost|undefined;
  drop(entry:string,pointer:UiPointer):void;
}

interface DragHost {
  delay(ms:number,callback:()=>void):{remove():unknown};
  movementThreshold():number;
  suspended():boolean;
}

interface PendingDrag {
  gesture:DragGesture;
  pointer:number;
  x:number;
  y:number;
  timer?:{remove():unknown};
  active:boolean;
  ghost?:DragGhost;
}

/** 背包和合成共用的长按手势；落点与物品规则由当前页面处理。 */
export class MenuItemDrag {
  private readonly host:DragHost;
  private pending?:PendingDrag;
  private clickSuppressed=false;

  constructor(host:DragHost){this.host=host;}

  get suppressClick():boolean{return this.clickSuppressed;}

  start(pointer:UiPointer,gesture:DragGesture):void {
    if(!gesture.scroll.contains(pointer))return;
    this.cancel();
    this.clickSuppressed=false;
    const pending:PendingDrag={gesture,pointer:pointer.id,x:pointer.x,y:pointer.y,active:false};
    this.pending=pending;
    pending.timer=this.host.delay(350,()=>{
      if(this.pending!==pending)return;
      if(this.host.suspended()){this.cancel();return;}
      pending.active=true;
      this.clickSuppressed=true;
      gesture.scroll.cancelGesture();
      if(this.pending!==pending)return;
      const ghost=gesture.activate();
      if(this.pending!==pending)ghost?.destroy();
      else pending.ghost=ghost;
    });
  }

  move(pointer:UiPointer):void {
    const pending=this.pending;
    if(!pending||pending.pointer!==pointer.id)return;
    if(!pending.active&&Math.hypot(pointer.x-pending.x,pointer.y-pending.y)>this.host.movementThreshold())this.cancel();
    else if(pending.active)pending.ghost?.setPosition(pointer.x,pointer.y);
  }

  end(pointer:UiPointer):void {
    const pending=this.pending;
    if(!pending||pending.pointer!==pointer.id)return;
    this.cancel();
    if(pending.active)pending.gesture.drop(pending.gesture.entry,pointer);
  }

  cancel():void {
    const pending=this.pending;
    this.pending=undefined;
    pending?.timer?.remove();
    pending?.ghost?.destroy();
  }
}
