import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {SaveSlots,SAVE_FORMAT,type SaveSlotRef} from '../src/domain/save-game.ts';
import {displaySettings} from '../src/application/display-settings.ts';
import type {MenuContext} from '../src/application/ports.ts';
import type {StoryWorldViewSnapshot} from '../src/scenes/world-scene.ts';
import type {CloudSaveEntry,CloudSavePort,CloudSession} from '../src/application/cloud-save.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'?{url:'data:text/javascript,export default {Scene:class{},BlendModes:{}}',shortCircuit:true}:next(specifier,context);}});
const {MenuScene}=await import('../src/scenes/menu-scene.ts');
const {UiSurface}=await import('../src/ui/phaser/widgets.ts');hook.deregister();
class Button {
  readonly active=true;readonly visible=true;readonly input:{enabled:boolean};
  x=0;y=0;width=0;height=0;
  private readonly data=new Map<string,unknown>();
  constructor(label:string,action:()=>void,disabled=false){this.input={enabled:!disabled};this.data.set('label',label);this.data.set('action',action);}
  setData(key:string,value:unknown){this.data.set(key,value);return this;}
  getData(key:string){return this.data.get(key);}
}
interface TextNode { value:string; x:number; y:number; size:number; origin:[number,number]; handlers:Map<string,()=>void> }
/** 标题页的滚动区替身：只记录滚动窗口和内容高度，拖动行为由 ScrollArea 自己的用例覆盖。 */
interface FakeScroll {
  x:number;y:number;width:number;height:number;extent:number;scrollTop:number;
  content:{list:unknown[];add():void;remove():void;removeAll():void};
  setHeight(value:number):void;layout():void;destroy():void;onScroll?:()=>void;
}
/** 标题页的菜单画布与删除确认画布共用这一份替身，只有尺寸与 `scene` 相同。 */
function fakeView(width:number,height:number){
  /** 图片只被链式调用，不需要真的画出来。 */
  const stub=()=>{const value:Record<string,()=>unknown>={};for(const name of ['setOrigin','setFlipY','setDisplaySize','setAlpha','setScale','setPosition'])value[name]=()=>value;return value;};
  return {
    width,height,
    root:{visible:true,bringToTop:()=>{},setPosition:function(){return this;},setScale:function(){return this;},getWorldTransformMatrix:()=>({scaleX:1,scaleY:1,transformPoint:(x:number,y:number)=>({x,y})})},
    buttons:[] as Button[],texts:[] as string[],textNodes:[] as TextNode[],scrolls:[] as FakeScroll[],
    sliders:[] as {label:string;value:number;setValue:(value:number)=>void}[],enabled:()=>true,focusIndex:-1,
    scene:{game:{events:{emit:()=>{}}},scale:{width,height}},focus:()=>{},layout:()=>{},image:stub,
    text(value:string,x:number,y:number,_width:number,size:number){
      this.texts.push(value);
      const node:TextNode={value,x,y,size,origin:[0,0],handlers:new Map()};this.textNodes.push(node);
      const label={setOrigin:(originX:number,originY:number)=>{node.origin=[originX,originY];return label;},
        setPosition:(nextX:number,nextY:number)=>{node.x=nextX;node.y=nextY;return label;},
        setAlign:()=>label,
        setInteractive:()=>label,on:(event:string,handler:()=>void)=>{node.handlers.set(event,handler);return label;}};
      return label;
    },rect:()=>{},
    clear(){this.buttons=[];this.texts=[];this.scrolls=[];this.sliders=[];this.focusIndex=-1;},
    slider(label:string,_x:number,_y:number,_width:number,value:number,onChange:(value:number)=>void){
      const slider={label,value,setValue:(next:number)=>{slider.value=next;onChange(next);}};
      this.sliders.push(slider);return slider;
    },
    button(label:string,x:number,y:number,width:number,height:number,action:()=>void,options:{disabled?:boolean}={}){
      const button=new Button(label,action,options.disabled);
      Object.assign(button,{x,y,width,height});this.buttons.push(button);return button;
    },
    key(event:KeyboardEvent){UiSurface.prototype.key.call(this as unknown as InstanceType<typeof UiSurface>,event);},
    focusables(){return UiSurface.prototype.focusables.call(this as unknown as InstanceType<typeof UiSurface>);},
    scroll(x:number,y:number,width:number,height:number){
      const content={ list:[] as unknown[], add(){}, remove(){}, removeAll(){} };
      const value:FakeScroll={x,y,width,height,extent:0,scrollTop:0,content,setHeight(extent:number){value.extent=extent;},layout(){},destroy(){}};
      this.scrolls.push(value);return value;
    },
  };
}
function fixture(gmMode?:MenuContext['gmMode'],cloud?:CloudSavePort){
  const entries=new Map<string,string>(),events:string[]=[],signals:AbortSignal[]=[];
  const saves=new SaveSlots<StoryWorldViewSnapshot>({getItem:key=>entries.get(key)??null,setItem:(key,value)=>{entries.set(key,value);},removeItem:key=>{entries.delete(key);}});
  const app:MenuContext={saves,gmMode,cloud,ui:{ready:true,suspended:false,setMode:()=>{},loading:()=>{},menuLoaded:()=>{},error:()=>{}},
    enterGame:async()=>{events.push('new');},resumeSlot:async(slot,signal)=>{events.push(`load:${slot}`);if(signal)signals.push(signal);}};
  const view=fakeView(1200,640),modal=fakeView(1024,640);
  // 直接借用 MenuScene.prototype 的假场景不会跑字段初始化；这里补上新加的私有状态，
  // 尤其是 cloudSerial（`++undefined` 会变成 NaN，后续请求代次比较全部失败）。
  const state={app,surface:view,modal,page:'home',cloudSerial:0,cloudBusy:false,cloudAccountInput:'',cloudPassword:'',
    cloudStatus:undefined,cloudCount:undefined,cloudRequest:undefined,confirmAction:undefined,confirmResolve:undefined,
    renameRef:undefined,slotRequest:undefined,slotPortraits:undefined,prompt:undefined,settingsScroll:0,backdrop:undefined,
    sys:{isActive:()=>true},textures:{exists:()=>true}};
  const scene=Object.setPrototypeOf(state,MenuScene.prototype);
  const call=(name:string,...args:unknown[])=>Reflect.get(MenuScene.prototype,name).call(scene,...args);
  const clickIn=(surface:ReturnType<typeof fakeView>,label:string)=>{
    const node=surface.buttons.find(button=>button.getData('label')===label);
    assert.ok(node,label);assert.equal(node.input.enabled,true);(node.getData('action') as ()=>void)();
  };
  const click=(label:string)=>clickIn(view,label);
  const key=(value:string)=>view.key({key:value,preventDefault:()=>{}} as KeyboardEvent);
  call('render');return {app,entries,events,signals,view,modal,call,click,clickModal:(label:string)=>clickIn(modal,label),key,saves};
}
const saved=(savedAt?:number)=>JSON.stringify({format:SAVE_FORMAT,summary:{...(savedAt===undefined?{}:{savedAt}),classId:'dark-knight',className:'黑暗骑士',level:1,mapId:'map',mapName:'营地',portrait:'portrait.png'},session:{},world:{location:{map:'map',x:0,y:0,facing:'south'},generatedEntities:[]}});

