import { SCENE_KEYS } from '../application/scene-keys.ts';
import Phaser from 'phaser';
import type { StoryApp } from '../app.ts';
import { UiSurface } from '../ui/phaser/widgets.ts';
import { SceneUiAssets } from '../ui/phaser/ui-asset-host.ts';
import { newStorySession } from '../domain/story-class.ts';
import { readSafeArea } from '../ui/viewport.ts';
import type { ItemDefinition } from '../domain/items.ts';

/**
 * 只调试菜单面板的独立场景，地址带 `?ui-debug` 进入。
 *
 * 它不装标题菜单、职业选择、世界场景和正式界面场景，所以没有剧情演出、人物移动和地图加载；
 * 菜单本身仍走正式的 `StoryUI` 与 `ShopPanel`，改面板外观时看到的就是游戏里的那一套。
 * 屏幕下方一条调试条（数字键 1–0 或点击）在这些面板状态之间跳。
 */
interface View { key: string; label: string }

const VIEWS: View[] = [
  { key: 'bag', label: '背包' },
  { key: 'describe', label: '物品说明' },
  { key: 'worn', label: '装备说明' },
  { key: 'use', label: '物品使用' },
  { key: 'discard', label: '丢弃' },
  { key: 'shop', label: '商店' },
  { key: 'shop-description', label: '商品说明' },
  { key: 'shop-quantity', label: '数量框' },
  { key: 'shop-confirm', label: '确认框' },
  { key: 'shop-notice', label: '不可出售' },
  { key: 'classified-shop', label: '分类商店' },
  { key: 'status', label: '人物页' },
];

const BUTTON = { width: 153, height: 56, gapX: 6, gapY: 6, padding: 5, size: 19 };
const COLUMNS = 6;
const STRIP_WIDTH = 960;
const STRIP_HEIGHT = BUTTON.padding * 2 + BUTTON.height * 2 + BUTTON.gapY;

/** 调试用的商店：只有固定商品的杂货商人，和带九类分类栏的武器商人。 */
const GENERAL_SHOP = 'merchandise-dealer-b09d9585';
const CLASSIFIED_SHOP = 'weapons-dealer-f31d78ce';
/** 恢复、强化、镶嵌、净化四类「使用」不弹这个面板，挑物品时要避开。 */
const APPLY_KINDS = ['recover-health', 'enchant', 'socket', 'purify'];

export class UiDebugScene extends Phaser.Scene {
  private readonly app: StoryApp;
  private readonly assets = new SceneUiAssets(this);
  private readonly abort = new AbortController();
  private strip?: UiSurface;
  private view = VIEWS[0]!.key;
  private ready = false;
  private failure = '';

  constructor(app: StoryApp) { super(SCENE_KEYS.uiDebug); this.app = app; }

