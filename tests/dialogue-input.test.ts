import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GameUI } from '../src/ui/game-ui.ts';
import { dialogueTextParts } from '../src/ui/dialogue-text.ts';

function harness(_t:TestContext) {
  const ui=new GameUI();ui.ready=true;ui.page='当前对白';
  ui.dialogueState={text:ui.page,start:0,readTo:0,skipped:false};
  let completed=0;ui.pending=()=>{completed++;};
  const pointer=(type:string,target='game-frame')=>{
    if(target==='choice')return;
    if(type==='pointerdown')ui.pressDialogue(1);
    if(type==='pointerup')ui.releaseDialogue(1);
    if(type==='pointercancel')ui.cancelPress(1);
  };
  return {ui,pointer,completed:()=>completed};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('翻页保留前文颜色和颜色锁定状态', () => {
  const ui=new GameUI();
  ui.dialogueState={text:'&C$G前文$R后文&C普通',start:7,readTo:7,skipped:false};
  ui.page='$R后文&C普通';
  const parts=dialogueTextParts(ui.dialoguePageMarkup,'base');
  assert.deepEqual(parts,[{text:'后文',key:'#808080'},{text:'普通',key:'base'}]);
});

test('screen pointer release reveals and advances dialogue without any browser click event', async t => {
  const h = harness(t);
  h.pointer('pointerdown'); h.pointer('pointerup'); await settle();
  assert.equal(h.ui.revealed, h.ui.page.length); assert.equal(h.completed(), 0);
  h.pointer('pointerdown'); h.pointer('pointerup'); await settle();
  assert.equal(h.completed(), 1); assert.equal(h.ui.pending, null);
});

test('cancelled touches, choice buttons, opening gestures and SKIP cannot advance a different page', async t => {
  const h = harness(t); h.ui.revealed = h.ui.page.length;
  h.pointer('pointerdown'); h.pointer('pointercancel'); h.pointer('pointerup'); await settle();
  h.pointer('pointerdown', 'choice'); h.pointer('pointerup', 'choice'); await settle();
  assert.equal(h.completed(), 0);
  h.ui.pending = null; h.pointer('pointerdown'); h.ui.pending = () => { throw new Error('opening tap consumed next page'); };
  h.pointer('pointerup'); await settle();
  h.ui.pending = () => {};
  h.pointer('pointerdown'); h.pointer('pointerup');
  h.ui.skipDialogue();
  // SKIP completes the old page before the delayed continuation handles release.
  h.ui.pending = () => { throw new Error('SKIP release consumed next page'); };
  await settle();
});

test('typewriter advances by 24ms steps over visible characters and stops rendering once the page is complete', () => {
  const ui=new GameUI();ui.ready=true;
  ui.dialogueState={text:'$R红$B字&N第二行',start:0,readTo:0,skipped:false};
  ui.page='$R红$B字&N第二行';ui.pending=()=>{};
  let renders=0;
  ui.view={sync(){},renderText(){renders++;},paginate(){return[{text:ui.page,end:ui.page.length}]},portrait:async()=>{}};
  ui.tick(12);assert.equal(ui.revealed,0,'不到 24ms 不推进');
  ui.tick(12);assert.equal(ui.revealed,2,'控制码和换行不占进度');assert.equal(renders,1);
  ui.tick(24);assert.equal(ui.revealed,4);
  ui.tick(24);assert.equal(ui.revealed,5,'只数可见文字');
  const done=renders;
  ui.tick(1000);ui.tick(1000);
  assert.equal(ui.revealed,5);assert.equal(renders,done,'等待点击时不重刷同一页');
});

test('typewriter never splits a surrogate pair and follows a replacement page', () => {
  const ui=new GameUI();ui.ready=true;ui.pending=()=>{};
  ui.view={sync(){},renderText(){},paginate(){return[{text:ui.page,end:ui.page.length}]},portrait:async()=>{}};
  ui.dialogueState={text:'a😀',start:0,readTo:0,skipped:false};ui.page='a😀';
  ui.tick(24);assert.equal(ui.revealed,3,'不能停在代理对中间');
  ui.page='新页';ui.revealed=0;
  ui.tick(24);assert.equal(ui.revealed,2,'换页后按新页的可见长度推进');
});

test('reflow discards the previous page cache and reveals against the new page length', () => {
  const ui=new GameUI();ui.ready=true;ui.pending=()=>{};
  let page='旧页';
  ui.view={sync(){},renderText(){},paginate(){return[{text:page,end:page.length}]},portrait:async()=>{}};
  ui.dialogueState={text:'旧页新页面',start:0,readTo:0,skipped:false};
  ui.layoutDialoguePage();
  ui.tick(24);assert.equal(ui.revealed,2);
  page='新页面';ui.reflowDialogue();
  assert.equal(ui.page,'新页面');
  ui.tick(24);assert.equal(ui.revealed,3,'重排后按新页长度补完');
});
