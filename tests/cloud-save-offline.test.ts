import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudSaveClient, type CloudSessionStore } from '../src/application/cloud-save.ts';
import { SAVE_FORMAT, SaveSlots, type SaveStorage } from '../src/domain/save-game.ts';

function storage():SaveStorage & { entries:Map<string,string> } {
  const entries=new Map<string,string>();
  return {entries,getItem:key=>entries.get(key)??null,setItem:(key,value)=>{entries.set(key,value);},removeItem:key=>{entries.delete(key);}};
}

function game():unknown {
  return {
    format:SAVE_FORMAT,
    summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'p.png',level:1,mapId:'map',mapName:'营地'},
    session:{money:1},
    world:{location:{map:'map'}},
  };
}

test('a broken cloud client never blocks local save reads or writes',async()=>{
  const local=storage();
  const saves=new SaveSlots(local);
  saves.write(0,game() as never);
  const broken:CloudSessionStore={
    read(){throw new Error('storage denied');},
    write(){throw new Error('storage denied');},
    clear(){throw new Error('storage denied');},
  };
  const client=new CloudSaveClient({
    baseUrl:'https://cloud.example/__cloud',
    storage:broken,
    fetch:async()=>{throw new Error('offline');},
  });
  const result=await client.list();
  assert.equal(result.ok,false);if(result.ok)return;
  assert.equal(result.error.code,'network');
  assert.equal(saves.inspect(0).kind,'ok','本地存档仍可读');
  saves.write(1,game() as never);
  assert.equal(saves.inspect(1).kind,'ok','本地存档仍可写');
});

test('an APK page without an injected endpoint reports unsupported without sending a request',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{value:{hostname:'appassets.androidplatform.net'},configurable:true});
  let calls=0;
  try{
    const client=new CloudSaveClient({
      storage:{read:()=>undefined,write:()=>{},clear:()=>{}},
      fetch:async()=>{calls+=1;return new Response('{}');},
    });
    const result=await client.list();
    assert.equal(result.ok,false);if(result.ok)return;
    assert.equal(result.error.code,'unsupported');
    assert.equal(calls,0,'没有地址时不发无意义请求');
  }finally{
    if(descriptor)Object.defineProperty(globalThis,'location',descriptor);
    else delete (globalThis as {location?:unknown}).location;
  }
});