test('start opens one auto row plus ten manual slots and an empty slot launches class selection',()=>{
  const f=fixture();f.click('开始游戏');assert.deepEqual(f.events,[]);
  // 空自动槽没有动作，所以只有返回钮、云存档入口与十个手动槽。
  assert.deepEqual(f.view.buttons.map(button=>button.getData('label')),
    ['返回主菜单','云存档',...Array.from({length:10},(_,slot)=>`存档槽 ${slot+1}`)]);
  f.click('存档槽 3');assert.deepEqual(f.events,['new']);
});

test('manual slots list newest first while keeping their slot identities',()=>{
  const f=fixture();
  f.entries.set('inotia4.story.v1.slot0',saved(100));
  f.entries.set('inotia4.story.v1.slot4',saved(400));
  f.entries.set('inotia4.story.v1.slot7',saved(250));
  f.click('开始游戏');
  const rows=f.view.buttons.map(button=>String(button.getData('label')))
    .filter(label=>/^存档槽 \d+$/.test(label));
  assert.deepEqual(rows,['存档槽 5','存档槽 8','存档槽 1','存档槽 2','存档槽 3','存档槽 4','存档槽 6','存档槽 7','存档槽 9','存档槽 10'],
    '有存档的按时间倒序，空槽按槽号排在后面');
  f.click('存档槽 5');assert.deepEqual(f.events,['load:4'],'显示位置变了，操作仍落在原槽');
});

