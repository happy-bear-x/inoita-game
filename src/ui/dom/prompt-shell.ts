import { COMMON_BUTTON } from '../common-button.ts';
import { FONT, TEXT_COLORS } from '../text-style.ts';
import { domAssets, type DomImageSource } from './assets.ts';
import { paintCommonButtonFace } from './common-button-face.ts';

/** 原生表单共用游戏皮肤；销毁时中止本次图片持有。 */
export function skinPrompt(form:HTMLFormElement, title:HTMLElement, actions:HTMLElement):()=>void {
  const controller=new AbortController(), signal=controller.signal;
  form.style.fontFamily=FONT;
  form.style.color=TEXT_COLORS.primary;
  form.style.setProperty('--prompt-secondary',TEXT_COLORS.secondary);
  form.style.setProperty('--prompt-danger',TEXT_COLORS.danger);
  title.classList.add('text-prompt-title');
  const body=document.createElement('div');body.className='text-prompt-body';
  for(const child of [...form.children])if(child!==title&&child!==actions)body.append(child);
  form.append(body,actions);
  const frame=document.createElement('div');frame.className='text-prompt-frame';frame.setAttribute('aria-hidden','true');
  form.append(frame);
  const load=(file:string,draw:(source:DomImageSource)=>void)=>{
    const cached=domAssets.peek(file);if(cached)draw(cached);
    void domAssets.acquire(file,signal).then(lease=>{
      if(signal.aborted){lease.release();return;}
      if(!cached)draw(lease.source);
    }).catch(error=>{if(!signal.aborted)console.error(error);});
  };
  const parts=[['corner-nw',1,1,false,false],['corner-ne',3,1,false,false],
    ['corner-sw',1,3,false,false],['corner-se',3,3,false,false],
    ['edge-horizontal',2,1,false,false],['edge-horizontal',2,3,false,true],
    ['edge-vertical',1,2,false,false],['edge-vertical',3,2,true,false]] as const;
  for(const [name,column,row,flipX,flipY] of parts){
    const tile=document.createElement('span');
    Object.assign(tile.style,{gridColumn:String(column),gridRow:String(row),position:'relative',overflow:'hidden',transform:`scale(${flipX?-1:1},${flipY?-1:1})`});
    frame.append(tile);
    load(`assets/ui/menus/${name}.png`,source=>{
      const image=document.createElement('img'),crop=source.frame;
      image.alt='';image.draggable=false;image.src=source.url;
      Object.assign(image.style,{position:'absolute',maxWidth:'none',width:`${source.width/crop.width*100}%`,height:`${source.height/crop.height*100}%`,left:`${-crop.x/crop.width*100}%`,top:`${-crop.y/crop.height*100}%`});
      tile.append(image);
    });
  }
  const faces=new Map<string,HTMLElement[]>();
  for(const button of [...actions.children] as HTMLButtonElement[]){
    const label=document.createElement('span');label.className='text-prompt-button-label';
    label.textContent=button.textContent;button.textContent='';
    for(const [file,pressed] of [[COMMON_BUTTON.image,false],[COMMON_BUTTON.pressed,true]] as const){
      const face=document.createElement('span');
      face.className=`text-prompt-button-face${pressed?' text-prompt-button-pressed':''}`;
      face.setAttribute('aria-hidden','true');button.append(face);
      const list=faces.get(file)??[];list.push(face);faces.set(file,list);
    }
    button.append(label);
  }
  for(const [file,layers] of faces){
    load(file,source=>{
      const cap=`calc(var(--prompt-button-height,44px) * ${COMMON_BUTTON.cap/source.frame.height})`;
      for(const layer of layers)paintCommonButtonFace(layer,source.url,cap);
    });
  }
  return ()=>controller.abort();
}

/** 系统键盘上方的可见范围也是表单的最大范围。 */
export function placePrompt(form:HTMLFormElement|undefined):void {
  if(!form||typeof window==='undefined')return;
  const viewport=window.visualViewport;
  const width=viewport?.width??window.innerWidth, height=viewport?.height??window.innerHeight;
  form.classList.toggle('text-prompt-compact',height<280);
  form.classList.toggle('text-prompt-scroll',height<180);
  form.style.left=`${(viewport?.offsetLeft??0)+width/2}px`;
  form.style.top=`${(viewport?.offsetTop??0)+height/2}px`;
  form.style.width=`${Math.min(420,Math.max(0,width-24))}px`;
  form.style.maxHeight=`${Math.max(0,height-24)}px`;
}
