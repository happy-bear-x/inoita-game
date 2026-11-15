import Phaser from 'phaser';
import type { Facing } from '../../src/domain/content.ts';
import type { ItemCatalog } from '../../src/domain/items.ts';
import type { CostumePose, WardrobeCatalog } from '../../src/domain/wardrobe.ts';
import {
  PART_NAMES, Playback, PoseRepository, actionChoices, compatibleOffhands, framePieces,
  poseBounds, variantChoices, viewerRecipe, weaponChoices,
} from './model.ts';
import type { ActionChoice, EquipmentSelection, FramePiece, PoseBounds, VariantOverrides } from './model.ts';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`页面控件缺失：${id}`);
  return found as T;
}

function option(value: string, label: string): HTMLOptionElement {
  return new Option(label, value);
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取失败 ${response.status}：${url}`);
  return response.json() as Promise<T>;
}

async function readImage(file: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = `/${file}`;
  try { await image.decode(); }
  catch { throw new Error(`图片加载失败：${file}`); }
  return image;
}

const playback = new Playback();
const workspace = document.querySelector<HTMLElement>('.workspace')!;
const status = element('status');
const actionsElement = element('actions');
const variantsElement = element('variants');
const piecesElement = element('pieces');
const mainSelect = element<HTMLSelectElement>('main-hand');
const offSelect = element<HTMLSelectElement>('off-hand');
const timeline = element<HTMLInputElement>('timeline');
const playButton = element<HTMLButtonElement>('play');
const zoomSelect = element<HTMLSelectElement>('zoom');
const stage = element('stage');
const showAll = element<HTMLButtonElement>('show-all');

let catalog: WardrobeCatalog;
let items: ItemCatalog;
let repository: PoseRepository;
let skillNames: Record<string, string>;
let equipment: EquipmentSelection = {};
let overrides: VariantOverrides = {};
let hiddenParts = new Set<string>();
let facing: Facing = 'south';
let selectedAction = 'idle';
let choices: ActionChoice[] = [];
let pose: CostumePose | undefined;
let bounds: PoseBounds = { left: 0, top: -40, right: 0, bottom: 0 };
let variants: Record<string, string> = {};
let currentPieces: FramePiece[] = [];
let soloOrder: number | undefined;
let revision = 0;
let ready = false;
let scene: CharacterScene | undefined;
let game: Phaser.Game | undefined;
let observer: ResizeObserver | undefined;
const images = new Map<string, HTMLImageElement>();
const thumbnailCache = new Map<string, string>();
const variantUseLabels = new Map<string, HTMLElement>();
const pieceCards = new Map<number, {
  card: HTMLElement; name: HTMLElement; order: HTMLElement; image: HTMLImageElement;
  details: HTMLElement; solo: HTMLButtonElement;
}>();

function report(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

/** 原图集里的切片按像素原样裁出；缩放只交给 CSS 的整数倍显示。 */
function thumbnail(key: string): string {
  const existing = thumbnailCache.get(key);
  if (existing) return existing;
  const sprite = catalog.sprites[key];
  const image = images.get(sprite.texture);
  if (!image) throw new Error(`切片图集未加载：${sprite.texture}`);
  const canvas = document.createElement('canvas');
  canvas.width = sprite.width;
  canvas.height = sprite.height;
  canvas.getContext('2d')!.drawImage(image, sprite.x, sprite.y, sprite.width, sprite.height,
    0, 0, sprite.width, sprite.height);
  const result = canvas.toDataURL();
  thumbnailCache.set(key, result);
  return result;
}

class CharacterScene extends Phaser.Scene {
  private root!: Phaser.GameObjects.Container;
  private readonly sprites: Phaser.GameObjects.Image[] = [];

  constructor() { super('warrior-viewer'); }

  create(): void {
    for (const [key, image] of images) this.textures.addImage(key, image);
    for (const [key, piece] of Object.entries(catalog.sprites)) {
      this.textures.get(piece.texture).add(key, 0, piece.x, piece.y, piece.width, piece.height);
    }
    this.root = this.add.container(0, 0);
    scene = this;
    this.scale.on('resize', () => this.draw());
    void refresh();
  }

  override update(_time: number, delta: number): void {
    if (ready && playback.advance(delta)) renderFrame();
  }

  setLoading(): void { this.root.setVisible(false); }

  draw(): void {
    if (!pose || !ready) return;
    const margin = 40;
    const width = bounds.right - bounds.left + 1;
    const height = bounds.bottom - bounds.top + 1;
    const fit = Math.max(1, Math.floor(Math.min((this.scale.width - margin) / width,
      (this.scale.height - margin) / height)));
    const requested = Number(zoomSelect.value);
    const zoom = Math.min(fit, requested);
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    this.root.setPosition(Math.round(this.scale.width / 2 - centerX * zoom),
      Math.round(this.scale.height / 2 - centerY * zoom));
    this.root.setScale(pose.mirrorX ? -zoom : zoom, zoom).setVisible(true);
    for (const [index, entry] of currentPieces.entries()) {
      let sprite = this.sprites[index];
      if (!sprite) {
        sprite = this.add.image(0, 0, entry.sprite.texture, entry.key);
        this.root.add(sprite);
        this.sprites.push(sprite);
      }
      const { part, sprite: piece } = entry;
      sprite.setTexture(piece.texture, entry.key)
        .setOrigin(piece.anchorX / piece.width, piece.anchorY / piece.height)
        .setPosition(part.x, part.y).setScale(part.scaleX, part.scaleY)
        .setAngle(part.angle).setAlpha(part.alpha)
        .setVisible(soloOrder === undefined ? !hiddenParts.has(part.part) : soloOrder === entry.order);
    }
    for (let index = currentPieces.length; index < this.sprites.length; index++) this.sprites[index].setVisible(false);
    element('scale-info').textContent = zoom === requested ? `${zoom}× · 原始像素` : `${zoom}× · 适应画布（选择 ${requested}×）`;
  }
}

function syncPlayback(): void {
  playButton.textContent = playback.playing ? '暂停' : '继续播放';
  playButton.setAttribute('aria-label', playback.playing ? '暂停播放' : '继续播放');
  element('frame-label').textContent = pose ? `${playback.frame + 1} / ${pose.frames.length}` : '— / —';
  timeline.value = String(playback.frame);
}

function resetSolo(): void {
  soloOrder = undefined;
  showAll.hidden = true;
}

function toggleSolo(order: number): void {
  if (soloOrder === order) resetSolo();
  else {
    playback.seek(playback.frame);
    soloOrder = order;
    showAll.hidden = false;
  }
  renderFrame();
}

function renderPieces(): void {
  const cards = currentPieces.map(entry => {
    const { part, sprite } = entry;
    let view = pieceCards.get(entry.order);
    if (!view) {
      const card = document.createElement('article');
      card.className = 'piece-card';
      const header = document.createElement('header');
      const name = document.createElement('strong');
      const order = document.createElement('span');
      header.append(name, order);
      const imageBox = document.createElement('div');
      imageBox.className = 'piece-image';
      const image = document.createElement('img');
      imageBox.append(image);
      const details = document.createElement('pre');
      const solo = document.createElement('button');
      solo.onclick = () => toggleSolo(entry.order);
      card.append(header, imageBox, details, solo);
      view = { card, name, order, image, details, solo };
      pieceCards.set(entry.order, view);
    }
    view.card.classList.toggle('selected', soloOrder === entry.order);
    view.name.textContent = PART_NAMES[part.part] ?? part.part;
    view.order.textContent = `#${entry.order + 1}`;
    const source = thumbnail(entry.key);
    if (view.image.getAttribute('src') !== source) view.image.src = source;
    view.image.alt = `${view.name.textContent} 原始切片 ${entry.key}`;
    const zoom = Math.max(1, Math.min(4, Math.floor(120 / sprite.width), Math.floor(94 / sprite.height)));
    view.image.width = sprite.width * zoom;
    view.image.height = sprite.height * zoom;
    view.details.textContent = `${entry.key} · 索引 ${part.piece}\n${sprite.width}×${sprite.height} · 基准 (${sprite.anchorX}, ${sprite.anchorY})\n位置 (${part.x}, ${part.y}) · 角度 ${part.angle}°\n缩放 ${part.scaleX}, ${part.scaleY} · 透明度 ${part.alpha}`;
    view.solo.textContent = soloOrder === entry.order ? '恢复完整角色' : '仅看此片';
    return view.card;
  });
  if (cards.length !== piecesElement.children.length || cards.some((card, index) => piecesElement.children[index] !== card)) {
    piecesElement.replaceChildren(...cards);
  }
  if (!cards.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-pieces';
    empty.textContent = '这一帧没有可见部件。可在右侧恢复外观。';
    piecesElement.append(empty);
  }
  element('piece-count').textContent = `${cards.length} 片 · 从后到前`;
}