test('mixed slots load existing saves, start empty slots and leave damaged slots unavailable',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());f.entries.set('inotia4.story.v1.slot1','broken JSON');
  f.click('开始游戏');assert(!f.view.buttons.some(button=>button.getData('label')==='存档槽 2'));
  f.click('存档槽 1');f.click('存档槽 3');assert.deepEqual(f.events,['load:0','new']);
  assert.equal(f.signals[0].aborted,false);f.click('返回主菜单');assert.equal(f.signals[0].aborted,true);
});

test('title slots delete a manual save only after the native confirmation',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());f.entries.set('inotia4.story.v1.slot1','broken JSON');
  f.click('开始游戏');
  // 自动槽没有管理动作；坏档只能删，不能改名。
  assert(!f.view.buttons.some(button=>String(button.getData('label')).startsWith('自动存档 ')));
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1 改名'));
  assert(!f.view.buttons.some(button=>button.getData('label')==='存档槽 2 改名'));
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 2 删除'));
  f.click('存档槽 1 删除');
  // 确认之前不动存档，底下的存档页也不接受输入。
  assert.equal(f.entries.has('inotia4.story.v1.slot0'),true);
  assert(f.modal.texts.includes('删除后无法恢复，确定删除这个存档？'));
  assert.equal(f.view.enabled(),false,'确认框打开时存档页不接受输入');
  f.clickModal('否');
  assert.equal(f.entries.has('inotia4.story.v1.slot0'),true);
  assert.equal(f.view.enabled(),true,'取消后恢复输入');
  f.click('存档槽 1 删除');f.clickModal('是');
  assert.equal(f.entries.has('inotia4.story.v1.slot0'),false);
  assert(!f.view.buttons.some(button=>button.getData('label')==='存档槽 1 删除'),'空槽不再给出删除');
});

test('title slots rename a manual save through the system keyboard',async()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot0',saved());
  const initials:string[]=[];
  f.app.promptText=async(initial:string)=>{initials.push(initial);return '第一章';};
  f.click('开始游戏');f.click('存档槽 1 改名');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(initials,[''],'改名以存档现有名字为初值');
  assert(f.view.buttons.some(button=>button.getData('label')==='第一章'),'行标题换成新名字');
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1 删除'),'控件仍用固定的槽位名');
  const reading=f.saves.inspect(0);
  assert.equal(reading.kind==='ok'?reading.game.summary.name:undefined,'第一章');
  assert.equal(f.view.enabled(),true,'改名结束后恢复输入');
});

test('the auto save sits on top of the list and a renamed manual slot shows its name',()=>{
  const f=fixture();
  f.entries.set('inotia4.story.v1.auto',saved());
  f.entries.set('inotia4.story.v1.slot0',saved().replace('"classId":"dark-knight"','"name":"第一章","classId":"dark-knight"'));
  f.click('开始游戏');
  const labels=f.view.buttons.map(button=>button.getData('label'));
  assert.equal(labels[1],'云存档','云存档入口在标题栏');
  assert.equal(labels[2],'自动存档','自动存档固定在存档列表第一位');
  assert.equal(labels[3],'第一章','手动槽显示自定义名字');
  f.click('自动存档');f.click('第一章');
  assert.deepEqual(f.events,['load:auto','load:0']);
});

