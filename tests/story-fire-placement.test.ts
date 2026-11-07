import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCampaign } from '../src/application/content-validation.ts';
import type { CollisionBox, EntityPlacement, WorldMap } from '../src/domain/content.ts';

/** 放火烧军备仓库：火焰是演出生成的固定机关，脚下碰撞盒不能压住可走地面。 */
const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = parseCampaign(read('campaign'));
const map = read('maps/east-kamuran-b52d2b0e') as WorldMap;
const actors = read('world').actors as Record<string, { collision?: CollisionBox }>;

const FIRE = 'story-flame-7ce0ff5c';
const TILE = 16;

function placedFires(collection: readonly { entity: EntityPlacement }[]): EntityPlacement[] {
  return collection.map(entry => entry.entity).filter(entity => entity.actor === FIRE);
}

function sceneFires(): EntityPlacement[] {
  const node = campaign.scripts['event-81'].nodes.find(entry => entry.id === 'scene-1');
  assert.ok(node, 'event-81 缺少 scene-1');
  const actions = placedFires(node.presentation.flatMap(action => action.type === 'world-object' && action.command.kind === 'place' ? [action.command] : []));
  assert.equal(actions.length, 5, '演出里应当摆放五团火');
  return actions;
}

function commandFires(): EntityPlacement[] {
  const node = campaign.scripts['event-81'].nodes.find(entry => entry.id === 'scene-1');
  assert.ok(node, 'event-81 缺少 scene-1');
  return placedFires(node.commands.flatMap(command => command.type === 'world' && command.command.kind === 'place' ? [command.command] : []));
}

function boxAt(x: number, y: number, collision: CollisionBox): CollisionBox {
  return { x: x + collision.x, y: y + collision.y, width: collision.width, height: collision.height };
}

function overlaps(a: CollisionBox, b: CollisionBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function walkableTiles(box: CollisionBox): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let row = Math.floor(box.y / TILE); row <= Math.floor((box.y + box.height - 1) / TILE); row++) {
    for (let column = Math.floor(box.x / TILE); column <= Math.floor((box.x + box.width - 1) / TILE); column++) {
      if (column < 0 || row < 0 || column >= map.columns || row >= map.rows) continue;
      if (map.blocked[row * map.columns + column]) continue;
      const tile = { x: column * TILE, y: row * TILE, width: TILE, height: TILE };
      if (overlaps(box, tile)) tiles.push({ x: tile.x, y: tile.y });
    }
  }
  return tiles;
}

test('event-81 的五团火都不压住仓库房间的可走地面', () => {
  for (const fire of sceneFires()) {
    const collision = actors[fire.actor]?.collision;
    assert.ok(collision, `${fire.actor} 缺少碰撞盒`);
    const tiles = walkableTiles(boxAt(fire.x, fire.y, collision));
    assert.deepEqual(tiles, [], `${fire.id} (${fire.x},${fire.y}) 压住了可走地面 ${tiles.map(tile => `${tile.x},${tile.y}`).join(' ')}`);
  }
});

test('演出摆放与剧情提交的五团火坐标一致', () => {
  const presentation = new Map(sceneFires().map(fire => [fire.id, fire]));
  const commands = commandFires();
  assert.equal(commands.length, presentation.size, '剧情提交应当复述同一批火焰');
  for (const fire of commands) {
    const shown = presentation.get(fire.id);
    assert.ok(shown, `剧情提交了演出里没有的火焰 ${fire.id}`);
    assert.deepEqual({ x: fire.x, y: fire.y }, { x: shown.x, y: shown.y }, `${fire.id} 两处坐标不一致`);
  }
});

test('仓库宝箱和主角演出落点都不在火焰碰撞盒里', () => {
  const chest = map.entities.find(entity => entity.id === 'treasure-box-a0caef88-002');
  assert.ok(chest, '宝箱位置变了，需要重新确认它和火焰的关系');
  assert.deepEqual({ x: chest.x, y: chest.y }, { x: 568, y: 136 }, '宝箱位置变了，需要重新确认它和火焰的关系');
  const chestCollision = actors['treasure-box-a0caef88'].collision;
  assert.ok(chestCollision, '宝箱缺少碰撞盒');
  const playerCollision = actors.kiyan.collision;
  assert.ok(playerCollision, '主角缺少碰撞盒');
  const targets = [
    { label: '宝箱', box: boxAt(chest.x, chest.y, chestCollision) },
    { label: '主角演出落点', box: boxAt(520, 296, playerCollision) },
  ];
  for (const fire of sceneFires()) {
    const collision = actors[fire.actor]?.collision;
    assert.ok(collision, `${fire.actor} 缺少碰撞盒`);
    const flame = boxAt(fire.x, fire.y, collision);
    for (const target of targets) assert.equal(overlaps(flame, target.box), false, `${target.label}落在火焰 ${fire.id} 的碰撞盒里`);
  }
});
