import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGameServer } from '../tools/serve-built.ts';
import type { CloudRateLimitOptions } from '../tools/cloud-save-service.ts';
import { SAVE_FORMAT } from '../src/domain/save-game.ts';

interface Response { status:number; headers:http.IncomingHttpHeaders; body:Buffer }
interface RequestOptions { method?:string; headers?:Record<string,string>; body?:string }

function request(port:number,urlPath:string,options:RequestOptions={}):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:urlPath,method:options.method??'GET',headers:options.headers??{}},response=>{
      const chunks:Buffer[]=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);
    if(options.body)req.write(options.body);
    req.end();
  });
}

interface Fixture {
  root:string; port:number; server:http.Server;
  advance(ms:number):void;
  close():Promise<void>;
}

async function fixture(options:{cloudRateLimit?:false|CloudRateLimitOptions;cloudDataDir?:string}={}):Promise<Fixture>{
  const root=await mkdtemp(path.join(tmpdir(),'inoita-cloud-service-'));
  const dist=path.join(root,'dist');
  await mkdir(dist,{recursive:true});
  await writeFile(path.join(dist,'index.html'),'<!doctype html><title>story</title>');
  let clock=1_000_000;
  const server=createGameServer({
    projectRoot:root,
    distDir:dist,
    now:()=>clock,
    cloudRateLimit:options.cloudRateLimit??false,
    ...(options.cloudDataDir?{cloudDataDir:options.cloudDataDir}:{}),
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;
  return {
    root,port,server,
    advance(ms){clock+=ms;},
    async close(){
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      await rm(root,{recursive:true,force:true});
    },
  };
}

function post(body:unknown,extra:Record<string,string>={}):RequestOptions{
  return {method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)};
}

function game():unknown{
  return {
    format:SAVE_FORMAT,
    summary:{classId:'dark-knight',className:'黑暗骑士',portrait:'portrait.png',level:2,mapId:'camp-1',mapName:'营地'},
    session:{money:5},
    world:{location:{map:'camp-1',x:2,y:3,facing:'south'}},
  };
}

test('register, login and single-session replacement work over HTTP',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const registered=await request(f.port,'/__cloud/register',post({account:'Player_1',password:'secret1'}));
  assert.equal(registered.status,201);
  const first=JSON.parse(registered.body.toString()) as {token:string;account:string};
  assert.equal(first.account,'Player_1');
  const logged=await request(f.port,'/__cloud/login',post({account:'player_1',password:'secret1'}));
  assert.equal(logged.status,200);
  const second=JSON.parse(logged.body.toString()) as {token:string};
  const old=await request(f.port,'/__cloud/saves',{headers:{authorization:`Bearer ${first.token}`}});
  assert.equal(old.status,401);
  assert.equal(JSON.parse(old.body.toString()).error,'unauthorized');
  const fresh=await request(f.port,'/__cloud/saves',{headers:{authorization:`Bearer ${second.token}`}});
  assert.equal(fresh.status,200);
});

test('three wrong passwords return 423 and the lock survives the clock advancing less than 15 minutes',async t=>{
  const f=await fixture();t.after(()=>f.close());
  await request(f.port,'/__cloud/register',post({account:'Player_1',password:'secret1'}));
  const first=await request(f.port,'/__cloud/login',post({account:'Player_1',password:'wrong1'}));
  assert.equal(first.status,401);
  assert.equal(JSON.parse(first.body.toString()).remainingAttempts,2);
  const second=await request(f.port,'/__cloud/login',post({account:'Player_1',password:'wrong2'}));
  assert.equal(JSON.parse(second.body.toString()).remainingAttempts,1);
  const third=await request(f.port,'/__cloud/login',post({account:'Player_1',password:'wrong3'}));
  assert.equal(third.status,423);
  assert.ok((JSON.parse(third.body.toString()).retryAfterSeconds??0)>=800);
  assert.ok(Number(third.headers['retry-after'])>=800);
  assert.equal((await request(f.port,'/__cloud/login',post({account:'Player_1',password:'secret1'}))).status,423);
  f.advance(14*60*1000);
  assert.equal((await request(f.port,'/__cloud/login',post({account:'Player_1',password:'secret1'}))).status,423);
  f.advance(60*1000+1);
  assert.equal((await request(f.port,'/__cloud/login',post({account:'Player_1',password:'secret1'}))).status,200);
});

