import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../src/generated/effect-atlas.ts';

// combat-feedback.ts 会连带加载角色与特效模块；测试只需要它们能 import，不调用 Phaser 运行时。
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(
      'export default { BlendModes: { NORMAL: 0, SCREEN: 1, ADD: 2, MULTIPLY: 3 } };')}` }
    : next(specifier, context);
} });
const { playDigitAnimation } = await import('../src/rendering/combat-feedback.ts');
hook.deregister();

interface FrameConfig { key: string; frame: string | number }
interface Animation { key: string; frames: FrameConfig[]; frameRate: number }

function sceneWithAnimations(animations: Map<string, Animation>) {
  return {
    exists: (key: string) => animations.has(key),
    get: (key: string) => animations.get(key),
    create: (value: Animation) => { animations.set(value.key, value); return value; },
    remove: (key: string) => { animations.delete(key); },
    stop: () => {}
  };
}

function spriteFor(textureKey: string, animations: Map<string, Animation>) {
  return {
    texture: { key: textureKey },
    anims: sceneWithAnimations(animations),
    scene: { anims: sceneWithAnimations(animations) },
    playConfig: undefined as { key: string } | undefined,
    play(config: { key: string }) { this.playConfig = config; return this; },
    animsStop() {},
    stop() {}
  };
}

test('图集伤害数字按页键和帧名创建动画，不再把源帧序号当纹理帧', () => {
  const animations = new Map<string, Animation>();
  const sprite = spriteFor('effects-atlas:24', animations);
  // 真实数字文件里帧名是内容哈希，源帧序号只是序列下标。
  const file = 'assets/battle-effects/damage-enemy-0/0-.png';
  const mapping = EFFECT_ATLAS_BY_FILE[file]!;
  const layer = { key: 'damage-enemy-0-0', file, blend: 'screen' as const, operations: [] };
  const sequence = [0, 1, 2, 3, 4, 4, 4, 5, 6];

  const spriteLike = sprite as unknown as import('phaser').GameObjects.Sprite & { playConfig?: { key: string } };
  playDigitAnimation(spriteLike, layer, sequence, 30, 0);

  const animation = animations.get(sprite.playConfig!.key)!;
  assert.ok(animation, '数字动画已创建');
  assert.equal(animation.frames.length, sequence.length);
  assert.deepEqual(animation.frames[0], {
    key: EFFECT_ATLAS_PAGES[mapping[0]!.page]!.key,
    frame: mapping[0]!.frame
  });
  assert.ok(animation.frames.every(frame => typeof frame.frame === 'string'),
    '图集帧必须是帧名，不能是数字序号');
  assert.deepEqual(animation.frames.map(frame => frame.frame),
    sequence.map(index => mapping[index]!.frame), '序列下标映射到正确的源帧');
});

test('数字图集缺少文件映射或帧时直接失败', () => {
  const animations = new Map<string, Animation>();
  const sprite = spriteFor('plain-digit-sheet', animations) as unknown as import('phaser').GameObjects.Sprite;

  const unmapped = { key: 'digit', file: 'assets/missing/digit.png', blend: 'screen' as const, operations: [] };
  assert.throws(() => playDigitAnimation(sprite, unmapped, [0], 30, 0), /伤害数字图集缺少文件映射/);

  const file = 'assets/battle-effects/damage-enemy-0/0-.png';
  const mapping = EFFECT_ATLAS_BY_FILE[file]!;
  const mapped = { key: 'digit', file, blend: 'screen' as const, operations: [] };
  assert.throws(() => playDigitAnimation(sprite, mapped, [mapping.length], 30, 0), /伤害数字图集缺少帧/);
});

test('未进图集的数字仍按原纹理和数字帧播放', () => {
  const animations = new Map<string, Animation>();
  const sprite = spriteFor('plain-digit-sheet', animations);
  const spriteLike = sprite as unknown as import('phaser').GameObjects.Sprite & { playConfig?: { key: string } };
  playDigitAnimation(spriteLike, undefined, [0, 1, 2], 30, 0);
  const animation = animations.get(sprite.playConfig!.key)!;
  assert.deepEqual(animation.frames, [
    { key: 'plain-digit-sheet', frame: 0 },
    { key: 'plain-digit-sheet', frame: 1 },
    { key: 'plain-digit-sheet', frame: 2 }
  ]);
});
