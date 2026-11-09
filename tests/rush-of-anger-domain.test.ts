import {dispatchFrame} from './support/combat-driver.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import type Phaser from 'phaser';
import type {BattleCatalog} from '../src/domain/battle.ts';
import {resolveBasicAttack} from '../src/domain/basic-attack.ts';
import {CombatController,type ActionPlayback,type Combatant,type CombatPort} from '../src/domain/combat.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import type {CharacterVisual} from '../src/rendering/characters.ts';

const hook=registerHooks({resolve(specifier,context,next){
  return specifier==='phaser'?{url:'data:text/javascript,export default {BlendModes:{NORMAL:0,MULTIPLY:1,SCREEN:2,ADD:3}}',shortCircuit:true}:next(specifier,context);
}});
const {CombatPresenter}=await import('../src/rendering/combat-presenter.ts');hook.deregister();
const catalog:BattleCatalog=JSON.parse(readFileSync(new URL('../public/content/battle.json',import.meta.url),'utf8'));
const warrior=catalog.classes.find(character=>character.id==='warrior')!;
const skill={id:'rush-of-anger',action:catalog.skills['rush-of-anger'].action!,level:1,manaCost:40};

function fixture(dx=24,dy=0){
  const source:Combatant={id:'source',team:'party',position:{x:320,y:192},bounds:{x:-8,y:-8,width:16,height:16}};
  const target:Combatant={...source,id:'target',team:'enemy',position:{x:320+dx,y:192+dy}};
  const actors=new Map([[source.id,source],[target.id,target]]);
  const log:string[]=[],moves:{x:number;y:number}[]=[],frames:{index:number;x:number;y:number;target?:string}[]=[];
  const plays:{action:ActionPlayback;frame:(index:number)=>void;complete:()=>void}[]=[];
  let mana=100,canStand=true,bodyChecks=0;
  const body={setPosition:()=>assert.fail('charge movement must not offset the body sprites')};
  const character={actor:warrior.actor,layers:[body],container:{active:true,x:320,y:192}} as unknown as CharacterVisual;
  const presenter=new CombatPresenter({} as Phaser.Scene,catalog,id=>id===source.id?character:undefined,()=>[...actors.values()]);
  const cooldowns=new CombatCooldownStore(()=>0).forActor(source.id);
  const port:CombatPort={
    cooldowns:{...cooldowns,start:(...args)=>{log.push('cooldown');cooldowns.start(...args);}},
    actor:id=>actors.get(id),candidates:()=>[...actors.values()],facing:()=> 'east',
    moveToward:()=>{},approachTarget:()=>false,stop:()=>{},clearEffects:()=>{},
    canSpendMana:amount=>mana>=amount,
    spendMana:amount=>{if(mana<amount)return false;log.push('mana');mana-=amount;return true;},
    canStand:()=>{log.push('path');return canStand;},
    canPlaceBody:()=>{bodyChecks++;return canStand;},
    relocate:position=>{
      actors.set(source.id,{...actors.get(source.id)!,position:{...position}});
      character.container.x=position.x;character.container.y=position.y;moves.push({...position});
    },
    play:(action,frame,complete)=>{log.push('play');plays.push({action,frame,complete});return ()=>{};},
    frame:(action,index,contact,unitsReady)=>{
      frames.push({index,...action.caster.position,target:action.target?.id});
      dispatchFrame(presenter,action,index,contact,unitsReady,undefined,(_definition,work)=>{
        log.push('dispatch');work();log.push('tail');
      });
    },
    unit:event=>{log.push(`unit:${event.cueIndex}:${event.targetId}`);return 'success';},
  };
  const controller=new CombatController(source.id,resolveBasicAttack(catalog,warrior),port);
  return {actors,controller,port,log,moves,frames,plays,mana:()=>mana,bodyChecks:()=>bodyChecks,setBlocked:()=>{canStand=false;},
    request:()=>controller.request(skill,target.id),position:()=>actors.get(source.id)!.position};
}

