import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameUI } from '../src/ui/game-ui.ts';
import { StoryApp } from '../src/app.ts';

test('releaseResidentCombat releases once and clears the session stamp', () => {
  const app = new StoryApp({} as GameUI);
  let released = 0;
  app.residentCombatAssets = { release: () => { released++; } };
  app.residentCombatClassId = 'warlock';
  app.residentCombatReady = true;
  app.releaseResidentCombat();
  assert.equal(released, 1);
  assert.equal(app.residentCombatAssets, undefined);
  assert.equal(app.residentCombatClassId, undefined);
  assert.equal(app.residentCombatReady, false);
  app.releaseResidentCombat();
  assert.equal(released, 1, '重复释放必须是幂等的');
});

test('session release clears old gameplay owners and ignores a delayed callback for a replaced session', () => {
  const app = new StoryApp({} as GameUI);
  const old = {} as StoryApp['session'], current = {} as StoryApp['session'];
  let disposed = 0, poolDestroyed = 0, cacheCleared = 0;
  app.session = current;
  app.director = { dispose() { disposed++; } } as StoryApp['director'];
  app.outfits = { destroy() { poolDestroyed++; } } as NonNullable<StoryApp['outfits']>;
  app.content.clearSessionCaches = () => { cacheCleared++; };
  assert.equal(app.releaseSession(old), false);
  assert.equal(app.session, current);
  assert.deepEqual([disposed, poolDestroyed, cacheCleared], [0, 0, 0]);
  assert.equal(app.releaseSession(current), true);
  assert.equal(app.session, undefined);
  assert.equal(app.director, undefined);
  assert.equal(app.outfits, undefined);
  assert.equal(app.checkpoint.available, false);
  assert.deepEqual([disposed, poolDestroyed, cacheCleared], [1, 1, 1]);
  assert.equal(app.releaseSession(current), false);
});

test('debug catalog releases only after active users finish and reloads when needed',async()=>{
  const app=new StoryApp({} as GameUI);
  app.campaign={} as StoryApp['campaign'];
  let loads=0,clears=0;
  app.content.storyDebug=async()=>{loads++;return {tasks:[]} as NonNullable<StoryApp['campaign']['debugStory']>;};
  app.content.releaseStoryDebug=()=>{clears++;};
  const first=await app.acquireDebugCatalog(),second=await app.acquireDebugCatalog();
  assert.equal(loads,1);app.releaseDebugCatalog();
  first();assert.ok(app.campaign.debugStory,'进行中的跳转仍能读取现场表');
  second();assert.equal(app.campaign.debugStory,undefined);assert.equal(clears,1);
  second();assert.equal(clears,1,'重复释放不影响引用计数');
  const third=await app.acquireDebugCatalog();assert.equal(loads,2);
  app.releaseDebugCatalog();third();assert.equal(app.campaign.debugStory,undefined);
});

test('a catalog load that finishes after release cannot restore discarded data',async()=>{
  const app=new StoryApp({} as GameUI);app.campaign={} as StoryApp['campaign'];
  let finish!:(value:NonNullable<StoryApp['campaign']['debugStory']>)=>void;
  app.content.storyDebug=()=>new Promise(resolve=>{finish=resolve;});
  const pending=app.loadDebugCatalog();app.releaseDebugCatalog();finish({tasks:[]});await pending;
  assert.equal(app.campaign.debugStory,undefined);
});

test('closing while a catalog is loading defers release until the active request finishes',async()=>{
  const app=new StoryApp({} as GameUI);app.campaign={} as StoryApp['campaign'];
  let finish!:(value:NonNullable<StoryApp['campaign']['debugStory']>)=>void;
  app.content.storyDebug=()=>new Promise(resolve=>{finish=resolve;});
  const pending=app.acquireDebugCatalog();app.releaseDebugCatalog();finish({tasks:[]});
  const release=await pending;
  assert.ok(app.campaign.debugStory,'完成前不能中断预览或跳转');
  release();assert.equal(app.campaign.debugStory,undefined);
});