test('older development saves enter the same empty-slot class flow',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot1',JSON.stringify({format:2}));
  f.click('开始游戏');f.click('存档槽 2');assert.deepEqual(f.events,['new']);
});

test('the previous published save format still opens as a readable slot',()=>{
  const f=fixture();f.entries.set('inotia4.story.v1.slot1',saved().replace('"format":34','"format":33'));
  f.click('开始游戏');f.click('存档槽 2');assert.deepEqual(f.events,['load:1']);
});

test('title settings keeps every row inside a scrolling panel',()=>{
  const f=fixture();f.click('环境设置');
  assert(f.view.texts.includes('背景音乐'));assert(f.view.texts.includes('音效'));
  assert(!f.view.texts.some(text=>text.includes('语言')||text.includes('简体中文')));
  assert.deepEqual(f.view.buttons.map(button=>button.getData('label')),
    ['返回主菜单','暴击光效：开','全屏：不支持']);
  assert.deepEqual(f.view.sliders.map(slider=>slider.label),['music','effects']);
  assert(f.view.sliders.every(slider=>slider.value===1),'音频默认满音量');
  // 选项挂在面板内侧的滚动区：边框不滚，行数再多也只滚动，不会画到边线上。
  const scroll=f.view.scrolls.at(-1);assert.ok(scroll);
  assert.deepEqual([scroll.x,scroll.y,scroll.width,scroll.height],[240,190,720,297]);
  const rows=f.view.buttons.filter(button=>String(button.getData('label')).includes('：'));
  assert.equal(rows.length,2);
  assert(rows.every(row=>row.y>=0&&row.y+row.height<=scroll.extent),'每一行都在滚动内容的高度内');
  assert(scroll.extent>scroll.height,'四行排不进可视区时靠滚动查看');
});

test('title settings toggles critical light effects',t=>{
  displaySettings.setCriticalDecorations(true);
  t.after(()=>displaySettings.setCriticalDecorations(true));
  const f=fixture();f.click('环境设置');
  assert(f.view.buttons.some(button=>button.getData('label')==='暴击光效：开'));
  f.click('暴击光效：开');
  assert(f.view.buttons.some(button=>button.getData('label')==='暴击光效：关'));
  assert.equal(displaySettings.criticalDecorations,false);
});

test('title settings uses volume sliders and leftmost means silence',()=>{
  const f=fixture();
  const audio={settings:{music:1,effects:1},setVolume(channel:'music'|'effects',value:number){this.settings[channel]=value;}};
  Object.defineProperty(f.app,'audio',{value:audio});
  f.click('环境设置');
  const music=f.view.sliders.find(slider=>slider.label==='music')!;
  const effects=f.view.sliders.find(slider=>slider.label==='effects')!;
  music.setValue(0);effects.setValue(.5);
  assert.equal(audio.settings.music,0,'最左边是静音');
  assert.equal(audio.settings.effects,.5);
  assert.equal(music.value,0);
});

test('challenge mode is disabled and is excluded from native keyboard focus',()=>{
  const f=fixture(),challenge=f.view.buttons.find(button=>button.getData('label')==='挑战模式');assert.ok(challenge);assert.equal(challenge.input.enabled,false);
  const focus=UiSurface.prototype.focusables.call(f.view as unknown as InstanceType<typeof UiSurface>);
  assert.deepEqual(focus.map(button=>button.getData('label')),['开始游戏','环境设置']);
  f.key('Tab');f.key('Enter');assert.deepEqual(f.events,[]);assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1'));
});

