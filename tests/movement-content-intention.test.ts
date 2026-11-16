import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire,registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import {NavigationWorld} from '../src/domain/navigation-world.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';
import {CHARACTER_FOOT_DEPTH_OFFSET} from '../src/rendering/depths.ts';

const require=createRequire(import.meta.url);
const World=require('../node_modules/phaser/src/physics/arcade/World.js') as typeof Phaser.Physics.Arcade.World;
const bodyUrl=new URL('../node_modules/phaser/src/physics/arcade/Body.js',import.meta.url).href;
const shim=`import Body from ${JSON.stringify(bodyUrl)};export default {Physics:{Arcade:{Body}},Scenes:{Events:{PRE_UPDATE:'preupdate',POST_UPDATE:'postupdate',PRE_RENDER:'prerender',RENDER:'render'}}};`;
const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:`data:text/javascript,${encodeURIComponent(shim)}`,shortCircuit:true}:next(specifier,context);}});
const {MovementWorld}=await import('../src/rendering/movement-world.ts');hook.deregister();

test('stopping a walking static content actor refreshes the content index and depth without place',t=>{
  const events=new EventEmitter();
  const group={scene:{},add(){},remove(){},destroy(){}};
  const scene={sys:{scale:{width:640,height:480}},events,add:{group:()=>group}} as unknown as Phaser.Scene;
  const world=new World(scene,{gravity:{x:0,y:0},debug:false});
  scene.physics={world,add:{collider:(...args:Parameters<typeof world.addCollider>)=>world.addCollider(...args)}} as Phaser.Physics.Arcade.ArcadePhysics;
  const navigation=new NavigationWorld({name:'arena',bounds:{x:0,y:0,width:400,height:400}});
  const movement=new MovementWorld(scene,navigation);
  t.after(()=>{movement.destroy();world.destroy();});

  const depthWrites:number[]=[];
  const container=Object.assign(new EventEmitter(),{
    x:80,y:80,depth:0,scaleX:1,scaleY:1,angle:0,rotation:0,displayOriginX:0,displayOriginY:0,active:true,visible:true,
    setPosition(nx:number,ny:number){this.x=nx;this.y=ny;return this;},
    setDepth(value:number){this.depth=value;depthWrites.push(value);return this;},
    setVisible(value:boolean){this.visible=value;return this;}
  });
  const walker={actor:{collision:{x:-8,y:-8,width:16,height:16}},entity:{id:'crate'},container} as unknown as CharacterVisual;
  const body=movement.register(walker,false);
  const probe={collision:{x:-2,y:-2,width:4,height:4}};
  const oldPosition={x:80,y:80};
  assert.equal(navigation.blockedByContent(probe,oldPosition),true,'初始位置应被内容索引命中');

  // 剧情走位会临时取消固定，但不会调用 place。
  body.setImmovable(false);
  const route=movement.walkTo(walker,{x:240,y:240},160);

  let time=0;
  const internals=movement as unknown as {beginFrame(time:number,delta:number):void;syncDepth():void};
  const step=(delta=1000/60)=>{
    time+=delta;
    internals.beginFrame(time,delta);
    world.update(time,delta);
    world.postUpdate();
    internals.syncDepth();
  };
  for(let index=0;index<600&&route.state==='walking';index++)step();
  assert.equal(route.state,'arrived');

  const newPosition=movement.position(walker);
  assert.ok(newPosition.x>oldPosition.x+32&&newPosition.y>oldPosition.y+32,
    `应走到远处：${JSON.stringify(newPosition)}`);
  assert.equal(navigation.blockedByContent(probe,newPosition),false,'停步前内容索引还没有刷新到新位置');

  const expectedDepth=container.y+CHARACTER_FOOT_DEPTH_OFFSET;
  const writesBeforeStop=depthWrites.length;
  container.depth=expectedDepth-100;
  movement.stop(walker);
  assert.equal(navigation.blockedByContent(probe,newPosition),true,'停步刷新后新位置能被内容阻挡查询命中');
  assert.equal(navigation.blockedByContent(probe,oldPosition),false,'旧位置不再命中');
  assert.equal(depthWrites.length,writesBeforeStop+1,'停步时重新写入深度');
  assert.equal(container.depth,expectedDepth,'深度按当前容器位置更新');
});