test('close rush moves the real actor in all four directions and restores its saved origin before the hit',()=>{
  for(const [dx,dy]of [[1,0],[-1,0],[0,1],[0,-1]]){
    const run=fixture(24*dx,24*dy);
    assert.equal(run.request(),'started');
    assert.deepEqual(run.position(),{x:320+8*dx,y:192+8*dy});
    run.plays[0].frame(3);run.plays[0].frame(3);
    assert.deepEqual(run.moves,[{x:320+8*dx,y:192+8*dy},{x:320,y:192}]);
    assert.deepEqual(run.frames.map(({index,x,y})=>[index,x,y]),[
      [0,320+8*dx,192+8*dy],[1,320+8*dx,192+8*dy],[2,320,192],[3,320,192],
    ]);
    assert.equal(run.mana(),60);
    assert.deepEqual(run.log,['mana','cooldown','play','dispatch','unit:0:target','unit:1:target','tail']);
    run.plays[0].complete();assert.deepEqual(run.position(),{x:320,y:192});
  }
});

test('failed charge planning and rejected approach or state leave resources unchanged',()=>{
  const failed=fixture(64);failed.setBlocked();
  assert.equal(failed.request(),'no-target');assert.equal(failed.controller.snapshot().state,'idle');
  assert.equal(failed.mana(),100);assert.deepEqual(failed.controller.snapshot().cooldowns,{});
  assert.ok(failed.bodyChecks()>0);assert.ok(!failed.log.includes('mana')&&!failed.log.includes('cooldown'));
  assert.equal(failed.plays.length,0);assert.deepEqual(failed.moves,[]);
  const distant=fixture(192);assert.equal(distant.request(),'started');
  assert.equal(distant.mana(),100);assert.deepEqual(distant.controller.snapshot().cooldowns,{});
  const stunned=fixture();stunned.actors.get('source')!.states=['stun'];
  assert.equal(stunned.request(),'busy');assert.equal(stunned.mana(),100);assert.deepEqual(stunned.log,[]);
});

test('a saved far landing is used even after occupation changes and precedes the frame-three hit',()=>{
  const run=fixture(64);run.request();run.setBlocked();
  const pathReads=run.log.filter(value=>value==='path').length;
  run.plays[0].frame(3);
  assert.deepEqual(run.moves,[{x:360,y:192}]);
  assert.deepEqual(run.frames.map(({index,x})=>[index,x]),[[0,320],[1,320],[2,360],[3,360]]);
  assert.equal(run.log.filter(value=>value==='path').length,pathReads);
  assert.equal(run.log.filter(value=>value==='unit:0:target').length,1);
});

test('cancellation before arrival keeps the lunged position and old callbacks cannot move a replacement action',()=>{
  for(const interruptedBy of ['explicit','stun']){
    const run=fixture();run.request();const old=run.plays[0];old.frame(1);
    if(interruptedBy==='explicit')run.controller.cancel();
    else run.actors.get('source')!.states=['stun'];
    old.frame(2);
    assert.equal(run.controller.snapshot().state,'idle');
    assert.deepEqual(run.position(),{x:328,y:192});
    assert.deepEqual(run.moves,[{x:328,y:192}]);
    assert.equal(run.mana(),60);assert.ok(run.controller.snapshot().cooldowns[skill.id]);
    run.actors.get('source')!.states=[];run.controller.resetSkillCooldowns();run.request();
    const before=structuredClone(run.moves);old.frame(3);old.complete();
    assert.deepEqual(run.moves,before);assert.equal(run.controller.snapshot().state,'attacking');
    assert.equal(run.log.includes('dispatch'),false);
  }
});

test('a lost or hidden target does not cancel the return to origin or the empty dispatch tail',()=>{
  for(const disappearedBy of ['removed','stealthed']){
    const run=fixture();run.request();run.plays[0].frame(1);
    if(disappearedBy==='removed')run.actors.delete('target');
    else run.actors.get('target')!.states=['stealthed'];
    run.controller.update();assert.equal(run.controller.snapshot().state,'attacking');
    run.plays[0].frame(3);
    assert.deepEqual(run.moves,[{x:328,y:192},{x:320,y:192}]);
    assert.equal(run.frames.at(-1)!.target,undefined);
    assert.deepEqual(run.log,['mana','cooldown','play','dispatch','tail']);
  }
});
