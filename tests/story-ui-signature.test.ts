import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../src/domain/session.ts';
import type { SlotSummaryReading } from '../src/domain/save-game.ts';
import {
  STORY_MENU_PAGES, storyMenuSignature, storyMenuViewModel,
  type StoryMenuPage, type StoryMenuSettingsView, type StoryMenuViewModelSource
} from '../src/ui/story-ui-signature.ts';

function fixture() {
  const hero = {
    level: 5, skillPoints: 2, statPoints: 1,
    player: { level: 5, health: 10, maxHealth: 20, mana: 1, maxMana: 2, experience: 3, nextLevelExperience: 4 }
  };
  const companion = {
    level: 3, skills: { version: 2 },
    aiFrequency: new Map([['attack', 5]]),
    player: { level: 3, health: 8, maxHealth: 12, mana: 2, maxMana: 6, experience: 1, nextLevelExperience: 10 }
  };
  let reserves: string[] = [];
  const party = {
    activeIds: ['player', 'c1'], controlledId: 'player',
    groupModifiers: () => ({ experience: 10 }),
    get: (id: string) => id === 'c1' ? companion : undefined,
    snapshot: () => ({
      rosterSlots: ['c1', null, null], reserves,
      members: [
        { id: 'player', level: 5, health: 10, mana: 1, experience: 3, source: 'story' },
        { id: 'c1', level: 3, health: 8, mana: 2, experience: 1, source: 'story' }
      ]
    })
  };
  const session = {
    bag: { revision: 7 }, money: 123, skills: { version: 4 },
    questBook: { version: 9 }, debugFocusQuest: 'q1',
    hero, party
  } as unknown as Session;
  const mutable = session as unknown as {
    bag: { revision: number }; money: number; skills: { version: number };
    questBook: { version: number }; debugFocusQuest?: string;
  };
  let slotsRead = 0;
  const readings = new Map<number | 'auto', SlotSummaryReading>([
    ['auto', { kind: 'ok', summary: { classId: 'dark-knight', className: '暗骑士', portrait: 'a.png', level: 5, mapId: 'map', mapName: '地图', savedAt: 10 } }]
  ]);
  const settings: StoryMenuSettingsView = { music: 0.5, effects: 0.8, fps: true, frameRateLimit: 60, textureBatching: 'auto', criticalDecorations: true,
    fullscreen: 'available', fullscreenActive: false, controlMode: 'stick' };
  const learn = { entryId: 'book-1', selected: 'fireball', message: '' };
  const forge = { targetId: 'sword', tab: 'enchant', confirming: false };
  const debug = { noclip: false, doubleSpeed: false };
  const source = (page: StoryMenuPage): StoryMenuViewModelSource => ({
    page, selectedMemberId: 'player', session,
    slotReading: ref => { slotsRead += 1; return readings.get(ref) ?? { kind: 'empty' }; },
    settings: () => ({ ...settings }), learn: () => ({ ...learn }), forge: () => ({ ...forge }), debug: () => ({ ...debug })
  });
  return { session, mutable, hero, companion, party, readings, settings, learn, forge, debug, source,
    reserve: (id: string) => { reserves = [...reserves, id]; },
    reads: () => slotsRead };
}

test('每个页面都有非空签名，view model 标出当前页', () => {
  const f = fixture();
  for (const page of STORY_MENU_PAGES) {
    const source = f.source(page);
    const signature = storyMenuSignature(source);
    assert.equal(typeof signature, 'string');
    assert.ok(signature.length > 0, `${page} 有签名`);
    assert.equal(storyMenuViewModel(source).page, page);
  }
});

