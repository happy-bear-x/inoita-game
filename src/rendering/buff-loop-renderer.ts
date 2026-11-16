import type Phaser from 'phaser';
import type {BattleCatalog} from '../domain/battle.ts';
import type {BuffLoopFrame} from '../domain/combat-conditions.ts';
import type {CharacterVisual} from './characters.ts';
import {createEffect} from './effects.ts';
import {effectAssets} from './combat-asset-descriptors.ts';
import {missingSceneAssets} from './scene-assets.ts';

/** 一个持续特效视觉：容器、创建时的层数，以及动画总帧数。 */
interface BuffLoopVisual {node:Phaser.GameObjects.Container;layers:number;frames:number}

/** 每个角色的特效成员；视觉对象被替换时整份重建。 */
interface ActorBuffLoops {
  container:Phaser.GameObjects.Container;
  /** 当前成员的数字编号，按绘制顺序；成员与帧龄无关。 */
  order:number[];
  visuals:Map<number,BuffLoopVisual>;
}

/** 持续效果随Buff计龄，独立于角色当前攻击动作；Phaser负责素材层与动画帧。 */
export class BuffLoopRenderer {
  private scene:Phaser.Scene;
  private catalog:BattleCatalog;
  private actors=new Map<string,ActorBuffLoops>();
  /** 每个特效上次画的帧龄；逻辑帧没变时不必重设纹理与帧。 */
  private readonly frameAges=new WeakMap<Phaser.GameObjects.Container,number>();
  /** buff 与 effect 组合编号；比较成员时用数字，不拼临时键字符串。 */
  private readonly effectIds=new Map<BuffLoopFrame['buff'],Map<string,number>>();
  private nextEffectId=1;
  /**
   * 一次 sync 内用完就清空的临时容器，可跨角色复用。
   * 不能保存这两个容器里的结果，也不能在 sync 执行期间重入。
   */
  private readonly retained=new Set<number>();
  private readonly expected:Phaser.GameObjects.Container[]=[];
  constructor(scene:Phaser.Scene,catalog:BattleCatalog){this.scene=scene;this.catalog=catalog;}
  sync(id:string,visual:CharacterVisual|undefined,frames:readonly BuffLoopFrame[]):void {
    if(!visual?.container.active){this.remove(id);return;}
    // 没有持续特效时不为每个角色建状态；已有特效仍要清掉。
    if(!frames.length){this.remove(id);return;}
    const container=visual.container;
    let state=this.actors.get(id);
    // 视觉对象被替换后旧特效挂在旧容器上，整份重建到新容器。
    if(!state||state.container!==container){
      if(state)this.destroyState(state);
      state={container,order:[],visuals:new Map()};
      this.actors.set(id,state);
      this.rebuild(state,visual,frames);
    }else if(!this.membershipCurrent(state,frames)){
      // 只有成员、特效存活、层数或素材就绪情况变化时才重建；帧龄变化走下面的帧更新。
      this.rebuild(state,visual,frames);
    }
    const expected=this.expected;expected.length=0;
    for(let index=0;index<frames.length;index++){
      const loop=state.visuals.get(state.order[index]);
      // 素材还没到齐时先不留空容器；下次 sync 会继续重试。
      if(!loop)continue;
      expected.push(loop.node);
      // setCurrentFrame 会重置纹理/尺寸/原点；帧龄没变时跳过。
      if(this.frameAges.get(loop.node)!==frames[index].frameAge){
        this.frameAges.set(loop.node,frames[index].frameAge);
        for(const layer of loop.node.list as Phaser.GameObjects.Sprite[]){
          layer.anims.pause();
          const animation=layer.anims.currentAnim;
          if(animation)layer.anims.setCurrentFrame(animation.frames[frames[index].frameAge%loop.frames]);
        }
      }
    }
    // 只有层序真的不对时才重排；bringToTop 是 O(n) 数组改动。
    const list=container.list;
    let ordered=false;
    if(list){
      const start=list.length-expected.length;ordered=start>=0;
      if(ordered)for(let index=0;index<expected.length;index++)if(list[start+index]!==expected[index]){ordered=false;break;}
    }
    if(!ordered)for(const effect of expected)container.bringToTop(effect);
    expected.length=0;
  }
  remove(id:string):void {
    const state=this.actors.get(id);
    if(!state)return;
    this.destroyState(state);
    this.actors.delete(id);
  }
  retainActors(ids:ReadonlySet<string>):void {for(const id of this.actors.keys())if(!ids.has(id))this.remove(id);}
  clear():void {for(const id of this.actors.keys())this.remove(id);}
  /** 成员顺序不变、特效都还在且层数一致时，无需重建。 */
  private membershipCurrent(state:ActorBuffLoops,frames:readonly BuffLoopFrame[]):boolean {
    const order=state.order;
    if(order.length!==frames.length)return false;
    for(let index=0;index<frames.length;index++){
      const frame=frames[index];
      if(order[index]!==this.effectId(frame.buff,frame.effect))return false;
      const loop=state.visuals.get(order[index]);
      if(!loop||!loop.node.active||loop.node.length!==loop.layers)return false;
    }
    return true;
  }
  private rebuild(state:ActorBuffLoops,visual:CharacterVisual,frames:readonly BuffLoopFrame[]):void {
    const retained=this.retained;retained.clear();
    const order=state.order;order.length=0;
    for(const frame of frames){
      const effect=this.effectId(frame.buff,frame.effect);
      retained.add(effect);order.push(effect);
    }
    for(let index=0;index<frames.length;index++){
      const frame=frames[index],effect=order[index];
      const clip=this.catalog.attackEffects[frame.effect]?.clips.default;
      if(!clip)throw new Error(`持续增益特效资源缺失：${frame.effect}`);
      const current=state.visuals.get(effect);
      if(current?.node.active&&current.node.length===clip.layers.length){
        current.layers=clip.layers.length;current.frames=clip.frames;
        continue;
      }
      if(this.scene.textures&&missingSceneAssets(this.scene,effectAssets({loop:{clips:{default:clip}}})).length){
        current?.node.destroy();state.visuals.delete(effect);continue;
      }
      current?.node.destroy();
      const node=createEffect(this.scene,clip,0,0,true).setName(`buff-loop:${frame.effect}`);
      visual.container.add(node);
      state.visuals.set(effect,{node,layers:clip.layers.length,frames:clip.frames});
    }
    for(const [effect,loop]of state.visuals)if(!retained.has(effect)){loop.node.destroy();state.visuals.delete(effect);}
    retained.clear();
  }
  private effectId(buff:BuffLoopFrame['buff'],effect:string):number {
    let ids=this.effectIds.get(buff);
    if(!ids){ids=new Map();this.effectIds.set(buff,ids);}
    let id=ids.get(effect);
    if(id===undefined){id=this.nextEffectId++;ids.set(effect,id);}
    return id;
  }
  private destroyState(state:ActorBuffLoops):void {
    for(const loop of state.visuals.values())loop.node.destroy();
    state.visuals.clear();state.order.length=0;
  }
}
