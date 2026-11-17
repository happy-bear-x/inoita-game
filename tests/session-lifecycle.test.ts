import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type {StoryApp} from '../src/app.ts';
import type {WorldScene} from '../src/scenes/world-scene.ts';
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Scenes:{Events:{SHUTDOWN:"shutdown"}},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {createSessionLifecycle}=await import('../src/session-lifecycle.ts');hook.deregister();

test('leaving a session cancels business work before shutdown and releases resources only after shutdown',()=>{
  const events:string[]=[],controller=new AbortController();
  let shutdown:(()=>void)|undefined;
  const session={} as StoryApp['session'];
  const scene={sys:{isActive:()=>true,isPaused:()=>false},events:{once(_event:string,done:()=>void){shutdown=done;}},
    scene:{start(){events.push('scene-stop');assert.equal(controller.signal.aborted,true);}}};
  const app={session,mode:'game',ui:{canReturn:true,resetInput(){events.push('input');},lock(){},setMode(){}},
    gm:{dispose(){events.push('gm');}},director:{dispose(){events.push('director');}},
    clearMapPrefetch(){},clearStoryPrefetch(){},releaseSession(expected:unknown){assert.equal(expected,session);events.push('release');},
    game:{scene:{getScene(){return undefined;}}}} as unknown as StoryApp;
  const lifecycle=createSessionLifecycle(app,{lifetime:{current:controller},
    worldScene:()=>({discardWorldWork(){events.push('discard');}} as WorldScene),currentScene:()=>scene as never,
    gmOn:()=>false,runtimeDiagnostics:()=>({}),prepareStory:async()=>{},prepareMenuCore:async()=>{},
    refreshMenuWhenReady(){},cancelCommonPreload(){},clearMenuPreparations(){},recordSceneChange(){},
    remeasureRefreshAfterStart(){},startAutoSave(){},stopAutoSave(){events.push('save-stop');},autoSaver:()=>undefined});
  lifecycle.exit();
  assert.deepEqual(events,['discard','save-stop','gm','director','input','scene-stop']);
  assert.equal(app.mode,'menu');
  assert.ok(shutdown);shutdown();
  assert.equal(events.at(-1),'release');
});
