import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseBattle} from '../src/application/content-validation.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {SkillConfiguration} from '../src/domain/skill-configuration.ts';
import {StoryWorldState} from '../src/domain/story-world.ts';
import type {BattleBuffEffect} from '../src/domain/battle.ts';

const catalog = parseBattle(JSON.parse(fs.readFileSync(new URL('../public/content/battle.json', import.meta.url), 'utf8')));

function buffEffect(overrides: Partial<BattleBuffEffect> = {}): BattleBuffEffect {
  return {durationMs: 1000, tickMs: 0, modifiers: [], states: [], periodic: [], ...overrides};
}

test('condition revision moves only when the buff or state set changes', () => {
  const conditions = new CombatConditions();
  const start = conditions.revision;

  conditions.attribute('ally', 'physicalDamageRate', 0);
  conditions.activeStates('ally');
  conditions.update(16);
  assert.equal(conditions.revision, start, '只读属性和空转帧不推进修订号');

  conditions.applyBuff('ally', 'attack-stun', 1, buffEffect({durationMs: 1000}));
  const afterBuff = conditions.revision;
  assert.ok(afterBuff > start, '施加 buff 推进修订号');

  conditions.update(100);
  assert.equal(conditions.revision, afterBuff, '计时推进不推进修订号');

  conditions.update(1000);
  assert.ok(conditions.revision > afterBuff, 'buff 自然到期推进修订号');
});

test('state expiry and explicit removal each advance the condition revision', () => {
  const conditions = new CombatConditions();
  const start = conditions.revision;
  conditions.applyState('ally', 'stealthed', 500);
  const afterApply = conditions.revision;
  assert.ok(afterApply > start);

  conditions.update(500);
  const afterExpiry = conditions.revision;
  assert.ok(afterExpiry > afterApply);

  conditions.applyState('ally', 'stealthed', 500);
  const afterReapply = conditions.revision;
  conditions.removeState('ally', 'stealthed');
  assert.ok(conditions.revision > afterReapply, '显式移除也推进修订号');
});

test('encounter revision ignores unrelated world commands', () => {
  const world = new StoryWorldState();
  const start = world.encounterRevision;

  world.apply({kind: 'flag', id: 'seen', value: true});
  world.apply({kind: 'choice', id: 'route', value: 'north'});
  assert.equal(world.encounterRevision, start);

  world.apply({kind: 'encounter', encounter: {id: 'ambush', map: 'forest', status: 'active', spawns: []}});
  assert.equal(world.encounterRevision, start + 1);

  world.apply({kind: 'encounter-result', id: 'ambush', result: 'won'});
  assert.equal(world.encounterRevision, start + 2);

  world.apply({kind: 'encounter-result', id: 'ambush', result: 'won'});
  assert.equal(world.encounterRevision, start + 2, '重复上报同一个结果不再推进');
});

test('draft call counter counts every real draft', () => {
  const skills = new SkillConfiguration();
  const classId = catalog.classes[0]!.id;
  const start = skills.draftCalls;
  skills.draft(catalog, classId);
  skills.draft(catalog, classId);
  assert.equal(skills.draftCalls, start + 2);
});
