import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBattle } from '../src/application/content-validation.ts';
import { CombatController } from '../src/domain/combat.ts';
import type { Combatant, CombatPort } from '../src/domain/combat.ts';
import type { Facing } from '../src/domain/content.ts';
import { planRearTeleport } from '../src/domain/rear-teleport.ts';
import { skillPlaybackEvents } from '../src/domain/skill-action.ts';

const bounds = { x: -8, y: -8, width: 16, height: 16 };
const target: Combatant = { id: 'enemy', team: 'hostile', position: { x: 320, y: 192 }, bounds, facing: 'north' };
const caster: Combatant = { id: 'player', team: 'party', position: { x: 256, y: 192 }, bounds, facing: 'east' };
const catalog = parseBattle(JSON.parse(fs.readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')));
const action = catalog.skills['dark-attack'].action!;

test('黑暗奇袭按目标朝向先找背后，再向两侧和正面寻找可站且可达的落点', () => {
  const destinations: Record<Facing, { x: number; y: number }> = {
    north: { x: 320, y: 216 }, south: { x: 320, y: 168 }, west: { x: 344, y: 192 }, east: { x: 296, y: 192 },
  };
  for (const facing of Object.keys(destinations) as Facing[])
    assert.deepEqual(planRearTeleport(caster, { ...target, facing }, () => true, () => true), destinations[facing]);
  assert.deepEqual(planRearTeleport(caster, target, point => point.y <= 192, () => true), { x: 296, y: 192 });
  assert.deepEqual(planRearTeleport(caster, target, () => true, point => point.y <= 192), { x: 296, y: 192 });
  assert.equal(planRearTeleport(caster, target, () => false, () => true), undefined);
});

test('战斗控制器把正式地图边界传给黑暗奇袭的候选格点扫描', () => {
  const player = { ...caster, position: { x: 8, y: 24 } };
  const enemy = { ...target, position: { x: 24, y: 24 } };
  const checked: { x: number; y: number }[] = [];
  let onFrame!: (index: number) => void;
  let boundsReads = 0;
  const port: CombatPort = {
    cooldowns: new CombatCooldownStore(() => 0).forActor('player'),
    actor: id => id === 'player' ? player : id === 'enemy' ? enemy : undefined,
    candidates: () => [player, enemy], facing: () => 'east',
    navigationBounds: () => { boundsReads++; return { x: 0, y: 0, width: 32, height: 32 }; },
    moveToward: () => {}, stop: () => {}, relocate: () => {}, clearEffects: () => {},
    canStand: point => { checked.push(point); return false; },
    // 位移只认整盒判定：这里把同一谓词当作整盒可站性。
    canPlaceBody: point => { checked.push(point); return false; },
    play: (_action, frame) => { onFrame = frame; return () => {}; },
    frame: () => {},
  };
  const combat = new CombatController('player', null, port);
  assert.equal(combat.request({ id: 'dark-attack', action }, 'enemy'), 'started');
  onFrame(8);
  assert.equal(boundsReads, 1);
  assert.deepEqual(checked, [
    { x: 24, y: 48 }, { x: 0, y: 24 }, { x: 8, y: 24 },
    { x: 48, y: 24 }, { x: 40, y: 24 }, { x: 24, y: 0 },
  ]);
});

test('第八帧先瞬移转向再结算；找位失败保留挥击与动作余帧', () => {
  for (const scenario of ['success', 'blocked', 'target-removed']) {
    const available = scenario !== 'blocked';
    let targetPresent = true;
    let player = { ...caster }, onFrame!: (index: number) => void, finish!: () => void;
    const order: string[] = [];
    const frames: number[] = [], clearanceActors: (string | undefined)[] = [];
    let mana = 100, cancelled = false, verifyCalls = 0;
    const port: CombatPort = {cooldowns:new CombatCooldownStore(()=>0).forActor('player'),
      actor: id => id === 'player' ? player : id === 'enemy' && targetPresent ? target : undefined,
      candidates: () => targetPresent ? [player, target] : [player], facing: () => 'east',
      moveToward: () => {}, stop: () => {},
      canStand: () => available,
      canPlaceBody: (_position, clearanceActorId) => { clearanceActors.push(clearanceActorId); return available; },
      canRelocateVerify: () => { verifyCalls++; return true; },
      relocate: point => { player = { ...player, position: point }; order.push('relocate'); },
      face: facing => order.push(`face:${facing}`), clearEffects: () => {},
      canSpendMana: cost => mana >= cost, spendMana: cost => { mana -= cost; return true; },
      play: (_action, frame, complete) => { onFrame = frame; finish = complete; return () => { cancelled = true; }; },
      frame: (playback,index,_contact,ready) => {
        frames.push(index);
        for(const event of skillPlaybackEvents(playback.skill!.action,index,playback.skill!.level)) {
          if(event.kind==='units') {
            order.push('dispatch');
            ready({event,selectedTargetId:playback.target?.id});
          }
          if(event.kind==='swing')order.push('swing');
        }
      },
      unit: event => { order.push(`hit:${event.targetId}@${player.position.x},${player.position.y}`); return 'success'; },
    };
    const combat = new CombatController('player', null, port);
    assert.equal(combat.request({ id: 'dark-attack', action, manaCost: 52 }, 'enemy'), 'started');
    onFrame(7); assert.deepEqual(order, []);
    if(scenario === 'target-removed')targetPresent = false;
    onFrame(8);
    if (scenario === 'success') assert.deepEqual(order, ['relocate', 'face:north', 'dispatch', 'hit:enemy@320,216', 'swing']);
    else assert.deepEqual(order, ['swing']);
    assert.equal(verifyCalls, 0, '瞬移只检查同地形和落点，不再跑全路线搜索');
    assert.equal(clearanceActors.length > 0, scenario !== 'target-removed');
    assert.ok(clearanceActors.every(id => id === 'enemy'));
    assert.equal(combat.snapshot().state, 'attacking');
    assert.equal(cancelled, false);
    assert.equal(mana, 48);
    assert.equal(combat.snapshot().cooldowns['dark-attack'].durationMs, action.cooldownFrames*60);
    onFrame(12);
    assert.equal(frames.at(-1), 12);
    assert.equal(combat.snapshot().state, 'attacking');
    finish();
    assert.equal(combat.snapshot().state, 'idle');
    assert.equal(action.events.some(event => event.kind === 'units'), true);
  }
});
