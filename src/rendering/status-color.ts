import Phaser from 'phaser';
import type { CharacterVisual } from './characters.ts';
import { statusColorMatrix, type StatusColor } from '../domain/status-color.ts';

/** 每个角色独立着色；动画换贴图后为新图层重新挂上同一颜色规则。 */
export class StatusColorRenderer {
  private filters=new WeakMap<Phaser.GameObjects.Sprite,Phaser.Filters.ColorMatrix>();
  private appearances=new WeakMap<CharacterVisual,{colors:readonly StatusColor[]|undefined;frame:number;layers:readonly Phaser.GameObjects.Sprite[]}>();
  private flashes=new WeakSet<CharacterVisual>();
  private flashTints=new WeakMap<Phaser.GameObjects.Sprite,{tinted:boolean;mode:Phaser.TintModes;color:number}>();
  flash(character:CharacterVisual,scene:Phaser.Scene):void {
    if(this.flashes.has(character))return;
    this.flashes.add(character);
    // 受击闪白走顶点着色，不开滤镜：滤镜要为角色新建或调整离屏目标，
    // 驱动会等 GPU 同步，真机上单次能卡 50ms 以上。
    for(const sprite of character.layers){
      if(!sprite.active)continue;
      this.flashTints.set(sprite,{tinted:sprite.isTinted,mode:sprite.tintMode,color:sprite.tintTopLeft});
      sprite.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    }
    scene.game.events.once(Phaser.Core.Events.POST_RENDER,()=>{
      this.flashes.delete(character);
      for(const sprite of character.layers){
        const saved=this.flashTints.get(sprite);
        if(!saved)continue;
        this.flashTints.delete(sprite);
        if(!sprite.active)continue;
        if(saved.tinted){sprite.setTint(saved.color).setTintMode(saved.mode);}else{sprite.clearTint();sprite.setTintMode(saved.mode);}
      }
    });
  }
  paint(character:CharacterVisual,colors:readonly StatusColor[]|undefined,logicalFrame:number):void {
    // 只有一种颜色时矩阵不随逻辑帧变化；把帧号固定，避免每个逻辑帧重设同一张矩阵。
    const frame=colors&&colors.length>1?logicalFrame:0;
    const previous=this.appearances.get(character);
    // 着色规则、有效帧和图层批次都没变时不必重设 color matrix；换动作会换新图层数组。
    if(previous&&previous.colors===colors&&previous.frame===frame&&previous.layers===character.layers)return;
    this.appearances.set(character,{colors,frame,layers:character.layers});
    for(const sprite of character.layers){
      let filter=this.filters.get(sprite);
      if(!colors?.length){filter?.setActive(false);continue;}
      if(!filter){
        sprite.enableFilters();
        filter=sprite.filters?.internal.addColorMatrix();
        if(!filter)continue;
        this.filters.set(sprite,filter);
      }
      const blackBackdrop=sprite.blendMode===Phaser.BlendModes.ADD||sprite.blendMode===Phaser.BlendModes.SCREEN;
      filter.colorMatrix.set(statusColorMatrix(colors,frame,false,blackBackdrop));
      filter.setActive(true);
    }
  }
}