test('背包页只对背包、金钱、队员等级和成员切换变化', () => {
  const f = fixture();
  const before = storyMenuSignature(f.source('bag'));
  assert.equal(storyMenuSignature(f.source('bag')), before, '数据没变签名不变');
  f.hero.player.health -= 1;
  assert.equal(storyMenuSignature(f.source('bag')), before, '生命值不在背包页显示');
  f.mutable.bag.revision += 1;
  assert.notEqual(storyMenuSignature(f.source('bag')), before, '背包变化要重绘');
  const afterBag = storyMenuSignature(f.source('bag'));
  f.mutable.money += 1;
  assert.notEqual(storyMenuSignature(f.source('bag')), afterBag, '金钱变化要重绘');
  const afterMoney = storyMenuSignature(f.source('bag'));
  const source = f.source('bag');
  source.selectedMemberId = 'c1';
  assert.notEqual(storyMenuSignature(source), afterMoney, '换人后页面内容不同');
});

test('队伍页把候补名册也纳入签名', () => {
  const f = fixture();
  const before = storyMenuSignature(f.source('party'));
  f.reserve('c2');
  const after = storyMenuSignature(f.source('party'));
  assert.notEqual(after, before, '候补变化要重绘队伍页');
  f.hero.player.health -= 1;
  assert.notEqual(storyMenuSignature(f.source('party')), after, '上阵队员血量变化要重绘队伍页');
});

test('任务页只依赖任务簿版本和调试焦点', () => {
  const f = fixture();
  const before = storyMenuSignature(f.source('quests'));
  f.hero.player.health -= 1;
  f.mutable.bag.revision += 1;
  assert.equal(storyMenuSignature(f.source('quests')), before, '战斗与背包通知不重绘任务页');
  f.mutable.questBook.version += 1;
  assert.notEqual(storyMenuSignature(f.source('quests')), before, '任务版本变化要重绘');
  const afterVersion = storyMenuSignature(f.source('quests'));
  f.mutable.debugFocusQuest = 'q2';
  assert.notEqual(storyMenuSignature(f.source('quests')), afterVersion, '调试焦点变化要重绘');
});

test('存档页把每个槽的摘要算进签名，其他页不读存档', () => {
  const f = fixture();
  f.reads();
  storyMenuSignature(f.source('bag'));
  assert.equal(f.reads(), 0, '背包页不读取存档槽');
  const before = storyMenuSignature(f.source('save'));
  assert.ok(f.reads() > 0, '存档页读取槽摘要');
  f.readings.set(0, { kind: 'ok', summary: { classId: 'priest', className: '祭司', portrait: 'b.png', level: 8, mapId: 'map2', mapName: '另一张图', savedAt: 20 } });
  assert.notEqual(storyMenuSignature(f.source('save')), before, '槽内容变化要重绘');
  const afterSave = storyMenuSignature(f.source('save'));
  f.readings.set(0, { kind: 'unreadable', reason: '损坏' });
  assert.notEqual(storyMenuSignature(f.source('save')), afterSave, '损坏槽的提示也要重绘');
});

test('设置页、技能书页和调试页各自的显式状态进入签名', () => {
  const f = fixture();
  const settingsBefore = storyMenuSignature(f.source('settings'));
  f.settings.effects = 0.1;
  assert.notEqual(storyMenuSignature(f.source('settings')), settingsBefore, '音量变化要重绘设置页');
  const settingsAfter = storyMenuSignature(f.source('settings'));
  f.settings.controlMode = 'keyboard';
  assert.notEqual(storyMenuSignature(f.source('settings')), settingsAfter, '操作方式变化要重绘设置页');

  const learnBefore = storyMenuSignature(f.source('learn'));
  f.mutable.bag.revision += 1;
  assert.notEqual(storyMenuSignature(f.source('learn')), learnBefore, '技能书数量变化要重绘技能书页');
  const learnAfterBag = storyMenuSignature(f.source('learn'));
  f.learn.selected = 'ice';
  assert.notEqual(storyMenuSignature(f.source('learn')), learnAfterBag, '选中技能进入签名');

  const debugBefore = storyMenuSignature(f.source('debug'));
  f.debug.noclip = true;
  assert.notEqual(storyMenuSignature(f.source('debug')), debugBefore, 'GM 开关变化要重绘调试页');
  const debugAfterToggle = storyMenuSignature(f.source('debug'));
  f.mutable.questBook.version += 1;
  assert.notEqual(storyMenuSignature(f.source('debug')), debugAfterToggle, '任务状态变化要重绘调试页');
});
