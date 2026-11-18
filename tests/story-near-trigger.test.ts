import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign, parseWorld } from '../src/application/content-validation.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { Session } from '../src/domain/session.ts';
import type { ChoiceOption } from '../src/domain/content.ts';
import type { Campaign } from '../src/domain/campaign.ts';
import type { PerformanceAction } from '../src/domain/story-performance.ts';

/**
 * 近身触发：原版 `near_npc_field` 的判据是 `PLAYER_pNearNPC + 0xa == param2`，
 * 也就是「玩家身边那个对象正是它」；「身边」由 `PLAYER_DoCheckNearNPC` 按曼哈顿 24 px 选出
 * （findings 94）。地图号、NPC 号与任务条件都从 EVTCONDBASE 解出，钉在这里。
 */
const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign')), world = parseWorld(read('world'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(content: Campaign = campaign) {
  const session = new Session(content), actions: PerformanceAction[] = [];
  let choose: ((option: ChoiceOption) => void) | undefined;
  const ui: StoryUI = {
    async dialogue() {}, choice: () => new Promise(resolve => { choose = resolve; }),
    async questPopup() {}, closeDialogue() {}, skipDialogue() {}, toast() {}
  };
  const director = new StoryDirector(content, session, ui, () => {}, {
    begin() {}, async execute(action) { actions.push(action); }, async finish() {}
  });
  return { session, director, actions, choose: (value: string) => choose!({ label: value, value }) };
}

const nearEvents = campaign.events.filter(event => event.source === 'near');

test('near triggers name an actor that stands somewhere and, when given, a real map', () => {
  assert.ok(nearEvents.length > 0, '应存在近身触发的事件');
  for (const event of nearEvents) {
    assert.ok(event.near, `${event.id} 的近身触发必须点名一个角色`);
    assert.ok(world.actors[event.near!], `${event.id} 点名的角色不在角色表里：${event.near}`);
    if (event.map !== undefined) assert.ok(world.maps.some(map => map.id === event.map), `${event.id} 的地图不存在：${event.map}`);
  }
});

test('event 351 keeps the native character and quest condition without adding a map restriction', () => {
  const event = nearEvents.find(candidate => candidate.id === 'event-351');
  assert.ok(event, '事件 351 应由近身触发');
  // EVTCONDBASE 事件 351：type2 param2=325（任务 325 进行中）+ type3 param1=2 param2=120
  // → NPCINFOBASE 120 = 浓雾村庄空地的路障（source-map 的 barricade-a1eb664e）。
  assert.equal(event!.near, 'barricade-a1eb664e');
  assert.equal(event!.nearCharacterId, 'npc-120');
  assert.equal(event!.map, undefined);
  assert.deepEqual(event!.condition, { type: 'all', conditions: [{ type: 'quest', quest: 'quest-325', status: 'active' }] });
});

test('approaching the named character plays the event; another character or a failing condition does not', async () => {
  const h = harness();
  const map = 'mist-village-clearings-c1defcd5';
  const event = nearEvents.find(event => event.id === 'event-351')!;
  const barricade = {id:'barricade',actor:'barricade-a1eb664e',characterId:'npc-120'};
  h.session.applyStoryCommands([{type:'travel',destination:{map,x:232,y:232,facing:'north'}}]);
  assert.equal(await h.director.approach(event, barricade, map), false, '任务还没接取时不上演');
  h.session.accept('quest-325');
  h.session.applyStoryCommands([{ type: 'item-give', item: 'sealed-dungeon-key-1', quantity: 1 }]);
  assert.equal(await h.director.approach(event, {...barricade, characterId:'npc-121'}, 'shadow-hall'), false, '外观相同的另一名人物不算');
  assert.equal(await h.director.approach(event, {...barricade, characterId:'another-barricade'}, map), false);
  const played = h.director.approach(event, barricade, map);
  await tick();
  assert.equal(await played, true, '走到指定角色旁边即上演');
  assert.equal(h.session.itemCount('sealed-dungeon-key-1'), 0, '上演的是原版那段：交掉地下城钥匙');
  assert.ok(h.director.runtime.snapshot().completedEvents.includes('event-351'));
});
