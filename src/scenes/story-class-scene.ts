import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryClassContext } from '../application/ports.ts';
import type { StoryClass } from '../domain/story-class.ts';
import { characterAssets, createCharacter } from '../rendering/characters.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import { loadSceneAssets } from '../rendering/scene-assets.ts';
import { UiSurface, loadUiImages } from '../ui/phaser/widgets.ts';
import type { ScrollArea } from '../ui/phaser/widgets.ts';
import type { DomLabel, DomUi } from '../ui/dom/dom-ui.ts';

/** 装配时传入的 StoryApp 比场景端口多一个 DOM 文字层；缺省时这一页不显示文字。 */
type StoryClassApp = StoryClassContext & { readonly domUi?: DomUi };

/** 职业选择页的 DOM 文字节点；图框、预览、按钮和滚动区仍由 Phaser 负责。 */
interface ClassDomText {
  title: DomLabel;
  descriptionClip: DomLabel;
  description: DomLabel;
  attributes: { name: DomLabel; value: DomLabel }[];
}

/** 960×640 页面坐标：说明滚动区和五行属性的位置。 */
const DESCRIPTION = { x: 80, y: 485, width: 622, height: 132 } as const;
const ATTRIBUTE = { nameX: 782, valueX: 894, top: 482, step: 28 } as const;
const GOLD = '#f3deb0';

