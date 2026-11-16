import { COMMON_BUTTON_IMAGES } from './common-button.ts';

/** 独立输入表单与菜单共用的原版图框和按钮。 */
export const PROMPT_IMAGES = [
  ...['corner-nw','corner-ne','corner-sw','corner-se','edge-horizontal','edge-vertical']
    .map(name => `assets/ui/menus/${name}.png`),
  ...COMMON_BUTTON_IMAGES,
];
