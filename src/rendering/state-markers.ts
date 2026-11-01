import type Phaser from 'phaser';
import type {BattleCatalog} from '../domain/battle.ts';
import type {BattleStateKey} from '../domain/battle-semantics.ts';
import type {EffectClip} from '../domain/content.ts';
import type {CharacterVisual} from './characters.ts';
import {STATE_MARKER_EFFECTS} from './combat-asset-descriptors.ts';
import {createEffect} from './effects.ts';

/**
 * 状态标记：只读地给规则状态加循环播放的原版状态特效，不参与战斗结算。
 *
 * `stun` 用金色星星，`sleep` 用 Zzz 表情；两者都挂在角色容器里，随角色移动。
 * 状态消失、角色隐藏或角色被销毁时由 `sync` 拆掉标记。
 */
interface StateMarker {
  setVisible(visible:boolean):void;
  destroy():void;
}

interface ActorMarkers {
  visual:CharacterVisual;
  markers:Map<BattleStateKey,StateMarker>;
}

type MarkedState=keyof typeof STATE_MARKER_EFFECTS;

const MARKED_STATES:ReadonlySet<BattleStateKey>=new Set<BattleStateKey>(['stun','sleep']);

class StateEffect implements StateMarker {
  private readonly character:CharacterVisual;
  private readonly effect:Phaser.GameObjects.Container;

  constructor(scene:Phaser.Scene,character:CharacterVisual,state:BattleStateKey,clip:EffectClip){
    this.character=character;
    this.effect=createEffect(scene,clip,0,0,true).setName(`state-marker:${state}`);
    character.container.add(this.effect);
  }

  setVisible(visible:boolean):void{
    const shown=visible&&this.character.container.active&&this.character.container.visible;
    this.effect.setVisible(shown);
    for(const layer of this.effect.list as Phaser.GameObjects.Sprite[]){
      if(shown)layer.anims.resume();else layer.anims.pause();
    }
  }

  destroy():void{
    if(this.effect.active)this.effect.destroy();
  }
}

/** 按战斗单位当前生效的状态维护表现；同一角色同一状态只建一个标记。 */
export class StateMarkers {
  private readonly scene:Phaser.Scene;
  private readonly catalog:BattleCatalog;
  private readonly actors=new Map<string,ActorMarkers>();

  constructor(scene:Phaser.Scene,catalog:BattleCatalog){
    this.scene=scene;this.catalog=catalog;
  }

  sync(id:string,visual:CharacterVisual|undefined,states:readonly BattleStateKey[],visible:boolean):void{
    // 角色隐藏或已被销毁时不再保留标记；之后重新显示会按仍在的状态重建。
    if(!visual?.container.active||!visual.container.visible){this.remove(id);return;}
    // 绝大多数单位没有要画的状态；先过滤，避免为每个角色每帧建 Map/Set。
    let marked=false;
    for(const state of states)if(MARKED_STATES.has(state)){marked=true;break;}
    if(!marked){this.remove(id);return;}
    let entry=this.actors.get(id);
    if(entry?.visual!==visual){this.remove(id);entry=undefined;}
    if(!entry)entry={visual,markers:new Map()};
    const retained=new Set<BattleStateKey>();
    for(const state of states){
      if(!MARKED_STATES.has(state))continue;
      retained.add(state);
      let marker=entry.markers.get(state);
      if(!marker){
        marker=this.create(state,visual);
        entry.markers.set(state,marker);
      }
      marker.setVisible(visible);
    }
    // 状态到期或受伤唤醒后，规则层已删掉节点；这里同步拆掉对应表现。
    for(const [state,marker]of entry.markers)if(!retained.has(state)){marker.destroy();entry.markers.delete(state);}
    if(entry.markers.size)this.actors.set(id,entry);else this.actors.delete(id);
  }

  private create(state:BattleStateKey,visual:CharacterVisual):StateMarker{
    const name=STATE_MARKER_EFFECTS[state as MarkedState];
    if(!name)throw new Error(`状态没有对应的标记表现：${state}`);
    const clip=this.catalog.attackEffects[name]?.clips.default;
    if(!clip)throw new Error(`状态标记特效资源缺失：${name}`);
    return new StateEffect(this.scene,visual,state,clip);
  }

  remove(id:string):void{
    const entry=this.actors.get(id);
    if(!entry)return;
    for(const marker of entry.markers.values())marker.destroy();
    this.actors.delete(id);
  }

  retainActors(ids:ReadonlySet<string>):void{
    for(const id of this.actors.keys())if(!ids.has(id))this.remove(id);
  }

  clear():void{
    for(const id of this.actors.keys())this.remove(id);
  }
}
