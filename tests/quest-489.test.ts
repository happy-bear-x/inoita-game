import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseCampaign, parseItemCatalog, parseWorld } from '../src/application/content-validation.ts';
import { Session } from '../src/domain/session.ts';
import { StoryDirector, type StoryUI } from '../src/domain/story-director.ts';
import { questPopupContent } from '../src/ui/quest-popup-layout.ts';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../public/content/${file}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign')), items = parseItemCatalog(read('items')), world = parseWorld(read('world'));
const quest = campaign.quests.find(value => value.id === 'quest-489')!;

function visit(session: Session, map: string) {
  session.applyStoryCommands([{ type: 'travel', destination: { map, x: 120, y: 120, facing: 'south' } }]);
  session.enterMap(map);
}

function setup() {
  const session = new Session(campaign, undefined, undefined, items), events: string[] = [], lines: string[] = [];
  visit(session, 'berkel-capital');
  const luna = session.storyWorld.projectEntities('berkel-capital', []).find(entity => entity.characterId === 'npc-651')!;
  assert.equal(luna.actor, 'busybody-luna');
  const ui: StoryUI = {
    async dialogue(line) { lines.push(line.text); },
    async choice() { throw new Error('评价任务不再提供是／否选择'); },
    async questPopup(kind) { events.push(`${kind}:${session.status(quest.id)}`); },
    toast() {}, closeDialogue() {}, skipDialogue() {},
  };
  const director = new StoryDirector(campaign, session, ui, () => {});
  return { session, director, luna, events, lines };
}

test('the review quest is a fan-work note with a Bilibili name and no external URL', () => {
  assert.match(quest.description, /同人作品/);
  assert.match(quest.description, /夏日的晚风踩着云朵/);
  assert.doesNotMatch(quest.description, /https?:\/\//);
  assert.equal((quest as unknown as Record<string, unknown>).specialAction, undefined);
  assert.equal((quest as unknown as Record<string, unknown>).reviewInvitation, undefined);
  const offer = questPopupContent('start', quest, undefined, id => id);
  assert.equal(offer.body, quest.description);
  assert.doesNotMatch(offer.body, /https?:\/\//);
});

test('accepting makes the quest ready without opening a page; the second talk completes it without the reserved reward', async () => {
  const { session, director, luna, events, lines } = setup();
  try {
    await director.interact(luna, world.actors[luna.actor]);
    assert.equal(session.status(quest.id), 'ready');
    assert.deepEqual(events, ['start:available']);
    assert.equal(session.itemCount('elixir'), 0);
    assert.ok(session.storyWorld.visible(luna.id));

    await director.interact(luna, world.actors[luna.actor]);
    assert.equal(session.status(quest.id), 'completed');
    assert.equal(session.itemCount('elixir'), 0);
    assert.equal(events.at(-1), 'complete:completed');
    assert.equal(lines.at(-1), quest.completeText);
    assert.match(lines.at(-1)!, /同人作品/);
  } finally { director.dispose(); }
});

test('a ready quest places the delivery NPC again after a map visit, then removes it after completion', async () => {
  const { session, director, luna } = setup();
  try {
    await director.interact(luna, world.actors[luna.actor]);
    assert.equal(session.status(quest.id), 'ready');
    visit(session, 'shadow-camp');
    visit(session, 'berkel-capital');
    const again = session.storyWorld.projectEntities('berkel-capital', []).find(entity => entity.characterId === 'npc-651');
    assert.ok(again, '待交付时重新进图仍要找到露娜');
    await director.interact(again, world.actors[again.actor]);
    assert.equal(session.status(quest.id), 'completed');
    visit(session, 'shadow-camp');
    visit(session, 'berkel-capital');
    assert.equal(session.storyWorld.projectEntities('berkel-capital', []).some(entity => entity.characterId === 'npc-651'), false, '任务完成后不再生成');
  } finally { director.dispose(); }
});
