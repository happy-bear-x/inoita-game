import Phaser from 'phaser';
import type { BattleCatalog } from '../domain/battle.ts';
import { COMBAT_OUTCOME_EFFECTS, ENEMY_DEFEAT_FADE_MS, ENEMY_DEFEAT_HOLD_MS } from '../domain/combat-outcomes.ts';
import type { CharacterVisual } from './characters.ts';
import { EffectPool } from './effects.ts';

/** Scene-owned recovery, death and level-up visuals, independent of attack cancellation. */
export class CombatOutcomes {
  private readonly scene: Phaser.Scene;
  private readonly catalog: BattleCatalog;
  private readonly effects = new Set<Phaser.GameObjects.Container>();
  private readonly pool: EffectPool;
  private readonly deaths = new Map<string, Phaser.Tweens.Tween>();
  private paused = false;
  private visible = true;
  constructor(scene: Phaser.Scene, catalog: BattleCatalog) {
    this.scene = scene; this.catalog = catalog;
    this.pool = new EffectPool(scene);
  }
  /** 进图装配战斗时先建好结算特效；升级时只挪位置重播，不再现场建容器和动画。 */
  warm(): void {
    for (const name of COMBAT_OUTCOME_EFFECTS) {
      const clip = this.catalog.attackEffects[name]?.clips.default;
      if (clip) this.pool.warm(clip);
    }
  }
  private track(effect: Phaser.GameObjects.Container): void {
    this.effects.add(effect);
    effect.setVisible(this.visible);
    const drop = (): void => {
      this.effects.delete(effect);
      effect.off('effect-recycle', drop);
      effect.off('destroy', drop);
    };
    effect.once('effect-recycle', drop);
    effect.once('destroy', drop);
    if (this.paused) for (const sprite of effect.list as Phaser.GameObjects.Sprite[]) sprite.anims.pause();
  }
  private effect(name: typeof COMBAT_OUTCOME_EFFECTS[number], x: number, y: number) {
    const effect = this.pool.acquire(this.catalog.attackEffects[name].clips.default, x, y);
    this.track(effect);
    return effect;
  }
  vanish(key: string, character: CharacterVisual, complete: () => void): void {
    for (const sprite of character.layers) sprite.anims.stop();
    this.effect('enemy-vanish', character.container.x, character.container.y).setDepth(Number.MAX_SAFE_INTEGER);
    const tween = this.scene.tweens.add({
      targets: character.container, alpha: 0, delay: ENEMY_DEFEAT_HOLD_MS, duration: ENEMY_DEFEAT_FADE_MS,
      ease: (value: number) => Math.floor(value * 10) / 10,
      paused: this.paused,
      onComplete: () => { this.deaths.delete(key); complete(); }
    });
    this.deaths.set(key, tween);
  }
  cancelDeath(key: string): void {
    this.deaths.get(key)?.stop();
    this.deaths.delete(key);
  }
  levelUp(character: CharacterVisual): void {
    const anchor = character.actor.effectAnchor;
    if (!anchor) throw new Error(`人物缺少升级特效锚点：${character.actor.id}`);
    for (const name of ['level-up-aura', 'level-up-light'] as const) {
      const effect = this.effect(name, anchor.x, anchor.y);
      character.container.addAt(effect, character.layers.length);
    }
    this.effect('level-up-burst', character.container.x, character.container.y).setDepth(Number.MAX_SAFE_INTEGER);
  }
  recover(character: CharacterVisual): void {
    const anchor=character.actor.effectAnchor;
    if(!anchor)throw new Error(`人物缺少恢复特效锚点：${character.actor.id}`);
    character.container.addAt(this.effect('energy-column',anchor.x,anchor.y),character.layers.length);
  }
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    for (const tween of this.deaths.values()) if (paused) tween.pause(); else tween.resume();
    for (const effect of this.effects) for (const sprite of effect.list as Phaser.GameObjects.Sprite[])
      if (paused) sprite.anims.pause(); else sprite.anims.resume();
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const effect of this.effects) effect.setVisible(visible);
  }
  destroy(): void {
    for (const tween of this.deaths.values()) tween.stop();
    this.deaths.clear();
    // 先归还正在播放的特效，再统一销毁池里的空闲容器；池会释放图集租约。
    for (const effect of [...this.effects]) this.pool.release(effect);
    this.effects.clear();
    this.pool.destroy();
  }
}