test('the version number sits bottom-right at menu-button size and toggles GM',()=>{
  const gm={on:false,toggles:0,toggle(){this.on=!this.on;this.toggles+=1;return this.on;}};
  const f=fixture(gm);
  const node=f.view.textNodes.find(text=>text.value==='v0.0.1');assert.ok(node);
  assert.equal(node.size,36,'版本号与主菜单按钮同字号');
  assert.deepEqual(node.origin,[1,1],'以右下角为锚点');
  assert.equal(node.x,1180);assert.equal(node.y,612);
  const notice=f.view.textNodes.find(text=>text.value.includes('同人作品'));assert.ok(notice,'版本号下方有同人作品说明');
  assert.equal(notice.size,14);
  assert.deepEqual(notice.origin,[1,1]);
  assert.equal(notice.x,1180);assert.ok(notice.y>612,'说明在版本号下方');
  assert.equal(gm.toggles,0);

  node.handlers.get('pointerdown')!();
  assert.equal(gm.toggles,1);assert.equal(gm.on,true);
  assert.ok(f.view.texts.includes('调试：开'),'打开后左下角出现状态指示');

  const again=f.view.textNodes.find(text=>text.value==='v0.0.1')!;
  again.handlers.get('pointerdown')!();
  assert.equal(gm.on,false);
  assert.ok(!f.view.texts.includes('调试：开'));
});

test('a rejected title load returns to usable slots after dismissing the loading error',async t=>{
  t.mock.method(console,'error',()=>{});
  const f=fixture();let retry:(()=>void)|undefined;
  f.app.resumeSlot=async()=>{throw new Error('存档内容无效');};
  const ui=f.app.ui as {ready:boolean;menuLoaded:()=>void;error:(message:string,retry:()=>void)=>void};
  ui.error=(message,again)=>{assert.equal(message,'存档内容无效');ui.ready=false;retry=again;};
  ui.menuLoaded=()=>{ui.ready=true;};
  f.entries.set('inotia4.story.v1.slot0',saved());f.click('开始游戏');f.click('存档槽 1');
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(ui.ready,false);assert.ok(retry);
  retry();assert.equal(ui.ready,true);assert.equal(f.view.enabled(),true);
  f.click('存档槽 2');assert.deepEqual(f.events,['new']);
});

const settle=async()=>{for(let index=0;index<12;index+=1)await new Promise(resolve=>setImmediate(resolve));};
const cloudEntry=(slot:SaveSlotRef):CloudSaveEntry=>({
  slot,format:SAVE_FORMAT,bytes:100,updatedAt:1,
  summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'portrait.png',level:1,mapId:'map',mapName:'营地'},
});
interface CloudStubOptions {
  loggedIn?:boolean;
  account?:string;
  expiresAt?:number;
  absoluteExpiresAt?:number;
  entries?:CloudSaveEntry[];
  login?:CloudSavePort['login'];
  changePassword?:CloudSavePort['changePassword'];
  refresh?:CloudSavePort['refresh'];
  list?:CloudSavePort['list'];
  upload?:CloudSavePort['upload'];
  download?:CloudSavePort['download'];
}
interface CloudHarness {port:CloudSavePort;calls:string[];uploads:{slot:SaveSlotRef;game:unknown}[];downloads:SaveSlotRef[]}
function cloudStub(options:CloudStubOptions={}):CloudHarness {
  const state={
    loggedIn:options.loggedIn??false,
    account:options.account??(options.loggedIn?'hero':undefined),
    expiresAt:options.expiresAt,
    absoluteExpiresAt:options.absoluteExpiresAt,
  };
  let entries=options.entries??[];
  const calls:string[]=[],uploads:{slot:SaveSlotRef;game:unknown}[]=[],downloads:SaveSlotRef[]=[];
  const port:CloudSavePort={
    get loggedIn(){return state.loggedIn;},
    get account(){return state.account;},
    get expiresAt(){return state.expiresAt;},
    get absoluteExpiresAt(){return state.absoluteExpiresAt;},
    login:async(account,password)=>{
      calls.push('login');
      if(options.login)return options.login(account,password);
      state.loggedIn=true;state.account=account;
      const session:CloudSession={account,token:`token-${account}`,expiresAt:1};
      return {ok:true,value:session};
    },
    register:async(account)=>{
      calls.push('register');
      state.loggedIn=true;state.account=account;
      const session:CloudSession={account,token:`token-${account}`,expiresAt:1};
      return {ok:true,value:session};
    },
    changePassword:async(currentPassword,newPassword)=>{
      calls.push('change-password');
      if(options.changePassword)return options.changePassword(currentPassword,newPassword);
      state.loggedIn=true;
      const session:CloudSession={account:state.account??'hero',token:'new-token',expiresAt:2};
      return {ok:true,value:session};
    },
    refresh:async()=>{
      calls.push('refresh');
      if(options.refresh)return options.refresh();
      const expiresAt=Date.now()+30*24*60*60*1000;
      const absoluteExpiresAt=Date.now()+90*24*60*60*1000;
      state.expiresAt=expiresAt;state.absoluteExpiresAt=absoluteExpiresAt;
      const session:CloudSession={account:state.account??'hero',token:'renewed-token',expiresAt,absoluteExpiresAt};
      return {ok:true,value:session};
    },
    logout:async()=>{calls.push('logout');state.loggedIn=false;state.account=undefined;return {ok:true,value:undefined};},
    list:async()=>{calls.push('list');if(options.list)return options.list();return {ok:true,value:entries};},
    upload:async(slot,game)=>{
      calls.push(`upload:${slot}`);uploads.push({slot,game});
      if(options.upload)return options.upload(slot,game);
      return {ok:true,value:cloudEntry(slot)};
    },
    download:async(slot)=>{
      calls.push(`download:${slot}`);downloads.push(slot);
      if(options.download)return options.download(slot);
      return {ok:true,value:JSON.parse(saved())};
    },
    forget(){state.loggedIn=false;state.account=undefined;},
  };
  return {port,calls,uploads,downloads};
}

