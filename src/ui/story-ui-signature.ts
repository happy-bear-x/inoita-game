import { AUTO_SAVE_SLOT, MANUAL_SAVE_SLOT_COUNT, type SaveSlotRef, type SlotSummaryReading } from '../domain/save-game.ts';
import type { Session } from '../domain/session.ts';
import type { FullscreenStatus } from '../application/fullscreen.ts';
import type { ControlMode } from '../application/control-settings.ts';
import type { FrameRateLimit } from '../application/display-settings.ts';

/** 菜单里所有可显示的页面；新增页面必须同时补一个签名分支。 */
export const STORY_MENU_PAGES = [
  'status', 'bag', 'skills', 'party', 'quests', 'system',
  'save', 'load', 'settings', 'shop', 'crafting', 'forge', 'learn', 'debug'
] as const;
export type StoryMenuPage = typeof STORY_MENU_PAGES[number];

/** 设置页真正显示的当前值；只在设置页参与签名。 */
export interface StoryMenuSettingsView {
  music: number;
  effects: number;
  fps: boolean;
  frameRateLimit: FrameRateLimit;
  criticalDecorations: boolean;
  fullscreen: FullscreenStatus;
  fullscreenActive: boolean;
  controlMode: ControlMode;
}

/** 技能书页自己的状态；选中项和提示由面板直接改，会话通知只关心书与技能版本。 */
interface StoryMenuLearnView {
  entryId: string;
  selected?: string;
  message: string;
}

/** 强化台自己的状态；通知期间它的动作由面板显式重绘。 */
interface StoryMenuForgeView {
  targetId?: string;
  tab: string;
  confirming: boolean;
}

/** GM 页顶部的开关状态。 */
interface StoryMenuDebugView {
  noclip: boolean;
  doubleSpeed: boolean;
}

/**
 * 页面签名的输入。模块只读取显式的版本号和小结构，不做对象深度哈希；
 * 回调按页面懒执行，避免每次通知都读存档或设置。
 */
export interface StoryMenuViewModelSource {
  page: StoryMenuPage;
  selectedMemberId: string;
  session: Session;
  /** 存档页：读某个槽的摘要。其他页不会调用。 */
  slotReading?: (slot: SaveSlotRef) => SlotSummaryReading;
  /** 设置页：当前声音、画面与操作方式。 */
  settings?: () => StoryMenuSettingsView;
  /** 技能书页。 */
  learn?: () => StoryMenuLearnView;
  /** 强化台页。 */
  forge?: () => StoryMenuForgeView;
  /** 调试页。 */
  debug?: () => StoryMenuDebugView;
}

/** 每个页面自己的 view model：只放这一页真正显示、且会随通知变化的数据。 */
interface StoryMenuViewModel {
  page: StoryMenuPage;
  selectedMemberId?: string;
  bagRevision?: number;
  money?: number;
  questBookVersion?: number;
  debugFocusQuest?: string;
  skillsVersion?: number;
  memberLevel?: number;
  memberSkillsVersion?: number;
  memberPlayer?: string;
  skillPoints?: number;
  statPoints?: number;
  party?: string;
  groupModifiers?: string;
  slots?: string;
  settings?: StoryMenuSettingsView;
  learn?: StoryMenuLearnView;
  forge?: StoryMenuForgeView;
  debug?: StoryMenuDebugView;
}

function partyShape(session: Session): string {
  const party = session.party;
  return `${party?.activeIds.join('|') ?? ''}|${party?.controlledId ?? ''}`;
}

function groupShape(session: Session): string {
  return JSON.stringify(Object.entries(session.party?.groupModifiers() ?? {}).sort());
}

/** 上阵队员的等级、技能版本、血量与技能频率设置；只在队伍/调试页使用。 */
function partyDetail(session: Session): string {
  const party = session.party, hero = session.hero;
  return party?.activeIds.map(id => {
    if (id === 'player') return `player:${hero?.level ?? 0}:${hero?.skillPoints ?? 0}:${JSON.stringify(hero?.player ?? null)}`;
    const entry = party.get(id);
    return `${id}:${entry?.level ?? 0}:${entry?.skills.version ?? 0}:${JSON.stringify(entry?.player ?? null)}:${JSON.stringify([...(entry?.aiFrequency ?? new Map())])}`;
  }).join('|') ?? '';
}

/** 队伍页还显示候补与名册槽位；招募、放逐或换位都要让签名变化。 */
function partyRosterShape(session: Session): string {
  const party = session.party;
  if (!party) return '';
  const snapshot = party.snapshot();
  const members = snapshot.members.map(member =>
    `${member.id}:${member.level}:${member.health}:${member.mana}:${member.experience}:${member.source}`).join(',');
  return `${snapshot.rosterSlots.join(',')}|${snapshot.reserves.join(',')}|${members}`;
}