test('saves upload, list and download by slot with per-account isolation',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const registered=await request(f.port,'/__cloud/register',post({account:'Player_1',password:'secret1'}));
  const token=(JSON.parse(registered.body.toString()) as {token:string}).token;
  const auth={authorization:`Bearer ${token}`};
  const uploaded=await request(f.port,'/__cloud/saves/0',{method:'PUT',headers:{'content-type':'application/json',...auth},body:JSON.stringify(game())});
  assert.equal(uploaded.status,200);
  const listed=await request(f.port,'/__cloud/saves',{headers:auth});
  assert.equal(listed.status,200);
  const listedValue=JSON.parse(listed.body.toString()) as {account:string;saves:{slot:number;format:number}[]};
  assert.equal(listedValue.account,'Player_1');
  assert.deepEqual(listedValue.saves.map(entry=>[entry.slot,entry.format]),[[0,SAVE_FORMAT]]);
  const downloaded=await request(f.port,'/__cloud/saves/0',{headers:auth});
  assert.deepEqual(JSON.parse(downloaded.body.toString()),game());
  assert.equal((await request(f.port,'/__cloud/saves/1',{headers:auth})).status,404);
  assert.equal((await request(f.port,'/__cloud/saves/10',{headers:auth})).status,400);
});

test('CORS allows the APK origin and same-origin, rejects everything else',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const preflight=await request(f.port,'/__cloud/saves/0',{method:'OPTIONS',headers:{
    origin:'https://appassets.androidplatform.net',
    'access-control-request-method':'PUT',
    'access-control-request-headers':'authorization,content-type',
  }});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers['access-control-allow-origin'],'https://appassets.androidplatform.net');
  assert.match(String(preflight.headers['access-control-allow-headers']),/Authorization/);
  assert.match(String(preflight.headers['access-control-allow-methods']),/PUT/);
  const evil=await request(f.port,'/__cloud/saves/0',{method:'OPTIONS',headers:{
    origin:'https://evil.example',
    'access-control-request-method':'PUT',
  }});
  assert.equal(evil.status,403);
  const sameOrigin=await request(f.port,'/__cloud/register',post({account:'Same_1',password:'secret1'},{origin:`http://127.0.0.1:${f.port}`}));
  assert.equal(sameOrigin.status,201);
  assert.equal(sameOrigin.headers['access-control-allow-origin'],`http://127.0.0.1:${f.port}`);
});

test('request bodies stay bounded and require JSON',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const oversizedAuth=JSON.stringify({account:'player',password:'x'.repeat(9*1024)});
  assert.equal((await request(f.port,'/__cloud/register',{method:'POST',headers:{'content-type':'application/json'},body:oversizedAuth})).status,413);
  assert.equal((await request(f.port,'/__cloud/register',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
  const registered=await request(f.port,'/__cloud/register',post({account:'Player_1',password:'secret1'}));
  const token=(JSON.parse(registered.body.toString()) as {token:string}).token;
  const oversizedSave=JSON.stringify({...game() as Record<string,unknown>,session:{blob:'x'.repeat(2*1024*1024)}});
  const oversized=await request(f.port,'/__cloud/saves/0',{method:'PUT',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:oversizedSave});
  assert.equal(oversized.status,413);
});

test('logout invalidates the token and static files keep serving when the API is unavailable',async t=>{
  t.mock.method(console,'error',()=>{});
  const f=await fixture();t.after(()=>f.close());
  const registered=await request(f.port,'/__cloud/register',post({account:'Player_1',password:'secret1'}));
  const token=(JSON.parse(registered.body.toString()) as {token:string}).token;
  assert.equal((await request(f.port,'/__cloud/logout',{method:'POST',headers:{authorization:`Bearer ${token}`}})).status,204);
  assert.equal((await request(f.port,'/__cloud/saves',{headers:{authorization:`Bearer ${token}`}})).status,401);
  const page=await request(f.port,'/');
  assert.equal(page.status,200);

  const blockedRoot=await mkdtemp(path.join(tmpdir(),'inoita-cloud-blocked-'));
  const blocked=path.join(blockedRoot,'blocked');
  await writeFile(blocked,'not a directory');
  const degraded=await fixture({cloudDataDir:blocked});
  t.after(()=>{void rm(blockedRoot,{recursive:true,force:true});});
  try{
    assert.equal((await request(degraded.port,'/')).status,200,'静态首页不受云服务初始化失败影响');
    const cloud=await request(degraded.port,'/__cloud/saves');
    assert.equal(cloud.status,503);
    assert.equal(JSON.parse(cloud.body.toString()).error,'cloud-unavailable');
  }finally{
    await degraded.close();
  }
});

test('register rate limiting returns 429 with a retry hint',async t=>{
  const f=await fixture({cloudRateLimit:{registerPerHour:1}});t.after(()=>f.close());
  assert.equal((await request(f.port,'/__cloud/register',post({account:'Player_1',password:'secret1'}))).status,201);
  const limited=await request(f.port,'/__cloud/register',post({account:'Player_2',password:'secret2'}));
  assert.equal(limited.status,429);
  assert.equal(JSON.parse(limited.body.toString()).error,'rate-limited');
  assert.ok(Number(limited.headers['retry-after'])>0);
});