function renderFrame(): void {
  if (!pose || !ready) return;
  currentPieces = framePieces(catalog, variants, pose.frames[playback.frame]);
  if (soloOrder !== undefined && !currentPieces.some(entry => entry.order === soloOrder)) resetSolo();
  scene?.draw();
  syncPlayback();
  renderPieces();
  const used = new Set(currentPieces.map(entry => entry.part.part));
  for (const [part, label] of variantUseLabels) {
    label.textContent = hiddenParts.has(part) ? '已隐藏' : used.has(part) ? '使用中' : '未使用';
  }
}

function renderActions(): void {
  const groups = new Map<string, HTMLElement>();
  for (const choice of choices) {
    let group = groups.get(choice.group);
    if (!group) {
      group = document.createElement('section');
      group.className = 'action-group';
      const title = document.createElement('h3');
      title.textContent = choice.group;
      group.append(title);
      groups.set(choice.group, group);
    }
    const button = document.createElement('button');
    button.textContent = choice.label;
    button.dataset.action = choice.key;
    button.setAttribute('aria-current', String(choice.key === selectedAction));
    button.onclick = () => {
      selectedAction = choice.key;
      playback.frame = 0;
      void refresh();
    };
    group.append(button);
  }
  actionsElement.replaceChildren(...groups.values());
  element('action-count').textContent = `${choices.length} 组`;
}