  create(): void {
    this.strip = new UiSurface(this, STRIP_WIDTH, STRIP_HEIGHT, 600);
    // 调试条不属于菜单的输入锁，菜单一打开它照样要能点。
    this.strip.enabled = () => true;
    this.drawStrip();
    this.input.keyboard?.on('keydown', this.onKey);
    this.scale.on('resize', this.layoutStrip, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.layoutStrip, this);
      this.input.keyboard?.off('keydown', this.onKey);
      this.abort.abort();
      this.assets.releaseContent();
      this.strip?.destroy();
    });
    void this.init();
  }

  private onKey = (event: KeyboardEvent): void => {
    // 调试场景没有正式界面场景，键盘也由这里桥接给全局 router。
    if (this.app.inputRouter.dispatch(event)) return;
    if (event.key === 'Tab') return;
    const index = '1234567890'.indexOf(event.key);
    if (index < 0 || index >= VIEWS.length) return;
    event.preventDefault();
    this.show(VIEWS[index]!.key);
  };

  /** 不复用 `UiSurface.layout`：它把画布居中，调试条要贴屏幕下缘。 */
  private layoutStrip(): void {
    const strip = this.strip;
    if (!strip) return;
    const bounds = this.game.canvas.getBoundingClientRect(), safe = readSafeArea();
    const unit = this.scale.width / Math.max(1, bounds.width);
    const left = (safe.left + 12) * unit, right = (safe.right + 12) * unit, bottom = (safe.bottom + 12) * unit;
    const factor = Math.min((this.scale.width - left - right) / strip.width, 1);
    strip.root.setScale(factor).setPosition(left, this.scale.height - bottom - strip.height * factor);
    strip.scrolls.forEach(scroll => scroll.layout());
  }

  private drawStrip(): void {
    const strip = this.strip;
    if (!strip) return;
    strip.clear();
    strip.visible(true);
    this.layoutStrip();
    if (this.failure) {
      strip.rect(0, 0, STRIP_WIDTH, STRIP_HEIGHT, 0x3a1414, .96);
      strip.text(`调试场景启动失败：${this.failure}`, BUTTON.padding + 4, 10, STRIP_WIDTH - 20, 20, '#f0b0a0');
      strip.text('看浏览器控制台；修好后刷新页面。', BUTTON.padding + 4, 70, STRIP_WIDTH - 20, 18, '#d0a090');
      return;
    }
    strip.rect(0, 0, STRIP_WIDTH, STRIP_HEIGHT, 0x101820, .96);
    VIEWS.forEach((view, index) => {
      const column = index % COLUMNS, row = Math.floor(index / COLUMNS);
      strip.button(`${index === 9 ? 0 : index + 1}　${view.label}`,
        BUTTON.padding + column * (BUTTON.width + BUTTON.gapX), BUTTON.padding + row * (BUTTON.height + BUTTON.gapY),
        BUTTON.width, BUTTON.height, () => this.show(view.key),
        { selected: view.key === this.view, fontSize: BUTTON.size });
    });
  }

  private async init(): Promise<void> {
    const signal = this.abort.signal;
    try {
      const { prepareStory, prepareMenu } = this.app;
      if (!prepareStory || !prepareMenu) throw new Error('缺少 main.ts 暴露的 prepareStory / prepareMenu');
      this.app.uiAssets = this.assets;
      await prepareStory(signal);
      // 职业目录不在 prepareStory 里——正常流程由职业选择场景加载，这里跳过那一步，自己补上。
      this.app.storyClasses = await this.app.content.storyClasses(signal);
      await prepareMenu(signal);
      this.stubWorldCapabilities();
      const campaign = this.app.campaign;
      this.app.session = newStorySession(campaign, this.app.world.actors[campaign.start.actor]!,
        this.app.storyClasses.classes[0]!, this.app.items, this.app.characterStats, this.app.battleCatalog, this.app.companions);
      this.seedBag();
      // `setMode` 会把 ready 清成 false，`show()` 要求 mode==='game' 且 ready，所以顺序不能反。
      this.app.ui.setMode('game');
      this.app.ui.loaded();
      this.app.storyUI.attach(this);
      this.app.storyUI.bind(this.app.session, this.app.world, this.app.storyInterface);
      this.ready = true;
      this.show(this.view);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      this.failure = error instanceof Error ? error.message : String(error);
      console.error(error);
    }
    this.drawStrip();
  }

  /**
   * 补上正式流程里由世界场景提供的三项能力。缺了它们，换装会变成一条报错提示，
   * 恢复药水点了没反应，「返回主菜单」还会把模式切成没有场景的 menu。
   */
  private stubWorldCapabilities(): void {
    const app = this.app;
    app.changeEquipment = async (entry, slot, _signal, memberId = 'player') => {
      const member = memberId === 'player' ? app.session.hero : app.session.party?.get(memberId);
      if (entry === undefined) app.session.bag.unequip(slot, memberId);
      else app.session.bag.equip(entry, slot, memberId, member?.classId, member?.level);
      return '';
    };
    app.useRecoveryItem = (entry, memberId = 'player') => {
      const hero = app.session.hero;
      if (!hero) return { used: false, reason: 'unavailable' };
      return app.session.recovery.use(app.session.bag, entry,
        [{ id: memberId, player: hero.player, setHealth: (value: number) => hero.setHealth(value), setMana: (value: number) => hero.setMana(value) }], memberId);
    };
    app.returnToMenu = () => {};
  }

  /** 补几件能把各条分支都摆出来的物品；用目录里第一条满足条件的，避免写死会变的编号。 */
  private seedBag(): void {
    const bag = this.app.session.bag, catalog = this.app.items.items;
    const first = (predicate: (item: ItemDefinition) => boolean) => Object.keys(catalog).find(id => predicate(catalog[id]!));
    const picks = [
      first(item => item.use?.kind === 'box'),
      first(item => item.use?.kind === 'pack'),
      first(item => item.use?.kind === 'learn'),
      first(item => item.sellable === false && !item.equipment),
      first(item => !!item.equipment && !item.stackable),
    ];
    for (const id of picks) if (id) bag.add(id);
  }

  private entryOf(predicate: (item: ItemDefinition) => boolean, worn = false): string | undefined {
    const bag = this.app.session.bag;
    const entries = bag.entries.filter(entry => predicate(bag.catalog.items[entry.item]!));
    if (!worn) return entries[entries.length - 1]?.id;
    const equipped = Object.values(bag.equipmentFor('player'));
    return entries.find(entry => equipped.includes(entry.id))?.id ?? entries[entries.length - 1]?.id;
  }

  private show(view: string): void {
    this.view = view;
    this.drawStrip();
    if (!this.ready) return;
    const ui = this.app.storyUI;
    switch (view) {
      case 'describe': {
        const entry = this.entryOf(item => !!item.equipment) ?? this.entryOf(() => true);
        if (entry) ui.debugDescribe(entry, 'left'); else ui.show('bag');
        break;
      }
      case 'worn': {
        // 说明面板停在右栏只在「点已穿戴的装备」时出现，所以这里找一件穿在身上的。
        const entry = this.entryOf(() => true, true);
        if (entry) ui.debugDescribe(entry, 'right'); else ui.show('bag');
        break;
      }
      case 'use': {
        const entry = this.entryOf(item => !!item.use && !APPLY_KINDS.includes(item.use.kind));
        if (entry) ui.debugUse(entry); else ui.show('bag');
        break;
      }
      case 'discard': {
        const entry = this.entryOf(item => item.stackable && item.discardable);
        if (entry) ui.debugUse(entry, 'discard'); else ui.show('bag');
        break;
      }
      case 'shop': ui.debugShop(GENERAL_SHOP); break;
      case 'shop-description': ui.debugShop(GENERAL_SHOP, 'description'); break;
      case 'shop-quantity': ui.debugShop(GENERAL_SHOP, 'quantity'); break;
      case 'shop-confirm': ui.debugShop(GENERAL_SHOP, 'confirm'); break;
      case 'shop-notice': ui.debugShop(GENERAL_SHOP, 'notice', 'sell'); break;
      case 'classified-shop': ui.debugShop(CLASSIFIED_SHOP); break;
      case 'status': ui.show('status'); break;
      default: ui.show('bag');
    }
  }
}
