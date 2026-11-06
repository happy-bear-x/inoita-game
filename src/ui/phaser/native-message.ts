import { screenCoverage } from './modal-placement.ts';
import type { MenuTextWriter } from '../dom/menu-text.ts';
import type { UiSurface } from './widgets.ts';

/**
 * UIPopupMsg 的普通提示：居中的黑色横带、上下原版花纹与小号中文按钮。
 * 横带横向铺满整屏，纵向仍是文字高度加留白。
 *
 * 给出 `writer` 时正文改由 DOM 输出；Phaser 文字只用来量横带高度，量完就销毁。
 * `writer` 接收弹层本地坐标，宿主按自己的页面坐标换算。按钮文字仍烘焙在
 * `message-yes`/`message-no`/`message-ok` 素材里，没有无字版本，因此不叠 DOM 文字。
 */
export function drawNativeMessage(v:UiSurface,assets:Record<string,string>,message:string,accept:()=>void,cancel?:()=>void,
  writer?:MenuTextWriter):void {
  // 弹层常按 1024×640 的外框居中，但 surface 自身可能是 450×350；横带按外框算屏幕范围。
  const width=1024,height=640,screen=screenCoverage(v,width,height),center=width/2;
  v.rect(screen.left,screen.top,screen.width,screen.height,0xaa966e,.13);
  const text=v.text(message,center,0,410,24,'#ffffff').setOrigin(.5,0);
  text.setAlign('center');
  const bandHeight=text.height+150,top=(height-bandHeight)/2;
  v.rect(screen.left,top,screen.width,bandHeight,0x000000,1);
  // 花纹素材是 240 宽；超出屏幕的部分由画布裁掉。
  for(let x=screen.left;x<screen.left+screen.width;x+=240){
    v.image(assets['message-edge'],x,top-29,240,38);
    v.image(assets['message-edge'],x,top+bandHeight+28,240,38).setOrigin(0,1).setFlipY(true);
  }
  if(writer){
    writer.add({key:'native-message',text:message,x:center,y:top+30,
      style:{size:24,color:'#ffffff',anchorX:.5,anchorY:0,width:410,align:'center',wrap:'word',lineHeight:29}});
    text.destroy();
  }else{
    v.root.bringToTop(text);text.setPosition(center,top+30);
  }
  const buttonY=top+bandHeight-82;
  const button=(key:string,label:string,x:number,action:()=>void)=>v.button('',x,buttonY,94,50,action,
    {image:assets[key],pressed:assets[`${key}-pressed`],native:true}).setData('label',label);
  if(cancel){button('message-yes','是',center-194,accept);button('message-no','否',center+100,cancel);}
  else button('message-ok','确认',center-47,accept);
}
