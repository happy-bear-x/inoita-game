import assert from 'node:assert/strict';
import test from 'node:test';
import { playthrough } from './helpers/story-playthrough.ts';
import { groundLootFor } from '../src/domain/ground-loot.ts';
import { LOGIC_FRAME_MS } from '../src/domain/battle.ts';

async function uniformPlaythrough() {
  const h = playthrough();
  await h.director.start(); await h.idle();
  await h.region('event-1'); await h.region('event-2');
  await h.travel('shadow-forest-east'); await h.talk('npc-120'); await h.region('event-3');
  await h.travel('silent-cave-depths');
  await h.defeat('enemy-earl-grafton-1');
  await h.defeat('enemy-berkel-soldier-2'); await h.defeat('enemy-berkel-soldier-3');
  await h.travel('shadow-camp'); h.choices(['option-3']); await h.talk('npc-40');
  await h.travel('berkel-capital'); await h.region('event-7'); await h.talk('npc-55');
  await h.travel('shadow-hall'); await h.talk('npc-54');
  await h.travel('shadow-training-dungeon-2-a6b8293b');
  for (let count = 0; count < 5; count++) await h.defeat('enemy-reagents-1');
  await h.travel('shadow-hall'); await h.talk('npc-54');
  assert.equal(h.session.status('knight-uniform'), 'completed');
  return h;
}

test('the fusion machine collection can be completed twice using warehouse items and their native refresh', async () => {
  const h = await uniformPlaythrough();
  const warehouse = 'shadow-warehouse-364a26cb';
  const iron = () => groundLootFor(h.session).forMap(warehouse)
    .filter(drop => drop.reward.kind === 'item' && drop.reward.item === 'paillette');
  try {
    const rewardBefore = h.session.itemCount('lvl-d-weapon-combo-unit');
    for (let round = 0; round < 2; round++) {
      await h.talk('npc-576');
      assert.equal(h.session.status('quest-353'), 'active', `第${round + 1}轮正常接取`);
      await h.travel(warehouse); await h.wait(60);
      assert.equal(iron().length, 5, '任务只需要五块，仓库七个原版生成点最多刷五个');
      await h.pickup('paillette');
      assert.equal(iron().length, 4);
      await h.wait((312 + 2 * 151) * LOGIC_FRAME_MS);
      assert.equal(iron().length, 4, '背包加地面已经够五块，刷新的生成点不再多产');
      await h.pickup('paillette', 4);
      assert.equal(h.session.status('quest-353'), 'ready');
      await h.travel('shadow-hall'); await h.talk('npc-576');
      assert.equal(h.session.itemCount('paillette'), 0, '交付实际扣除五个铁块');
      // D 级武器合成套装是配方书，不在保留道具/剧情装备名单里；重复任务每轮正常发放一份。
      assert.equal(h.session.itemCount('lvl-d-weapon-combo-unit'), rewardBefore + round + 1, '每轮完成发放一份合成配方');
    }
  } finally {
    h.director.dispose();
  }
});
