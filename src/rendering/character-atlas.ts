import type { PendingAsset } from './scene-assets.ts';
import {
  CHARACTER_ATLAS_BY_FILE,
  CHARACTER_ATLAS_PAGES,
  type CharacterAtlasEntry,
  type CharacterAtlasPage
} from '../generated/character-atlas.ts';


/**
 * 角色动作图集的运行时查询。
 *
 * 生成物只存「每个文件每一帧在哪一页」和帧名前缀，不逐帧存字符串。
 * 换装合成的动态纹理 `file` 为空，没有映射，继续按原来的纹理键取。
 */
export interface CharacterAtlasFrameRef {
  key: string;
  frame: string;
}

const pageAssets = new Map<number, PendingAsset>();

/** 某一页的加载描述；同一页始终返回同一个对象，便于按引用去重。 */
export function characterAtlasPageAsset(index: number): PendingAsset {
  const cached = pageAssets.get(index);
  if (cached) return cached;
  const page: CharacterAtlasPage | undefined = CHARACTER_ATLAS_PAGES[index];
  if (!page) throw new Error(`角色图集页缺失：${index}`);
  const asset: PendingAsset = Object.freeze({
    kind: 'atlas', key: page.key, file: page.file, atlas: page.data, frame: page.frame
  });
  pageAssets.set(index, asset);
  return asset;
}

export function characterAtlasEntry(file: string | undefined): CharacterAtlasEntry | undefined {
  if (!file) return undefined;
  return CHARACTER_ATLAS_BY_FILE[file];
}

/** 该文件的帧序号对应的图集纹理键和帧名；没有映射时返回 undefined。 */
export function characterFrame(file: string | undefined, index: number): CharacterAtlasFrameRef | undefined {
  const entry = characterAtlasEntry(file);
  const pageIndex = entry?.pages[index];
  const page = pageIndex === undefined ? undefined : CHARACTER_ATLAS_PAGES[pageIndex];
  if (!entry || !page) return undefined;
  return { key: page.key, frame: `${entry.prefix}-${String(index).padStart(3, '0')}` };
}

/** 一个动作需要的前 count 帧；调用方在返回不足时退回原 spritesheet。 */
export function characterFrameList(file: string | undefined, count: number): CharacterAtlasFrameRef[] {
  const entry = characterAtlasEntry(file);
  if (!entry) return [];
  const frames: CharacterAtlasFrameRef[] = [];
  for (let index = 0; index < Math.min(count, entry.pages.length); index++) {
    const frame = characterFrame(file, index);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** 该文件的帧分布在哪些页；用于动画记账和资源保留。 */
export function characterAtlasPageKeys(file: string | undefined): string[] {
  const entry = characterAtlasEntry(file);
  if (!entry) return [];
  const keys = new Set<string>();
  for (const index of entry.pages) {
    const page: CharacterAtlasPage | undefined = CHARACTER_ATLAS_PAGES[index];
    if (page) keys.add(page.key);
  }
  return [...keys];
}

