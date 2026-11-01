import { SCENE_KEYS } from '../application/scene-keys.ts';
import { displaySettings } from '../application/display-settings.ts';
import { fullscreenActive, fullscreenStatus, onFullscreenChange, setFullscreen } from '../application/fullscreen.ts';
import Phaser from 'phaser';
import type { MenuContext } from '../application/ports.ts';
import { TITLE_MESSAGE_ASSETS, titleMenuImages } from '../application/menu-images.ts';
import { UiSurface, loadUiImages, uiTexture } from '../ui/phaser/widgets.ts';
import { SAVE_BOARD, SAVE_BOARD_LAYOUT, drawSaveBoardRow, newestFirstSlots, saveBoardOrigin, saveRowTitle, type SaveBoardControl } from '../ui/phaser/save-board.ts';
import { drawNativeMessage } from '../ui/phaser/native-message.ts';
import { centerModal } from '../ui/phaser/modal-placement.ts';
import { TextPrompt } from '../ui/text-prompt.ts';
import { PasswordChangePrompt } from '../ui/password-change-prompt.ts';
import { CloudCredentialsInput, type CredentialInputRect } from '../ui/cloud-credentials-input.ts';
import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, saveSlotLabel, type SaveSlotRef, type SlotSummaryReading } from '../domain/save-game.ts';
import type { AssetLease } from '../application/assets.ts';
import { CLOUD_PAGE, type CloudPageActions, type CloudPageState, type CloudPageStatus } from '../ui/cloud-save-layout.ts';
import { drawCloudSavePage } from '../ui/phaser/cloud-save-panel.ts';
import {
  CLOUD_NEW_PASSWORD_SAME_MESSAGE,
  CLOUD_PASSWORD_CHANGED_MESSAGE,
  CLOUD_SESSION_RENEW_WINDOW_MS,
  cloudSlotLabel,
  normalizeCloudAccount,
  validateCloudAccount,
  validateCloudPassword,
} from '../domain/cloud-save.ts';
import { backupLocalSaves, restoreCloudSaves, type CloudSyncResult } from '../application/cloud-save-sync.ts';
import type { CloudSavePort } from '../application/cloud-save.ts';

const art=(name:string)=>`/assets/ui/title-menu/${name}.png`;
/** 标题页右下角展示的版本号；等用户要求时再改。 */
const GAME_VERSION='v0.0.1';
/** 版本号下方一行；说明作品性质，并提醒支持官方版本。 */
const FAN_WORK_NOTICE='同人作品 · 仅供个人学习研究 · 请支持官方正版';
const CLOSE_IMAGE='/assets/ui/menus/close.png';
const CLOSE_PRESSED='/assets/ui/menus/close-pressed.png';

interface ConfirmRequest {
  message:string;
  accept:()=>void;
  cancel:()=>void;
}

