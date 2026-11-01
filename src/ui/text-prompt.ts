import { SAVE_NAME_MAX_LENGTH, sanitizeSaveName } from '../domain/save-game.ts';
import { CLOUD_ACCOUNT_MAX_LENGTH, CLOUD_PASSWORD_MAX_LENGTH, sanitizeCloudAccountInput } from '../domain/cloud-save.ts';

export type PromptPurpose = 'save-name' | 'account' | 'password';

export interface TextPromptOptions {
  title:string;
  initial:string;
  onConfirm(value:string):void;
  onCancel():void;
  /** 输入框用途：决定过滤规则、密码遮罩和默认提示。省略时按存档改名处理。 */
  purpose?:PromptPurpose;
  /** 覆盖默认提示；传空串不显示提示。 */
  hint?:string;
}

interface PromptBehavior {
  filter:(value:string)=>string;
  maxLength:number;
  inputType:'text'|'password';
  autocomplete:string;
}

function behaviorFor(purpose:PromptPurpose|undefined):PromptBehavior {
  if(purpose==='account')return {
    filter:sanitizeCloudAccountInput,
    maxLength:CLOUD_ACCOUNT_MAX_LENGTH,
    inputType:'text',
    autocomplete:'username',
  };
  if(purpose==='password')return {
    filter:value=>value,
    maxLength:CLOUD_PASSWORD_MAX_LENGTH,
    inputType:'password',
    autocomplete:'off',
  };
  return {
    filter:sanitizeSaveName,
    maxLength:SAVE_NAME_MAX_LENGTH,
    inputType:'text',
    autocomplete:'off',
  };
}

function defaultHint(purpose:PromptPurpose|undefined):string|undefined {
  if(purpose==='account')return '3–24 位字母、数字、下划线或汉字，不区分大小写';
  if(purpose==='password')return '6–64 位，区分大小写；忘记密码无法找回';
  return undefined;
}

/**
 * 手机系统键盘的唯一入口：原生 input 覆盖在画布之上，确认/取消后自己摘掉。
 *
 * 为什么不用 Phaser 画：手机的系统键盘只能由真实的 `<input>` 唤起，画布上画的
 * 文本框敲不出中文。输入框本身只用在不属于游戏画面的改名操作上，样式在 `game.css`。
 */
export class TextPrompt {
  private root?:HTMLDivElement;
  private form?:HTMLFormElement;
  private input?:HTMLInputElement;
  private options?:TextPromptOptions;
  private filterValue:(value:string)=>string=sanitizeSaveName;
  private readonly cancelOnHide=()=>{ if(this.options)this.cancel(); };
  /**
   * 手机键盘弹出时 `visualViewport` 会缩小：把卡片放在可视区中心，
   * 输入框才不会被键盘盖住。没有 `visualViewport` 时退回窗口尺寸。
   */
  private readonly place=()=>{
    if(!this.form||typeof window==='undefined')return;
    const viewport=window.visualViewport;
    const width=viewport?.width ?? window.innerWidth, height=viewport?.height ?? window.innerHeight;
    this.form.style.left=`${(viewport?.offsetLeft ?? 0)+width/2}px`;
    this.form.style.top=`${(viewport?.offsetTop ?? 0)+height/2}px`;
  };

  get active():boolean { return !!this.root; }

  show(options:TextPromptOptions):void {
    this.close();
    if(typeof document==='undefined')return;
    this.options=options;
    const behavior=behaviorFor(options.purpose);
    this.filterValue=behavior.filter;
    const root=document.createElement('div');
    root.className='text-prompt';
    const form=document.createElement('form');
    form.autocomplete='off';
    const title=document.createElement('p');
    title.textContent=options.title;
    const hintText=options.hint??defaultHint(options.purpose);
    const hint=document.createElement('p');
    if(hintText){hint.className='text-prompt-hint';hint.textContent=hintText;}
    const input=document.createElement('input');
    input.type=behavior.inputType;
    input.inputMode='text';
    input.enterKeyHint='done';
    input.maxLength=behavior.maxLength;
    input.setAttribute('autocomplete',behavior.autocomplete);
    input.autocapitalize='off';
    input.spellcheck=false;
    input.value=behavior.filter(options.initial);
    const actions=document.createElement('div');
    actions.className='text-prompt-actions';
    const confirm=document.createElement('button');
    confirm.type='submit';
    confirm.textContent='确定';
    const cancel=document.createElement('button');
    cancel.type='button';
    cancel.textContent='取消';
    actions.append(confirm,cancel);
    if(hintText)form.append(title,hint,input,actions);else form.append(title,input,actions);
    root.append(form);
    document.body.append(root);
    this.root=root;this.form=form;this.input=input;
    // 按用途过滤：存档名只留中文/英文/数字，账号只留允许字符，密码原样保留。
    input.addEventListener('input',()=>{
      const filtered=behavior.filter(input.value);
      if(filtered!==input.value)input.value=filtered;
    });
    input.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();this.cancel();}
    });
    form.addEventListener('submit',event=>{event.preventDefault();this.confirm();});
    cancel.addEventListener('click',()=>this.cancel());
    if(typeof window!=='undefined'&&typeof window.addEventListener==='function'){
      window.addEventListener('pagehide',this.cancelOnHide,{once:true});
      window.addEventListener('resize',this.place);
      window.visualViewport?.addEventListener('resize',this.place);
      window.visualViewport?.addEventListener('scroll',this.place);
    }
    this.place();
    input.focus();
    input.select();
  }

  /** 摘掉输入框，不回调；场景关闭或页面切走时用。 */
  close():void {
    if(typeof window!=='undefined'&&typeof window.removeEventListener==='function'){
      window.removeEventListener('pagehide',this.cancelOnHide);
      window.removeEventListener('resize',this.place);
      window.visualViewport?.removeEventListener('resize',this.place);
      window.visualViewport?.removeEventListener('scroll',this.place);
    }
    const input=this.input;
    if(input){try{input.blur();}catch{}}
    this.root?.remove();
    this.root=undefined;this.form=undefined;this.input=undefined;this.options=undefined;
    this.filterValue=sanitizeSaveName;
  }

  private confirm():void {
    const options=this.options;
    if(!options)return;
    this.options=undefined;
    options.onConfirm(this.filterValue(this.input?.value ?? ''));
    this.close();
  }

  private cancel():void {
    const options=this.options;
    this.options=undefined;
    this.close();
    options?.onCancel();
  }

}
