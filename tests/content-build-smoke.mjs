/**
 * 生产内容烟雾测试：用真实 `public/content` 编译到临时目录，再跑一个小战斗和一个剧情节点。
 *
 * 只证明编译后的 `battle.json`/`campaign.json` 能在运行时格式下工作，不重复单元测试的语义校验。
 * 独立运行：`npm run test:content-build`；不进入每次 `npm test`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContent } from '../tools/content-build.ts';
import { buildContentManifest } from '../tools/content-manifest.ts';
import { hashTree } from '../tools/build-version.ts';
import { CombatController } from '../src/domain/combat.ts';
import { CombatCooldownStore } from '../src/domain/combat-cooldowns.ts';
import { resolveBasicAttack } from '../src/domain/basic-attack.ts';
import { needsTarget, skillEvents } from '../src/domain/skill-action.ts';
import { StoryRuntime } from '../src/domain/story-runtime.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'story-content-smoke-'));
try {
  const contentDir = path.join(temporary, 'content');
  await buildContent(path.join(root, 'public/content'), contentDir);
  const battle = JSON.parse(await fs.readFile(path.join(contentDir, 'battle.json'), 'utf8'));
  const campaign = JSON.parse(await fs.readFile(path.join(contentDir, 'campaign.json'), 'utf8'));

  // 构建期清单：版本来自编译后目录，必需顶层键必须真的存在。
  const manifest = await buildContentManifest(contentDir, hashTree(contentDir));
  assert.deepEqual(manifest.required['content/campaign.json'], ['version', 'start', 'scripts', 'quests']);
  assert.deepEqual(manifest.required['content/battle.json'], ['classes', 'skills', 'enemies']);
  assert.ok(campaign.scripts && campaign.start && campaign.quests);

  // 编译后的技能 IR：目标需求、特效名和事件帧已经被运行时直接使用。
  const character = battle.classes[0];
  const skillId = character.skills.find(id => battle.skills[id].kind === 'active');
  const skill = battle.skills[skillId];
  assert.ok(skill?.action, '主动技能缺少动作时间轴');
  assert.equal(needsTarget(skill.action), skill.action.requiresTarget);
  assert.ok(Array.isArray(skill.action.effectNames));
  let events = 0;
  for (let frame = 0; frame < 240 && !events; frame++) events = skillEvents(skill.action, frame).length;
  assert.ok(events > 0, '编译后的技能事件帧没有被任何一帧触发');

  // 最小战斗：用编译后的目录跑一次普通攻击并命中。
  const caster = { id: 'player', team: 'party', position: { x: 100, y: 100 }, bounds: { x: -8, y: -8, width: 16, height: 16 } };
  const enemy = { ...caster, id: 'enemy', team: 'hostile', position: { x: 108, y: 100 } };
  const combatants = [caster, enemy];
  const contacts = [];
  let onFrame;
  const cooldowns = new CombatCooldownStore(() => 0);
  const port = {
    canSelectSkill: () => true,
    cooldowns: cooldowns.forActor('player'),
    actor: id => combatants.find(actor => actor.id === id),
    candidates: () => combatants,
    facing: () => 'east',
    moveToward: () => {}, stop: () => {}, canStand: () => true, relocate: () => {},
    play: (_action, frame) => { onFrame = frame; return () => {}; },
    frame: (action, index, contact) => {
      if (action.basicAttack && index === action.basicAttack.strikeFrame && action.target) contact(action.target.id);
    },
    contact: event => contacts.push(event.targetId),
    clearEffects: () => {},
  };
  const basic = resolveBasicAttack(battle, character);
  const combat = new CombatController('player', basic, port);
  assert.equal(combat.requestTarget('enemy'), 'started');
  for (let step = 0; step < 8 && !onFrame; step++) combat.update();
  assert.ok(onFrame, '最小战斗没有进入出招');
  onFrame(basic.strikeFrame);
  assert.deepEqual(contacts, ['enemy'], '普通攻击没有命中目标');

  // 最小剧情节点：从编译后的脚本直接执行一个空节点，确认图与运行时格式可读。
  const runtime = new StoryRuntime(campaign, {
    prepare: async () => {}, capture: () => undefined, present: async () => ({}), finish: async () => {},
    apply: () => {}, commit: () => {}, rollback: () => {}, evaluate: () => false,
  });
  assert.equal(await runtime.start('complete:quest-10', undefined, undefined, 'done'), true);
  assert.equal(runtime.snapshot().runs[0]?.status, 'completed');

  console.log('Content build smoke passed: compiled battle IR, minimal combat and a story node');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
