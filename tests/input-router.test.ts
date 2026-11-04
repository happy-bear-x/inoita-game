import test from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter } from '../src/application/input-router.ts';

function key(value: string): KeyboardEvent {
  let prevented = 0;
  return { key: value, prevented,
    preventDefault() { prevented += 1; } } as unknown as KeyboardEvent;
}

function router(textInputFocused = false) {
  return new InputRouter({ textInputFocused: () => textInputFocused });
}

test('按键只交给优先级最高的作用域，弹层结束后才轮到菜单和世界', () => {
  const input = router(), calls: string[] = [];
  input.register('world', () => { calls.push('world'); return true; });
  input.register('menu', () => { calls.push('menu'); return true; });
  input.register('modal', () => { calls.push('modal'); return true; });
  assert.equal(input.dispatch(key('Escape')), true);
  assert.deepEqual(calls, ['modal'], '同一次按键只被一层消费');
});

test('高优先级作用域没消费时，非独占才继续往下走', () => {
  const input = router(), calls: string[] = [];
  input.register('world', () => { calls.push('world'); return true; });
  input.register('menu', () => { calls.push('menu'); return true; });
  input.register('modal', () => { calls.push('modal'); return false; });
  assert.equal(input.dispatch(key('1')), true);
  assert.deepEqual(calls, ['modal', 'menu']);

  calls.length = 0;
  const exclusive = router();
  exclusive.register('world', () => { calls.push('world'); return true; });
  exclusive.register('menu', () => { calls.push('menu'); return true; });
  exclusive.register('modal', () => { calls.push('modal'); return false; }, { exclusive: () => true });
  assert.equal(exclusive.dispatch(key('1')), false);
  assert.deepEqual(calls, ['modal'], '独占作用域挡住了下面的菜单和世界');
});

test('文本输入框有焦点时整场键盘让路', () => {
  const input = router(true), calls: string[] = [];
  input.register('world', () => { calls.push('world'); return true; });
  input.register('menu', () => { calls.push('menu'); return true; });
  input.register('text-input', () => { calls.push('text'); return false; });
  assert.equal(input.dispatch(key('Escape')), true);
  assert.deepEqual(calls, ['text'], '输入框和输入法自己处理按键，游戏层不重复消费');
});

test('同一作用域后注册的先收到，独占时不再落到更早的处理器', () => {
  const input = router(), calls: string[] = [];
  input.register('menu', () => { calls.push('older'); return true; });
  input.register('menu', () => { calls.push('newer'); return false; });
  input.dispatch(key('Tab'));
  assert.deepEqual(calls, ['newer', 'older']);

  calls.length = 0;
  const exclusive = router();
  exclusive.register('menu', () => { calls.push('older'); return true; });
  exclusive.register('menu', () => { calls.push('newer'); return false; }, { exclusive: () => true });
  exclusive.dispatch(key('Tab'));
  assert.deepEqual(calls, ['newer']);
});

test('作用域可以暂停接收，注销后不再触发', () => {
  const input = router(), calls: string[] = [];
  let active = false;
  const unregister = input.register('world', () => { calls.push('world'); return true; }, { active: () => active });
  input.dispatch(key('1'));
  assert.deepEqual(calls, [], '暂停的作用域不接收按键');
  active = true;
  input.dispatch(key('1'));
  assert.deepEqual(calls, ['world']);
  unregister();
  input.dispatch(key('1'));
  assert.deepEqual(calls, ['world'], '注销后处理器已摘掉');
});
