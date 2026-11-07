import type Phaser from 'phaser';
import { domAssets } from '../dom/assets.ts';
import type { AssetLease } from '../../application/assets.ts';
import { COMMON_BUTTON_IMAGES } from '../common-button.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_KEY, UI_ICON_FRAMES } from '../../generated/icon-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../../generated/ui-atlas.ts';

export const GOLD = '#f3deb0';
export const uiTexture = (file: string): string => `interface:${file}`;
/** 图集映射键不带前导斜杠；原始文件路径仍按原样作为单图纹理键。 */
const atlasName = (file: string): string => file.startsWith('/') ? file.slice(1) : file;
/** 图标和菜单 UI 都可能来自图集；非图集资源仍按文件路径作为纹理键。 */
export function uiImage(file: string): { key: string; frame?: string } {
  const name = atlasName(file);
  const iconFrame = UI_ICON_FRAMES[name];
  if (iconFrame) return { key: UI_ICON_ATLAS_KEY, frame: iconFrame };
  const ui = UI_ATLAS_FRAMES[name];
  return ui ? { key: ui.key, frame: ui.frame } : { key: uiTexture(file) };
}
/** 图集尚未加载（测试替身或异常路径）时退回单图纹理键，避免整页渲染中断。 */
export function uiImageFor(scene: Phaser.Scene, file: string): { key: string; frame?: string } {
  const ref = uiImage(file);
  if (!ref.frame) return ref;
  const texture = scene.textures.exists(ref.key) ? scene.textures.get(ref.key) : undefined;
  return texture?.has(ref.frame) ? ref : { key: uiTexture(file) };
}
export async function loadUiImages(_scene: Phaser.Scene, files: string[], progress = (_value: number) => {}): Promise<AssetLease> {
  const names = [...new Set([...files, ...COMMON_BUTTON_IMAGES])].flatMap(file => {
    const name=atlasName(file);
    if(name===UI_ICON_ATLAS_DATA||name===UI_ICON_ATLAS_FILE)return Object.keys(UI_ICON_FRAMES).slice(0,1);
    const page=UI_ATLAS_PAGES.find(page=>page.file===name||page.data===name);
    return page?Object.keys(UI_ATLAS_FRAMES).filter(key=>UI_ATLAS_FRAMES[key]!.key===page.key).slice(0,1):[file];
  });
  return domAssets.preloadFiles(names,new AbortController().signal,progress);
}
export { UiSurface, ScrollArea } from '../dom/surface.ts';
