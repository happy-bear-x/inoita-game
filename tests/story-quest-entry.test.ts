import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Campaign, CampaignQuest } from '../src/domain/campaign.ts';
import type { ActorDefinition, EntityPlacement } from '../src/domain/content.ts';
import type { ItemCatalog } from '../src/domain/items.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { storyConditionReferences } from '../src/domain/story-condition.ts';

const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8')) as T;
const campaign = read<Campaign>('campaign');
const items = read<ItemCatalog>('items');
const actors = read<{ actors: Record<string, ActorDefinition> }>('world').actors;

function harness(id: string) {
  const quest = campaign.quests.find(candidate => candidate.id === id)!;
  assert.ok(quest, `${id} 必须进入正式内容`);
  // 本用例只检查 NPC 接取与 prepare 发物品。前置作为已完成的剧情节点提供，整章走法另行验证。
  const prerequisites: CampaignQuest[] = [...storyConditionReferences(quest.availableWhen).quests].map(previous => ({
    id: previous, title: previous, description: previous, completion: 'story', goals: [],
    guidance: { available: previous, active: previous }, progressText: previous, completeText: previous
  }));
  const content: Campaign = { ...campaign, quests: [...prerequisites, quest], events: [], questGroups: [] };
  const session = new Session(content, undefined, undefined, items);
  for (const previous of prerequisites) {
    assert.equal(session.accept(previous.id), true);
    session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: previous.id } }]);
  }
  const ui: StoryUI = {
    async dialogue() {}, async choice(_prompt, options) { return options[0]; },
    async questPopup() {}, closeDialogue() {}, skipDialogue() {}, toast() {}
  };
  const director = new StoryDirector(content, session, ui, () => {});
  return { quest, session, director };
}

// 原版 QUESTINFOBASE[242]：+4=412，type=5，prepare 发 ITEMDATABASE 的暗精灵要塞钥匙。
// [336]：+4=473，type=5；其后事件591检查任务336进行中。原生菜单消费者见 findings145。
for (const [id, characterId] of [['quest-242', 'npc-412'], ['quest-336', 'npc-473']] as const) {
  test(`${id} can be accepted from its native giver while story events own completion`, async () => {
    const { quest, session, director } = harness(id);
    assert.equal(quest.completion, 'story');
    assert.equal(quest.giverCharacterId, characterId);
    assert.ok(quest.giver);
    assert.equal(session.status(id), 'available');
    assert.deepEqual(session.forActor(quest.giver, characterId).map(candidate => candidate.id), [id]);
    assert.deepEqual(session.forActor(quest.giver, 'different-character'), [], '外观相同不能冒充接取人');
    const entity: EntityPlacement = { id: 'giver', actor: quest.giver, characterId, x: 40, y: 40 };
    try {
      assert.equal(await director.interact(entity, actors[quest.giver]), true);
      assert.equal(session.status(id), 'active', '从 NPC 接取后等待剧情，而非立即交付');
      if (id === 'quest-242') {
        assert.deepEqual(quest.onAcceptItems, [{ item: 'drow-s-key', quantity: 1 }]);
        assert.equal(session.itemCount('drow-s-key'), 1, '接取必须实际发放开门钥匙');
        await director.interact(entity, actors[quest.giver]);
        assert.equal(session.itemCount('drow-s-key'), 1, '进行中再次交互不重复发钥匙');
      }
    } finally {
      director.dispose();
    }
  });
}

test('script admission and a native NPC menu coexist for a story quest', () => {
  // 任务56也有原版+4接取人196；事件73的0x09 state1不能删掉NPC的合法接取入口。
  const quest = campaign.quests.find(candidate => candidate.id === 'quest-56')!;
  assert.equal(quest.completion, 'story');
  assert.equal(quest.giverCharacterId, 'npc-196');
  assert.ok(campaign.scripts['event-73'].nodes.some(node => node.commands.some(command => command.type === 'quest'
    && command.command.type === 'accept' && command.command.quest === quest.id)));
  // 任务177的+4为-1，接取继续由事件201执行，保持原版的无菜单通路。
  const eventOnly = campaign.quests.find(candidate => candidate.id === 'quest-177')!;
  assert.equal(eventOnly.giver, undefined);
  assert.equal(eventOnly.completion, 'story');
  assert.ok(campaign.scripts['event-201'].nodes.some(node => node.commands.some(command => command.type === 'quest'
    && command.command.type === 'accept' && command.command.quest === eventOnly.id)));
});

for (const [origin, successor, sameNpc] of [
  ['quest-45', 'quest-67', false], ['quest-10', 'quest-11', true]
] as const) {
  test(`handover ${origin} only offers ${successor} automatically when the native NPC matches`, async () => {
    const quests = [origin, successor].map(id => campaign.quests.find(quest => quest.id === id)!);
    const previous = [...new Set(quests.flatMap(quest => [...storyConditionReferences(quest.availableWhen).quests]))]
      .filter(id => !quests.some(quest => quest.id === id));
    const prerequisites: CampaignQuest[] = previous.map(id => ({
      id, title: id, description: id, completion: 'story', goals: [],
      guidance: { available: id, active: id }, progressText: id, completeText: id
    }));
    const content = { ...campaign, quests: [...prerequisites, ...quests], events: [], questGroups: [] };
    const session = new Session(content, undefined, undefined, items);
    const ui: StoryUI = {
      async dialogue() {}, async choice(_prompt, options) { return options[0]; },
      async questPopup() {}, closeDialogue() {}, skipDialogue() {}, toast() {}
    };
    const director = new StoryDirector(content, session, ui, () => {});
    const interact = (actor: string, characterId: string) => director.interact(
      { id: characterId, actor, characterId, x: 40, y: 40 }, actors[actor]);
    try {
      for (const id of previous) {
        session.accept(id);
        session.applyStoryCommands([{ type: 'quest', command: { type: 'script-complete', quest: id } }]);
      }
      assert.equal(session.accept(origin), true);
      assert.equal(session.status(origin), 'ready', '首次接取即待交付');
      await interact(quests[0].delivery!, quests[0].deliveryCharacterId!);
      assert.equal(session.status(origin), 'completed');
      if (!sameNpc) {
        assert.equal(session.status(successor), 'available', '前置完成只解锁，不代替去找其他接取人');
        assert(session.forActor(quests[1].giver!, quests[1].giverCharacterId).some(quest => quest.id === successor));
        await interact(quests[1].giver!, quests[1].giverCharacterId!);
      }
      assert.equal(session.status(successor), 'active');
    } finally {
      director.dispose();
    }
  });
}
