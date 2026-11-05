import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const hook = registerHooks({resolve(specifier, context, next) {
  return specifier === 'phaser'
    ? {url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
    : next(specifier, context);
}});
const { WorldScene } = await import('../src/scenes/world-scene.ts');
hook.deregister();
const invoke = (host: object, name: string, ...args: unknown[]) => Reflect.get(WorldScene.prototype, name).call(host, ...args);

test('a quest marker is created when a quest becomes available after the map is already loaded', () => {
  type Status = 'available' | 'active' | 'ready' | null;
  let status: Status = null, marked = false, version = 0;
  const created: unknown[] = [], taskLists: unknown[][] = [];
  const container = {
    visible: true, x: 120, y: 80, children: [] as unknown[],
    setVisible(value: boolean) { container.visible = value; },
    add(child: unknown) { container.children.push(child); },
  };
  interface Marker {
    container: { visible: boolean; setVisible(value: boolean): void };
    glyph: { text: string; style: { color: string }; setText(value: string): void; setColor(value: string): void };
  }
  const character = {
    entity: { id: 'npc-1', actor: 'elder', characterId: 'npc-1' },
    actor: { id: 'elder' }, container, marker: undefined as Marker | undefined,
  };
  const session = {
    questBook: { version }, storyWorld: { revision: 0, actorVisible: () => true },
    chests: { revision: 0 }, legendaryWeapons: { revision: 0 },
    runtimeState: { sequence: 0 }, restorationVersion: 0,
    marker: () => status, markerActor: () => marked, visible: () => true,
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: { session },
    characters: [character],
    map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    minimap: { updatePlayer() {}, updateTasks(tasks: unknown[]) { taskLists.push(tasks); } },
    refreshLoadout() {}, noticeQuestCompletions() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
    createQuestMarker(target: typeof character) {
      created.push(target);
      const glyph = { text: '', style: { color: '#ffdb78' },
        setText(value: string) { glyph.text = value; },
        setColor(value: string) { glyph.style.color = value; } };
      const markerContainer = { visible: true,
        setVisible(value: boolean) { markerContainer.visible = value; } };
      target.container.add(markerContainer);
      target.marker = { container: markerContainer, glyph };
    },
  });

  invoke(host, 'refreshState');
  assert.equal(created.length, 0, '任务尚不可接取，不创建头顶标记');
  assert.equal(container.children.length, 0);

  // 前置任务完成：当前地图和角色没有重建，只是任务状态变为可接取。
  status = 'available'; marked = true; version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(created.length, 1, '任务变为可接取后补建头顶标记');
  assert.equal(container.children.length, 1, '标记挂在角色容器里');
  assert.equal(character.marker?.container.visible, true);
  assert.equal(character.marker?.glyph.text, '!');
  assert.deepEqual(taskLists.at(-1), [{ id: 'npc-1', x: 120, y: 80, status: 'available' }]);

  // 同一状态没有变化时不再刷新；状态再变也复用已有标记，不重复创建。
  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
  version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
});
