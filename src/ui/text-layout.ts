/**
 * 一行最多能放下几个字：宽度随字符数增加只增不减，所以可以二分。
 * 逐字量（老写法）会把整行重量的次数乘上字数，长说明和菜单页一次要量几万次。
 */
function fitLength(chars: readonly string[], from: number, width: number, measure: (text: string) => number): number {
  let low = from + 1, high = chars.length, best = from + 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (measure(chars.slice(from, middle).join('')) <= width) { best = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return best;
}

function wrapParagraph(chars: readonly string[], width: number, measure: (text: string) => number): string[] {
  if (!chars.length) return [''];
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const end = fitLength(chars, start, width, measure);
    lines.push(chars.slice(start, end).join(''));
    start = end;
  }
  return lines;
}

/** 按字形测量中文，保留显式换行；同一结果用于显示与分页。 */
export function wrapText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) lines.push(...wrapParagraph(Array.from(paragraph), width, measure));
  return lines;
}
