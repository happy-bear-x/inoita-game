import type { Facing } from '../../src/domain/content.ts';
import type { EquipmentSlot, ItemCatalog } from '../../src/domain/items.ts';
import { costumeRecipe, townMovementPoses, wardrobePoseFile } from '../../src/domain/wardrobe.ts';
import type { CostumePart, CostumePiece, CostumePose, WardrobeCatalog } from '../../src/domain/wardrobe.ts';

export const PART_NAMES: Record<string, string> = {
  body: '基础头脸', 'head-front': '发型 / 帽子', 'head-back': '头饰',
  'coat-front': '上衣 / 双臂', 'coat-back': '下装 / 腿脚', cloak: '披风',
  'two-handed': '双手武器', 'main-blade': '主手剑 / 斧 / 锤', 'off-blade': '副手剑 / 斧 / 锤',
  'main-dagger': '主手短剑', 'off-dagger': '副手短剑', shield: '盾牌',
  'cast-prop-1': '技能道具',
};

const ACTION_NAMES: Record<string, string> = {
  idle: '持械待机', walk: '持械行走', attack: '普通攻击 · 第一段',
  'attack-2': '普通攻击 · 第二段', 'attack-3': '普通攻击 · 第三段',
  'dual-attack': '双持攻击', 'dual-quick-attack': '双持快速攻击',
  'frenzy-blade': '狂暴攻击 · 单手', 'frenzy-dagger': '狂暴攻击 · 短剑',
  'frenzy-two-handed': '狂暴攻击 · 双手',
};

export type EquipmentSelection = Partial<Record<EquipmentSlot, string>>;
export type VariantOverrides = Record<string, string | null>;
export interface WeaponChoice { id: string; label: string; kind: string }
export interface ActionChoice { key: string; label: string; group: string; poseId: string }
export interface FramePiece { order: number; part: CostumePart; key: string; sprite: CostumePiece }
export interface PoseBounds { left: number; top: number; right: number; bottom: number }