function renderVariants(): void {
  variantUseLabels.clear();
  const core = ['body', 'head-front', 'head-back', 'coat-front', 'coat-back', 'cloak'];
  const baseVariants = viewerRecipe(catalog, items, equipment, {}).variants;
  const parts = new Set([...core, ...Object.keys(baseVariants), ...Object.keys(overrides), ...Object.keys(variants)]);
  for (const frame of pose?.frames ?? []) for (const part of frame) {
    if (variants[part.part] || part.part === 'cast-prop-1') parts.add(part.part);
  }
  const rows: HTMLElement[] = [];
  for (const part of parts) {
    const available = variantChoices(catalog, items, part);
    if (!available.length) continue;
    const row = document.createElement('div');
    row.className = 'variant-row';
    const title = document.createElement('div');
    title.className = 'variant-title';
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hiddenParts.has(part);
    checkbox.onchange = () => {
      if (checkbox.checked) hiddenParts.delete(part);
      else hiddenParts.add(part);
      renderFrame();
    };
    label.append(checkbox, PART_NAMES[part] ?? part);
    const usage = document.createElement('span');
    usage.className = 'variant-use';
    variantUseLabels.set(part, usage);
    title.append(label, usage);
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${PART_NAMES[part] ?? part}外观`);
    select.append(option('', '不显示'), ...available.map(choice => option(choice.id, choice.label)));
    select.value = variants[part] ?? '';
    select.onchange = () => {
      overrides[part] = select.value || null;
      void refresh(false);
    };
    const id = document.createElement('div');
    id.className = 'variant-id';
    id.textContent = variants[part] ?? '未装备';
    row.append(title, select, id);
    rows.push(row);
  }
  variantsElement.replaceChildren(...rows);
}

async function refresh(rebuildActions = true): Promise<void> {
  const request = ++revision;
  ready = false;
  workspace.setAttribute('aria-busy', 'true');
  scene?.setLoading();
  report('正在准备动作…');
  try {
    variants = viewerRecipe(catalog, items, equipment, overrides).variants;
    if (rebuildActions) {
      choices = actionChoices(catalog, items, equipment, facing, skillNames);
      if (!choices.some(choice => choice.key === selectedAction)) {
        selectedAction = 'idle';
        playback.frame = 0;
      }
      renderActions();
    }
    const selected = choices.find(choice => choice.key === selectedAction)!;
    const nextPose = await repository.get(selected.poseId);
    if (request !== revision) return;
    pose = nextPose;
    bounds = poseBounds(catalog, variants, pose);
    playback.configure(pose.frames.length, pose.frameRate);
    timeline.max = String(pose.frames.length - 1);
    resetSolo();
    renderVariants();
    element('action-title').textContent = selected.label;
    element('pose-info').textContent = `${selected.poseId} · ${Number(pose.frameRate.toFixed(2))} fps${pose.mirrorX ? ' · 镜像' : ''}`;
    ready = true;
    workspace.setAttribute('aria-busy', 'false');
    renderFrame();
    report(`游戏原始素材 · ${pose.frames.length} 帧 · 可替换部位、暂停并查看切片`);
  } catch (error) {
    if (request !== revision) return;
    report(error instanceof Error ? error.message : String(error), true);
    workspace.setAttribute('aria-busy', 'false');
  }
}

function refreshWeapons(): void {
  const choices = compatibleOffhands(catalog, items, equipment['main-hand']);
  if (!choices.some(choice => choice.id === equipment['off-hand'])) delete equipment['off-hand'];
  offSelect.replaceChildren(option('', '空手'), ...choices.map(choice => option(choice.id, choice.label)));
  offSelect.value = equipment['off-hand'] ?? '';
  offSelect.disabled = !choices.length;
}

function clearWeaponOverrides(): void {
  for (const part of Object.keys(overrides)) {
    if (!['body', 'head-front', 'head-back', 'coat-front', 'coat-back', 'cloak', 'cast-prop-1'].includes(part)) {
      delete overrides[part];
      hiddenParts.delete(part);
    }
  }
  for (const part of [...hiddenParts]) {
    if (!['body', 'head-front', 'head-back', 'coat-front', 'coat-back', 'cloak', 'cast-prop-1'].includes(part)) {
      hiddenParts.delete(part);
    }
  }
}

function selectFrame(frame: number): void {
  if (!ready) return;
  playback.seek(frame);
  renderFrame();
}

function wireControls(): void {
  playButton.onclick = () => {
    if (!ready) return;
    playback.toggle();
    resetSolo();
    renderFrame();
  };
  element('previous').onclick = () => selectFrame(playback.frame - 1);
  element('next').onclick = () => selectFrame(playback.frame + 1);
  timeline.oninput = () => selectFrame(Number(timeline.value));
  element<HTMLSelectElement>('speed').onchange = event => {
    playback.speed = Number((event.target as HTMLSelectElement).value);
  };
  zoomSelect.onchange = () => scene?.draw();
  element<HTMLSelectElement>('background').onchange = event => {
    stage.className = `stage ${(event.target as HTMLSelectElement).value}`;
  };
  showAll.onclick = () => { resetSolo(); renderFrame(); };
  mainSelect.onchange = () => {
    if (mainSelect.value) equipment['main-hand'] = mainSelect.value;
    else delete equipment['main-hand'];
    clearWeaponOverrides();
    refreshWeapons();
    void refresh();
  };
  offSelect.onchange = () => {
    if (offSelect.value) equipment['off-hand'] = offSelect.value;
    else delete equipment['off-hand'];
    clearWeaponOverrides();
    void refresh();
  };
  element('reset').onclick = () => {
    equipment = { 'main-hand': mainSelect.options[1].value };
    overrides = {};
    hiddenParts = new Set();
    mainSelect.value = equipment['main-hand']!;
    refreshWeapons();
    void refresh();
  };
  element('directions').querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    button.onclick = () => {
      facing = button.dataset.facing as Facing;
      element('directions').querySelectorAll('button').forEach(other => {
        other.setAttribute('aria-pressed', String(other === button));
      });
      void refresh();
    };
  });
  window.addEventListener('keydown', event => {
    if (!ready || event.altKey || event.metaKey || event.ctrlKey) return;
    if ((event.target as HTMLElement).closest('input, select, textarea, button, [contenteditable]')) return;
    if (event.code === 'Space') { event.preventDefault(); playButton.click(); }
    if (event.code === 'ArrowLeft') { event.preventDefault(); selectFrame(playback.frame - 1); }
    if (event.code === 'ArrowRight') { event.preventDefault(); selectFrame(playback.frame + 1); }
  });
}

async function boot(): Promise<void> {
  const battle = await readJson<{ skills: Record<string, { name: string }> }>('/content/battle.json');
  [catalog, items] = await Promise.all([
    readJson<WardrobeCatalog>('/content/wardrobe.json'), readJson<ItemCatalog>('/content/items.json'),
  ]);
  repository = new PoseRepository(catalog, readJson<CostumePose>);
  skillNames = Object.fromEntries(Object.entries(battle.skills).map(([id, value]) => [id, value.name]));
  const choices = weaponChoices(catalog, items);
  const defaultAppearance = catalog.equipment[items.startingEquipment.warrior['main-hand']!];
  const initial = choices.find(choice => JSON.stringify(catalog.equipment[choice.id].main) ===
    JSON.stringify(defaultAppearance.main))!;
  equipment = { 'main-hand': initial.id };
  mainSelect.append(option('', '空手'), option(initial.id, `${initial.label}（默认）`),
    ...choices.filter(choice => choice.id !== initial.id).map(choice => option(choice.id, choice.label)));
  mainSelect.value = initial.id;
  refreshWeapons();
  wireControls();
  await Promise.all(catalog.textures.map(async texture => { images.set(texture.key, await readImage(texture.file)); }));
  const parent = element('character-canvas');
  game = new Phaser.Game({
    type: Phaser.WEBGL, parent, width: parent.clientWidth, height: parent.clientHeight,
    transparent: true, pixelArt: true, roundPixels: false, antialias: false, banner: false,
    audio: { noAudio: true }, scene: CharacterScene,
    scale: { mode: Phaser.Scale.NONE }, fps: { target: 30 },
  });
  observer = new ResizeObserver(() => {
    if (parent.clientWidth && parent.clientHeight) game?.scale.resize(parent.clientWidth, parent.clientHeight);
  });
  observer.observe(parent);
}

window.addEventListener('pagehide', () => {
  observer?.disconnect();
  game?.destroy(true);
});
void boot().catch(error => report(error instanceof Error ? error.message : String(error), true));
