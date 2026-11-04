import type { QuestRewardReceipt } from '../domain/content.ts';
import type { CampaignQuest } from '../domain/campaign.ts';
import { questTextParts, type QuestTextTone } from '../domain/quest-text.ts';

interface QuestTextRun { text: string; tone: QuestTextTone; x: number }
export interface QuestTextLine { runs: QuestTextRun[]; width: number }

const OPENING = new Set(Array.from('（([【《「『“‘〈〔｛{'));
const CLOSING = new Set(Array.from('，。！？；：、）)]】》」』”’〉〕｝}…,.!?;:'));

/** 带色文本的一段：`key` 是这条排版不关心的分段依据（任务窗口用语气，对白用字色）。 */
export type KeyedTextPart<K> = { text: string; key: K } | { break: true };
interface KeyedTextRun<K> { text: string; key: K; x: number }
export interface KeyedTextLine<K> { runs: KeyedTextRun<K>[]; width: number }

/** 先为整行测量、断行，再恢复颜色片段；颜色标记不改变换行位置。 */
export function layoutKeyedText<K>(parts: readonly KeyedTextPart<K>[], width: number, measure: (text: string) => number): KeyedTextLine<K>[] {
  const paragraphs: { text: string; key: K }[][] = [[]];
  for (const part of parts) {
    if ('break' in part) paragraphs.push([]);
    else paragraphs.at(-1)!.push(...Array.from(part.text, text => ({ text, key: part.key })));
  }
  const lines: KeyedTextLine<K>[] = [];
  for (const characters of paragraphs) {
    if (!characters.length) { lines.push({ runs: [], width: 0 }); continue; }
    let start = 0;
    while (start < characters.length) {
      const text = (end: number) => characters.slice(start, end).map(character => character.text).join('');
      let end = start;
      while (end < characters.length && (end === start || measure(text(end + 1)) <= width)) end++;
      if (end < characters.length) {
        let legalEnd = end;
        while (legalEnd > start && (OPENING.has(characters[legalEnd - 1].text) || CLOSING.has(characters[legalEnd].text))) legalEnd--;
        if (legalEnd > start) end = legalEnd;
        else while (end < characters.length && CLOSING.has(characters[end].text)) end++;
      }
      const runs: KeyedTextRun<K>[] = [];
      for (let index = start; index < end; index++) {
        const character = characters[index], previous = runs.at(-1);
        if (previous?.key === character.key) previous.text += character.text;
        else runs.push({ text: character.text, key: character.key, x: measure(text(index)) });
      }
      lines.push({ runs, width: measure(text(end)) });
      start = end;
    }
  }
  return lines;
}

export function layoutQuestText(text: string, width: number, measure: (text: string) => number): QuestTextLine[] {
  const parts = questTextParts(text).map(part => 'break' in part ? part : { text: part.text, key: part.tone });
  return layoutKeyedText(parts, width, measure)
    .map(line => ({ width: line.width, runs: line.runs.map(run => ({ text: run.text, tone: run.key, x: run.x })) }));
}

export function questPopupContent(kind: 'start' | 'complete', quest: Pick<CampaignQuest, 'title' | 'description'>,
  reward: QuestRewardReceipt | undefined, itemName: (id: string) => string): { heading: string; body: string; money: number } {
  const heading = `$A<${quest.title}>$B ${kind === 'start' ? '获得' : '完成'}`;
  if (kind === 'start') return { heading, body: quest.description, money: 0 };
  const lines: string[] = [];
  if (reward?.experience) lines.push(`经验值: ${reward.experience}`);
  for (const item of reward?.items ?? []) lines.push(`${itemName(item.item)}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`);
  return { heading, body: lines.join('\n'), money: reward?.money ?? 0 };
}

/** 原版按内容增高；横屏浏览器把超出的正文放入滚动区。 */
export function questPopupLayout(kind: 'start' | 'complete', titleHeight: number, bodyHeight: number, hasMoney: boolean) {
  const nativeHeight = kind === 'start'
    ? Math.max(titleHeight + bodyHeight + 40, 255) + 95
    : Math.max(titleHeight + bodyHeight + 40 + (hasMoney ? 127 : 95), 350);
  const height = Math.min(nativeHeight, 364), x = 175, y = (480 - height) / 2;
  const bodyY = y + titleHeight + 40;
  return { x, y, width: 450, height, nativeHeight, titleY: y + 20, bodyX: x + 20, bodyY,
    bodyWidth: 410, bodyHeight: Math.max(1, y + height - 95 - bodyY), buttonX: 338, buttonY: y + height - 75 };
}