export function weaponChoices(catalog: WardrobeCatalog, items: ItemCatalog, offhand = false): WeaponChoice[] {
  const result: WeaponChoice[] = [];
  const seen = new Set<string>();
  for (const [id, item] of Object.entries(items.items)) {
    const equipment = item.equipment;
    const appearance = catalog.equipment[id];
    if (!equipment?.classes.includes('warrior') || !appearance) continue;
    const usable = offhand ? item.kind === 'shield' || equipment.dualWield : equipment.slot === 'main-hand';
    if (!usable) continue;
    const parts = offhand && equipment.dualWield ? appearance.offHand : appearance.main;
    const signature = JSON.stringify([item.kind, parts]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push({ id, label: item.name, kind: item.kind });
  }
  return result;
}

export function compatibleOffhands(catalog: WardrobeCatalog, items: ItemCatalog, main?: string): WeaponChoice[] {
  const kind = main ? items.items[main].kind : 'unarmed';
  return weaponChoices(catalog, items, true).filter(choice => catalog.stances[`${kind}:${choice.kind}`]);
}

export function viewerRecipe(catalog: WardrobeCatalog, items: ItemCatalog, equipment: EquipmentSelection,
  overrides: VariantOverrides) {
  const recipe = costumeRecipe(catalog, items, equipment, 'warrior');
  const variants: Record<string, string> = { ...recipe.variants };
  for (const [part, variant] of Object.entries(overrides)) {
    if (variant === null) delete variants[part];
    else variants[part] = variant;
  }
  return { ...recipe, variants };
}

export function actionChoices(catalog: WardrobeCatalog, items: ItemCatalog, equipment: EquipmentSelection,
  facing: Facing, skillNames: Record<string, string>): ActionChoice[] {
  const recipe = viewerRecipe(catalog, items, equipment, {});
  const result: ActionChoice[] = [];
  for (const [clip, poseId] of Object.entries(recipe.poses)) {
    const suffix = `-${facing}`;
    if (!poseId || !clip.endsWith(suffix)) continue;
    const key = clip.slice(0, -suffix.length);
    const skill = key.startsWith('skill-');
    const group = skill ? '主动技能' : key.startsWith('frenzy-') ? '狂暴攻击'
      : key.startsWith('dual-') ? '双持攻击' : key.startsWith('attack') ? '普通攻击' : '基础动作';
    result.push({ key, label: skill ? skillNames[key.slice(6)] ?? key : ACTION_NAMES[key] ?? key, group, poseId });
  }
  const town = townMovementPoses(catalog);
  for (const movement of ['idle', 'walk'] as const) {
    result.push({ key: `town-${movement}`, label: movement === 'idle' ? '地图待机' : '地图行走',
      group: '地图动作', poseId: town[`${movement}-${facing}`]! });
  }
  return result;
}

export function variantChoices(catalog: WardrobeCatalog, items: ItemCatalog, part: string) {
  const names = new Map<string, Set<string>>();
  for (const [id, appearance] of Object.entries(catalog.equipment)) {
    const name = items.items[id]?.name;
    if (!name) continue;
    for (const map of [appearance.main, appearance.offHand]) {
      const variant = map[part];
      if (!variant) continue;
      if (!names.has(variant)) names.set(variant, new Set());
      names.get(variant)!.add(name);
    }
  }
  return Object.keys(catalog.variants).filter(id => id === part || id.startsWith(`${part}-style-`))
    .map(id => ({ id, label: [...(names.get(id) ?? [])].slice(0, 2).join(' / ') ||
      `${PART_NAMES[part] ?? part} · ${id.split('-style-')[1] ?? '默认'}` }));
}

export function framePieces(catalog: WardrobeCatalog, variants: Record<string, string>, frame: CostumePart[]): FramePiece[] {
  const result: FramePiece[] = [];
  for (const [order, part] of frame.entries()) {
    const variant = variants[part.part];
    if (!variant) continue;
    const entries = catalog.variants[variant];
    if (!entries) throw new Error(`外观款式缺失：${variant}`);
    const key = entries[part.piece];
    if (key === null) continue;
    const sprite = key ? catalog.sprites[key] : undefined;
    if (!sprite) throw new Error(`切片缺失：${variant}[${part.piece}]`);
    result.push({ order, part, key: key!, sprite });
  }
  return result;
}

export function poseBounds(catalog: WardrobeCatalog, variants: Record<string, string>, pose: CostumePose): PoseBounds {
  const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
  for (const frame of pose.frames) for (const { part, sprite } of framePieces(catalog, variants, frame)) {
    const angle = part.angle * Math.PI / 180;
    for (const x of [0, sprite.width]) for (const y of [0, sprite.height]) {
      const u = (x - sprite.anchorX) * part.scaleX;
      const v = (y - sprite.anchorY) * part.scaleY;
      const px = part.x + u * Math.cos(angle) - v * Math.sin(angle);
      const py = part.y + u * Math.sin(angle) + v * Math.cos(angle);
      const worldX = pose.mirrorX ? -px : px;
      bounds.left = Math.min(bounds.left, Math.floor(worldX));
      bounds.right = Math.max(bounds.right, Math.ceil(worldX));
      bounds.top = Math.min(bounds.top, Math.floor(py));
      bounds.bottom = Math.max(bounds.bottom, Math.ceil(py));
    }
  }
  return bounds;
}

/** 每次加载完成都返回数据，由调用方只安装仍然选中的动作。失败的请求允许重试。 */
export class PoseRepository {
  private readonly loads = new Map<string, Promise<CostumePose>>();
  readonly catalog: WardrobeCatalog;
  private readonly fetchPose: (url: string) => Promise<CostumePose>;

  constructor(catalog: WardrobeCatalog, fetchPose: (url: string) => Promise<CostumePose>) {
    this.catalog = catalog;
    this.fetchPose = fetchPose;
  }

  async get(id: string): Promise<CostumePose> {
    const existing = this.catalog.poses[id];
    if (existing) return existing;
    let pending = this.loads.get(id);
    if (!pending) {
      pending = this.fetchPose(`/${wardrobePoseFile(id)}`).then(pose => {
        if (!pose.frames.length || !(pose.frameRate > 0)) throw new Error(`动作数据无效：${id}`);
        this.catalog.poses[id] = pose;
        return pose;
      }).catch(error => { this.loads.delete(id); throw error; });
      this.loads.set(id, pending);
    }
    return pending;
  }
}

export class Playback {
  frame = 0;
  playing = true;
  speed = 1;
  private elapsed = 0;
  private count = 1;
  private rate = 1;

  configure(count: number, rate: number): void {
    this.count = count;
    this.rate = rate;
    this.frame = Math.min(this.frame, count - 1);
    this.elapsed = 0;
  }

  seek(frame: number): void {
    this.frame = Math.max(0, Math.min(this.count - 1, Math.round(frame)));
    this.playing = false;
    this.elapsed = 0;
  }

  toggle(): void { this.playing = !this.playing; this.elapsed = 0; }

  advance(delta: number): boolean {
    if (!this.playing) return false;
    this.elapsed += delta * this.speed;
    const duration = 1000 / this.rate;
    const steps = Math.floor(this.elapsed / duration);
    if (!steps) return false;
    this.elapsed -= steps * duration;
    this.frame = (this.frame + steps) % this.count;
    return true;
  }
}
