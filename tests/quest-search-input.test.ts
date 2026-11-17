import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { domWindow, installMenuDom, MenuElement } from './support/menu-dom.ts';
import { QuestSearchInput } from '../src/ui/dom/quest-search-input.ts';

const cleanup = installMenuDom();
after(cleanup);

function searchRoot(): MenuElement | undefined {
  return domWindow.children[0]!.children.find(node => node.id === 'game-frame')!.children
    .find(node => String(node.className).includes('gm-quest-search'));
}
function searchField(): MenuElement | undefined {
  return searchRoot()?.children
    .find(node => String(node.className).includes('gm-quest-search-field'));
}

test('the inline input keeps a readable height and ignores IME confirm keys', () => {
  let submitted = 0, escaped = 0;
  const inputs: string[] = [];
  const input = new QuestSearchInput({
    onInput: value => inputs.push(value),
    onSubmit: () => { submitted++; },
    onEscape: () => { escaped++; },
  });
  input.show({ left: 10, top: 20, width: 100, height: 14, fontSize: 8 },
    { value: '', placeholder: '搜索任务' });
  const field = searchField();
  assert.ok(field, '输入框已挂到画框下');
  assert.equal(field!.style.height, '22px', '缩放后的高度仍能放下 16px 字号');
  assert.equal(field!.style.fontSize, '16px');
  assert.equal(field!.style.top, '16px', '加高时保持原来的垂直中心');

  const value = field as unknown as { value: string };
  value.value = '哥布林';
  field!.dispatchEvent(new Event('input', { bubbles: true }));
  assert.deepEqual(inputs, ['哥布林']);

  const ime = new Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(ime, { key: 'Enter', keyCode: 229 });
  field!.dispatchEvent(ime);
  assert.equal(submitted, 0, '输入法确认候选的回车不能当成搜索提交');

  const enter = new Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(enter, { key: 'Enter' });
  field!.dispatchEvent(enter);
  assert.equal(submitted, 1);
  const escape = new Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(escape, { key: 'Escape' });
  field!.dispatchEvent(escape);
  assert.equal(escaped, 1);

  input.destroy();
  assert.equal(searchRoot(), undefined);
});
