import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,ADD:1,MULTIPLY:2,SCREEN:3},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}:next(specifier,context);
}});
const {WorldScene}=await import('../src/scenes/world-scene.ts');
phaser.deregister();

test('GM noclip follows the controlled character and clears the previous one',()=>{
  const calls:[string,boolean][]=[];
  const a={container:{active:true}},b={container:{active:true}};
  const state={
    app:{gmNoclip:false},
    player:a,
    combat:{controlledVisual:a as unknown},
    movement:{setNoclip:(visual:{container:{active:boolean}},enabled:boolean)=>{calls.push([visual===a?'a':'b',enabled]);},position:()=>({x:0,y:0})},
    cameras:{main:{startFollow(){}}},
    refreshLoadout(){},refreshCombatTarget(){},syncHud(){},
  };
  const scene=Object.setPrototypeOf(state,WorldScene.prototype) as unknown as InstanceType<typeof WorldScene>;
  scene.setNoclip(true);
  assert.deepEqual(calls,[['a',true]]);
  state.combat.controlledVisual=b;
  scene.syncControlledCharacter();
  assert.deepEqual(calls,[['a',true],['a',false],['b',true]],'换人后旧角色必须关闭穿墙');
  scene.setNoclip(false);
  assert.deepEqual(calls,[['a',true],['a',false],['b',true],['b',false]],'关闭穿墙要清掉当前角色');
});
