import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
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
