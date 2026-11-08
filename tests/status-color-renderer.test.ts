import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import type Phaser from 'phaser';
import type { CharacterVisual } from '../src/rendering/characters.ts';
import { statusColorMatrix } from '../src/domain/status-color.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {Core:{Events:{POST_RENDER:"postrender"}},BlendModes:{ADD:1,SCREEN:2}}',shortCircuit:true}
  :next(specifier,context);}});
const {StatusColorRenderer}=await import('../src/rendering/status-color.ts');hook.deregister();

function fixture(){
  const events=new EventEmitter(),scene={game:{events}} as unknown as Phaser.Scene;
  const filter={active:false,matrix:[] as number[],colorMatrix:{set(value:number[]){filter.matrix=[...value];}},setActive(value:boolean){filter.active=value;}};
  const sprite={blendMode:0,filters:{internal:{addColorMatrix:()=>filter}},enableFilters(){}};
  const character={container:{active:true},layers:[sprite]} as unknown as CharacterVisual;
  return {renderer:new StatusColorRenderer(),scene,events,character,filter};
}

test('hit flash ends after rendering and restores the original appearance',()=>{
  const f=fixture();f.renderer.paint(f.character,undefined,0);
  f.renderer.flash(f.character,f.scene);f.renderer.flash(f.character,f.scene);
  assert.equal(f.filter.active,true);
  assert.deepEqual(f.filter.matrix,statusColorMatrix([{red:0,green:0,blue:0}],0,true));
  f.events.emit('postrender');assert.equal(f.filter.active,false);
  f.renderer.flash(f.character,f.scene);assert.equal(f.filter.active,true);
  f.events.emit('postrender');assert.equal(f.filter.active,false);
});

test('hit flash restores the latest status color and animation frame',()=>{
  const f=fixture(),colors=[{red:100,green:0,blue:0},{red:0,green:60,blue:0}];
  f.renderer.paint(f.character,colors,0);f.renderer.flash(f.character,f.scene);
  f.renderer.paint(f.character,colors,1);
  assert.deepEqual(f.filter.matrix,statusColorMatrix(colors,1,true));
  f.events.emit('postrender');
  assert.equal(f.filter.active,true);assert.deepEqual(f.filter.matrix,statusColorMatrix(colors,1));
});
