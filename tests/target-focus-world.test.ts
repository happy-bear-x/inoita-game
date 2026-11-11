import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

const phaser=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{shortCircuit:true,url:`data:text/javascript,${encodeURIComponent(
    'export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}')}`}:next(specifier,context);
}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');phaser.deregister();
const syncFocusRings=Reflect.get(WorldCombat.prototype,'syncFocusRings') as (this:unknown,shown:boolean,delta:number)=>void;

/** 脚下红圈只读目标 id、脚点和显隐；这里用最小宿主验证目标回退顺序。 */
function host(options:{playerTarget?:string;companionTarget?:string;activeTarget?:string;focusTargetId?:string;pending?:string}={}){
  const player={x:10,y:20,container:{active:true}};
  const enemy={x:100,y:200,container:{active:true}};
  const calls:unknown[][]=[];
  const value=Object.setPrototypeOf({
    controlledId:'player',
    visualOf:(id:string)=>id==='player'?player:id==='enemy'?enemy:undefined,
    memberOf:()=>({player:{health:100}}),
    movement:{displayPosition:(visual:{x:number;y:number})=>({x:visual.x,y:visual.y})},
    partyControllers:new Map([
      ['player',{activeAction:()=>options.activeTarget?{targetId:options.activeTarget}:undefined,selectedTargetId:()=>options.playerTarget}],
      ['mercenary',{activeAction:()=>undefined,selectedTargetId:()=>options.companionTarget}],
    ]),
    pendingDefeats:new Set(options.pending?[options.pending]:[]),
    focusTargetId:options.focusTargetId,
    focusRings:{update:(...args:unknown[])=>calls.push(args)},
  },WorldCombat.prototype);
  return {value,calls,player:{x:10,y:20},enemy:{x:100,y:200}};
}

test('operator target keeps the ring',()=>{
  const run=host({playerTarget:'enemy',companionTarget:'enemy'});
  syncFocusRings.call(run.value,true,16);
  assert.deepEqual(run.calls.at(-1),[run.player,run.enemy,'enemy',true,16]);
});

test('companion target keeps the ring after the operator clears selection',()=>{
  const run=host({companionTarget:'enemy'});
  syncFocusRings.call(run.value,true,16);
  assert.deepEqual(run.calls.at(-1),[run.player,run.enemy,'enemy',true,16]);
});

test('a running action target keeps the ring after selection clears',()=>{
  const run=host({activeTarget:'enemy'});
  syncFocusRings.call(run.value,true,16);
  assert.deepEqual(run.calls.at(-1),[run.player,run.enemy,'enemy',true,16]);
});

test('focus target is the last fallback',()=>{
  const run=host({focusTargetId:'enemy'});
  syncFocusRings.call(run.value,true,16);
  assert.deepEqual(run.calls.at(-1),[run.player,run.enemy,'enemy',true,16]);
});

test('a pending defeat hides the ring',()=>{
  const run=host({companionTarget:'enemy',pending:'enemy'});
  syncFocusRings.call(run.value,true,16);
  assert.deepEqual(run.calls.at(-1),[run.player,undefined,undefined,true,16]);
});
