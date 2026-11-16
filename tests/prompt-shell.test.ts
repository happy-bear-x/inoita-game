import test from 'node:test';
import assert from 'node:assert/strict';
import { installMenuDom, domWindow } from './support/menu-dom.ts';
import { NumberPrompt } from '../src/ui/number-prompt.ts';
import { PasswordChangePrompt } from '../src/ui/password-change-prompt.ts';
import { domAssets } from '../src/ui/dom/assets.ts';
import { placePrompt } from '../src/ui/dom/prompt-shell.ts';
import { PROMPT_IMAGES } from '../src/ui/prompt-assets.ts';
import { COMMON_BUTTON } from '../src/ui/common-button.ts';

const settle=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};

test('both native prompt actions paint the shared normal and pressed button images',async t=>{
  t.after(installMenuDom());
  const controller=new AbortController();t.after(()=>controller.abort());
  const lease=await domAssets.preloadFiles(PROMPT_IMAGES,controller.signal,()=>{});
  t.after(()=>lease.release());
  const prompt=new NumberPrompt();t.after(()=>prompt.close());
  prompt.show({title:'数量',initial:1,minimum:1,maximum:99,onConfirm(){},onCancel(){}});
  const root=domWindow.children[0]!.children.find(node=>node.className.includes('number-prompt'))!;
  const actions=root.children[0]!.children.find(node=>node.className==='text-prompt-actions')!;
  assert.equal(actions.children.length,2);
  for(const [index,button] of actions.children.entries()){
    const faces=button.children.filter(node=>node.className.includes('text-prompt-button-face'));
    assert.equal(faces.length,2,'两个操作按钮都具有正常和按下图片');
    for(const [faceIndex,file] of [COMMON_BUTTON.image,COMMON_BUTTON.pressed].entries()){
      assert.equal(faces[faceIndex]!.style.borderImageSource,`url(${JSON.stringify(domAssets.peek(file)!.url)})`,'图片直接画在节点上，地址不经过外部样式表变量');
      assert.equal(faces[faceIndex]!.style.borderImageSlice,`0 ${COMMON_BUTTON.cap} fill`);
    }
    assert.equal(button.children.at(-1)!.textContent,index===0?'确定':'取消');
  }
});

test('closing a prompt releases pending and loaded artwork, including on reopen',async t=>{
  t.after(installMenuDom());
  const prompt=new NumberPrompt();t.after(()=>prompt.close());
  const open=()=>prompt.show({title:'数量',initial:1,minimum:1,maximum:99,onConfirm(){},onCancel(){}});
  const initial=domAssets.size;
  open();assert.ok(domAssets.size>initial);
  prompt.close();await settle();assert.equal(domAssets.size,initial);
  open();await settle();assert.ok(domAssets.size>initial);
  prompt.close();await settle();assert.equal(domAssets.size,initial);
});

test('prompt placement fits the visual viewport above the keyboard',t=>{
  t.after(installMenuDom());
  const target=domWindow as unknown as {visualViewport?:unknown};
  const previous=target.visualViewport;t.after(()=>{target.visualViewport=previous;});
  target.visualViewport={width:320,height:210,offsetLeft:8,offsetTop:12};
  const form=document.createElement('form');placePrompt(form);
  assert.equal(form.style.left,'168px');assert.equal(form.style.top,'117px');
  assert.equal(form.style.width,'296px');assert.equal(form.style.maxHeight,'186px');
  assert.equal(form.classList.contains('text-prompt-compact'),true);
  assert.equal(form.classList.contains('text-prompt-scroll'),false);
  target.visualViewport={width:640,height:160,offsetLeft:0,offsetTop:0};placePrompt(form);
  assert.equal(form.classList.contains('text-prompt-scroll'),true,'极短空间允许整张表单滚动');
  assert.equal(form.style.maxHeight,'136px');
  target.visualViewport={width:640,height:480,offsetLeft:0,offsetTop:0};placePrompt(form);
  assert.equal(form.classList.contains('text-prompt-compact'),false);
  assert.equal(form.classList.contains('text-prompt-scroll'),false,'键盘收起恢复固定操作行');
});

test('prompt actions follow the menu canvas scale and the original 450-wide confirm geometry',async t=>{
  t.after(installMenuDom());
  const target=domWindow as unknown as {visualViewport?:unknown};
  const previous=target.visualViewport;t.after(()=>{target.visualViewport=previous;});
  const viewport=(width:number,height:number)=>({width,height,offsetLeft:0,offsetTop:0,addEventListener(){},removeEventListener(){}});
  target.visualViewport=viewport(1000,700);
  const controller=new AbortController();t.after(()=>controller.abort());
  const lease=await domAssets.preloadFiles(PROMPT_IMAGES,controller.signal,()=>{});
  t.after(()=>lease.release());
  const prompt=new NumberPrompt();t.after(()=>prompt.close());
  prompt.show({title:'数量',initial:1,minimum:1,maximum:99,scale:()=>2,onConfirm(){},onCancel(){}});
  const root=domWindow.children[0]!.children.find(node=>node.className.includes('number-prompt'))!;
  const form=root.children[0]! as any;
  assert.equal(form.style.width,'900px','输入卡按菜单倍率保持原版 450 宽');
  assert.equal(form.style['--prompt-unit'],'2px','按钮几何共用同一个画布单位');
  const actions=form.children.find((node:any)=>node.className==='text-prompt-actions');
  const face=actions.children[0]!.children.find((node:any)=>node.className.includes('text-prompt-button-face'));
  assert.ok(String(face.style.borderImageWidth).startsWith('0 calc(var(--prompt-unit,1px) *'),'按钮图边框按同一画布单位缩放');
  target.visualViewport=viewport(320,700);
  placePrompt(form);
  assert.equal(form.style.width,'296px','窄屏整张卡等比缩小，按钮不会被挤出屏幕');
  assert.equal(form.style['--prompt-unit'],`${296/450}px`);
});

test('password prompt preserves mismatch validation and native form submission',async t=>{
  t.after(installMenuDom());
  const prompt=new PasswordChangePrompt();t.after(()=>prompt.close());
  const submitted:string[][]=[];
  prompt.show({onConfirm:(...values)=>submitted.push(values),onCancel(){}});
  const root=domWindow.children[0]!.children.find(node=>node.className==='text-prompt')!;
  const form=root.children[0]!,body=form.children.find(node=>node.className==='text-prompt-body')!;
  const fields=body.children.filter(node=>node.children.some(child=>(child as any).type==='password'));
  const inputs=fields.map(node=>node.children.find(child=>(child as any).type==='password')! as any);
  inputs[0].value='old-password';inputs[1].value='new-password';inputs[2].value='mismatch';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(submitted.length,0);assert.ok(prompt.active);
  const error=body.children.find(node=>node.className==='text-prompt-error')!;
  assert.equal(error.hidden,false);
  inputs[2].value='new-password';
  form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  assert.deepEqual(submitted,[['old-password','new-password']]);assert.equal(prompt.active,false);
  await settle();
});
