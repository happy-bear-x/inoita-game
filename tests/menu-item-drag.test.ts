import test from 'node:test';
import assert from 'node:assert/strict';
import { MenuItemDrag } from '../src/ui/menu-item-drag.ts';
import type { UiPointer } from '../src/ui/dom/node.ts';

const pointer=(id=1,x=10,y=20)=>({id,x,y,isDown:true} as UiPointer);

function setup(){
  const timers:{ms:number;run:()=>void;removed:boolean}[]=[];
  let suspended=false;
  let cancelledScroll=0,activated=0,destroyed=0;
  const positions:[number,number][]=[];
  const drops:{entry:string;pointer:UiPointer}[]=[];
  const drag=new MenuItemDrag({
    delay:(ms,run)=>{const timer={ms,run,removed:false};timers.push(timer);return {remove:()=>{timer.removed=true;}};},
    movementThreshold:()=>16,
    suspended:()=>suspended,
  });
  const gesture={entry:'sword',scroll:{contains:()=>true,cancelGesture:()=>{cancelledScroll++;}},
    activate:()=>{activated++;return {setPosition:(x:number,y:number)=>positions.push([x,y]),destroy:()=>{destroyed++;}};},
    drop:(entry:string,pointer:UiPointer)=>{drops.push({entry,pointer});},
  };
  return {drag,gesture,timers,positions,drops,setSuspended:()=>{suspended=true;},
    counts:()=>({cancelledScroll,activated,destroyed})};
}

test('short press leaves click available and does not drop',()=>{
  const s=setup();s.drag.start(pointer(),s.gesture);
  assert.equal(s.timers[0].ms,350);
  s.drag.end(pointer());
  assert.equal(s.drag.suppressClick,false);
  assert.equal(s.drops.length,0);
  assert.equal(s.timers[0].removed,true);
  s.timers[0].run();
  assert.equal(s.counts().activated,0);
});

test('long press cancels scrolling, moves its ghost and drops once after cleanup',()=>{
  const s=setup();s.drag.start(pointer(),s.gesture);s.timers[0].run();
  assert.equal(s.drag.suppressClick,true);
  assert.deepEqual(s.counts(),{cancelledScroll:1,activated:1,destroyed:0});
  s.drag.move(pointer(2,30,40));s.drag.end(pointer(2));
  assert.deepEqual(s.positions,[]);assert.equal(s.drops.length,0);
  s.drag.move(pointer(1,30,40));s.drag.end(pointer(1,30,40));s.drag.end(pointer());
  assert.deepEqual(s.positions,[[30,40]]);
  assert.equal(s.counts().destroyed,1);
  assert.equal(s.drops.length,1);assert.equal(s.drops[0].entry,'sword');
  assert.equal(s.drag.suppressClick,true);
  s.drag.start(pointer(),s.gesture);assert.equal(s.drag.suppressClick,false);
});

test('movement before long press respects screen scale and cancels the gesture',()=>{
  const s=setup();s.drag.start(pointer(),s.gesture);
  s.drag.move(pointer(2,100,100));assert.equal(s.timers[0].removed,false);
  s.drag.move(pointer(1,26,20));assert.equal(s.timers[0].removed,false);
  s.drag.move(pointer(1,27,20));assert.equal(s.timers[0].removed,true);
  s.timers[0].run();assert.equal(s.counts().activated,0);
});

test('cancel removes ghost without dropping or allowing the synthetic click',()=>{
  const s=setup();s.drag.start(pointer(),s.gesture);s.timers[0].run();
  s.drag.cancel();s.drag.cancel();s.drag.end(pointer());
  assert.equal(s.counts().destroyed,1);assert.equal(s.drops.length,0);
  assert.equal(s.drag.suppressClick,true);
});

test('replaced timer cannot activate the new drag, and suspension cancels pending work',()=>{
  const s=setup();s.drag.start(pointer(),s.gesture);s.drag.start(pointer(2),s.gesture);
  s.timers[0].run();assert.equal(s.counts().activated,0);
  s.setSuspended();s.timers[1].run();assert.equal(s.counts().activated,0);
  assert.equal(s.timers[1].removed,true);assert.equal(s.drag.suppressClick,false);
});

test('activation that leaves the page cleans up the returned ghost',()=>{
  const s=setup();const activate=s.gesture.activate;
  s.drag.start(pointer(),{...s.gesture,activate:()=>{s.drag.cancel();return activate();}});
  s.timers[0].run();s.drag.end(pointer());
  assert.equal(s.counts().destroyed,1);assert.equal(s.drops.length,0);
});

test('pointer outside scroll does not replace an existing gesture',()=>{
  const s=setup();s.drag.start(pointer(),s.gesture);
  s.drag.start(pointer(2),{...s.gesture,scroll:{...s.gesture.scroll,contains:()=>false}});
  assert.equal(s.timers.length,1);assert.equal(s.timers[0].removed,false);
  s.timers[0].run();s.drag.end(pointer());assert.equal(s.drops.length,1);
});
