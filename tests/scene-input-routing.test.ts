import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { InputRouter } from '../src/application/input-router.ts';
import { EventEmitter } from 'node:events';
import { DomUi } from '../src/ui/dom/dom-ui.ts';
import { UiNode } from '../src/ui/dom/node.ts';
import { UiSurface } from '../src/ui/dom/surface.ts';
import { installMenuDom, MenuElement } from './support/menu-dom.ts';

// 只替换 Phaser 的运行边界；场景的键盘判断跑真实代码。
const hook = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'phaser' ? { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
    export default {
      Scene: class { constructor(config) { this.key = typeof config === 'string' ? config : config?.key; } },
      BlendModes: { NORMAL: 0, ADD: 1, SCREEN: 2, MULTIPLY: 3 },
      Scenes: { Events: { RESUME: 'resume', PAUSE: 'pause' } },
      Input: { Events: { POINTER_MOVE: 'pointermove', POINTER_UP: 'pointerup', POINTER_UP_OUTSIDE: 'pointerupoutside' } },
      Math: { Clamp: (value, min, max) => Math.max(min, Math.min(max, value)) },
      Geom: { Rectangle: class {}, Circle: class {} }
    };
  `)}` } : next(specifier, context);
} });
const { FormalUiScene } = await import('../src/scenes/formal-ui-scene.ts');
const { MenuScene } = await import('../src/scenes/menu-scene.ts');
const { StoryClassScene } = await import('../src/scenes/story-class-scene.ts');
hook.deregister();

test('dialogue and choice text stays above its shade and hides during occlusion',t=>{
  const restore=installMenuDom();t.after(restore);
  const dom=new DomUi();
  dom.layer=name=>document.getElementById(`ui-${name}`) as HTMLDivElement;
  dom.setOccluded=()=>{};
  const ui={mode:'game',ready:true,suspended:false,worldRebuildCover:false,defeated:false,canSkip:false,
    dialogueLine:{speaker:'说话人',actor:'npc',text:'对白内容'},page:'对白内容',revealed:4,
    choices:undefined as undefined|{prompt:string;options:never[];choose:()=>void},quest:undefined,
    pressDialogue:()=>{},releaseDialogue:()=>{},resetInput:()=>{}};
  const app={ui,domUi:dom,storyInterface:{assets:{}},director:{canSkip:false}};
  const scene=new FormalUiScene(app as never) as any;
  scene.events=new EventEmitter();scene.scale=Object.assign(new EventEmitter(),{width:1024,height:640});
  scene.game={events:new EventEmitter(),canvas:{getBoundingClientRect:()=>({left:0,top:0,width:1024,height:640})}};
  scene.surface=new UiSurface(scene,960,640,1000,'overlay');
  scene.background=new UiNode(scene,scene.surface.mount);scene.blocker=new UiNode(scene,scene.surface.mount).setInteractive();
  scene.questPopup={sync:()=>{}};scene.domSpeaker=dom.label('overlay','dom-speaker');
  t.after(()=>{scene.surface.destroy();scene.background.destroy();scene.blocker.destroy();scene.events.emit('shutdown');});
  scene.sync(ui);
  const overlay=document.getElementById('ui-overlay') as unknown as MenuElement;
  const speaker=scene.domSpeaker.element as unknown as MenuElement,run=scene.dialogueDomRuns[0].element as unknown as MenuElement;
  assert.equal(scene.surface.mount.parentElement,overlay);assert.equal(speaker.parentElement,overlay);assert.equal(run.parentElement,overlay);
  assert.equal(speaker.hidden,false);assert.equal(run.hidden,false);
  ui.suspended=true;scene.sync(ui);assert.equal(speaker.hidden,true);assert.equal(run.hidden,true);
  ui.page='暂停期间更新';scene.sync(ui);assert.equal(run.hidden,true,'遮挡期间正文变化不会让文字重新出现');
  ui.suspended=false;scene.sync(ui);assert.equal(speaker.hidden,false);assert.equal(run.hidden,false);
  ui.worldRebuildCover=true;scene.sync(ui);assert.equal(speaker.hidden,true);assert.equal(run.hidden,true);
  ui.worldRebuildCover=false;scene.sync(ui);assert.equal(run.hidden,false);
  ui.choices={prompt:'选择',options:[],choose:()=>{}};scene.sync(ui);
  const choice=scene.choiceDom.prompt[0].element as MenuElement;
  assert.equal(choice.parentElement,overlay);assert.equal(choice.hidden,false);assert.equal(run.hidden,true);
  ui.suspended=true;scene.sync(ui);assert.equal(choice.hidden,true);
  ui.suspended=false;scene.sync(ui);assert.equal(choice.hidden,false);
});

interface FakeEvent { key: string; target?: { tagName: string }; prevented: number; preventDefault(): void }
function press(key: string, target?: { tagName: string }): FakeEvent {
  const event: FakeEvent = { key, target, prevented: 0, preventDefault() { event.prevented += 1; } };
  return event;
}

