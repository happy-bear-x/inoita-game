import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryApp } from '../app.ts';
import type { ActorDefinition, ClipName, Facing } from '../domain/content.ts';
import { NavigationWorld } from '../domain/navigation-world.ts';
import { isBodyWalking } from '../rendering/arcade-movement.ts';
import { characterAssets, createCharacter, PLAYER_MOVE_SPEED, setCharacterClip, type CharacterVisual } from '../rendering/characters.ts';
import { controlSkinAssets } from '../rendering/control-skin.ts';
import { Hud } from '../rendering/hud.ts';
import { MovementWorld } from '../rendering/movement-world.ts';
import { loadSceneAssets } from '../rendering/scene-assets.ts';
import { Wardrobe } from '../rendering/wardrobe.ts';
import { MoveStick } from '../ui/phaser/move-stick.ts';
import { GOLD, UiSurface } from '../ui/phaser/widgets.ts';
import { MenuTextLayer, type MenuTextSpec } from '../ui/dom/menu-text.ts';
import type { DomLabel } from '../ui/dom/dom-ui.ts';
import { worldZoom } from '../ui/viewport.ts';

interface AnimationSample {
  label: string;
  visual: CharacterVisual;
  offset: number;
  sprite?: Phaser.GameObjects.Sprite;
  changes: number;
  firstChangeMs: number;
  lastChangeMs: number;
  onFrame: () => void;
}

/** 复用正式表现模块的独立动画场景，通过 ?animation-debug 直接进入。 */
export class AnimationDebugScene extends Phaser.Scene {
  private readonly app: StoryApp;
  private request = new AbortController();
  private hud?: Hud;
  private surface?: UiSurface;
  private stick?: MoveStick;
  private movement?: MovementWorld;
  private wardrobe?: Wardrobe;
  private player?: CharacterVisual;
  private samples: AnimationSample[] = [];
  /** 角色头顶的名字改用 DOM；它跟着世界坐标投影，缩放随相机。 */
  private labels: DomLabel[] = [];
  /** 控制面板文字走 DOM；状态行和统计块按 key 原地更新。 */
  private uiText?: MenuTextLayer;
  private textSpecs: MenuTextSpec[] = [];
  private statusText = '正在加载动画测试资源…';
  private statsText = '';
  private floor?: Phaser.GameObjects.Image;
  private floorTexture?: Phaser.Textures.CanvasTexture;
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private ready = false;
  private failure = '';
  private facing: Facing = 'south';
  private mode: 'in-place' | 'movement' = 'in-place';
  private elapsedMs = 0;
  private wallStartMs = 0;
  private renderedFrames = 0;
  private distancePx = 0;
  private previousPosition = { x: 2000, y: 2000 };
  private nextStatsMs = 0;