test('the cloud entry sits on the slots page and a logged-out page sends no cloud request',async()=>{
  const cloud=cloudStub();
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');
  assert(f.view.buttons.some(button=>button.getData('label')==='云存档'));
  assert.deepEqual(cloud.calls,[],'打开存档页不触发云请求');
  f.click('云存档');await settle();
  assert.deepEqual(cloud.calls,[],'未登录时进入云页也不请求服务器');
  assert(f.view.buttons.some(button=>button.getData('label')==='登录'));
  assert(f.view.buttons.some(button=>button.getData('label')==='返回存档'));
});

test('cloud login switches to the signed-in actions',async()=>{
  const cloud=cloudStub();
  const f=fixture(undefined,cloud.port);
  f.app.promptText=async(_initial,purpose)=>{
    if(purpose==='account')return 'hero';
    if(purpose==='password')return 'secret1';
    return '第一章';
  };
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('输入账号');await settle();
  f.click('输入密码');await settle();
  f.click('登录');await settle();
  assert.deepEqual(cloud.calls,['login','list']);
  assert(f.view.texts.some(text=>text.includes('已登录：hero')));
  assert(f.view.buttons.some(button=>button.getData('label')==='导入本机存档'));
  assert(f.view.buttons.some(button=>button.getData('label')==='下载云存档'));
  assert(f.view.buttons.some(button=>button.getData('label')==='退出登录'));
});

test('a locked cloud login shows the lock message without entering the signed-in page',async()=>{
  const cloud=cloudStub({login:async()=>({
    ok:false,
    error:{code:'locked',message:'密码连续输错 3 次，账号已锁定，请 15 分钟后再试。',retryAfterSeconds:900},
  })});
  const f=fixture(undefined,cloud.port);
  f.app.promptText=async(_initial,purpose)=>purpose==='account'?'hero':purpose==='password'?'secret1':'';
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('输入账号');await settle();f.click('输入密码');await settle();f.click('登录');await settle();
  assert(f.view.texts.some(text=>text.includes('15 分钟')));
  assert(f.view.buttons.some(button=>button.getData('label')==='登录'));
});

test('an unreachable cloud page does not block local saves',async()=>{
  const cloud=cloudStub({loggedIn:true,list:async()=>({
    ok:false,error:{code:'network',message:'无法连接云存档服务，请检查网络。'},
  })});
  const f=fixture(undefined,cloud.port);
  f.entries.set('inotia4.story.v1.slot0',saved());
  f.click('开始游戏');f.click('云存档');await settle();
  assert(f.view.texts.some(text=>text.includes('无法连接云存档服务')));
  f.click('返回存档');
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1'));
  f.click('存档槽 1');
  assert.deepEqual(f.events,['load:0'],'本机读档不受云服务影响');
});

