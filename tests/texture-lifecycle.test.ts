import assert from 'node:assert/strict';
import test from 'node:test';
import { drawnHolder, releaseTextureWhenUnused } from '../src/rendering/texture-lifecycle.ts';

interface FakeScene { sys: { isVisible(): boolean; settings: { key: string } }; children: { list: unknown[] } }

function harness(objects: unknown[]) {
  const removed: string[] = [];
  const animations: string[] = [];
  const diagnostics: { kind: string; details: unknown }[] = [];
  const listeners: (() => void)[] = [];
  let visible = true;
  const scene: FakeScene = {
    sys: { isVisible: () => visible, settings: { key: 'world' } },
    children: { list: objects },
  };
  const game = {
    scene: { scenes: [scene] },
    events: {
      on: (_event: string, listener: () => void) => listeners.push(listener),
      off: (_event: string, listener: () => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
  };
  let texture = { key: 'atlas' };
  const textures = {
    game,
    exists: () => true,
    get: () => texture,
    remove: (key: string) => { removed.push(key); },
  };
  const anims = {
    exists: () => true,
    remove: (key: string) => { animations.push(key); },
  };
  globalThis.storyDiagnostics = {
    record: (kind: string, details: unknown) => { diagnostics.push({ kind, details }); },
  } as unknown as NonNullable<typeof globalThis.storyDiagnostics>;
  return {
    textures, anims, removed, animations, diagnostics, listeners, scene, objects,
    setVisible: (value: boolean) => { visible = value; },
    reloadTexture: () => { texture = { key: 'atlas' }; },
  };
}

function sprite(key: string, visible = true) {
  return { type: 'Sprite', visible, frame: { texture: { key } } };
}

test('画面里还有对象在画这张纹理时不删除，并记下引用者', () => {
  const h = harness([sprite('characters-atlas')]);
  const deleted = releaseTextureWhenUnused(h.textures as never, h.anims as never, 'characters-atlas');
  assert.equal(deleted, false);
  assert.deepEqual(h.removed, []);
  assert.equal(h.diagnostics.length, 1);
  assert.deepEqual(h.diagnostics[0], { kind: 'texture-retained', details: { key: 'characters-atlas', scene: 'world', object: 'Sprite' } });
});

test('没有可见引用时立即删除，并清理引用该纹理的动画', () => {
  const h = harness([sprite('other')]);
  const deleted = releaseTextureWhenUnused(h.textures as never, h.anims as never, 'characters-atlas');
  assert.equal(deleted, true);
  assert.deepEqual(h.removed, ['characters-atlas']);
  assert.deepEqual(h.animations, ['characters-atlas']);
});

test('隐藏的对象和不可见的场景都不算引用', () => {
  const hidden = harness([sprite('characters-atlas', false)]);
  assert.equal(drawnHolder({ scene: { scenes: [hidden.scene] } } as never, 'characters-atlas', hidden.textures as never), undefined);
  assert.equal(releaseTextureWhenUnused(hidden.textures as never, hidden.anims as never, 'characters-atlas'), true);

  const sleeping = harness([sprite('characters-atlas')]);
  sleeping.setVisible(false);
  assert.equal(releaseTextureWhenUnused(sleeping.textures as never, sleeping.anims as never, 'characters-atlas'), true);
});

test('容器里的角色和当前动画的其他页也算引用', () => {
  const container = { type: 'Container', visible: true, list: [sprite('outfit-1')] };
  const h = harness([container]);
  assert.equal(drawnHolder({ scene: { scenes: [h.scene] } } as never, 'outfit-1', h.textures as never)?.type, 'Sprite');

  const animated = {
    type: 'Sprite', visible: true, frame: { texture: { key: 'page-a' } },
    anims: { currentAnim: { frames: [{ textureKey: 'page-b' }] } },
  };
  const pages = harness([animated]);
  assert.equal(releaseTextureWhenUnused(pages.textures as never, pages.anims as never, 'page-b'), false);
});

test('仍被引用时帧后检查只推迟，引用消失后才补删', async () => {
  const h = harness([sprite('outfit-1')]);
  releaseTextureWhenUnused(h.textures as never, h.anims as never, 'outfit-1');
  assert.equal(h.listeners.length, 1, '排队后应挂上帧后检查');
  h.listeners[0]!();
  assert.deepEqual(h.removed, [], '第一次帧后检查仍被引用，不能删除');
  h.objects.length = 0;
  await new Promise(resolve => setTimeout(resolve, 510));
  h.listeners[0]!();
  assert.deepEqual(h.removed, ['outfit-1']);
  assert.equal(h.listeners.length, 0, '队列清空后摘掉帧后检查');
});

test('同 key 的纹理被重新加载后作废这次删除', () => {
  const h = harness([sprite('outfit-1')]);
  releaseTextureWhenUnused(h.textures as never, h.anims as never, 'outfit-1');
  h.reloadTexture();
  h.objects.length = 0;
  h.listeners[0]!();
  assert.deepEqual(h.removed, [], '新纹理由新租约管理，旧队列应作废');
});

test('重复排队只挂一个帧后检查和一条诊断', () => {
  const h = harness([sprite('outfit-1')]);
  releaseTextureWhenUnused(h.textures as never, h.anims as never, 'outfit-1');
  releaseTextureWhenUnused(h.textures as never, h.anims as never, 'outfit-1');
  assert.equal(h.listeners.length, 1);
  assert.equal(h.diagnostics.length, 1);
});
