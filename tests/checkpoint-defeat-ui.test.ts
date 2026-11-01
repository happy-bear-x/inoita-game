import assert from 'node:assert/strict';
import test from 'node:test';
import { GameUI } from '../src/ui/game-ui.ts';

test('defeat actions require confirmation; cancellation preserves the input lock',async()=>{
  const ui=new GameUI();let restored=0;
  ui.showDefeat({restore:()=>{restored++;}});
  assert.equal(ui.locked,true);assert.equal(ui.defeated,true);
  ui.selectDefeatAction('checkpoint');ui.cancelDefeatConfirmation();await ui.confirmDefeat();
  assert.equal(restored,0);assert.equal(ui.defeated,true);assert.equal(ui.locked,true);
  ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();
  assert.equal(restored,1);assert.equal(ui.defeated,false);assert.equal(ui.locked,false);
});

test('a failed restore leaves the defeat screen operable',async()=>{
  const ui=new GameUI();let calls=0;
  ui.showDefeat({restore:()=>{calls++;if(calls===1)throw new Error('地图加载失败');}});
  ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();
  assert.equal(ui.defeatState!.error,'地图加载失败');assert.equal(ui.defeated,true);
  ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();
  assert.equal(calls,2);assert.equal(ui.defeated,false);
});

test('an old asynchronous action cannot close a newer defeat screen',async()=>{
  const ui=new GameUI();let finish!:()=>void;
  ui.showDefeat({restore:()=>new Promise<void>(resolve=>finish=resolve)});
  ui.selectDefeatAction('checkpoint');const pending=ui.confirmDefeat();ui.closeDefeat();
  ui.showDefeat({restore:()=>{}});
  finish();await pending;assert.equal(ui.defeated,true);assert.equal(ui.locked,true);
  ui.suspended=true;ui.selectDefeatAction('checkpoint');await ui.confirmDefeat();assert.equal(ui.defeatState!.confirmation,undefined);
});

test('a new wipeout replaces a stale defeat flow instead of being ignored',()=>{
  const ui=new GameUI();
  ui.showDefeat({restore:()=>{}});
  ui.showDefeat({restore:()=>{}});
  assert.equal(ui.defeated,true);
  assert.equal(ui.locked,true);
});

test('the defeat screen hands off to the load page and restores itself when the page closes',()=>{
  const ui=new GameUI();let opened=0;
  ui.showDefeat({restore:()=>{},load:()=>{opened++;return true;}});
  ui.selectDefeatAction('load');
  assert.equal(opened,1);
  assert.equal(ui.defeated,true,'阵亡流程还在');
  assert.equal(!!ui.defeatState,false,'读档页打开时不再画阵亡面板');
  assert.equal(ui.locked,false,'读档页需要能打开菜单');
  ui.revealDefeat();
  assert.ok(ui.defeatState);
  assert.equal(ui.locked,true);
});

test('a load page that cannot open leaves the defeat screen usable',()=>{
  for(const load of [()=>false,()=>{throw new Error('no ui');}]){
    const ui=new GameUI();
    ui.showDefeat({restore:()=>{},load});
    ui.selectDefeatAction('load');
    assert.ok(ui.defeatState,'打开失败要回到阵亡面板');
    assert.equal(ui.locked,true);
    ui.selectDefeatAction('checkpoint');
    assert.equal(ui.defeatState!.confirmation,'checkpoint');
  }
});
