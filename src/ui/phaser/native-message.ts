import { screenCoverage } from './modal-placement.ts';
import type { MenuTextWriter } from '../dom/menu-text.ts';
import type { UiSurface } from './widgets.ts';

/** 共用按钮皮肤上的文字颜色，与 `UiSurface.button` 的默认字色一致。 */
const BUTTON_TEXT='#f3deb0';
const BUTTON_SIZE=20;

/**
 * UIPopupMsg 的普通提示：居中的黑色横带、上下原版花纹与两个小号中文按钮。
 * 横带横向铺满整屏，纵向仍是文字高度加留白。
 *
 * 正文与按钮文字都交给 `writer` 输出 DOM；Phaser 文字只用来量横带高度，量完就销毁。
 * 按钮不再是带字烘焙图，改成共用按钮皮肤加 DOM 文字。`writer` 接收弹层本地坐标，
 * 宿主按自己的页面坐标换算。
 */
export function drawNativeMessage(v:UiSurface,assets:Record<string,string>,message:string,accept:()=>void,cancel?:()=>void,
  writer?:MenuTextWriter):void {
  // 弹层常按 1024×640 的外框居中，但 surface 自身可能是 450×350；横带按外框算屏幕范围。
  const width=1024,height=640,screen=screenCoverage(v,width,height),center=width/2;
  v.rect(screen.left,screen.top,screen.width,screen.height,0xaa966e,.13);
  const text=v.text(message,center,0,410,24,'#ffffff').setOrigin(.5,0);
  text.setAlign('center');
  const bandHeight=text.height+150,top=(height-bandHeight)/2;
  text.destroy();
  v.rect(screen.left,top,screen.width,bandHeight,0x000000,1);
  // 花纹素材是 240 宽；超出屏幕的部分由画布裁掉。
  for(let x=screen.left;x<screen.left+screen.width;x+=240){
    v.image(assets['message-edge'],x,top-29,240,38);
    v.image(assets['message-edge'],x,top+bandHeight+28,240,38).setOrigin(0,1).setFlipY(true);
  }
  writer?.add({key:'native-message',text:message,x:center,y:top+30,
    style:{size:24,color:'#ffffff',anchorX:.5,anchorY:0,width:410,align:'center',wrap:'word',lineHeight:29}});
  const buttonY=top+bandHeight-82;
  const button=(key:string,label:string,x:number,action:()=>void)=>{
    v.button('',x,buttonY,94,50,action).setData('label',label);
    writer?.add({key:`native-message-${key}`,text:label,x:x+47,y:buttonY+25,
      style:{size:BUTTON_SIZE,color:BUTTON_TEXT,anchorX:.5,anchorY:.5,width:82,align:'center',wrap:'word'}});
  };
  if(cancel){button('yes','是',center-194,accept);button('no','否',center+100,cancel);}
  else button('ok','确认',center-47,accept);
}
