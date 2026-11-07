import type Phaser from 'phaser';
import { domAssets } from '../dom/assets.ts';
import type { AssetLease } from '../../application/assets.ts';
import { COMMON_BUTTON_IMAGES } from '../common-button.ts';
import { UI_ICON_ATLAS_DATA, UI_ICON_ATLAS_FILE, UI_ICON_FRAMES } from '../../generated/icon-atlas.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../../generated/ui-atlas.ts';

export const GOLD = '#f3deb0';
const atlasName = (file: string): string => file.replace(/^\//, '');
export async function loadUiImages(_scene: Phaser.Scene, files: string[], progress = (_value: number) => {}, signal = new AbortController().signal): Promise<AssetLease> {
  const names = [...new Set([...files, ...COMMON_BUTTON_IMAGES])].flatMap(file => {
    const name=atlasName(file);
    if(name===UI_ICON_ATLAS_DATA||name===UI_ICON_ATLAS_FILE)return Object.keys(UI_ICON_FRAMES).slice(0,1);
    const page=UI_ATLAS_PAGES.find(page=>page.file===name||page.data===name);
    return page?Object.keys(UI_ATLAS_FRAMES).filter(key=>UI_ATLAS_FRAMES[key]!.key===page.key).slice(0,1):[file];
  });
  return domAssets.preloadFiles(names,signal,progress);
}
export { UiSurface, ScrollArea } from '../dom/surface.ts';
