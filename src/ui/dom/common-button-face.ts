import { COMMON_BUTTON } from '../common-button.ts';

/** 菜单按钮和原生表单按钮共用同一张完整图片与边框切片。 */
export function paintCommonButtonFace(element:HTMLElement,url:string,cap:string):void {
  Object.assign(element.style,{
    boxSizing:'border-box',borderStyle:'solid',borderColor:'transparent',
    borderWidth:`0 ${cap}`,borderImageSource:`url(${JSON.stringify(url)})`,
    borderImageSlice:`0 ${COMMON_BUTTON.cap} fill`,borderImageWidth:`0 ${cap}`,borderImageRepeat:'stretch',
  });
}