function memberShape(session: Session, selectedMemberId: string): {
  level?: number;
  skillsVersion?: number;
  player?: string;
} {
  if (selectedMemberId === 'player') {
    return { level: session.hero?.level, player: JSON.stringify(session.hero?.player ?? null) };
  }
  const companion = session.party?.get(selectedMemberId);
  return { level: companion?.level, skillsVersion: companion?.skills.version, player: JSON.stringify(companion?.player ?? null) };
}

/** 存档槽显示的是摘要；槽为空、损坏或有效时都给出稳定字符串。 */
function slotsShape(read: ((slot: SaveSlotRef) => SlotSummaryReading) | undefined): string {
  if (!read) return '';
  const readings: SlotSummaryReading[] = [read(AUTO_SAVE_SLOT)];
  for (let slot = 0; slot < MANUAL_SAVE_SLOT_COUNT; slot++) readings.push(read(slot));
  return readings.map(reading => {
    if (reading.kind === 'empty') return 'empty';
    if (reading.kind === 'unreadable') return `unreadable:${reading.reason}`;
    const summary = reading.summary;
    return `ok:${summary.name ?? ''}:${summary.level}:${summary.className}:${summary.mapName}:${summary.savedAt ?? ''}:${summary.portrait}`;
  }).join('|');
}

/**
 * 把当前页依赖的数据收成显式 view model。返回值可以直接比较，也可以序列化成签名。
 * 页面只读取自己显示的字段；例如生命值变化不会让背包页的 view model 变。
 */
export function storyMenuViewModel(source: StoryMenuViewModelSource): StoryMenuViewModel {
  const session = source.session, page = source.page;
  const bagRevision = session.bag.revision, money = session.money;
  const member = page === 'status' || page === 'bag' || page === 'skills' || page === 'crafting'
    ? memberShape(session, source.selectedMemberId) : undefined;
  switch (page) {
    case 'bag':
      return { page, selectedMemberId: source.selectedMemberId, bagRevision, money,
        memberLevel: member?.level, party: partyShape(session) };
    case 'status':
      return { page, selectedMemberId: source.selectedMemberId, bagRevision,
        memberLevel: member?.level, memberPlayer: member?.player,
        skillPoints: session.hero?.skillPoints ?? 0, statPoints: session.hero?.statPoints ?? 0,
        party: partyShape(session), groupModifiers: groupShape(session) };
    case 'skills':
      return { page, selectedMemberId: source.selectedMemberId, bagRevision,
        skillsVersion: session.skills.version, memberSkillsVersion: member?.skillsVersion,
        memberLevel: member?.level, skillPoints: session.hero?.skillPoints ?? 0,
        party: partyShape(session) };
    case 'party':
      return { page, bagRevision, party: `${partyShape(session)}|${partyDetail(session)}|${partyRosterShape(session)}` };
    case 'quests':
      return { page, questBookVersion: session.questBook.version, debugFocusQuest: session.debugFocusQuest };
    case 'shop':
      return { page, selectedMemberId: source.selectedMemberId, bagRevision, money, party: partyShape(session) };
    case 'crafting':
      return { page, selectedMemberId: source.selectedMemberId, bagRevision, money,
        memberLevel: member?.level, party: partyShape(session) };
    case 'save':
    case 'load':
      return { page, slots: slotsShape(source.slotReading) };
    case 'settings':
      return { page, settings: source.settings?.() };
    case 'forge':
      return { page, selectedMemberId: source.selectedMemberId, bagRevision,
        forge: source.forge?.() ?? { tab: 'enchant', confirming: false } };
    case 'learn':
      return { page, bagRevision, skillsVersion: session.skills.version,
        learn: source.learn?.() ?? { entryId: '', message: '' } };
    case 'debug': {
      const detail = memberShape(session, source.selectedMemberId);
      return { page, selectedMemberId: source.selectedMemberId, bagRevision, money,
        questBookVersion: session.questBook.version, debugFocusQuest: session.debugFocusQuest,
        memberLevel: detail.level, memberPlayer: detail.player,
        skillPoints: session.hero?.skillPoints ?? 0, statPoints: session.hero?.statPoints ?? 0,
        party: `${partyShape(session)}|${partyDetail(session)}|${partyRosterShape(session)}`, groupModifiers: groupShape(session),
        debug: source.debug?.() ?? { noclip: false, doubleSpeed: false } };
    }
    case 'system':
      return { page };
    default:
      return { page };
  }
}

/** 当前页的显式签名。字段顺序固定，不做深度哈希。 */
export function storyMenuSignature(source: StoryMenuViewModelSource): string {
  return JSON.stringify(storyMenuViewModel(source));
}
