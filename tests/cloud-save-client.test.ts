import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CloudSaveClient,
  type CloudSaveEntry,
  type CloudSession,
  type CloudSessionStore,
} from '../src/application/cloud-save.ts';
import { SAVE_FORMAT } from '../src/domain/save-game.ts';

interface Call { url:string; init:RequestInit }
interface FakeFetch { fetch:typeof fetch; calls:Call[] }

function fakeFetch(handler:(call:Call)=>Response|Promise<Response>):FakeFetch {
  const calls:Call[]=[];
  const fetchImpl=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
    const call={url:String(input),init:init??{}};
    calls.push(call);
    return handler(call);
  };
  return {fetch:fetchImpl as typeof fetch,calls};
}

function json(value:unknown,status=200):Response {
  return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
}

interface MemorySessionStore extends CloudSessionStore { value?:CloudSession }
function memoryStore():MemorySessionStore {
  let value:CloudSession|undefined;
  return {
    get value(){return value;},
    read(){return value;},
    write(session){value=session;},
    clear(){value=undefined;},
  };
}

const base='https://cloud.example/__cloud';
const validToken='t'.repeat(43);

const entry:CloudSaveEntry={
  slot:0,format:SAVE_FORMAT,bytes:10,updatedAt:1,
  summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'p.png',level:2,mapId:'camp',mapName:'营地'},
};
const game={format:SAVE_FORMAT,summary:entry.summary,session:{money:1},world:{}};

test('login stores the session and sends the expected request',async()=>{
  const store=memoryStore();
  const fake=fakeFetch(call=>{
    assert.equal(call.url,`${base}/login`);
    assert.equal(call.init.method,'POST');
    assert.deepEqual(JSON.parse(String(call.init.body)),{account:'Player_1',password:'secret1'});
    return json({account:'Player_1',token:validToken,expiresAt:123});
  });
  const client=new CloudSaveClient({baseUrl:base,fetch:fake.fetch,storage:store});
  const result=await client.login('Player_1','secret1');
  assert.ok(result.ok);
  assert.equal(client.loggedIn,true);
  assert.equal(client.account,'Player_1');
  assert.equal(store.value?.token,validToken);
});

test('an authenticated 401 clears the token while a network error keeps it',async()=>{
  const store=memoryStore();
  let offline=false;
  const fake=fakeFetch(call=>{
    if(call.url.endsWith('/login'))return json({account:'Player_1',token:validToken,expiresAt:1});
    if(offline)throw new Error('offline');
    return json({error:'unauthorized',message:'登录已失效'},401);
  });
  const client=new CloudSaveClient({baseUrl:base,fetch:fake.fetch,storage:store});
  assert.ok((await client.login('Player_1','secret1')).ok);
  const expired=await client.list();
  assert.equal(expired.ok,false);if(expired.ok)return;
  assert.equal(expired.error.code,'unauthorized');
  assert.equal(client.loggedIn,false);
  assert.equal(store.value,undefined);

  assert.ok((await client.login('Player_1','secret1')).ok);
  offline=true;
  const failed=await client.list();
  assert.equal(failed.ok,false);if(failed.ok)return;
  assert.equal(failed.error.code,'network');
  assert.equal(client.loggedIn,true,'网络错误不清 token');
});

test('locked responses become a readable 15-minute message',async()=>{
  const fake=fakeFetch(()=>json({error:'locked',retryAfterSeconds:900,remainingAttempts:0},423));
  const client=new CloudSaveClient({baseUrl:base,fetch:fake.fetch,storage:memoryStore()});
  const result=await client.login('Player_1','secret1');
  assert.equal(result.ok,false);if(result.ok)return;
  assert.equal(result.error.code,'locked');
  assert.match(result.error.message,/15 分钟/);
  assert.equal(result.error.retryAfterSeconds,900);
});

test('non-HTTPS absolute endpoints are rejected without sending a request',async()=>{
  const fake=fakeFetch(()=>json({}));
  const client=new CloudSaveClient({baseUrl:'http://cloud.example/__cloud',fetch:fake.fetch,storage:memoryStore()});
  const result=await client.list();
  assert.equal(result.ok,false);if(result.ok)return;
  assert.equal(result.error.code,'unsupported');
  assert.equal(fake.calls.length,0);
});

test('upload sends the bearer token and download returns the cloud game',async()=>{
  const fake=fakeFetch(call=>{
    if(call.url.endsWith('/login'))return json({account:'Player_1',token:validToken,expiresAt:1});
    if(call.init.method==='PUT')return json(entry);
    return json(game);
  });
  const client=new CloudSaveClient({baseUrl:base,fetch:fake.fetch,storage:memoryStore()});
  assert.ok((await client.login('Player_1','secret1')).ok);
  const uploaded=await client.upload(0,game);
  assert.ok(uploaded.ok);
  assert.deepEqual(uploaded.value,entry);
  const put=fake.calls[1]!;
  const headers=put.init.headers as Record<string,string>;
  assert.equal(headers.Authorization,`Bearer ${validToken}`);
  assert.deepEqual(JSON.parse(String(put.init.body)),game);
  const downloaded=await client.download(0);
  assert.ok(downloaded.ok);
  assert.deepEqual(downloaded.value,game);
});

test('storage failures only lose persistence, not the in-memory session',async()=>{
  const storage:CloudSessionStore={
    read(){throw new Error('denied');},
    write(){throw new Error('denied');},
    clear(){throw new Error('denied');},
  };
  const fake=fakeFetch(()=>json({account:'Player_1',token:validToken,expiresAt:1}));
  const client=new CloudSaveClient({baseUrl:base,fetch:fake.fetch,storage});
  assert.equal(client.loggedIn,false);
  assert.ok((await client.login('Player_1','secret1')).ok);
  assert.equal(client.loggedIn,true);
  client.forget();
  assert.equal(client.loggedIn,false);
});
