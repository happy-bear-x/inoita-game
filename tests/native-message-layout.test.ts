import assert from 'node:assert/strict';
import test from 'node:test';
import { drawNativeMessage } from '../src/ui/phaser/native-message.ts';
import type { UiSurface } from '../src/ui/phaser/widgets.ts';

interface RectCall { x:number; y:number; width:number; height:number }
interface ButtonCall { x:number; y:number }

function surface(originX=70.4,originY=64) {
  const rects:RectCall[]=[], buttons:ButtonCall[]=[];
  const text={height:48,
    setOrigin(){return text;},setAlign(){return text;},setPosition(){return text;},destroy(){}};
  const image={setOrigin(){return image;},setFlipY(){return image;}};
  const view={
    // 弹层实际画布可以很小（450×350），确认层按 1024×640 的外框居中。
    width:450,height:350,
    root:{x:originX,y:originY,scaleX:.8,scaleY:.8,bringToTop() {},
      getWorldTransformMatrix(){return {scaleX:.8,scaleY:.8,
        transformPoint(x:number,y:number){return {x:originX+x*.8,y:originY+y*.8};}};}},
    scene:{scale:{width:960,height:640}},
    rect(x:number,y:number,width:number,height:number){rects.push({x,y,width,height});},
    text(){return text;},
    image(){return image;},
    button(_label:string,x:number,y:number){buttons.push({x,y});return {setData(){return this;}};},
  };
  return {view,buttons,rects};
}

test('confirmation messages use a full-width black band and keep the short height',()=>{
  const {view,rects,buttons}=surface();
  drawNativeMessage(view as unknown as UiSurface,{},'读取存档将丢失当前未保存的进度，确定读取？',()=>{},()=>{});
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(70.4+black.x*.8,0,'缩放后左缘贴画布左边');
  assert.equal(black.width*.8,960,'宽度横穿整个画布');
  assert.equal(black.height,48+150,'高度仍是文字高度加留白');
  assert.ok(black.y>0,'上下仍留出画面');
  assert.ok(buttons.every(button=>button.y>0&&button.y+50<=640),'确认按钮仍在屏内');
});

test('ordinary notices share the same full-width band',()=>{
  const {view,rects}=surface();
  drawNativeMessage(view as unknown as UiSurface,{},'保存成功',()=>{});
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(70.4+black.x*.8,0);
  assert.equal(black.width*.8,960);
  assert.equal(black.height,48+150);
  assert.ok(black.y>0);
});

test('full-width bands follow an off-centre surface instead of assuming screen centring',()=>{
  // 横屏刘海让左右安全区不相等时，菜单画布会偏离屏幕中心；横带仍要覆盖 0…960。
  const {view,rects}=surface(200,64);
  drawNativeMessage(view as unknown as UiSurface,{},'保存成功',()=>{});
  const black=rects.filter(rect=>rect.width===1200).at(-1)!;
  assert.equal(200+black.x*.8,0,'左缘仍贴画布左边');
  assert.equal(200+(black.x+black.width)*.8,960,'右缘仍贴画布右边');
});