test('cloud backup uploads valid local slots and skips damaged ones',async()=>{
  const cloud=cloudStub({loggedIn:true});
  const f=fixture(undefined,cloud.port);
  f.entries.set('inotia4.story.v1.slot0',saved());
  f.entries.set('inotia4.story.v1.slot1','{broken');
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('导入本机存档');await settle();
  assert.deepEqual(cloud.uploads.map(item=>item.slot),[0]);
  assert(f.view.texts.some(text=>text.includes('导入成功 1 个')));
  assert(f.view.texts.some(text=>text.includes('存档槽 2')));
});

test('cloud download writes local slots and returns to the save list',async()=>{
  const cloud=cloudStub({loggedIn:true,entries:[cloudEntry(0)]});
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('下载云存档');await settle();
  assert.deepEqual(cloud.downloads,[0]);
  assert.equal(f.saves.inspect(0).kind,'ok');
  assert(f.view.buttons.some(button=>button.getData('label')==='存档槽 1'));
});

test('cloud backup asks before overwriting and does not upload when cancelled',async()=>{
  const cloud=cloudStub({loggedIn:true,entries:[cloudEntry(0)]});
  const f=fixture(undefined,cloud.port);
  f.entries.set('inotia4.story.v1.slot0',saved());
  f.click('开始游戏');f.click('云存档');await settle();
  f.click('导入本机存档');await settle();
  assert(f.modal.texts.some(text=>text.includes('覆盖')));
  assert.equal(cloud.uploads.length,0,'确认前不上传');
  f.clickModal('是');await settle();
  assert.deepEqual(cloud.uploads.map(item=>item.slot),[0]);
});

test('cloud password change uses the password form hook and keeps the player signed in',async()=>{
  const cloud=cloudStub({loggedIn:true});
  const f=fixture(undefined,cloud.port);
  let asked=0;
  f.app.promptPasswordChange=async()=>{asked+=1;return {currentPassword:'secret1',newPassword:'secret2'};};
  f.click('开始游戏');f.click('云存档');await settle();
  assert(f.view.buttons.some(button=>button.getData('label')==='修改密码'));
  f.click('修改密码');await settle();
  assert.equal(asked,1);
  assert.ok(cloud.calls.includes('change-password'));
  assert(f.view.texts.some(text=>text.includes('密码已修改')));
  assert(f.view.buttons.some(button=>button.getData('label')==='导入本机存档'));
});

test('a near-expiry cloud session renews before listing',async()=>{
  const now=Date.now();
  const cloud=cloudStub({
    loggedIn:true,
    expiresAt:now+24*60*60*1000,
    absoluteExpiresAt:now+60*24*60*60*1000,
  });
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  assert.ok(cloud.calls.includes('refresh'));
  assert.ok(cloud.calls.indexOf('refresh')<cloud.calls.indexOf('list'));
});

test('a session far from expiry lists without renewal',async()=>{
  const now=Date.now();
  const cloud=cloudStub({
    loggedIn:true,
    expiresAt:now+30*24*60*60*1000,
    absoluteExpiresAt:now+90*24*60*60*1000,
  });
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  assert.ok(!cloud.calls.includes('refresh'));
  assert.ok(cloud.calls.includes('list'));
});

test('a network error during renewal still lets the list run',async()=>{
  const now=Date.now();
  const cloud=cloudStub({
    loggedIn:true,
    expiresAt:now+24*60*60*1000,
    absoluteExpiresAt:now+60*24*60*60*1000,
    refresh:async()=>({ok:false,error:{code:'network',message:'无法连接云存档服务，请检查网络。'}}),
  });
  const f=fixture(undefined,cloud.port);
  f.click('开始游戏');f.click('云存档');await settle();
  assert.ok(cloud.calls.includes('refresh'));
  assert.ok(cloud.calls.includes('list'));
  assert(f.view.buttons.some(button=>button.getData('label')==='导入本机存档'));
});
