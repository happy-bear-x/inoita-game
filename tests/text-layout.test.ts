import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../src/ui/text-layout.ts';

/** 老写法：逐字累加，量到第一处放不下就换行。拿它当行为基准。 */
function referenceWrap(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = []; let line = '';
  for (const character of Array.from(text)) {
    if (character === '\n') { lines.push(line); line = ''; continue; }
    if (line && measure(line + character) > width) { lines.push(line); line = character; }
    else line += character;
  }
  lines.push(line); return lines;
}

// 按码点定宽，宽度随字符数单调增加，和真实字形测量一致。
const measure = (text: string): number => Array.from(text).reduce((sum, character) => sum + (character.codePointAt(0)! % 7) + 6, 0);

function* samples(): Generator<string> {
  let seed = 12345;
  const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = Array.from('艾诺迪亚的四位英雄在森林里寻找失落的宝珠forestdark');
  for (let index = 0; index < 400; index++) {
    const length = Math.floor(random() * 80);
    let text = '';
    for (let cursor = 0; cursor < length; cursor++) text += random() < 0.08 ? '\n' : alphabet[Math.floor(random() * alphabet.length)];
    yield text;
  }
  yield '';
  yield '\n';
  yield 'aaa\n';
  yield '\n\n';
}

test('wrapText 与逐字换行结果一致', () => {
  for (const text of samples()) {
    for (const width of [0, 12, 40, 90, 160, 1000]) {
      assert.deepEqual(wrapText(text, width, measure), referenceWrap(text, width, measure), `text=${JSON.stringify(text)} width=${width}`);
    }
  }
});

test('wrapText 对长文本只量 O(n log n) 次宽度', () => {
  let calls = 0;
  const counted = (text: string): number => { calls++; return measure(text); };
  const text = '艾'.repeat(600);
  const lines = wrapText(text, 160, counted);
  assert.equal(lines.join(''), text);
  assert.ok(calls < 600 * 4, `测量次数 ${calls} 应远少于逐字的 ${600 * 600 / 2}`);
});
