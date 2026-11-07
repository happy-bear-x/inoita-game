import type Phaser from 'phaser';
import type { ActorDefinition } from '../../domain/content.ts';
import type { UiSurface } from './surface.ts';
import { UiImage,uiMount } from './node.ts';
const sourceUrls=new WeakMap<object,string>();
/** 读取衣柜已合成的原始图片，浏览器绘制预览；世界纹理继续由衣柜管理。 */
export class CharacterPreview {
  private readonly scene:Phaser.Scene;
  private current?:{actor:ActorDefinition;images:UiImage[]};
  constructor(scene:Phaser.Scene){this.scene=scene;}
  show(surface:UiSurface,actor:ActorDefinition,rect:{x:number;y:number;width:number;height:number}):void{
    if(this.current?.actor!==actor){this.destroy();this.current={actor,images:[]};const clip=actor.clips['idle-south'];if(clip){
      const scale=Math.min(rect.width/clip.frameWidth,rect.height/clip.frameHeight),x=rect.x+(rect.width-clip.frameWidth*scale)/2+clip.originX*clip.frameWidth*scale,y=rect.y+(rect.height-clip.frameHeight*scale)/2+clip.originY*clip.frameHeight*scale;
      for(const layer of clip.layers){const texture=this.scene.textures.get(layer.key),frame=texture.get(0),source=texture.getSourceImage() as HTMLImageElement|HTMLCanvasElement;
        let url=sourceUrls.get(source);if(!url){url='toDataURL'in source?source.toDataURL():source.src;sourceUrls.set(source,url);}
        const image=new UiImage(this.scene,uiMount(this.scene)).applySource({url,width:source.width,height:source.height,frame:{x:frame.cutX,y:frame.cutY,width:clip.frameWidth,height:clip.frameHeight}}).setOrigin(clip.originX,clip.originY).setScale(scale).setPosition(x,y).setFlipX(clip.mirrorX).setBlendMode(layer.blend);this.current.images.push(image);
      }
    }}
    for(const image of this.current.images){image.setVisible(true);surface.root.add(image);}
  }
  detach():void{for(const image of this.current?.images??[]){image.parentContainer?.remove(image);image.setVisible(false);}}
  destroy():void{for(const image of this.current?.images??[])image.destroy();this.current=undefined;}
}
