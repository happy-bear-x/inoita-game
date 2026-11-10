import fs from 'node:fs';
import path from 'node:path';
import { walkClips } from './content-build.ts';
import { EFFECT_ATLAS_BY_FILE, EFFECT_ATLAS_PAGES } from '../src/generated/effect-atlas.ts';
import { CHARACTER_ATLAS_BY_FILE, CHARACTER_ATLAS_PAGES } from '../src/generated/character-atlas.ts';
import { CHARACTER_ATLAS_ALIASES } from './character-atlas-aliases.ts';
import { UI_ATLAS_FRAMES, UI_ATLAS_PAGES } from '../src/generated/ui-atlas.ts';
import { UI_ICON_FRAMES, UI_ICON_ATLAS_FILE, UI_ICON_ATLAS_DATA } from '../src/generated/icon-atlas.ts';
import { PROP_ATLAS_BY_KEY, PROP_ATLAS_PAGES } from '../src/generated/prop-atlas.ts';
import { COMMON_BUTTON_IMAGES } from '../src/ui/common-button.ts';
import { TITLE_MESSAGE_ASSETS, titleMenuImages, gameMenuImageGroups } from '../src/application/menu-images.ts';
import { pickupMessageAssets } from '../src/rendering/pickup-messages.ts';
import { groundLootAssets } from '../src/rendering/ground-loot.ts';
import { statusHudAssets } from '../src/rendering/status-hud.ts';
import { controlSkinAssets } from '../src/rendering/control-skin.ts';
import { questMarkerAssets } from '../src/rendering/quest-marker.ts';
import { sharedCombatAssets } from '../src/rendering/combat-assets.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';
import type { PendingAsset } from '../src/rendering/scene-assets.ts';

/** 素材被哪张图集替代；归档时用于说明原因。 */
export type AssetAtlasKind = 'ui-atlas' | 'icon-atlas' | 'effect-atlas' | 'prop-atlas' | 'character-atlas';

export interface AssetKeepResult {
  /** 需要保留的路径，统一写成 `assets/...`。 */
  keep: Set<string>;
  /** 原图被图集页替代的路径；这些文件可以归档，但图集页必须保留。 */
  covered: Map<string, AssetAtlasKind>;
  /** 被引用、但磁盘上不存在的路径。 */
  missing: string[];
  /** 内容里出现过的 `assets/...` 引用数。 */
  references: number;
  /** 通过 Phaser 加载器直接读取的文件数。 */
  phaserFiles: number;
}

/** 把内容或代码里的路径统一成 `assets/...`；不是素材路径时返回 undefined。 */
export function normalizeAssetPath(value: string): string | undefined {
  let normalized = value.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  const query = normalized.search(/[?#]/);
  if (query >= 0) normalized = normalized.slice(0, query);
  return normalized.startsWith('assets/') ? normalized : undefined;
}

function filesUnder(directory: string, relative = ''): { relative: string; absolute: string }[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const result: { relative: string; absolute: string }[] = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(childAbsolute, childRelative));
    else if (entry.isFile()) result.push({ relative: childRelative, absolute: childAbsolute });
  }
  return result;
}