export class StoryClassScene extends Phaser.Scene {
  private readonly app:StoryClassApp;
  private surface?:UiSurface;
  private preview?:CharacterVisual;
  private selected?:StoryClass;
  private request=new AbortController();
  /** DOM 是这一页唯一的文字路径：没有 DOM 文字层时宁可不显示文字，也不回退 Phaser 文字。 */
  private domText?:ClassDomText;
  private descriptionScroll?:ScrollArea;
  /** 职业选择整屏独占键盘；场景关闭时注销，避免回到标题页后继续处理按键。 */
  private unregisterInput?:()=>void;
  constructor(app:StoryClassApp){super(SCENE_KEYS.classSelect);this.app=app;}
  create():void{
    this.request=new AbortController();this.selected=undefined;this.cameras.main.setBackgroundColor('#000000');
    this.scale.on('resize',this.layout,this);
    this.unregisterInput?.();this.unregisterInput=this.app.inputRouter.register('menu',this.routeKey,{exclusive:()=>true});
    this.events.once('shutdown',()=>{this.unregisterInput?.();this.unregisterInput=undefined;this.request.abort();this.scale.off('resize',this.layout,this);this.surface?.destroy();this.surface=undefined;this.preview=undefined;this.clearDomText();this.descriptionScroll=undefined;});
    const signal=this.request.signal;
    void this.open(signal).catch(error=>{if(!signal.aborted)this.app.ui.error((error as Error).message,()=>this.scene.restart());});
  }
  private routeKey=(event:KeyboardEvent):boolean=>{
    if(this.app.suspended)return false;
    if(event.key==='Escape'){this.app.returnToMenu?.();return true;}
    return this.surface?.key(event)??false;
  };
  private async open(signal:AbortSignal):Promise<void>{
    const catalog=this.app.storyClasses;
    await Promise.all([
      loadUiImages(this,[catalog.background,...Object.values(catalog.assets),...catalog.classes.map(entry=>entry.icon),'/assets/ui/menus/close.png','/assets/ui/menus/close-pressed.png'],value=>{if(!signal.aborted)this.app.ui.loading('正在准备职业…',value);}).then(lease=>{if(signal.aborted){lease.release();signal.throwIfAborted();}this.events.once('shutdown',()=>lease.release());}),
      loadSceneAssets(this,catalog.classes.flatMap(entry=>characterAssets(entry.previewActor)),()=>{})
    ]);
    signal.throwIfAborted();
    this.surface=new UiSurface(this,960,640);this.choose(catalog.classes.find(entry=>entry.id===catalog.defaultClass)!);
    this.app.ui.loaded();this.app.syncLifecycle?.();this.app.prefetchStory?.();
  }
  private choose(entry:StoryClass):void{
    this.selected=entry;const view=this.surface!,catalog=this.app.storyClasses;view.clear();this.preview=undefined;this.descriptionScroll=undefined;
    view.image(catalog.background,80,0,800,640);view.image(catalog.assets.title,263,20,434,56);
    const guard=()=>this.app.ui.ready&&!this.app.suspended;view.enabled=guard;
    view.button('',12,16,67,67,()=>this.app.returnToMenu?.(),{image:'/assets/ui/menus/close.png',pressed:'/assets/ui/menus/close-pressed.png',guard}).setData('label','返回主菜单');
    const positions=[[37,118],[70,251],[198,313],[648,313],[776,251],[809,118]];
    catalog.classes.forEach((character,index)=>{
      const [x,y]=positions[index];const button=view.button('',x,y,116,114,()=>this.choose(character),{image:character.icon,guard}).setData('label',character.name);
      if(character.id===entry.id)view.image(catalog.assets.selected,0,0,116,114,button).setBlendMode(Phaser.BlendModes.ADD);
    });
    view.button('',334,388,292,77,()=>this.app.startStory?.(this.selected!.id),{image:catalog.assets.start,pressed:catalog.assets.startPressed,guard}).setData('label','开始游戏');
    view.rect(42,464,699,174,0x000000,.4);
    view.image(catalog.assets.descriptionTop,71,456);
    view.image(catalog.assets.panelLeft,32,455);view.image(catalog.assets.panelRight,712,455);
    const description=view.scroll(DESCRIPTION.x,DESCRIPTION.y,DESCRIPTION.width,DESCRIPTION.height);
    this.descriptionScroll=description;description.onScroll=()=>this.positionDescription();
    view.rect(767,464,151,174,0x000000,.4);
    view.image(catalog.assets.attributesTop,796,455);
    view.image(catalog.assets.panelLeft,757,454);view.image(catalog.assets.panelRight,888,454);
    this.preview=createCharacter(this,entry.previewActor,{id:'class-preview',actor:entry.previewActor.id,x:480,y:290});view.root.add(this.preview.container);this.preview.container.setScale(3);
    this.renderDomText(entry);this.layout();
  }
  private layout():void{
    this.surface?.layout(8);
    this.layoutDomText();
  }
  /** 页面坐标 → 画框内 CSS 坐标；画布按 CSS 尺寸渲染，容器矩阵已经是屏幕像素。 */
  private domMatrix():{scale:number;point:(x:number,y:number)=>{x:number;y:number}}{
    const matrix=this.surface?.root.getWorldTransformMatrix();
    if(!matrix)return{scale:1,point:(x,y)=>({x,y})};
    return{scale:matrix.scaleX,point:(x,y)=>{const point=matrix.transformPoint(x,y);return{x:point.x,y:point.y};}};
  }
  private ensureDomText():ClassDomText|undefined{
    const domUi=this.app.domUi;if(!domUi)return undefined;
    if(this.domText)return this.domText;
    const title=domUi.label('screen','dom-label dom-class-title',{x:.5,y:0}).setStyle({pointerEvents:'none'});
    const descriptionClip=domUi.label('screen','dom-label dom-class-description').setStyle({overflow:'hidden',pointerEvents:'none'});
    const description=domUi.label('screen','dom-label').setStyle({pointerEvents:'none'});
    descriptionClip.element.appendChild(description.element);
    this.domText={title,descriptionClip,description,attributes:[]};
    return this.domText;
  }
  private attributeLabels(index:number):{name:DomLabel;value:DomLabel}{
    const dom=this.domText!,domUi=this.app.domUi!;
    let pair=dom.attributes[index];
    if(!pair){
      pair={name:domUi.label('screen','dom-label dom-class-attribute-name'),value:domUi.label('screen','dom-label dom-class-attribute-value',{x:1,y:0})};
      dom.attributes[index]=pair;
    }
    return pair;
  }
  /** 职业名、说明和属性都只写 DOM；说明的换行宽度和行高按页面坐标乘当次缩放。 */
  private renderDomText(entry:StoryClass):void{
    const dom=this.ensureDomText();if(!dom)return;
    dom.title.setText(entry.name).setVisible(true);
    dom.description.setText(entry.description);
    dom.attributes.forEach(pair=>{pair.name.setVisible(false);pair.value.setVisible(false);});
    entry.attributes.forEach((attribute,index)=>{
      const pair=this.attributeLabels(index);
      pair.name.setText(attribute.name).setVisible(true);
      pair.value.setText(String(attribute.value)).setVisible(true);
    });
    this.layoutDomText();
  }
  private styleDomText(scale:number):void{
    const dom=this.domText;if(!dom)return;
    dom.title.setStyle({fontSize:`${28*scale}px`,lineHeight:`${28*scale}px`,color:GOLD});
    dom.description.setStyle({
      fontSize:`${23*scale}px`,lineHeight:`${28*scale}px`,color:'#ffffff',
      width:`${DESCRIPTION.width*scale}px`,whiteSpace:'pre-wrap',overflowWrap:'anywhere'
    });
    for(const pair of dom.attributes){
      pair.name.setStyle({fontSize:`${22*scale}px`,lineHeight:`${22*scale}px`,color:'#989898'});
      pair.value.setStyle({fontSize:`${22*scale}px`,lineHeight:`${22*scale}px`,color:'#ffffff'});
    }
  }
  private layoutDomText():void{
    const dom=this.domText,selected=this.selected;if(!dom||!selected)return;
    const {scale,point}=this.domMatrix();
    this.styleDomText(scale);
    const title=point(480,31);dom.title.setPosition(title.x,title.y);
    const origin=point(DESCRIPTION.x,DESCRIPTION.y);
    dom.descriptionClip.setStyle({width:`${DESCRIPTION.width*scale}px`,height:`${DESCRIPTION.height*scale}px`}).setPosition(origin.x,origin.y);
    const scroll=this.descriptionScroll;
    if(scroll){
      // 说明由浏览器按固定宽度换行；用实际排版高度决定滚动范围，避免文字被截在框外。
      const height=dom.description.element.getBoundingClientRect().height;
      scroll.setHeight(Math.max(1,height/Math.max(.0001,scale)));
    }
    this.positionDescription();
    selected.attributes.forEach((_attribute,index)=>{
      const pair=dom.attributes[index];if(!pair)return;
      const name=point(ATTRIBUTE.nameX,ATTRIBUTE.top+index*ATTRIBUTE.step);
      const value=point(ATTRIBUTE.valueX,ATTRIBUTE.top+index*ATTRIBUTE.step);
      pair.name.setPosition(name.x,name.y);
      pair.value.setPosition(value.x,value.y);
    });
  }
  private positionDescription():void{
    const dom=this.domText,scroll=this.descriptionScroll;if(!dom||!scroll)return;
    const {scale}=this.domMatrix();
    dom.description.setPosition(0,-scroll.scrollTop*scale);
  }
  private clearDomText():void{
    const dom=this.domText;if(!dom)return;
    dom.title.remove();dom.description.remove();dom.descriptionClip.remove();
    for(const pair of dom.attributes){pair.name.remove();pair.value.remove();}
    this.domText=undefined;
  }
}
