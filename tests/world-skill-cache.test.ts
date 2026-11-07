import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import type {WardrobeCatalog} from '../src/domain/wardrobe.ts';
import {playerCombatAssets} from '../src/rendering/combat-assets.ts';
import {loadSceneAssets,missingSceneAssets} from '../src/rendering/scene-assets.ts';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');
hook.deregister();

const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;

function fixture(){
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(read<Campaign>('campaign'),undefined,undefined,items,hero,battle);
  const host=Object.assign(Object.create(WorldCombat.prototype),{
    app:{battleCatalog:battle,items,session},hero,
    passivesCache:new Map(),skillTableCache:new Map(),equipmentRecoveryCache:new Map(),combatProcsCache:new Map(),
    closed:false,
    playerSkillSignature:'',playerSkillGate:'',allySkillSignatures:new Map(),allySkillGates:new Map(),
    skillAssetFailures:new Map(),skillAssetRefreshRunning:false,skillAssetRefreshQueued:false,
    scene:{player:{actor:{id:'hero'}},time:{now:0,delayedCall:()=>({remove(){}})}},
    memberOf:(id:string)=>id==='player'?hero:session.party?.get(id),
    skillConfiguration:(id:string,member:{skills:unknown})=>id==='player'?session.skills:member.skills,
    conditions:{hasState:()=>false},
  });
  const invoke=(name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
  return {session,host,invoke};
}

test('party passives are reused until a real input changes',()=>{
  const {session,host,invoke}=fixture();
  const before=session.skills.draftCalls;
  const first=invoke('partyPassives','player') as unknown[];
  const afterFirst=session.skills.draftCalls;
  assert.equal(afterFirst,before+1,'第一次计算要读一次技能配置');

  const second=invoke('partyPassives','player') as unknown[];
  assert.equal(session.skills.draftCalls,afterFirst,'输入没变时不再克隆技能配置');
  assert.equal(second,first,'命中缓存时返回同一份只读结果');

  host.conditions.hasState=()=>true;
  invoke('partyPassives','player');
  assert.equal(session.skills.draftCalls,afterFirst+1,'潜行状态变化会失效一次');
});

test('skill asset refresh uses cheap gates and ignores health changes',async()=>{
  const {host,invoke}=fixture();
  const calls:unknown[][]=[];
  const anyHost=host as any;
  anyHost.refreshSkillAssets=(signature:string|undefined,gate:string,allies:unknown[])=>{
    calls.push([signature,gate,allies]);return Promise.resolve();
  };
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const schedule=()=>invoke('scheduleSkillAssetRefresh');

  schedule();await settle();
  assert.equal(calls.length,1,'第一次发现签名变化时补载一次');

  anyHost.playerSkillSignature=invoke('playerSkillSignatureNow');
  anyHost.playerSkillGate=invoke('playerSkillGateNow');
  schedule();await settle();
  assert.equal(calls.length,1,'门控和签名都没变时不重复补载');

  host.hero.setMana(1);host.hero.setHealth(host.hero.player.maxHealth-1);
  schedule();await settle();
  assert.equal(calls.length,1,'掉血回蓝不触发补载');

  host.hero.bag.addEquipped('dagger','main-hand','player');
  schedule();await settle();
  assert.equal(calls.length,2,'换武器才补载');
});


test('learning guardian while a companion owns its textures survives companion departure',async()=>{
  const {host,session,invoke}=fixture();
  const catalog=host.app.battleCatalog;
  const actor=catalog.classes.find((entry:{id:string})=>entry.id==='dark-knight')!.actor;
  host.app.wardrobe=read<WardrobeCatalog>('wardrobe');
  host.scene.player.actor=actor;
  host.extraSkillLeases=new Map();
  host.allies=[];
  const learned=new Set(['dark-strike','guardian-of-darkness']);
  session.skills.draft=()=>({levels:Object.fromEntries([...learned].map(id=>[id,1]))});
  const plan=playerCombatAssets({catalog,wardrobe:host.app.wardrobe,items:host.app.items,hero:host.hero,actor,learnedSkills:learned});
  const textures=new Set(plan.map(asset=>asset.key));
  host.scene.events=new EventEmitter();
  host.scene.textures={exists:(key:string)=>textures.has(key),get:()=>({has:()=>true}),remove:(key:string)=>textures.delete(key)};
  host.scene.anims={exists:()=>false,remove(){}};
  host.scene.load={start(){throw new Error('cached textures must not download again');}};
  const companion=await loadSceneAssets(host.scene,plan,()=>{});
  await invoke('refreshSkillAssets',invoke('playerSkillSignatureNow'),invoke('playerSkillGateNow'),[]);
  companion.release();
  assert.equal(missingSceneAssets(host.scene,plan).length,0,'主角必须独立持有已由佣兵下载的完整素材');
  invoke('releaseSkillLeases','player');
  assert.equal(textures.size,0,'最后一名使用者释放后回收贴图');
});


test('pending new skills cannot start while previously prepared skills remain available',()=>{
  const {host,invoke}=fixture();
  host.preparedSkillIds=new Map([['player',new Set(['dark-strike'])]]);
  const action=host.app.battleCatalog.skills['dark-strike'].action!;
  const mana=host.hero.player.mana;
  assert.equal(invoke('canSelectSkill','player',{id:'guardian-of-darkness',action}),false);
  assert.equal(invoke('canSelectSkill','player',{id:'dark-strike',action}),true);
  assert.equal(host.hero.player.mana,mana);
  host.preparedSkillIds.get('player').add('guardian-of-darkness');
  assert.equal(invoke('canSelectSkill','player',{id:'guardian-of-darkness',action}),true);
});
