import type { StatusHudSkin } from '../domain/status-hud.ts';

export function statusHudAssets(skin:StatusHudSkin) {
  return [skin.assets['overhead-frame'],skin.assets['overhead-leader']]
    .map(file=>({kind:'image' as const,key:file,file}));
}
