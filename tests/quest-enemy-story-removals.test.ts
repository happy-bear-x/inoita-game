import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { Campaign } from '../src/domain/campaign.ts';
import type { WorldMap } from '../src/domain/content.ts';

const read = <T>(name: string): T => JSON.parse(fs.readFileSync(
  new URL(`../public/content/${name}.json`, import.meta.url), 'utf8'));
const campaign = read<Campaign>('campaign');
const drops = read<{ questItems: Record<string, { item: string }[]> }>('drops');

/**
 * 已知会被剧情永久清掉、但任务仍可能需要的目标怪。
 *
 * 运行时靠 WorldEnemyRoster 的「任务进行中优先生成」兜底，所以这些组合本身不再卡任务。
 * 新增组合必须显式登记：先确认任务提示地图是否还找得到目标怪，再决定是修内容还是接受兜底。
 * 键的格式：`任务|地图|怪物|remove-all|disabled`。
 */
const KNOWN_REMOVALS = [
  'knight-uniform|shadow-training-dungeon-2-a6b8293b|enemy-reagents-1|disabled',
  'quest-11|training-dungeon-two|enemy-wild-wolf-1|disabled',
  'quest-102|closed-dungeon-1-61475d35|enemy-black-giant-maggots-1|disabled',
  'quest-102|closed-dungeon-2-563efc16|enemy-ghost-2|disabled',
  'quest-109|hanun-forest-3-3a1017a4|enemy-red-snake-1|disabled',
  'quest-109|hanun-forest-3-3a1017a4|enemy-black-wolf-1|disabled',
  'quest-109|hanun-forest-4-3a7b18ae|enemy-red-snake-1|disabled',
  'quest-141|hanun-forest-4-3a7b18ae|enemy-berkel-soldier-9|disabled',
  'quest-157|training-dungeon-one|enemy-acid-slime-1|disabled',
  'quest-157|training-dungeon-two|enemy-starving-boss-wolf-1|disabled',
  'quest-170|hanun-forest-4-3a7b18ae|enemy-berkel-soldier-9|disabled',
  'quest-171|closed-dungeon-2-563efc16|enemy-enraged-magic-book-1|disabled',
  'quest-181|shadow-training-dungeon-2-a6b8293b|enemy-knife-needled-mosquitoes-1|disabled',
  'quest-182|blackhoods-hideout-86afa206|enemy-blackhood-thieves-2|disabled',
  'quest-188|blackhoods-hideout-86afa206|enemy-blackhood-thieves-2|disabled',
  'quest-225|piolren-meadows-4-391c0785|enemy-convict-1|remove-all',
  'quest-347|hanun-forest-4-3a7b18ae|enemy-geyorgk-the-cruel-enemy-1|disabled',
  'quest-357|piolren-meadows-7-4c61d9fe|enemy-meadow-turtle-1|remove-all',
  'quest-476|empire-capital-alley-1-81ac0655|enemy-berkelen-castle-guards-1|disabled',
  'quest-476|empire-capital-alley-1-81ac0655|enemy-berkelen-guards-1|disabled',
  'quest-476|empire-capital-alley-2-fedba5da|enemy-berkelen-guards-1|disabled',
  'quest-476|empire-capital-alley-2-fedba5da|enemy-berkel-wizard-guards-1|disabled',
  'quest-476|empire-capital-alley-3-b7bc4d6b|enemy-berkelen-castle-guards-1|disabled',
  'quest-476|empire-capital-alley-3-b7bc4d6b|enemy-berkelen-guards-1|disabled',
  'quest-476|empire-capital-alley-5-30743650|enemy-berkelen-castle-guards-1|disabled',
  'quest-476|empire-capital-alley-5-30743650|enemy-berkel-wizard-guards-1|disabled',
  'quest-477|piolren-meadows-2-3af4c9e5|enemy-blue-wingslime-1|remove-all',
];

test('剧情永久清场的任务目标怪组合保持登记状态', () => {
  const maps = new Map<string, WorldMap>();
  const mapDir = new URL('../public/content/maps/', import.meta.url);
  for (const name of fs.readdirSync(mapDir)) {
    if (!name.endsWith('.json')) continue;
    const map = JSON.parse(fs.readFileSync(new URL(name, mapDir), 'utf8')) as WorldMap;
    maps.set(map.id, map);
  }

  const staticSources = new Map<string, Set<string>>();
  for (const map of maps.values()) for (const spawn of map.enemySpawns ?? []) {
    if (!staticSources.has(spawn.enemyId)) staticSources.set(spawn.enemyId, new Set());
    staticSources.get(spawn.enemyId)!.add(map.id);
  }

  const commands: { kind: string; map?: string; enemyId: string; available?: boolean; all?: boolean; script: string; node: string }[] = [];
  for (const [scriptId, script] of Object.entries(campaign.scripts ?? {})) {
    for (const node of script.nodes ?? []) for (const command of node.commands ?? []) {
      if (command.type !== 'world' || !command.command) continue;
      const value = command.command;
      if (value.kind === 'remove-enemy' || value.kind === 'enemy-availability')
        commands.push({ ...value, script: scriptId, node: node.id });
    }
  }

  const resumed = new Set(commands
    .filter(command => command.kind === 'enemy-availability' && command.available)
    .map(command => `${command.map}|${command.enemyId}`));
  const removedAll = new Set(commands
    .filter(command => command.kind === 'remove-enemy' && command.map && command.all)
    .map(command => `${command.map}|${command.enemyId}`));
  const disabled = new Set(commands
    .filter(command => command.kind === 'enemy-availability' && !command.available
      && !resumed.has(`${command.map}|${command.enemyId}`))
    .map(command => `${command.map}|${command.enemyId}`));

  const actual: string[] = [];
  for (const quest of campaign.quests ?? []) {
    const enemies = new Set<string>();
    for (const goal of quest.goals ?? []) {
      if (goal.kind === 'defeat') enemies.add(goal.target);
      else if (goal.kind === 'item') for (const [enemyId, rules] of Object.entries(drops.questItems))
        if (rules.some(rule => rule.item === goal.target)) enemies.add(enemyId);
    }
    for (const enemyId of enemies) for (const mapId of staticSources.get(enemyId) ?? []) {
      const key = `${mapId}|${enemyId}`;
      if (removedAll.has(key)) actual.push(`${quest.id}|${mapId}|${enemyId}|remove-all`);
      else if (disabled.has(key)) actual.push(`${quest.id}|${mapId}|${enemyId}|disabled`);
    }
  }

  assert.deepEqual([...new Set(actual)].sort(), [...KNOWN_REMOVALS].sort(),
    '新增或移除了“任务目标怪被剧情永久清场”的组合，请先确认运行时保护覆盖它');
});
