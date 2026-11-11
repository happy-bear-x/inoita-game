import Phaser from 'phaser';
import type { BattleCatalog } from '../domain/battle.ts';
import type { EffectClip, EffectLayer } from '../domain/content.ts';
import { damageDigits, digitSequence, feedbackImpactEffects, feedbackPlan, type CombatHitFeedback, type CombatFeedbackSelection } from '../domain/combat-feedback.ts';
import type { CharacterVisual } from './characters.ts';
import { EffectPool, effectLayerBlendMode } from './effects.ts';
import { rememberEffectAnimation } from './effect-animations.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../generated/effect-atlas.ts';

/**
 * 数字序列动画按「贴图 + 帧序列 + 帧率」只建一次。
 * 之前每个数字精灵都往动画表写一条同名 `damage`，命中越密写得越多。
 * 数字文件进了图集时，序列里是源帧序号，必须换成图集页键和帧名；
 * 直接拿页纹理配数字帧会找不到帧，Phaser 会把整页图集当一张图显示。
 */
export function playDigitAnimation(sprite:Phaser.GameObjects.Sprite,layer:EffectLayer|undefined,sequence:number[],
  frameRate:number,delayMs:number):void {
  const file=layer?.file;
  let frames:{key:string;frame:string|number}[];
  if(file){
    const atlas=EFFECT_ATLAS_BY_FILE[file];
    if(!atlas)throw new Error(`伤害数字图集缺少文件映射：${file}`);
    frames=sequence.map(index=>{
      const ref=atlas[index],page=ref?EFFECT_ATLAS_PAGES[ref.page]:undefined;
      if(!ref||!page)throw new Error(`伤害数字图集缺少帧：${file} 第 ${index} 帧`);
      return {key:page.key,frame:ref.frame};
    });
  }else frames=sequence.map(frame=>({key:sprite.texture.key,frame}));
  const textureKeys=[...new Set(frames.map(frame=>frame.key))];
  const key=`damage:${file||sprite.texture.key}:${textureKeys.join('+')}:${frameRate}:${sequence.join('.')}`;
  const anims=sprite.scene.anims;
  const existing=anims.exists(key)?anims.get(key):undefined;
  // 贴图在上一次地图关闭时被释放后，帧会失效；重建而不是播旧动画。
  const stale=!!existing?.frames.some(frame=>{
    const textureFrame=(frame as unknown as {frame?:{texture?:unknown}}).frame;
    return !!textureFrame&&typeof textureFrame==='object'&&!textureFrame.texture;
  });
  if(existing&&(!existing.frames.length||stale))anims.remove(key);
  if(!anims.exists(key)){
    anims.create({key,frames,frameRate});
    rememberEffectAnimation(sprite.scene,key,textureKeys);
  }
  sprite.anims.stop();
  sprite.play({key,delay:delayMs,showOnStart:true});
}

/** 一个伤害数字占一个容器；容器里的每个精灵对应一位数字。 */
interface NumberSlot {
  readonly container:Phaser.GameObjects.Container;
  readonly sprites:Phaser.GameObjects.Sprite[];
  busy:boolean;
  order:number;
  finishSprite?:Phaser.GameObjects.Sprite;
  finishListener?:()=>void;
}

const NUMBER_SLOT_LIMIT=32;
const WARM_NUMBER_SLOTS=8;
const WARMED_SPRITES_PER_SLOT=4;
/** 目标离镜头超过这么远时，命中特效和数字已经完全看不见，不再生成。 */
const CULL_MARGIN=520;
/** 同一帧最多生成多少个暴击装饰（光环和爆闪）；主体冲击与伤害数字不受限。 */
const DECORATION_BUDGET_PER_FRAME=8;

/** 数字精灵第一次创建时的纹理；真正播放时动画帧会换成对应数字的图集页。 */
function digitSpriteTexture(layer:EffectLayer):{key:string;frame:string|number} {
  const ref=layer.file?EFFECT_ATLAS_BY_FILE[layer.file]?.[0]:undefined;
  const page=ref?EFFECT_ATLAS_PAGES[ref.page]:undefined;
  return page?{key:page.key,frame:ref!.frame}:{key:layer.key,frame:0};
}

