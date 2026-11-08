import type Phaser from 'phaser';
import type { ActorDefinition } from '../../domain/content.ts';
import type { UiSurface } from './surface.ts';
import { UiImage,uiMount } from './node.ts';
const sourceUrls=new WeakMap<object,string>();
/** 读取衣柜已合成的原始图片，浏览器绘制预览；世界纹理继续由衣柜管理。 */
export class CharacterPreview {
  private readonly scene:Phaser.Scene;
  private current?:{actor:ActorDefinition;snapshot?:string;images:UiImage[]};
  constructor(scene:Phaser.Scene){this.scene=scene;}
  static available(scene:Phaser.Scene,actor:ActorDefinition,snapshot?:string):boolean{
    const clip=actor.clips['idle-south'];
    return !!clip&&(!!snapshot||clip.layers.length>0&&clip.layers.every(layer=>{
      if(!scene.textures.exists(layer.key))return false;
      const texture=scene.textures.get(layer.key);
      return !('type' in texture)||texture.type!=='DynamicTexture';
    }));
  }
  show(surface:UiSurface,actor:ActorDefinition,rect:{x:number;y:number;width:number;height:number},parent=surface.root,snapshot?:string):void{
    if(this.current?.actor!==actor||this.current.snapshot!==snapshot||this.current.images.some(image=>!image.active)){this.destroy();this.current={actor,snapshot,images:[]};const clip=actor.clips['idle-south'];if(clip){
      if(snapshot){
        this.current.images.push(new UiImage(this.scene,uiMount(this.scene)).applySource({url:snapshot,width:clip.frameWidth,height:clip.frameHeight,frame:{x:0,y:0,width:clip.frameWidth,height:clip.frameHeight}}).setOrigin(clip.originX,clip.originY).setFlipX(clip.mirrorX));
      }else{
      for(const layer of clip.layers){const texture=this.scene.textures.get(layer.key),frame=texture.get(0),source=texture.getSourceImage() as HTMLImageElement|HTMLCanvasElement;
        let url=sourceUrls.get(source);if(!url){url='toDataURL'in source?source.toDataURL():source.src;sourceUrls.set(source,url);}
        const image=new UiImage(this.scene,uiMount(this.scene)).applySource({url,width:source.width,height:source.height,frame:{x:frame.cutX,y:frame.cutY,width:clip.frameWidth,height:clip.frameHeight}}).setOrigin(clip.originX,clip.originY).setFlipX(clip.mirrorX).setBlendMode(layer.blend);this.current.images.push(image);
      }
      }
    }}
    const clip=actor.clips['idle-south'];if(!clip)return;
    const scale=Math.min(rect.width/Math.max(1,clip.frameWidth),rect.height/Math.max(1,clip.frameHeight));
    const x=rect.x+(rect.width-clip.frameWidth*scale)/2+clip.originX*clip.frameWidth*scale;
    const y=rect.y+(rect.height-clip.frameHeight*scale)/2+clip.originY*clip.frameHeight*scale;
    for(const image of this.current.images){image.setScale(scale).setPosition(x,y).setVisible(true);parent.add(image);}
  }
  detach():void{for(const image of this.current?.images??[]){image.parentContainer?.remove(image);image.setVisible(false);}}
  destroy():void{for(const image of this.current?.images??[])image.destroy();this.current=undefined;}
}
