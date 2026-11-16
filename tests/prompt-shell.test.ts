import test from 'node:test';
import assert from 'node:assert/strict';
import { installMenuDom, domWindow } from './support/menu-dom.ts';
import { NumberPrompt } from '../src/ui/number-prompt.ts';
import { PasswordChangePrompt } from '../src/ui/password-change-prompt.ts';
import { domAssets } from '../src/ui/dom/assets.ts';
import { placePrompt } from '../src/ui/dom/prompt-shell.ts';

const settle=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};

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
