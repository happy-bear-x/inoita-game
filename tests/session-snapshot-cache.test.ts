import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Session} from '../src/domain/session.ts';
import {BattleCharacter,type CharacterStatsCatalog} from '../src/domain/character-stats.ts';
import type {BattleCatalog} from '../src/domain/battle.ts';
import type {Campaign} from '../src/domain/campaign.ts';
import type {ItemCatalog} from '../src/domain/items.ts';

const read=<T>(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8')) as T;

function fixture(){
  const battle=read<BattleCatalog>('battle'),items=read<ItemCatalog>('items'),stats=read<CharacterStatsCatalog>('character-stats');
  const hero=new BattleCharacter('dark-knight',stats,items);
  const session=new Session(read<Campaign>('campaign'),undefined,undefined,items,hero,battle);
  return {session,items};
}

test('persistent snapshots reuse unchanged subsystem clones',()=>{
  const {session,items}=fixture();
  const first=session.capturePersistentState();
  const second=session.capturePersistentState();
  assert.notEqual(second,first,'顶层状态每次仍是新对象');
  assert.equal(second.storyWorld,first.storyWorld,'剧情世界没变时复用');
  assert.equal(second.bag,first.bag,'背包没变时复用');
  assert.equal(second.enemies,first.enemies,'敌人状态没变时复用');
  assert.equal(second.receipts,first.receipts,'收据没变时复用');
  assert.equal(second.chests,first.chests,'宝箱访问没变时复用');
  assert.equal(second.questBook,first.questBook,'任务簿没变时复用');
  assert.equal(second.groundLoot,first.groundLoot,'地面掉落没变时复用');

  session.bag.add(items.startingShortcut!);
  const third=session.capturePersistentState();
  assert.notEqual(third.bag,first.bag,'背包变化后重新克隆');
  assert.equal(third.storyWorld,first.storyWorld,'没变的世界继续复用');
});

test('a settled reward invalidates the cached receipt snapshot',()=>{
  const {session}=fixture();
  const before=session.capturePersistentState();
  assert.equal(session.accept('quest-61'),true);
  assert.equal(session.complete('quest-61'),true);
  const after=session.capturePersistentState();
  assert.notEqual(after.receipts,before.receipts,'结算后重新克隆收据');
  assert.deepEqual(after.receipts.map(receipt=>receipt.quest),['quest-61']);
});

test('restoring a snapshot clears the cache so the next capture is fresh',()=>{
  const {session}=fixture();
  const before=session.capturePersistentState();
  session.restoreState(before);
  const after=session.capturePersistentState();
  assert.notEqual(after.bag,before.bag);
  assert.notEqual(after.storyWorld,before.storyWorld);
  assert.notEqual(after.enemies,before.enemies);
});
