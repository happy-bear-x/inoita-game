import { SAVE_NAME_MAX_LENGTH, sanitizeSaveName } from '../domain/save-game.ts';

export interface TextPromptOptions {
  title:string;
  initial:string;
  onConfirm(value:string):void;
  onCancel():void;
}

/**
 * 手机系统键盘的输入层：原生 input 覆盖在画布之上，确认/取消后自己摘掉。
 *
 * 为什么不用 Phaser 画：手机的系统键盘只能由真实的 `<input>` 唤起，画布上画的
 * 文本框敲不出中文。这里只负责存档改名；修改密码用独立的三项表单。
 */
export class TextPrompt {
  private root?:HTMLDivElement;
  private form?:HTMLFormElement;
  private input?:HTMLInputElement;
  private options?:TextPromptOptions;
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
    const root=document.createElement('div');
    root.className='text-prompt';
    const form=document.createElement('form');
    form.autocomplete='off';
    const title=document.createElement('p');
    title.textContent=options.title;
    const input=document.createElement('input');
    input.type='text';
    input.inputMode='text';
    input.enterKeyHint='done';
    input.maxLength=SAVE_NAME_MAX_LENGTH;
    input.setAttribute('autocomplete','off');
    input.autocapitalize='off';
    input.spellcheck=false;
    input.value=sanitizeSaveName(options.initial);
    const actions=document.createElement('div');
    actions.className='text-prompt-actions';
    const confirm=document.createElement('button');
    confirm.type='submit';
    confirm.textContent='确定';
    const cancel=document.createElement('button');
    cancel.type='button';
    cancel.textContent='取消';
    actions.append(confirm,cancel);
    form.append(title,input,actions);
    root.append(form);
    document.body.append(root);
    this.root=root;this.form=form;this.input=input;
    input.addEventListener('input',()=>{
      const filtered=sanitizeSaveName(input.value);
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
  }

  private confirm():void {
    const options=this.options;
    if(!options)return;
    this.options=undefined;
    options.onConfirm(sanitizeSaveName(this.input?.value ?? ''));
    this.close();
  }

  private cancel():void {
    const options=this.options;
    this.options=undefined;
    this.close();
    options?.onCancel();
  }
}