/** 命中反馈由地图持有，攻击动作结束或中断不提前销毁已生成的数字。 */
/** 命中反馈由地图持有，攻击动作结束或中断不提前销毁已生成的数字。 */
export class CombatFeedback {
  private readonly scene:Phaser.Scene;
  private readonly catalog:BattleCatalog;
  private readonly vibrationEnabled:boolean;
  private readonly effects=new Set<Phaser.GameObjects.Container>();
  private readonly pool:EffectPool;
  private readonly numbers:NumberSlot[]=[];
  private readonly digitClips=new Map<string,(EffectClip|undefined)[]>();
  private shake?:Phaser.Tweens.Tween;
  private shakeBase?:{x:number;y:number};
  private paused=false;
  private visible=true;
  private warmed=false;
  private numberOrder=0;
  private decorationFrame=-1;
  private decorationBudget=DECORATION_BUDGET_PER_FRAME;
  constructor(scene:Phaser.Scene,catalog:BattleCatalog,vibrationEnabled=false){
    this.scene=scene;this.catalog=catalog;this.vibrationEnabled=vibrationEnabled;
    this.pool=new EffectPool(scene);
  }
  /** 进图装配战斗时预建命中特效容器和数字容器；首次命中不再现场建对象。 */
  warm():void {
    if(this.warmed)return;
    this.warmed=true;
    for(const name of feedbackImpactEffects(this.catalog.feedback)){
      const clip=this.catalog.attackEffects[name]?.clips.default;
      if(clip)this.pool.warm(clip,2);
    }
    const name=this.catalog.feedback.digits.enemy[0];
    const layer=name?this.digitClip(name,0)?.layers[0]:undefined;
    while(this.numbers.length<WARM_NUMBER_SLOTS){
      const slot=this.createNumber();
      if(layer)for(let index=0;index<WARMED_SPRITES_PER_SLOT;index++)this.numberSprite(slot,index,layer);
    }
  }
  private createNumber():NumberSlot {
    const container=this.scene.add.container(0,0).setDepth(Number.MAX_SAFE_INTEGER).setVisible(false);
    const slot:NumberSlot={container,sprites:[],busy:false,order:0};
    this.numbers.push(slot);
    return slot;
  }
  /** 优先拿空闲数字容器；都在播时复用最早开始的那个，不再新建。 */
  private acquireNumber():NumberSlot|undefined {
    let slot=this.numbers.find(value=>!value.busy);
    if(!slot){
      if(this.numbers.length<NUMBER_SLOT_LIMIT)slot=this.createNumber();
      else for(const value of this.numbers)if(!slot||value.order<slot.order)slot=value;
    }
    if(!slot)return undefined;
    this.stopNumber(slot);
    slot.busy=true;slot.order=++this.numberOrder;
    return slot;
  }
  private numberSprite(slot:NumberSlot,index:number,layer:EffectLayer):Phaser.GameObjects.Sprite {
    let sprite=slot.sprites[index];
    if(!sprite){
      const texture=digitSpriteTexture(layer);
      sprite=this.scene.add.sprite(0,0,texture.key,texture.frame);
      slot.container.add(sprite);
      slot.sprites[index]=sprite;
    }
    return sprite;
  }
  private stopNumber(slot:NumberSlot):void {
    if(slot.finishSprite&&slot.finishListener)slot.finishSprite.off('animationcomplete',slot.finishListener);
    slot.finishSprite=undefined;slot.finishListener=undefined;
    for(const sprite of slot.sprites)sprite.anims.stop();
  }
  /** 没有可播的精灵时直接归还，避免槽位等不到结束回调。 */
  private releaseSlot(slot:NumberSlot):void {
    this.stopNumber(slot);
    slot.container.setVisible(false);
    slot.busy=false;
  }
  private releaseNumber(slot:NumberSlot,anchor:Phaser.GameObjects.Sprite):void {
    // 复用槽位后，上一个数字迟到的结束回调不能把新数字一起收掉。
    if(!slot.busy||slot.finishSprite!==anchor)return;
    this.releaseSlot(slot);
  }
  private digitClip(name:string,digit:number):EffectClip|undefined {
    let clips=this.digitClips.get(name);
    if(!clips){
      const source=this.catalog.attackEffects[name]?.clips??{};
      clips=Array.from({length:11},(_,index)=>source[String(index)]);
      this.digitClips.set(name,clips);
    }
    return clips[digit];
  }
  /** 整个伤害数字放在同一个容器里，位数只增加精灵，不再增加容器。 */
  private showDigits(name:string,event:CombatHitFeedback,target:CharacterVisual):void {
    const slot=this.acquireNumber();
    if(!slot)return;
    slot.container.setPosition(target.container.x,target.container.y);
    let spriteIndex=0,finishSprite:Phaser.GameObjects.Sprite|undefined,finishDuration=-1;
    for(const digit of damageDigits(event.hit.damage,event.hit.kind==='miss')){
      const clip=this.digitClip(name,digit.digit);
      if(!clip)continue;
      const sequence=digitSequence(clip.frames,digit.holdFrames),duration=digit.delayMs+sequence.length/clip.frameRate*1000;
      for(const layer of clip.layers){
        const sprite=this.numberSprite(slot,spriteIndex++,layer);
        sprite.setPosition(digit.x,digit.y).setVisible(true)
          .setOrigin(clip.originX,clip.originY).setScale(clip.mirrorX?-1:1,1)
          .setBlendMode(effectLayerBlendMode(layer));
        playDigitAnimation(sprite,layer,sequence,clip.frameRate,digit.delayMs);
        if(this.paused)sprite.anims.pause();
        if(duration>finishDuration){finishDuration=duration;finishSprite=sprite;}
      }
    }
    // 上一次数字更长时留下的精灵要收起来，否则会跟着新数字一起显示。
    for(let index=spriteIndex;index<slot.sprites.length;index++)slot.sprites[index]!.setVisible(false);
    if(!finishSprite){this.releaseSlot(slot);return;}
    const anchor=finishSprite,listener=()=>this.releaseNumber(slot,anchor);
    slot.finishSprite=anchor;slot.finishListener=listener;
    anchor.once('animationcomplete',listener);
    slot.container.setVisible(this.visible);
  }
  /** 镜头外超过最大特效半径的目标看不到反馈，直接跳过。 */
  private offscreen(target:CharacterVisual):boolean {
    const view=this.scene.cameras?.main?.worldView;
    if(!view)return false;
    const x=target.container.x,y=target.container.y;
    return x<view.x-CULL_MARGIN||x>view.right+CULL_MARGIN||y<view.y-CULL_MARGIN||y>view.bottom+CULL_MARGIN;
  }
  /** 暴击光环和爆闪每帧有限额；范围暴击同时打中很多目标时不再无限叠加。 */
  private takeDecorationBudget():boolean {
    const frame=this.scene.game?.loop?.frame;
    if(frame===undefined)return true;
    if(frame!==this.decorationFrame){this.decorationFrame=frame;this.decorationBudget=DECORATION_BUDGET_PER_FRAME;}
    if(this.decorationBudget<=0)return false;
    this.decorationBudget--;
    return true;
  }
  private track(effect:Phaser.GameObjects.Container):void {
    this.effects.add(effect);effect.setVisible(this.visible);
    const drop=():void=>{
      this.effects.delete(effect);
      effect.off('effect-recycle',drop);effect.off('destroy',drop);
    };
    effect.once('effect-recycle',drop);effect.once('destroy',drop);
    if(this.paused)for(const sprite of effect.list as Phaser.GameObjects.Sprite[])sprite.anims.pause();
  }
  private impact(name:string,target:CharacterVisual,attached=true):void {
    const anchor=target.actor.effectAnchor??{x:0,y:0};
    const position=attached?anchor:target.container;
    const effect=this.pool.acquire(this.catalog.attackEffects[name].clips.default,position.x,position.y);
    if(attached)target.container.addAt(effect,target.layers.length);
    else effect.setDepth(Number.MAX_SAFE_INTEGER);
    this.track(effect);
  }
  show(event:CombatHitFeedback,target:CharacterVisual,selection:CombatFeedbackSelection,
    plan:ReturnType<typeof feedbackPlan>=feedbackPlan(event)):void {
    if(this.offscreen(target))return;
    for(const effect of selection.impacts){
      const decoration=!effect.attached||effect.name===this.catalog.feedback.criticalRing;
      if(decoration&&!this.takeDecorationBudget())continue;
      this.impact(effect.name,target,effect.attached);
    }
    if(selection.digitEffect)this.showDigits(selection.digitEffect,event,target);
    if(plan.shake&&this.visible)this.startShake();
  }
  startShake():void {
    if(!this.visible)return;
    this.cancelShake();
    const camera=this.scene.cameras.main,base={x:camera.followOffset.x,y:camera.followOffset.y};
    this.shakeBase=base;
    const phase={step:0},offsets=this.catalog.feedback.shakeOffsets;
    const apply=()=>{const offset=offsets[Math.min(offsets.length-1,Math.floor(phase.step))];camera.setFollowOffset(base.x-offset.x,base.y-offset.y);};
    apply();
    this.shake=this.scene.tweens.add({targets:phase,step:offsets.length,duration:offsets.length*60,ease:'Linear',paused:this.paused,
      onUpdate:apply,onComplete:()=>this.cancelShake()});
  }
  vibrate(durationMs:number):void {
    if(this.visible&&this.vibrationEnabled&&typeof navigator!=='undefined')navigator.vibrate?.(durationMs);
  }
  cancelShake():void {
    this.shake?.stop();this.shake=undefined;
    if(this.shakeBase)this.scene.cameras.main?.setFollowOffset(this.shakeBase.x,this.shakeBase.y);
    this.shakeBase=undefined;
  }
  setPaused(paused:boolean):void {
    if(this.paused===paused)return;this.paused=paused;
    if(paused)this.shake?.pause();else this.shake?.resume();
    for(const effect of this.effects)for(const sprite of effect.list as Phaser.GameObjects.Sprite[])
      if(paused)sprite.anims.pause();else sprite.anims.resume();
    for(const slot of this.numbers){
      if(!slot.busy)continue;
      for(const sprite of slot.sprites)if(paused)sprite.anims.pause();else sprite.anims.resume();
    }
  }
  setVisible(visible:boolean):void {
    this.visible=visible;if(!visible)this.cancelShake();
    for(const effect of this.effects)effect.setVisible(visible);
    for(const slot of this.numbers)slot.container.setVisible(visible&&slot.busy);
  }
  destroy():void {
    this.cancelShake();
    for(const effect of [...this.effects])effect.destroy();
    for(const slot of this.numbers)this.stopNumber(slot);
    for(const slot of this.numbers)slot.container.destroy();
    this.numbers.length=0;
    this.pool.destroy();
  }
}