function formalFixture(menuOpen = false) {
  const calls: string[] = [];
  const ui = {
    mode: 'game' as string, suspended: false, worldRebuildCover: false, keyBindingEditing: false,
    defeated: false, canSkip: false,
    quest: undefined as unknown,
    advance() { calls.push('advance'); },
    cancelDefeatConfirmation() { calls.push('cancel-defeat'); }
  };
  const app = {
    ui, storyUI: { menuOpen },
    inputRouter: new InputRouter({ textInputFocused: () => false })
  };
  const scene = new FormalUiScene(app as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    bridgeKey(event: FakeEvent): void;
    surface: { key(event: FakeEvent): boolean };
    questPopup: { key(event: FakeEvent): void };
  };
  let surfaceResult = false;
  scene.surface = { key: () => surfaceResult };
  scene.questPopup = { key: () => calls.push('quest-popup') };
  return { app, ui, scene, calls, setSurfaceResult: (value: boolean) => { surfaceResult = value; } };
}

test('正式界面弹层按原守卫顺序处理键盘', () => {
  const f = formalFixture();
  assert.equal(f.scene.routeKey(press('Escape')), false, '普通按键交给更低层');
  assert.deepEqual(f.calls, []);

  f.ui.suspended = true;
  assert.equal(f.scene.routeKey(press('Enter')), false);
  f.ui.suspended = false;

  f.ui.keyBindingEditing = true;
  assert.equal(f.scene.routeKey(press('Enter')), false, '键位捕获时让给设置面板');
  f.ui.keyBindingEditing = false;

  f.ui.defeated = true;
  const escape = press('Escape');
  assert.equal(f.scene.routeKey(escape), true);
  assert.equal(escape.prevented, 1);
  assert.deepEqual(f.calls, ['cancel-defeat']);
  f.ui.defeated = false;

  f.ui.quest = { kind: 'start' };
  assert.equal(f.scene.routeKey(press('Enter')), true);
  assert.deepEqual(f.calls, ['cancel-defeat', 'quest-popup'], '任务窗打开时其他层不重复消费');
  f.ui.quest = undefined;

  f.ui.canSkip = true;
  const enter = press('Enter');
  assert.equal(f.scene.routeKey(enter), true);
  assert.equal(enter.prevented, 1);
  assert.deepEqual(f.calls, ['cancel-defeat', 'quest-popup', 'advance']);

  f.setSurfaceResult(true);
  assert.equal(f.scene.routeKey(press('Tab')), true, '界面按钮聚焦由 surface 消费');
});

test('游戏内菜单打开时正式界面先让路，避免 Tab/Enter 被两层抢走', () => {
  const f = formalFixture(true);
  f.ui.canSkip = true;
  assert.equal(f.scene.routeKey(press('Enter')), false);
  assert.deepEqual(f.calls, []);
});

test('正式界面场景只把原始按键桥接给 router', () => {
  const f = formalFixture();
  const seen: string[] = [];
  f.app.inputRouter.register('modal', event => { seen.push(event.key); return true; });
  f.scene.bridgeKey(press('Escape'));
  assert.deepEqual(seen, ['Escape']);
});

test('标题页的 Escape 先关确认框，再返回上一页', () => {
  const inputRouter = new InputRouter({ textInputFocused: () => false });
  const app = { inputRouter, ui: { suspended: false } };
  const scene = new MenuScene(app as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    page: string;
    confirmAction?: { cancel(): void };
    surface: { key(event: FakeEvent): boolean };
    back(): void;
  };
  const calls: string[] = [];
  scene.surface = { key: () => false };
  scene.back = () => calls.push('back');

  scene.page = 'slots';
  scene.confirmAction = { cancel: () => calls.push('cancel-confirm') };
  const first = press('Escape');
  assert.equal(scene.routeKey(first), true);
  assert.equal(first.prevented, 1);
  assert.deepEqual(calls, ['cancel-confirm']);

  scene.confirmAction = undefined;
  assert.equal(scene.routeKey(press('Escape')), true);
  assert.deepEqual(calls, ['cancel-confirm', 'back'], '确认框关掉后 Escape 才离开页面');

  scene.page = 'home';
  assert.equal(scene.routeKey(press('Escape')), false);
  assert.deepEqual(calls, ['cancel-confirm', 'back']);

  scene.page = 'slots';
  (scene as unknown as { renameRef?: object }).renameRef = {};
  assert.equal(scene.routeKey(press('Escape')), true, '输入框有焦点时场景不处理按键');
  assert.deepEqual(calls, ['cancel-confirm', 'back']);
});

test('职业选择页的 Escape 回标题，其他按键交给页面按钮', () => {
  const app = { inputRouter: new InputRouter({ textInputFocused: () => false }), suspended: false,
    returnToMenu: () => { app.returned += 1; }, returned: 0 };
  const scene = new StoryClassScene(app as never) as unknown as {
    routeKey(event: FakeEvent): boolean;
    surface: { key(event: FakeEvent): boolean };
  };
  scene.surface = { key: () => true };
  assert.equal(scene.routeKey(press('Escape')), true);
  assert.equal(app.returned, 1);
  assert.equal(scene.routeKey(press('Tab')), true);
  app.suspended = true;
  assert.equal(scene.routeKey(press('Escape')), false, '挂起时不再响应');
  assert.equal(app.returned, 1);
});

