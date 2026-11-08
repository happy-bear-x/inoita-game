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
    holder: unknown;
    image: { visible(value: boolean): void; load(): Promise<void>; signal: { aborted: boolean }; destroy(): void };
    file: string;
    visible: boolean;
  }
  let iconVisible = false;
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
    app: { session, storyInterface: { assets: {
      'minimap-available': 'available.png', 'minimap-active': 'active.png', 'minimap-ready': 'ready.png' } } },
    characters: [character],
    map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    minimap: { updatePlayer() {}, updateTasks(tasks: unknown[]) { taskLists.push(tasks); } },
    refreshLoadout() {}, noticeQuestCompletions() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
    createQuestMarker(target: typeof character) {
      created.push(target);
      target.marker = {
        holder: {},
        image: { visible(value: boolean) { iconVisible = value; }, load: async () => {},
          signal: { aborted: false }, destroy() {} },
        file: '', visible: true,
      };
    },
  });

  invoke(host, 'refreshState');
  assert.equal(created.length, 0, '任务尚不可接取，不创建头顶标记');

  // 前置任务完成：当前地图和角色没有重建，只是任务状态变为可接取。
  status = 'available'; marked = true; version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(created.length, 1, '任务变为可接取后补建头顶标记');
  assert.equal(character.marker?.visible, true);
  assert.equal(character.marker?.file, 'available.png', '头顶标记用原版可接取图标');
  assert.equal(iconVisible, true);
  assert.deepEqual(taskLists.at(-1), [{ id: 'npc-1', x: 120, y: 80, status: 'available' }]);

  // 同一状态没有变化时不再刷新；状态再变也复用已有标记，不重复创建。
  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
  version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
});

test('the minimap receives quest characters on the first refresh after it is created', () => {
  const taskLists: unknown[][] = [];
  const container = {
    visible: true, x: 64, y: 96, children: [] as unknown[],
    setVisible(value: boolean) { container.visible = value; },
  };
  const marker = {
    holder: {},
    image: { visible() {}, load: async () => {}, signal: { aborted: false }, destroy() {} },
    file: '', visible: true,
  };
  const character = {
    entity: { id: 'npc-1', actor: 'elder', characterId: 'npc-1' },
    actor: { id: 'elder' }, container, marker,
  };
  const session = {
    questBook: { version: 1 }, storyWorld: { revision: 0, actorVisible: () => true },
    chests: { revision: 0 }, legendaryWeapons: { revision: 0 },
    runtimeState: { sequence: 0 }, restorationVersion: 0,
    marker: () => 'available', markerActor: () => true, visible: () => true,
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: { session, storyInterface: { assets: {
      'minimap-available': 'available.png', 'minimap-active': 'active.png', 'minimap-ready': 'ready.png' } } },
    characters: [character], map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    refreshLoadout() {}, noticeQuestCompletions() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
  });
  // 进图流程里，第一次刷新发生在小地图创建之前；此时标记列表无人接收。
  invoke(host, 'refreshState');
  // 小地图就绪后，即使会话状态没变，也要完整刷新一次并把任务人物交过去。
  host.minimap = {
    updatePlayer() {},
    updateTasks(tasks: unknown[]) { taskLists.push(tasks); },
  };
  invoke(host, 'refreshState');
  assert.deepEqual(taskLists, [[{ id: 'npc-1', x: 64, y: 96, status: 'available' }]]);
});

test('hidden ready deliveries do not light the overhead marker or the minimap', () => {
  type Status = 'available' | 'ready';
  let status: Status = 'available', marked = true, version = 1, iconVisible = false;
  const created: unknown[] = [], taskLists: unknown[][] = [];
  const container = {
    visible: true, x: 32, y: 48,
    setVisible(value: boolean) { container.visible = value; },
  };
  interface Marker {
    holder: unknown;
    image: { visible(value: boolean): void; load(): Promise<void>; signal: { aborted: boolean }; destroy(): void };
    file: string;
    visible: boolean;
  }
  const character = {
    entity: { id: 'npc-hidden', actor: 'well', characterId: 'npc-137' },
    actor: { id: 'well' }, container, marker: undefined as Marker | undefined,
  };
  const session = {
    questBook: { version }, storyWorld: { revision: 0, actorVisible: () => true },
    chests: { revision: 0 }, legendaryWeapons: { revision: 0 },
    runtimeState: { sequence: 0 }, restorationVersion: 0,
    marker: () => status, markerActor: () => marked, visible: () => true,
  };
  const host = Object.assign(Object.create(WorldScene.prototype), {
    app: { session, storyInterface: { assets: {
      'minimap-available': 'available.png', 'minimap-active': 'active.png', 'minimap-ready': 'ready.png' } } },
    characters: [character], map: { id: 'map' },
    player: { container: { x: 0, y: 0 } },
    minimap: { updatePlayer() {}, updateTasks(tasks: unknown[]) { taskLists.push(tasks); } },
    refreshLoadout() {}, noticeQuestCompletions() {},
    chestOpened: () => false, legendarySwordConsumed: () => false,
    movement: { setEnabled() {} },
    createQuestMarker(target: typeof character) {
      created.push(target);
      target.marker = {
        holder: {},
        image: { visible(value: boolean) { iconVisible = value; }, load: async () => {},
          signal: { aborted: false }, destroy() {} },
        file: '', visible: true,
      };
    },
  });

  invoke(host, 'refreshState');
  assert.equal(created.length, 1);
  assert.equal(iconVisible, true, '普通任务仍显示头顶标记');

  // 同一交付人只剩隐藏任务的待交付状态：头顶和地图都不能继续提示。
  status = 'ready'; marked = false; version += 1; session.questBook.version = version;
  invoke(host, 'refreshState');
  assert.equal(character.marker?.visible, false, '隐藏待交付不保留头顶图标');
  assert.equal(iconVisible, false, '头顶图标实际隐藏');
  assert.deepEqual(taskLists.at(-1), [], '小地图也不显示隐藏待交付');
});