function readJsonDocuments(directory: string, relative = ''): Map<string, unknown> {
  const documents = new Map<string, unknown>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of readJsonDocuments(childAbsolute, childRelative)) documents.set(key, value);
    } else if (entry.name.endsWith('.json')) {
      try {
        documents.set(childRelative, JSON.parse(fs.readFileSync(childAbsolute, 'utf8')));
      } catch (error) {
        throw new Error(`内容 JSON 无法解析：${childRelative}（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  }
  return documents;
}

function document(documents: ReadonlyMap<string, unknown>, file: string): Record<string, unknown> {
  const value = documents.get(file);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`缺少内容文件或结构不是对象：${file}`);
  return value as Record<string, unknown>;
}

/** 收集一个 JSON 文档里所有 `assets/...` 字符串。 */
function collectReferences(value: unknown, references: Set<string>): void {
  if (typeof value === 'string') {
    const asset = normalizeAssetPath(value);
    if (asset) references.add(asset);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectReferences(item, references);
  }
}

function addPendingAssets(assets: readonly PendingAsset[], add: (file: string) => void): void {
  for (const asset of assets) {
    add(asset.file);
    if (asset.kind === 'atlas') add(asset.atlas);
  }
}

function mapDocument(
  contentDir: string,
  documents: ReadonlyMap<string, unknown>,
  file: string,
): Record<string, unknown> | undefined {
  const relative = file.replace(/^content\//, '');
  const value = documents.get(relative);
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  const fallback = path.resolve(contentDir, '..', file);
  if (!fs.existsSync(fallback)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(fallback, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * UI 图集帧的路由结果：页存在、缺页，或该路径根本不是 UI 图集帧。
 * 缺页时不能再退回原文件，构建必须把它当成素材引用缺失。
 */
export function uiAtlasFrameRoute(file: string): { page: (typeof UI_ATLAS_PAGES)[number] } | 'missing' | undefined {
  const ui = UI_ATLAS_FRAMES[file];
  if (!ui) return undefined;
  const page = UI_ATLAS_PAGES[ui.page];
  return page ? { page } : 'missing';
}

/**
 * 按运行时真正会读取的路径计算保留名单。
 *
 * 三类来源：
 * - 内容 JSON 里的 `assets/...` 字符串；
 * - 代码里直接写死的标题、按钮、拾取、加载背景等路径；
 * - 实际会交给 Phaser 加载的草稿（动画、地图、prop、战斗反馈、状态栏、控件皮肤、衣柜）。
 *
 * 被 UI/图标/特效/物件图集覆盖的原图不会进保留名单；对应的图集页和数据文件一定保留。
 */
export async function collectAssetKeep(contentDir: string, assetsDir: string): Promise<AssetKeepResult> {
  // 构建时传入的是 dist/content，动画图层已经由 content-build 合并到规范路径；
  // 这里不再重复做去重哈希，避免为了裁素材把几百 MB 图片重新读一遍。
  const documents = readJsonDocuments(contentDir);

  const keep = new Set<string>();
  const phaser = new Set<string>();
  const covered = new Map<string, AssetAtlasKind>();
  const missing: string[] = [];

  const addPhaser = (value: string | undefined): void => {
    if (!value) return;
    const asset = normalizeAssetPath(value);
    if (!asset) return;
    phaser.add(asset);
    keep.add(asset);
  };

  const addAtlasPage = (page: { file: string; data: string }): void => {
    keep.add(page.file);
    keep.add(page.data);
  };

  // 所有内容里的动画图层：被特效/角色图集替代的原图记入 covered，其余由 Phaser 直接加载。
  for (const value of documents.values()) {
    walkClips(value, clip => {
      for (const layer of clip.layers) {
        const file = normalizeAssetPath(layer.file);
        if (!file) continue;
        const atlas = EFFECT_ATLAS_BY_FILE[file];
        if (atlas) {
          covered.set(file, 'effect-atlas');
          for (const frame of atlas.slice(0, clip.frames)) {
            const page = EFFECT_ATLAS_PAGES[frame.page];
            if (page) addAtlasPage(page);
          }
          continue;
        }
        const character = CHARACTER_ATLAS_BY_FILE[CHARACTER_ATLAS_ALIASES[file] ?? file];
        if (character) {
          covered.set(file, 'character-atlas');
          for (const pageIndex of character.pages) {
            const page = CHARACTER_ATLAS_PAGES[pageIndex];
            if (page) addAtlasPage(page);
          }
          continue;
        }
        addPhaser(file);
      }
    });
  }

  // 图集页本身始终保留；它们的体量很小，缺失一张就会让整页帧全部失效。
  for (const page of [...UI_ATLAS_PAGES, ...EFFECT_ATLAS_PAGES, ...PROP_ATLAS_PAGES, ...CHARACTER_ATLAS_PAGES]) addAtlasPage(page);
  keep.add(UI_ICON_ATLAS_FILE);
  keep.add(UI_ICON_ATLAS_DATA);

  const references = new Set<string>();
  for (const value of documents.values()) collectReferences(value, references);

  const world = document(documents, 'world.json');
  const battle = document(documents, 'battle.json');
  const items = document(documents, 'items.json');
  const wardrobe = document(documents, 'wardrobe.json');
  const companions = document(documents, 'companions.json');
  const statusHud = document(documents, 'status-hud.json');
  const controlSkin = document(documents, 'control-skin.json');
  const menuPanels = document(documents, 'menu-panels.json');
  const storyInterface = document(documents, 'story-interface.json');
  const shops = document(documents, 'shops.json');
  const storyClasses = document(documents, 'story-classes.json');

  // 运行时交给 Phaser 加载的草稿；这些文件必须留在磁盘上。
  addPendingAssets(sharedCombatAssets(battle as never, wardrobe as never), addPhaser);
  addPendingAssets(residentCombatAssets({
    battle: battle as never,
    wardrobe: wardrobe as never,
    world: world as never,
    companions: companions as never,
  }).assets, addPhaser);
  addPendingAssets(statusHudAssets(statusHud as never), addPhaser);
  addPendingAssets(controlSkinAssets(controlSkin as never), addPhaser);
  addPendingAssets(groundLootAssets(items as never), addPhaser);
  addPendingAssets(pickupMessageAssets(), addPhaser);
  addPendingAssets(questMarkerAssets(storyInterface as never), addPhaser);
  for (const texture of (wardrobe.textures ?? []) as { file?: string }[]) addPhaser(texture.file);
  for (const skill of Object.values((battle.skills ?? {}) as Record<string, { icon?: string }>)) addPhaser(skill.icon);
  // 源内容可能还保留合并前的路径；运行时内容构建会改写成规范路径，再由角色图集页接管。
  // 这些别名不能按 spritesheet 继续常驻，否则会引用 public 里已经归档的原图。
  for (const file of [...phaser]) {
    const canonical = CHARACTER_ATLAS_ALIASES[file];
    const entry = canonical ? CHARACTER_ATLAS_BY_FILE[canonical] : undefined;
    if (!entry) continue;
    phaser.delete(file);
    keep.delete(file);
    covered.set(file, 'character-atlas');
    for (const pageIndex of entry.pages) {
      const page = CHARACTER_ATLAS_PAGES[pageIndex];
      if (page) addAtlasPage(page);
    }
  }
  // 职业选择背景由 Phaser 直接加载，不是界面图集的一帧。
  if (typeof storyClasses.background === 'string') addPhaser(storyClasses.background);

  // 地图表面与 prop：进了物件图集的 prop 只保留图集页，其余读取 world.props 里的原图。
  const propFiles = new Map<string, string>();
  for (const prop of (world.props ?? []) as { key?: string; file?: string }[]) {
    const file = prop.file && normalizeAssetPath(prop.file);
    if (prop.key && file) propFiles.set(prop.key, file);
  }
  const usedProps = new Set<string>();
  for (const entry of (world.maps ?? []) as { file?: string }[]) {
    if (!entry.file) continue;
    const map = mapDocument(contentDir, documents, entry.file);
    if (!map) {
      missing.push(entry.file);
      continue;
    }
    for (const key of ['ground', 'canopy']) {
      if (typeof map[key] === 'string') addPhaser(map[key] as string);
    }
    for (const feature of (map.features ?? []) as { texture?: string }[]) {
      if (feature.texture) usedProps.add(feature.texture);
    }
  }
  for (const key of usedProps) {
    const atlas = PROP_ATLAS_BY_KEY[key];
    if (atlas) {
      const page = PROP_ATLAS_PAGES.find(candidate => candidate.key === atlas.key);
      if (page) addAtlasPage(page);
      else missing.push(`props:${key}`);
      const original = propFiles.get(key);
      if (original) covered.set(original, 'prop-atlas');
      continue;
    }
    const file = propFiles.get(key);
    if (file) addPhaser(file);
    else missing.push(`props:${key}`);
  }

  // 代码里写死的界面素材。
  const menuImages = gameMenuImageGroups(
    menuPanels as never, items as never, battle as never, storyInterface as never, shops as never,
  );
  for (const file of [
    ...titleMenuImages,
    ...Object.values(TITLE_MESSAGE_ASSETS),
    ...COMMON_BUTTON_IMAGES,
    ...menuImages.core,
    ...menuImages.extra,
    'assets/ui/items/money-ground.png',
    'assets/ui/loading-background.webp',
    'assets/ui/app-icon.png',
    'assets/ui/app-icon-192.png',
    'assets/ui/app-icon-512.png',
  ]) {
    const asset = normalizeAssetPath(file);
    if (asset) references.add(asset);
  }

  // 被图集覆盖的原图可以归档；其余引用必须保留原文件。
  const route = (file: string): void => {
    if (phaser.has(file) || covered.has(file)) return;
    const character = CHARACTER_ATLAS_BY_FILE[CHARACTER_ATLAS_ALIASES[file] ?? file];
    if (character) {
      for (const pageIndex of character.pages) {
        const page = CHARACTER_ATLAS_PAGES[pageIndex];
        if (page) addAtlasPage(page);
      }
      covered.set(file, 'character-atlas');
      return;
    }
    if (UI_ICON_FRAMES[file]) {
      covered.set(file, 'icon-atlas');
      keep.add(UI_ICON_ATLAS_FILE);
      keep.add(UI_ICON_ATLAS_DATA);
      return;
    }
    const ui = uiAtlasFrameRoute(file);
    if (ui === 'missing') {
      // 图集帧指向不存在的页：原文件已经被图集流程接管，不能悄悄退回单文件。
      missing.push(file);
      return;
    }
    if (ui) {
      addAtlasPage(ui.page);
      covered.set(file, 'ui-atlas');
      return;
    }
    keep.add(file);
  };
  for (const file of references) route(file);

  const existing = new Set(filesUnder(assetsDir).map(file => `assets/${file.relative}`));
  for (const file of keep) if (!existing.has(file)) missing.push(file);

  return { keep, covered, missing, references: references.size, phaserFiles: phaser.size };
}