export class MenuScene extends Phaser.Scene {
  readonly app:MenuContext;
  private surface?:UiSurface;
  /** 确认框画在它上面；底下的页面在确认期间不接受输入。 */
  private modal?:UiSurface;
  private backdrop?:Phaser.GameObjects.Image;
  private page:'home'|'slots'|'settings'|'cloud'='home';
  /** 存档槽立绘的租约：每次进存档页按槽里的路径取，离开页面或关场景时释放。 */
  private slotPortraits?:AssetLease;
  private slotRequest?:AbortController;
  /** 改名输入与通用确认：标题页的存档管理与云存档覆盖确认共用。 */
  private renameRef?:SaveSlotRef;
  private prompt?:TextPrompt;
  private passwordPrompt?:PasswordChangePrompt;
  /** 云存档登录的账号/密码输入框：直接盖在面板行上，不是独立弹层。 */
  private credentials?:CloudCredentialsInput;
  private confirmAction?:ConfirmRequest;
  private confirmResolve?:(value:boolean)=>void;
  /** 云存档请求：离开云页、回主页或场景关闭时 abort；代次防止旧结果覆盖新页面。 */
  private cloudRequest?:AbortController;
  private cloudSerial=0;
  private cloudBusy=false;
  private cloudAccountInput='';
  private cloudPassword='';
  private cloudStatus?:CloudPageStatus;
  private cloudCount?:number;
  /** 环境设置列表的滚动位置：开关后整页重画，位置要接着上次的来。 */
  private settingsScroll=0;
  private readonly renderCloudOnResume=():void=>{
    if(this.page==='cloud'&&this.surface&&this.sys.isActive())this.render();
  };
  private readonly hideCredentials=():void=>{this.credentials?.hide();};
  constructor(app:MenuContext){super(SCENE_KEYS.menu);this.app=app;}
  create(options:{page?:'home'|'slots'}={}):void {
    this.page='home';this.app.ui.setMode('menu');this.app.ui.loading('正在准备主菜单…');
    const controller=new AbortController();
    this.events.once('shutdown',()=>{controller.abort();this.cancelCloudRequest();this.settleConfirm(false,false);this.slotRequest?.abort();this.prompt?.close();this.passwordPrompt?.close();this.credentials?.destroy();this.credentials=undefined;this.surface?.destroy();this.surface=undefined;this.modal?.destroy();this.modal=undefined;this.slotPortraits?.release();this.slotPortraits=undefined;this.events.off(Phaser.Scenes.Events.RESUME,this.renderCloudOnResume);this.events.off(Phaser.Scenes.Events.PAUSE,this.hideCredentials);this.scale.off('resize',this.layout,this);});
    this.input.keyboard?.on('keydown',(event:KeyboardEvent)=>{
      if(this.app.ui.suspended)return;
      // 键盘事件来自 DOM 输入框时归输入框；即使输入框刚失焦，也不能让同一次回车/退出触发菜单按钮。
      const target=event.target as HTMLElement|null;
      if(target&&(target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.isContentEditable))return;
      // 改名、修改密码表单或云存档账号/密码框有焦点时键盘归输入框，场景不再处理按键。
      if(this.renameRef!==undefined||this.prompt?.active||this.passwordPrompt?.active||this.credentials?.focused)return;
      // 确认框打开时 Escape 只关确认框，不退出页面。
      if(event.key==='Escape'&&this.confirmAction!==undefined){event.preventDefault();this.confirmAction.cancel();return;}
      if(event.key==='Escape'&&this.page!=='home'){event.preventDefault();this.back();return;}
      this.surface?.key(event);
    });
    this.events.on(Phaser.Scenes.Events.RESUME,this.renderCloudOnResume);
    this.events.on(Phaser.Scenes.Events.PAUSE,this.hideCredentials);
    this.scale.on('resize',this.layout,this);
    // 浏览器自身的退出（Esc、手势）不会走设置页的按钮，靠事件把开关状态同步回来。
    this.events.once('shutdown',onFullscreenChange(()=>{
      if(this.page==='settings'&&this.surface&&this.sys.isActive())this.render();
    }));
    void loadUiImages(this,titleMenuImages).then(lease=>{
      if(controller.signal.aborted){lease.release();return;}
      this.events.once('shutdown',()=>lease.release());
      this.backdrop=this.add.image(0,0,uiTexture(art('background'))).setOrigin(.5);
      this.surface=new UiSurface(this,1200,640);this.modal=new UiSurface(this,1024,640,200);this.prompt=new TextPrompt();this.passwordPrompt=new PasswordChangePrompt();
      this.credentials=new CloudCredentialsInput({
        onAccount:value=>{this.cloudAccountInput=value;},
        onPassword:value=>{this.cloudPassword=value;},
      });
      // 确认框打开时页面整块不响应，确认框自己也只在有确认时响应。
      this.modal.enabled=()=>this.app.ui.ready&&!this.app.ui.suspended&&this.sys.isActive()&&this.confirmAction!==undefined;
      this.app.ui.menuLoaded();if(options.page==='slots')this.openSlots();else this.render();this.app.syncLifecycle?.();
    },error=>{if(!controller.signal.aborted)this.app.ui.error(String(error),()=>this.scene.restart());});
  }
  /**
   * 右下角版本号；点击它切换 GM 调试模式。
   *
   * 版本号用主菜单按钮的 36 号字，直接作为点击目标，不另铺热点——它本身就很小，
   * 不需要连点防误触。打开时左下角常驻一行「调试：开」——它是状态指示，不是操作结果提示。
   * 开关关闭时这一行不存在。
   */
  private addVersion(view:UiSurface):void {
    const label=view.text(GAME_VERSION,1180,612,0,36).setOrigin(1,1);
    view.text(FAN_WORK_NOTICE,1180,632,0,14,'#b8ab92').setOrigin(1,1);
    const gm=this.app.gmMode;if(!gm)return;
    label.setInteractive({useHandCursor:true});
    label.on('pointerdown',()=>{
      if(!this.app.ui.ready||this.app.ui.suspended||!this.sys.isActive())return;
      // 开关状态先同步画出来；目录是可选依赖，没有它也不能让「调试：开」一直不出现。
      if(gm.toggle()){this.render();void this.app.loadDebugCatalog?.().then(()=>this.render(),error=>console.error(error));}
      else this.render();
    });
    if(gm.on)view.text('调试：开',8,610,0,18);
  }
  private render():void {
    // 异步目录加载和指针回调可能在场景关闭后才回来；surface 此时已经销毁。
    if(!this.surface||!this.sys.isActive())return;
    const view=this.surface;view.clear();this.modal?.clear();
    const guard=()=>this.app.ui.ready&&!this.app.ui.suspended&&this.sys.isActive()&&this.confirmAction===undefined&&this.renameRef===undefined;
    view.enabled=guard;
    const button=(label:string,x:number,y:number,w:number,h:number,action:()=>void,fontSize=36,parent?:Phaser.GameObjects.Container)=>view.button(label,x,y,w,h,action,{fontSize,guard,parent});
    if(this.page==='home'){
      view.image(art('logo'),291,52,617,353);view.image(art('subtitle-left'),305,385,undefined,122);view.image(art('subtitle-right'),601,385,undefined,122);
      button('开始游戏',416,457,369,124,()=>this.openSlots());
      button('环境设置',65,472,300,92,()=>{this.page='settings';this.render();});
      view.button('挑战模式',835,472,300,92,()=>{},{fontSize:36,disabled:true});
      this.addVersion(view);
    }else if(this.page==='cloud'){
      drawCloudSavePage(view,this.cloudState(),this.cloudActions(),{frame:art('slot'),close:CLOSE_IMAGE,closePressed:CLOSE_PRESSED});
    }else{
      view.button('',28,21,67,67,()=>this.showHome(),{image:CLOSE_IMAGE,pressed:CLOSE_PRESSED,guard}).setData('label','返回主菜单');
      if(this.page==='slots'){
        view.text('存档槽',600,20,760,49).setOrigin(.5,0);
        view.button('云存档',CLOUD_PAGE.entry.x,CLOUD_PAGE.entry.y,CLOUD_PAGE.entry.width,CLOUD_PAGE.entry.height,()=>this.openCloud(),{fontSize:26,guard});
        const assets={frame:art('slot'),empty:art('slot-empty')};
        const origin=saveBoardOrigin(view.width);
        // 自动存档固定一行置顶；它没有改名与删除。
        const auto=this.app.saves.peek(AUTO_SAVE_SLOT),autoTitle=saveRowTitle(AUTO_SAVE_SLOT,auto);
        drawSaveBoardRow(view,assets,origin,SAVE_BOARD_LAYOUT.autoTop,
          {reading:auto,action:auto.kind==='ok'?()=>this.resume(AUTO_SAVE_SLOT):undefined,label:autoTitle,title:autoTitle,auto:true});
        // 十个手动槽放进滚动区；按写入时间倒序，最新的排最前，空槽排在后面。
        const scroll=view.scroll(origin.x,SAVE_BOARD_LAYOUT.listTop,SAVE_BOARD.panelWidth,SAVE_BOARD_LAYOUT.listHeight);
        newestFirstSlots(slot=>this.app.saves.peek(slot)).forEach((slot,index)=>{
          const ref=slot,reading=this.app.saves.peek(ref),title=saveRowTitle(ref,reading);
          drawSaveBoardRow(view,assets,{x:0,y:0},index*SAVE_BOARD.rowStep,{
            reading,label:title,title,
            action:reading.kind==='ok'?()=>this.resume(ref):reading.kind==='empty'?()=>{void this.app.enterGame?.(slot);}:undefined,
            ...this.slotControls(ref,reading),
          },scroll.content);
        });
        scroll.setHeight((MANUAL_SAVE_SLOT_COUNT-1)*SAVE_BOARD.rowStep+SAVE_BOARD.frameHeight);
      }else{
        view.text('环境设置',600,20,760,49).setOrigin(.5,0);
        // 边框固定在原版位置；选项排进金色边线内侧的滚动区，行数增加时只滚动，不会压到边线。
        // 边线在 slot.png 原图里内缩约 18×20 像素，按显示尺寸换算后水平约 28、垂直约 47。
        const panel={x:200,y:126,width:800,height:425};
        view.image(art('slot'),panel.x,panel.y,panel.width,panel.height);
        const list=view.scroll(panel.x+40,panel.y+64,panel.width-80,panel.height-128),content=list.content;
        // 音频用滑动条实时改音量，其余项仍是开关；整页重画，滚动位置由 settingsScroll 接续。
        let rowTop=20;
        for(const [channel,label]of ([['music','背景音乐'],['effects','音效']]as const)){
          view.text(label,38,rowTop+12,0,34,undefined,content);
          // 轨道伸到面板右侧，百分比留在轨道右端。
          view.slider(channel,270,rowTop+33,380,this.app.audio?.settings[channel]??1,
            value=>this.app.audio?.setVolume(channel,value),content);
          rowTop+=100;
        }
        const rows:{label:string;value:string;action:()=>void;disabled?:boolean}[]=[];
        const decorations=displaySettings.criticalDecorations;
        rows.push({label:'暴击光效',value:decorations?'开':'关',
          action:()=>{displaySettings.setCriticalDecorations(!decorations);this.render();}});
        // 全屏是浏览器能力；不支持的环境显示为不可用，APK 壳已经隐藏系统栏，显示为已全屏。
        const fullscreen=fullscreenStatus();
        if(fullscreen==='available'){
          const active=fullscreenActive();
          rows.push({label:'全屏',value:active?'开':'关',action:()=>setFullscreen(!active)});
        }else{
          rows.push({label:'全屏',value:fullscreen==='packaged'?'已全屏':'不支持',action:()=>{},disabled:true});
        }
        rows.forEach((row,index)=>{
          const top=rowTop+index*100;
          view.text(row.label,38,top+12,0,34,undefined,content);
          button(row.value,270,top,190,67,row.action,row.value.length>2?30:34,content)
            .setData('label',`${row.label}：${row.value}`);
        });
        list.setHeight(20+(2+rows.length-1)*100+67+20);
        list.onScroll=()=>{this.settingsScroll=list.scrollTop;};
        list.scrollTop=this.settingsScroll;
      }
    }
    if(this.confirmAction){
      const action=this.confirmAction,modal=this.modal!;
      // 先按父画布的缩放放好弹层，横带才能按实际可见范围铺满屏幕。
      centerModal(modal,view,1024,640);
      drawNativeMessage(modal,TITLE_MESSAGE_ASSETS,action.message,()=>action.accept(),()=>action.cancel());
    }
    this.layout();
  }
  private cloudState():CloudPageState {
    return {
      available:!!this.app.cloud,
      account:this.cloudAccountInput,
      loggedIn:!!this.app.cloud?.loggedIn,
      busy:this.cloudBusy,
      cloudCount:this.cloudCount,
      status:this.cloudStatus,
    };
  }
  private cloudActions():CloudPageActions {
    return {
      back:()=>this.openSlots(),
      login:()=>{void this.submitCloud('login');},
      register:()=>{void this.submitCloud('register');},
      upload:()=>{void this.backupCloud();},
      download:()=>{void this.restoreCloud();},
      changePassword:()=>this.changeCloudPassword(),
      logout:()=>{void this.logoutCloud();},
    };
  }
  /** 手动槽的行内控件：有效存档可改名与删除，坏档只能删；自动槽永远没有。 */
  private slotControls(ref:SaveSlotRef,reading:SlotSummaryReading):{controls?:SaveBoardControl[]}{
    if(ref===AUTO_SAVE_SLOT)return {};
    // 控件用固定的槽位名（改名后仍叫「存档槽 N 删除」），行本身的标题才用自定义名字。
    const slotLabel=saveSlotLabel(ref);
    if(reading.kind==='ok')return {controls:[
      {text:'改名',label:`${slotLabel} 改名`,action:()=>this.renameSlot(ref)},
      {text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)},
    ]};
    if(reading.kind==='unreadable')return {controls:[{text:'删除',label:`${slotLabel} 删除`,action:()=>this.requestDelete(ref)}]};
    return {};
  }
  private requestDelete(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT||this.app.saves.peek(ref).kind==='empty')return;
    this.confirmAction={
      message:'删除后无法恢复，确定删除这个存档？',
      accept:()=>this.deleteSlot(ref),
      cancel:()=>this.settleConfirm(false),
    };
    this.render();
  }
  private deleteSlot(ref:SaveSlotRef):void{
    try{this.app.saves.erase(ref);this.app.audio?.ui('select');}
    catch(error){console.warn('删除存档失败',error);}
    this.settleConfirm(true);
  }
  /** 改名：手机系统键盘输入，只收中文、英文、数字；确认后只改摘要里的名字。 */
  private renameSlot(ref:SaveSlotRef):void{
    if(ref===AUTO_SAVE_SLOT)return;
    const reading=this.app.saves.peek(ref);
    if(reading.kind!=='ok')return;
    const apply=(value:string|undefined):void=>{
      if(value!==undefined){
        try{this.app.saves.rename(ref,value);}
        catch(error){console.warn('存档改名失败',error);}
      }
      this.renameRef=undefined;this.render();
    };
    // 测试没有 DOM 输入框，直接注入一个返回值。
    if(this.app.promptText){void this.app.promptText(reading.summary.name??'').then(apply,()=>{});return;}
    this.renameRef=ref;this.render();
    this.prompt?.show({title:'存档名称',initial:reading.summary.name??'',
      onConfirm:value=>apply(value),onCancel:()=>apply(undefined)});
  }
  private settleConfirm(value:boolean,render=true):void{
    const resolve=this.confirmResolve;
    this.confirmResolve=undefined;
    this.confirmAction=undefined;
    if(render&&this.surface&&this.sys.isActive())this.render();
    resolve?.(value);
  }
  /** 云存档覆盖确认：返回 Promise，取消、Escape、离开云页或场景关闭时都会落地为 false。 */
  private confirmCloud(message:string):Promise<boolean>{
    if(this.confirmResolve){const previous=this.confirmResolve;this.confirmResolve=undefined;previous(false);}
    return new Promise<boolean>(resolve=>{
      this.confirmResolve=resolve;
      this.confirmAction={
        message,
        accept:()=>this.settleConfirm(true),
        cancel:()=>this.settleConfirm(false),
      };
      this.render();
    });
  }
  private cancelCloudRequest():void{
    this.cloudRequest?.abort();
    this.cloudRequest=undefined;
    this.cloudSerial+=1;
    this.cloudBusy=false;
    this.cloudPassword='';
    this.cloudStatus=undefined;
  }
  private openCloud():void{
    this.closeDialogs();
    this.slotRequest?.abort();
    this.slotPortraits?.release();this.slotPortraits=undefined;
    this.cancelCloudRequest();
    const request=new AbortController();this.cloudRequest=request;
    const serial=++this.cloudSerial;
    this.page='cloud';
    this.cloudCount=undefined;
    this.render();
    const cloud=this.app.cloud;
    if(!cloud){
      this.cloudStatus={kind:'error',text:'云存档暂不可用，本机存档不受影响。'};
      this.render();
      return;
    }
    if(cloud.account)this.cloudAccountInput=cloud.account;
    if(!cloud.loggedIn){this.render();return;}
    void this.refreshCloud(request,serial);
  }
  private async refreshCloud(request:AbortController,serial:number):Promise<void>{
    const cloud=this.app.cloud;if(!cloud)return;
    const account=cloud.account;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在检查登录…'};
    this.render();
    if(!await this.renewCloudIfNeeded(cloud,request,serial)){
      if(request.signal.aborted||serial!==this.cloudSerial)return;
      this.cloudBusy=false;
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudStatus={kind:'info',text:'正在读取云端存档…'};
    this.render();
    const result=await cloud.list(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    if(result.ok){
      this.cloudCount=result.value.length;
      this.cloudStatus=undefined;
    }else{
      if(result.error.code==='unauthorized'){
        if(account)this.cloudAccountInput=account;
        this.cloudCount=undefined;
        cloud.forget();
      }
      this.cloudStatus={kind:'error',text:result.error.message};
    }
    if(this.page==='cloud'&&this.sys.isActive())this.render();
  }
  /**
   * 打开云页时懒续期：只在 token 剩余不足 7 天时换发新 token。
   * 不在游戏内定时、不后台轮询；网络失败保留旧 token，让后续请求给出具体错误。
   */
  private async renewCloudIfNeeded(cloud:CloudSavePort,request:AbortController,serial:number):Promise<boolean>{
    const expiresAt=cloud.expiresAt;
    if(expiresAt===undefined)return true;
    const nowMs=Date.now();
    if(expiresAt-nowMs>CLOUD_SESSION_RENEW_WINDOW_MS)return true;
    const absoluteExpiresAt=cloud.absoluteExpiresAt;
    if(absoluteExpiresAt!==undefined&&absoluteExpiresAt<=expiresAt)return true;
    this.cloudStatus={kind:'info',text:'登录即将过期，正在续期…'};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    const result=await cloud.refresh(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return false;
    if(result.ok)return true;
    if(result.error.code==='unauthorized'){
      this.cloudAccountInput=cloud.account??this.cloudAccountInput;
      this.cloudCount=undefined;
      cloud.forget();
      this.cloudStatus={kind:'error',text:'登录已到期，请重新登录。'};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return false;
    }
    return true;
  }
  private changeCloudPassword():void{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    if(this.app.promptPasswordChange){
      void this.app.promptPasswordChange().then(values=>{
        if(values)void this.submitPasswordChange(values.currentPassword,values.newPassword);
      },()=>{});
      return;
    }
    this.passwordPrompt?.show({
      onConfirm:(currentPassword,newPassword)=>{void this.submitPasswordChange(currentPassword,newPassword);},
      onCancel:()=>{},
    });
  }
  private async submitPasswordChange(currentPassword:string,newPassword:string):Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    if(!currentPassword){this.cloudStatus={kind:'error',text:'请输入当前密码。'};this.render();return;}
    const problem=validateCloudPassword(newPassword);
    if(problem){this.cloudStatus={kind:'error',text:problem};this.render();return;}
    if(newPassword===currentPassword){
      this.cloudStatus={kind:'error',text:CLOUD_NEW_PASSWORD_SAME_MESSAGE};
      this.render();
      return;
    }
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在修改密码…'};
    this.render();
    const result=await cloud.changePassword(currentPassword,newPassword,request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    if(!result.ok){
      if(result.error.code==='unauthorized')this.cloudAccountInput=cloud.account??this.cloudAccountInput;
      this.cloudStatus={kind:'error',text:result.error.message};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    this.cloudAccountInput=result.value.account;
    this.cloudStatus={kind:'success',text:CLOUD_PASSWORD_CHANGED_MESSAGE};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
  }
  private async submitCloud(mode:'login'|'register'):Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    this.credentials?.blur();
    const account=normalizeCloudAccount(this.cloudAccountInput);
    const problem=validateCloudAccount(account)??validateCloudPassword(this.cloudPassword);
    if(problem){
      this.cloudStatus={kind:'error',text:problem};
      this.render();
      return;
    }
    this.cloudAccountInput=account;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:mode==='login'?'正在登录…':'正在注册…'};
    this.render();
    const result=mode==='login'
      ? await cloud.login(account,this.cloudPassword,request.signal)
      : await cloud.register(account,this.cloudPassword,request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    if(!result.ok){
      this.cloudStatus={kind:'error',text:result.error.message};
      if(result.error.code==='unauthorized')this.cloudAccountInput=account;
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    this.cloudPassword='';
    this.cloudAccountInput=result.value.account;
    this.cloudStatus={kind:'success',text:mode==='login'?'登录成功。':'注册成功，已登录。'};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    await this.refreshCloud(request,serial);
    if(serial===this.cloudSerial&&this.page==='cloud'&&this.sys.isActive()&&this.cloudStatus===undefined&&this.app.cloud?.loggedIn){
      this.cloudStatus={kind:'success',text:mode==='login'?'登录成功，云端存档已读取。':'注册成功，已登录。'};
      this.render();
    }
  }
  private async logoutCloud():Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    const account=cloud.account;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在退出登录…'};
    this.render();
    await cloud.logout(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    this.cloudPassword='';
    this.cloudCount=undefined;
    if(account)this.cloudAccountInput=account;
    this.cloudStatus={kind:'info',text:'已退出登录。'};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
  }
  private async backupCloud():Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在读取本机存档…'};
    this.render();
    let result:CloudSyncResult;
    try{
      result=await backupLocalSaves({
        cloud,
        saves:this.app.saves,
        confirm:message=>this.confirmCloud(message),
        progress:message=>{
          if(serial!==this.cloudSerial)return;
          this.cloudStatus={kind:'info',text:message};
          if(this.page==='cloud'&&this.sys.isActive())this.render();
        },
        signal:request.signal,
      });
    }catch(error){
      if(request.signal.aborted||serial!==this.cloudSerial)return;
      this.cloudBusy=false;
      this.cloudStatus={kind:'error',text:error instanceof Error?error.message:'云存档操作失败。'};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    this.cloudStatus={kind:this.syncStatusKind(result),text:this.syncMessage(result,'导入')};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    if(result.ok||result.completed>0)void this.refreshCloudCount(request,serial);
  }
  private async restoreCloud():Promise<void>{
    const cloud=this.app.cloud;
    if(!cloud||this.cloudBusy)return;
    const request=this.cloudRequest??(this.cloudRequest=new AbortController());
    const serial=++this.cloudSerial;
    this.cloudBusy=true;
    this.cloudStatus={kind:'info',text:'正在读取云端存档…'};
    this.render();
    let result:CloudSyncResult;
    try{
      result=await restoreCloudSaves({
        cloud,
        saves:this.app.saves,
        confirm:message=>this.confirmCloud(message),
        progress:message=>{
          if(serial!==this.cloudSerial)return;
          this.cloudStatus={kind:'info',text:message};
          if(this.page==='cloud'&&this.sys.isActive())this.render();
        },
        signal:request.signal,
      });
    }catch(error){
      if(request.signal.aborted||serial!==this.cloudSerial)return;
      this.cloudBusy=false;
      this.cloudStatus={kind:'error',text:error instanceof Error?error.message:'云存档操作失败。'};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
      return;
    }
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    this.cloudBusy=false;
    this.cloudStatus={kind:this.syncStatusKind(result),text:this.syncMessage(result,'恢复')};
    if(this.page==='cloud'&&this.sys.isActive())this.render();
    // 场景暂停期间完成时先留在云页；resume 会重绘，避免切到存档页却没有画出来。
    if(result.ok&&result.completed>0&&this.sys.isActive())this.openSlots();
  }
  private async refreshCloudCount(request:AbortController,serial:number):Promise<void>{
    const cloud=this.app.cloud;if(!cloud)return;
    const result=await cloud.list(request.signal);
    if(request.signal.aborted||serial!==this.cloudSerial)return;
    if(result.ok){this.cloudCount=result.value.length;if(this.page==='cloud'&&this.sys.isActive())this.render();}
    else if(result.error.code==='unauthorized'){
      this.cloudCount=undefined;
      cloud.forget();
      this.cloudStatus={kind:'error',text:result.error.message};
      if(this.page==='cloud'&&this.sys.isActive())this.render();
    }
  }
  private syncStatusKind(result:CloudSyncResult):CloudPageStatus['kind']{
    if(result.ok)return 'success';
    return result.cancelled||result.aborted?'info':'error';
  }
  private syncMessage(result:CloudSyncResult,verb:string):string{
    if(result.cancelled)return '已取消。';
    if(result.aborted)return '操作已取消。';
    if(result.error)return result.error;
    if(result.total===0)return '没有可处理的存档。';
    const details=result.failures.map(failure=>`${cloudSlotLabel(failure.slot)}：${failure.reason}`).join('；');
    const summary=`${verb}成功 ${result.completed} 个`;
    return details?`${summary}，${result.failures.length} 个失败（${details}）`:`${summary}。`;
  }
  /**
   * 存档页要按槽里的立绘路径补加载图片。先画出文字行，立绘到位后再画一次：
   * 立绘是随存档记录走的路径，旧档引用的图没了也只是少一张画，不该让标题页失败。
   */
  private openSlots():void{
    this.slotRequest?.abort();this.slotPortraits?.release();this.slotPortraits=undefined;
    this.cancelCloudRequest();
    this.closeDialogs();
    const request=new AbortController();this.slotRequest=request;
    this.page='slots';this.render();
    const refs:SaveSlotRef[]=[AUTO_SAVE_SLOT,...Array.from({length:MANUAL_SAVE_SLOT_COUNT},(_,slot)=>slot)];
    const portraits=[...new Set(refs.map(ref=>{
      const reading=this.app.saves.peek(ref);
      return reading.kind==='ok'?reading.summary.portrait:undefined;
    }).filter((file):file is string=>!!file&&!this.textures.exists(uiTexture(file))))];
    if(!portraits.length)return;
    void loadUiImages(this,portraits).then(lease=>{
      if(request.signal.aborted||this.slotRequest!==request||!this.sys.isActive()){lease.release();return;}
      this.slotPortraits?.release();this.slotPortraits=lease;
      if(this.page==='slots')this.render();
    },()=>{});
  }
  private resume(slot:SaveSlotRef):void{
    const resume=this.app.resumeSlot;if(!resume)return;
    const request=this.slotRequest;
    void resume(slot,request?.signal).catch(error=>{
      if(!this.sys.isActive()||this.slotRequest!==request||request?.signal.aborted||error instanceof DOMException&&error.name==='AbortError')return;
      console.error(error);
      this.app.ui.error(error instanceof Error?error.message:String(error),()=>{this.app.ui.menuLoaded();this.openSlots();});
    });
  }
  private back():void {if(this.page==='cloud')this.openSlots();else this.showHome();}
  private showHome():void {
    this.cancelCloudRequest();
    this.closeDialogs();this.slotRequest?.abort();this.slotPortraits?.release();this.slotPortraits=undefined;
    this.page='home';this.render();
  }
  /** 离开页面或重进时收掉确认框、改名输入和密码输入，免得残留状态一直挡住输入。 */
  private closeDialogs():void {
    this.settleConfirm(false,false);
    this.renameRef=undefined;
    this.prompt?.close();
    this.passwordPrompt?.close();
  }
  private layout():void {
    if(this.backdrop){const source=this.backdrop.texture.getSourceImage(),factor=Math.max(this.scale.width/source.width,this.scale.height/source.height);this.backdrop.setPosition(this.scale.width/2,this.scale.height/2).setScale(factor);}
    this.surface?.layout();
    if(this.surface&&this.modal&&this.confirmAction!==undefined)centerModal(this.modal,this.surface,1024,640);
    this.syncCredentials();
  }

  /** 云页、确认框和输入弹层互斥；只有账号/密码真正可见时才让 DOM 覆盖层出现。 */
  private credentialsVisible():boolean {
    return this.page==='cloud'
      && !!this.surface
      && !!this.app.cloud
      && !this.app.cloud.loggedIn
      && this.app.ui.ready
      && !this.app.ui.suspended
      && this.sys.isActive()
      && this.confirmAction===undefined
      && this.renameRef===undefined
      && !this.prompt?.active
      && !this.passwordPrompt?.active;
  }

  /** 把面板里的两行矩形换算成画布坐标；输入框挂在 `#game-frame` 内，画布移动时自动跟随。 */
  private credentialRects():{account:CredentialInputRect;password:CredentialInputRect}|undefined {
    if(!this.surface)return;
    const bounds=this.game.canvas.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    const matrix=this.surface.root.getWorldTransformMatrix();
    const scaleX=bounds.width/this.scale.width, scaleY=bounds.height/this.scale.height;
    const map=(local:{x:number;y:number;width:number;height:number;fontSize:number}):CredentialInputRect=>{
      const point=matrix.transformPoint(local.x,local.y);
      return {
        left:point.x*scaleX,
        top:point.y*scaleY,
        width:local.width*matrix.scaleX*scaleX,
        height:local.height*matrix.scaleY*scaleY,
        fontSize:local.fontSize*matrix.scaleY*scaleY,
      };
    };
    return {account:map(CLOUD_PAGE.accountInput),password:map(CLOUD_PAGE.passwordInput)};
  }

  private syncCredentials():void {
    const credentials=this.credentials;
    if(!credentials)return;
    if(!this.credentialsVisible()){credentials.hide();return;}
    const rects=this.credentialRects();
    if(!rects){credentials.hide();return;}
    credentials.setRects(rects.account,rects.password);
    credentials.setValues(this.cloudAccountInput,this.cloudPassword);
    credentials.show();
  }
}