  constructor(app: StoryApp) {
    super({ key: SCENE_KEYS.animationDebug, physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } } });
    this.app = app;
  }

  create(): void {
    this.request = new AbortController();
    this.ready = false; this.failure = ''; this.facing = 'south'; this.mode = 'in-place';
    this.samples = []; this.labels = []; this.textSpecs = []; this.statsText = '';
    this.statusText = '正在加载动画测试资源…';
    this.hud = new Hud(this);
    this.surface = new UiSurface(this.hud.scene, 960, 640);
    this.hud.add(this.surface.root);
    this.surface.enabled = () => this.sys.isActive();
    this.surface.layout();
    if (this.app.domUi) {
      this.uiText = new MenuTextLayer(this.app.domUi, (x, y) => this.textPoint(x, y), () => undefined);
      this.uiText.register('animation-loading', writer => {
        writer.add({ key: 'status', text: this.statusText, x: 24, y: 24,
          style: { size: 24, color: this.failure ? '#f0b0a0' : GOLD, width: 900, wrap: 'word' } });
        if (this.failure) writer.add({ key: 'retry', text: '重试', x: 94, y: 107,
          style: { size: 20, color: GOLD, anchorX: .5, anchorY: .5, width: 128, align: 'center' } });
      });
      this.uiText.register('animation-debug', writer => { for (const spec of this.textSpecs) writer.add(spec); });
      this.uiText.renderPage('animation-loading');
    }
    this.events.on(Phaser.Scenes.Events.PRE_UPDATE, this.advanceClock, this);
    this.events.on(Phaser.Scenes.Events.POST_UPDATE, this.afterMovement, this);
    this.scale.on('resize', this.layout, this);
    this.game.events.on(Phaser.Core.Events.POST_RENDER, this.countRender, this);
    this.events.on('pause', this.resetInput, this);
    this.events.on('resume', this.resetMeasurement, this);
    this.input.keyboard?.on('keydown', this.onKey);
    this.events.once('shutdown', () => {
      this.request.abort(); this.ready = false;
      this.scale.off('resize', this.layout, this);
      this.game.events.off(Phaser.Core.Events.POST_RENDER, this.countRender, this);
      this.input.keyboard?.off('keydown', this.onKey);
      for (const sample of this.samples) sample.sprite?.off('animationupdate', sample.onFrame);
      this.movement?.destroy(); this.stick?.destroy(); this.wardrobe?.clear();
      this.uiText?.destroy(); this.uiText = undefined;
      for (const label of this.labels) label.remove();
      this.surface?.destroy(); this.hud?.destroy();
      this.player = undefined; this.movement = undefined; this.stick = undefined;
      this.floor = undefined; this.floorTexture = undefined; this.wardrobe = undefined;
      this.surface = undefined; this.hud = undefined; this.cursors = undefined;
      this.samples = []; this.labels = []; this.textSpecs = [];
      this.events.removeListener(Phaser.Scenes.Events.PRE_UPDATE, this.advanceClock, this);
      this.events.removeListener(Phaser.Scenes.Events.POST_UPDATE, this.afterMovement, this);
      this.events.removeListener(Phaser.Scenes.Events.PRE_RENDER, this.placeSamples, this);
      this.events.removeListener('pause', this.resetInput, this);
      this.events.removeListener('resume', this.resetMeasurement, this);
    });
    void this.loadSamples();
  }

  /** 控制面板本地坐标 → 画框 CSS 坐标。 */
  private textPoint(x: number, y: number): { x: number; y: number; scale: number } {
    const root = this.surface?.root;
    if (!root) return { x, y, scale: 1 };
    const matrix = root.getWorldTransformMatrix(), point = matrix.transformPoint(x, y);
    return { x: point.x, y: point.y, scale: matrix.scaleX };
  }

  private setStatus(text: string): void {
    this.statusText = text;
    this.uiText?.setText('animation-loading', 'status', text);
  }

  private async loadSamples(): Promise<void> {
    const signal = this.request.signal;
    try {
      const [world, battle, wardrobe, items, skin] = await Promise.all([
        this.app.content.world(signal), this.app.content.battle(signal), this.app.content.wardrobe(signal),
        this.app.content.items(signal), this.app.content.controlSkin(signal)
      ]);
      const hero = world.actors.kiyan;
      const wolf = battle.enemies.find(enemy => enemy.name === '狼')?.actor;
      const torch = world.actors['torch-45eb4a23'];
      const merchant = world.actors['weapons-dealer-f31d78ce'];
      if (!hero || !wolf || !torch || !merchant) throw new Error('动画测试角色缺少资源');
      const movementClips = (actor: ActorDefinition): ActorDefinition => ({ ...actor,
        clips: Object.fromEntries(Object.entries(actor.clips).filter(([name]) => name.startsWith('idle-') || name.startsWith('walk-'))) });
      const actors = [hero, wolf, torch, merchant].map(movementClips);
      await loadSceneAssets(this, [...actors.flatMap(characterAssets), ...controlSkinAssets(skin),
        ...wardrobe.textures.map(texture => ({ kind: 'image' as const, ...texture }))],
        progress => this.setStatus(`正在加载动画测试资源… ${Math.round(progress * 100)}%`));
      signal.throwIfAborted();
      const equipment = items.startingEquipment['dark-knight'];
      const main = items.items[equipment['main-hand']!].kind;
      const off = equipment['off-hand'] ? items.items[equipment['off-hand']].kind : 'empty';
      const stance = `${main}:${off}`;
      const poses = Object.fromEntries(Object.entries(wardrobe.stances[stance]).filter(([name]) => name.startsWith('idle-') || name.startsWith('walk-')));
      this.wardrobe = new Wardrobe(this, { ...wardrobe, stances: { ...wardrobe.stances, [stance]: poses } }, items,
        (ids, signal) => this.app.content.wardrobePoses(ids, signal));
      const outfit = await this.wardrobe.prepare(actors[0], equipment);
      signal.throwIfAborted();
      this.wardrobe.activate(outfit);
      const floor = this.textures.createCanvas('animation-debug-floor', 16, 16)!;
      this.floorTexture = floor;
      this.floor = this.add.image(this.scale.width / 2, this.scale.height / 2, floor.key).setScrollFactor(0).setDepth(-1000);
      this.events.once('shutdown', () => this.textures.remove(floor.key));
      this.movement = new MovementWorld(this, new NavigationWorld({ name: '动画空地', bounds: { x: 0, y: 0, width: 4000, height: 4000 } }));
      const plans = [
        { actor: actors[3], label: '普通人物', offset: -112 },
        { actor: actors[0], label: '离线主角', offset: -56 },
        { actor: outfit.actor, label: '实时换装', offset: 0 },
        { actor: actors[1], label: '狼', offset: 56 },
        { actor: actors[2], label: '火把', offset: 112 }
      ];
      this.samples = plans.map((plan, index) => {
        const visual = createCharacter(this, plan.actor, { id: `animation-sample-${index}`, actor: plan.actor.id, x: 2000 + plan.offset, y: 2000 });
        const sample: AnimationSample = { ...plan, visual, changes: 0, firstChangeMs: 0, lastChangeMs: 0, onFrame: () => {
          if (!sample.changes) sample.firstChangeMs = this.elapsedMs;
          sample.changes++; sample.lastChangeMs = this.elapsedMs;
        } };
        const label = this.app.domUi?.label('screen', 'dom-animation-label', { x: .5, y: .5 }).setText(plan.label);
        if (label) this.labels.push(label.setStyle({ fontSize: '8px', color: '#ffffff' }).setVisible(false));
        return sample;
      });
      this.player = this.samples[2].visual;
      this.movement.register(this.player);
      this.events.on(Phaser.Scenes.Events.PRE_RENDER, this.placeSamples, this);
      this.cameras.main.startFollow(this.player.container, true, 1, 1);
      this.stick = new MoveStick(this, this.hud!, skin);
      this.cursors = this.input.keyboard?.createCursorKeys();
      this.ready = true;
      this.drawControls(); this.layout(); this.resetMeasurement(); this.afterMovement();
    } catch (error) {
      if (signal.aborted) return;
      console.error(error);
      this.failure = error instanceof Error ? error.message : String(error);
      this.statusText = `动画测试加载失败：${this.failure}`;
      this.uiText?.renderPage('animation-loading');
      this.surface?.clear();
      this.surface?.button('', 24, 84, 140, 46, () => this.scene.restart()).setData('label', '重试');
    }
  }

  private drawControls(): void {
    const ui = this.surface!;
    ui.clear();
    this.textSpecs = [];
    const label = (key: string, text: string, x: number, y: number, width: number, size: number,
      color = GOLD, anchorX = 0, anchorY = 0): void => {
      this.textSpecs.push({ key, text, x, y, style: { size, color, anchorX, anchorY,
        width: width || undefined, wrap: width ? 'word' : undefined } });
    };
    const button = (key: string, text: string, x: number, y: number, width: number, height: number,
      action: () => void): void => {
      ui.button('', x, y, width, height, action).setData('label', text);
      label(key, text, x + width / 2, y + height / 2, width - 12, Math.min(22, height * .42), GOLD, .5, .5);
    };
    label('title', '动画与移动检查 · 黑暗骑士初始装备', 24, 12, 900, 25);
    const directions: { facing: Facing; label: string }[] = [{ facing: 'south', label: '南 ↓' }, { facing: 'west', label: '西 ←' }, { facing: 'north', label: '北 ↑' }, { facing: 'east', label: '东 →' }];
    directions.forEach((direction, index) => button(`direction-${index}`, direction.label, 24 + index * 108, 52, 100, 42, () => {
      this.facing = direction.facing; this.resetMeasurement();
    }));
    button('mode', this.mode === 'in-place' ? '切到摇杆移动' : '切到原地行走', 476, 52, 192, 42, () => {
      this.mode = this.mode === 'in-place' ? 'movement' : 'in-place';
      this.resetInput(); this.resetMeasurement(); this.drawControls(); this.layout();
    });
    button('reset', '重置测量', 688, 52, 140, 42, () => this.resetMeasurement());
    label('hint', '原地模式看四向姿势；移动模式使用左下摇杆或方向键。', 24, 106, 920, 19);
    ui.rect(270, 402, 666, 214, 0x101d24, .92);
    label('stats', this.statsText, 286, 414, 630, 19, '#dcebef');
    this.uiText?.renderPage('animation-debug');
  }

  private layout(): void {
    const zoom = worldZoom(this);
    this.cameras.main.setZoom(zoom).setRoundPixels(true);
    if (this.floor && this.floorTexture) {
      const width = Math.ceil(this.scale.width / zoom / 16) * 16 + 32;
      const height = Math.ceil(this.scale.height / zoom / 16) * 16 + 32;
      const texture = this.floorTexture;
      texture.setSize(width, height);
      texture.context.fillStyle = '#26363c'; texture.context.fillRect(0, 0, width, height);
      texture.context.fillStyle = '#33474e';
      for (let x = 0; x < width; x += 16) texture.context.fillRect(x, 0, 1, height);
      for (let y = 0; y < height; y += 16) texture.context.fillRect(0, y, width, 1);
      texture.refresh();
      this.floor.setTexture(texture.key).setDisplaySize(width, height);
    }
    this.hud?.layout(this.scale.width, this.scale.height);
    this.surface?.layout(); this.uiText?.refresh(); this.stick?.layout(this.scale.height);
    this.stick?.setVisible(this.ready && this.mode === 'movement');
  }

  private advanceClock(_time: number, delta: number): void { if (this.ready) this.elapsedMs += delta; }
  private countRender(): void { if (this.ready && this.sys.isActive()) this.renderedFrames++; }
  resetInput(): void { this.stick?.reset(); if (this.player) this.movement?.stop(this.player); }
  private onKey = (event: KeyboardEvent): void => {
    if (!this.ready) return;
    if (event.key === 'm' || event.key === 'M') {
      this.mode = this.mode === 'in-place' ? 'movement' : 'in-place';
      this.resetInput(); this.resetMeasurement(); this.drawControls(); this.layout();
    }
  };

  override update(): void {
    if (!this.ready || !this.player || !this.movement) return;
    if (this.mode === 'in-place') { this.movement.stop(this.player); return; }
    const axis = { ...this.stick!.axis };
    if (!Math.hypot(axis.x, axis.y)) {
      axis.x = Number(this.cursors?.right.isDown) - Number(this.cursors?.left.isDown);
      axis.y = Number(this.cursors?.down.isDown) - Number(this.cursors?.up.isDown);
    }
    this.movement.drive(this.player, axis, Math.trunc(PLAYER_MOVE_SPEED));
    if (Math.hypot(axis.x, axis.y)) this.facing = Math.abs(axis.x) > Math.abs(axis.y)
      ? axis.x < 0 ? 'west' : 'east' : axis.y < 0 ? 'north' : 'south';
  }

  private afterMovement(): void {
    if (!this.ready || !this.player || !this.movement) return;
    const position = this.movement.position(this.player);
    this.distancePx += Math.hypot(position.x - this.previousPosition.x, position.y - this.previousPosition.y);
    this.previousPosition = position;
    const walking = this.mode === 'in-place' || isBodyWalking(this.movement.body(this.player));
    for (const sample of this.samples) {
      const requested = `${walking ? 'walk' : 'idle'}-${this.facing}` as ClipName;
      setCharacterClip(this, sample.visual, sample.visual.actor.clips[requested] ? requested : 'idle-south');
      const sprite = sample.visual.layers[0];
      if (sprite !== sample.sprite) {
        sample.sprite?.off('animationupdate', sample.onFrame);
        sample.sprite = sprite;
        sample.changes = 0;
        sprite?.on('animationupdate', sample.onFrame);
      }
    }
    if (this.elapsedMs >= this.nextStatsMs) {
      this.nextStatsMs = this.elapsedMs + 250;
      const snapshot = this.snapshot();
      this.statsText = [
        `实测绘制 ${snapshot.renderFps.toFixed(1)} FPS  ·  计时比例 ${snapshot.clockRatio.toFixed(3)}`,
        `移动 ${snapshot.speedPxPerSecond.toFixed(2)} 像素/秒  ·  方向 ${this.facing}`,
        ...snapshot.animations.map(sample => `${sample.label}：${sample.entryMs.toFixed(1)}ms/条目 · 周期 ${sample.cycleMs.toFixed(0)}ms`)
      ].join('\n');
      this.uiText?.setText('animation-debug', 'stats', this.statsText);
    }
  }

  private placeSamples(): void {
    if (!this.ready || !this.player || !this.movement) return;
    const position = this.movement.displayPosition(this.player);
    this.floor?.setPosition(this.scale.width / 2 - position.x % 16, this.scale.height / 2 - position.y % 16);
    const camera = this.cameras.main, fontSize = Math.max(8, 6 * camera.zoom);
    this.samples.forEach((sample, index) => {
      if (sample.visual !== this.player) sample.visual.container.setPosition(position.x + sample.offset, position.y);
      const label = this.labels[index], point = this.app.domUi?.worldToScreen(camera, position.x + sample.offset, position.y + 10);
      if (label && point) label.setPosition(point.x, point.y)
        .setStyle({ fontSize: `${fontSize}px`, textShadow: '0 1px 2px rgba(0,0,0,.8)' }).setVisible(true);
    });
  }

  private resetMeasurement(): void {
    this.elapsedMs = 0; this.wallStartMs = performance.now(); this.renderedFrames = 0;
    this.distancePx = 0; this.nextStatsMs = 0;
    if (this.player && this.movement) this.previousPosition = this.movement.position(this.player);
    this.samples.forEach(sample => { sample.changes = 0; sample.firstChangeMs = 0; sample.lastChangeMs = 0; });
  }

  snapshot() {
    const wallMs = this.ready ? performance.now() - this.wallStartMs : 0;
    return { ready: this.ready, failure: this.failure, mode: this.mode, facing: this.facing,
      elapsedMs: this.elapsedMs, wallMs, renderFps: wallMs ? this.renderedFrames * 1000 / wallMs : 0,
      clockRatio: wallMs ? this.elapsedMs / wallMs : 0,
      speedPxPerSecond: this.elapsedMs ? this.distancePx * 1000 / this.elapsedMs : 0,
      player: this.player && this.movement ? { ...this.movement.position(this.player), clip: this.player.clipName, frame: this.player.layers[0]?.anims.currentFrame?.textureFrame } : null,
      animations: this.samples.map(sample => {
        const clip = sample.visual.actor.clips[sample.visual.clipName!]!;
        const entryMs = sample.changes > 1 ? (sample.lastChangeMs - sample.firstChangeMs) / (sample.changes - 1) : 1000 / clip.frameRate;
        return { label: sample.label, entryMs, cycleMs: clip.frames * entryMs, frames: clip.frames, frameRate: clip.frameRate, clip: sample.visual.clipName };
      }) };
  }
}
