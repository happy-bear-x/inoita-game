import type {WorldEnemyRoster} from './world-enemies.ts';
import {CombatConditions,type CombatConditionsState} from './combat-conditions.ts';
import type {CombatThreatSystemState} from './combat-threat-system.ts';
import type {CombatSnapshot} from './combat.ts';
import type {EnemyController} from './enemy-ai.ts';
import {friendlySummonStationaryState,type FriendlySummonState} from './friendly-summon-ai.ts';
import type {PartyController} from './party-ai.ts';
import type {Point} from './navigation.ts';
import type {Facing} from './content.ts';
import type {BattleCatalog} from './battle.ts';
import {ThreatLedger} from './combat-threat.ts';

type WorldEnemyAIState =
  | {kind:'enemy';state:ReturnType<EnemyController['captureState']>}
  | {kind:'friendly-summon';state:FriendlySummonState};

export interface WorldCombatState {
  /** 持有者 `WorldEnemyRoster`。注意其中的位置是**生成时刻的站位**，实时真值在物理体上；
   *  `captureState` 会先用 `movement.position` 覆盖一次，别把它当成敌人的当前位置读。 */
  roster:ReturnType<WorldEnemyRoster['captureState']>;
  /** 持有者 `CombatConditions`，回读后紧跟 `syncControlled` 重建受控者。 */
  conditions:CombatConditionsState;
  /** 持有者 `CombatThreatSystem`。它读单位名单，所以回读要排在 `roster` 之后。 */
  threat:CombatThreatSystemState;
  /** 逐名上阵队员：位置与朝向来自 `movement`／`scene`，战斗状态来自各自的 `CombatController`，
   *  AI 状态来自 `heroAi`／`allies` 里的对应实例。 */
  party:{id:string;position:Point;facing:Facing;combat:CombatSnapshot;ai?:ReturnType<PartyController['captureState']>}[];
  /** 逐名场上敌人。位置的实时真值在物理体上，这里只存朝向与 AI。 */
  enemies:{id:string;facing:Facing;ai?:WorldEnemyAIState;summonRemainingMs?:number;summonTauntChance?:number}[];
  /** 持有者就是 `WorldCombat.summonGroups` 自己：召唤物分组，键是主人，值是召唤物 id。 */
  summonGroups:[string,string[]][];
  /** `WorldCombat` 自己的字段：当前锁定目标。 */
  focusTargetId?:string;
}

function finiteTree(value:unknown,seen=new Set<object>()):void {
  if(typeof value==='number'&&!Number.isFinite(value))throw new Error('战斗快照含无效数值');
  if(value&&typeof value==='object'){
    if(seen.has(value))throw new Error('战斗快照包含循环引用');
    seen.add(value);for(const child of Object.values(value))finiteTree(child,seen);seen.delete(value);
  }
}
/** 读档先校验隔离副本；静止恢复丢弃动作、路径与动作临时属性。 */
export function prepareCombatRestore(value:WorldCombatState,catalog:BattleCatalog,partyIds:readonly string[]):WorldCombatState {
  const copy=structuredClone(value);finiteTree(copy);
  if(!copy||!Array.isArray(copy.party)||!Array.isArray(copy.enemies)||!Array.isArray(copy.roster?.enemies)||!Array.isArray(copy.summonGroups))throw new Error('战斗快照结构无效');
  if(!Number.isSafeInteger(copy.roster.sequence)||copy.roster.sequence<0||![1,2,3].includes(copy.roster.partySize))throw new Error('战斗名册快照无效');
  const facings=new Set(['north','south','east','west']),definitions=new Set(catalog.enemies.map(enemy=>enemy.id));
  const actors=new Set<string>(),members=new Set(['player',...partyIds]);
  for(const saved of copy.party){
    if(!members.has(saved.id)||actors.has(saved.id)||!facings.has(saved.facing)||!Number.isFinite(saved.position?.x)||!Number.isFinite(saved.position?.y)||!saved.combat)throw new Error('战斗队员快照无效');
    actors.add(saved.id);saved.combat={...saved.combat,state:'idle'};
    if(saved.ai){saved.ai.path=[];saved.ai.destination=undefined;saved.ai.destinationTarget=undefined;saved.ai.accumulator=0;}
  }
  for(const enemy of copy.roster.enemies){if(typeof enemy.key!=='string'||!enemy.key||actors.has(enemy.key)||!definitions.has(enemy.enemyId)||!Number.isFinite(enemy.x)||!Number.isFinite(enemy.y)||
    enemy.health!==undefined&&enemy.health<0||enemy.mana!==undefined&&enemy.mana<0)throw new Error('战斗敌人快照无效');actors.add(enemy.key);}
  const placedById=new Map(copy.roster.enemies.map(enemy=>[enemy.key,enemy]));
  const enemies=new Set(placedById.keys());
  const party=new Set(copy.party.map(member=>member.id));
  for(const placed of copy.roster.enemies){
    if(placed.summonedBy===undefined)continue;
    if(typeof placed.summonedBy!=='string'||!actors.has(placed.summonedBy)||placed.summonedBy===placed.key)throw new Error('召唤主人引用无效');
    const visited=new Set<string>([placed.key]);
    let owner:string|undefined=placed.summonedBy;
    while(owner){
      if(visited.has(owner))throw new Error('召唤主人关系包含循环');
      visited.add(owner);owner=placedById.get(owner)?.summonedBy;
    }
  }
  if(new Set(copy.enemies.map(enemy=>enemy.id)).size!==copy.enemies.length||copy.enemies.length!==enemies.size)throw new Error('战斗敌人记录重复或缺失');
  for(const saved of copy.enemies){
    if(!enemies.has(saved.id)||!facings.has(saved.facing))throw new Error('战斗敌人状态引用无效');
    if([saved.summonRemainingMs,saved.summonTauntChance].some(value=>value!==undefined&&(!Number.isFinite(value)||value<0)))throw new Error('召唤状态数值无效');
    const placed=placedById.get(saved.id)!;
    const friendly=placed.summonedBy!==undefined&&members.has(placed.summonedBy);
    if(friendly&&!party.has(placed.summonedBy!))throw new Error('友方召唤主人不在活动队伍中');
    if(!saved.ai){if(friendly)throw new Error('友方召唤缺少行为状态');continue;}
    if(!saved.ai.state||typeof saved.ai.state!=='object')throw new Error('战斗行为状态无效');
    if(saved.ai.kind==='friendly-summon'){
      const state=saved.ai.state;
      const role=placed.enemyId==='enemy-hell-s-pawn-1'?'hell-soldier':placed.enemyId==='enemy-beast-companion-1'?'beast':undefined;
      if(!friendly||state.ownerId!==placed.summonedBy||!role||state.role!==role)throw new Error('友方召唤行为身份不一致');
      saved.ai.state=friendlySummonStationaryState(state);
    }else if(saved.ai.kind==='enemy'){
      if(friendly)throw new Error('友方召唤行为类型无效');
      const state=saved.ai.state;
      if(!['idle','wandering','chasing','attacking','returning'].includes(state.state)||
        typeof state.pendingReturn!=='boolean'||!Array.isArray(state.path)||
        [state.accumulator,state.clock,state.nextPathAt,state.lastProgressAt,state.idleElapsed].some(value=>!Number.isFinite(value)||value<0))throw new Error('敌方行为状态无效');
      state.state='idle';state.path=[];state.destination=undefined;state.destinationRange=undefined;state.wanderDestination=undefined;state.progressPosition=undefined;state.targetId=undefined;state.pendingReturn=false;state.accumulator=0;state.threatCombatActive=false;
      if(state.combat)state.combat={...state.combat,state:'idle',targetId:undefined};
    }else throw new Error('战斗行为类型无效');
  }
  const grouped=new Set<string>(),owners=new Set<string>();
  for(const group of copy.summonGroups){
    if(!Array.isArray(group)||group.length!==2)throw new Error('召唤分组结构无效');
    const [owner,ids]=group;
    if(!actors.has(owner)||owners.has(owner)||!Array.isArray(ids))throw new Error('召唤分组引用无效');
    owners.add(owner);
    for(const id of ids){
      if(!enemies.has(id)||grouped.has(id)||placedById.get(id)?.summonedBy!==owner)throw new Error('召唤分组主人不一致');
      grouped.add(id);
    }
  }
  if(copy.roster.enemies.some(placed=>placed.summonedBy!==undefined&&!grouped.has(placed.key)))throw new Error('召唤分组缺少活动召唤');
  if(copy.focusTargetId&&!actors.has(copy.focusTargetId))copy.focusTargetId=undefined;
  // 验证状态容器结构之后，重新计算静止角色的资源容量缓存。
  if(!copy.conditions||!Array.isArray(copy.conditions.buffs)||!Array.isArray(copy.conditions.states)||!Array.isArray(copy.conditions.temporary))throw new Error('战斗状态容器无效');
  for(const records of [copy.conditions.buffs,copy.conditions.states]){
    const owners=new Set<string>();
    for(const [id,entries] of records){
      if(!actors.has(id)||owners.has(id)||!Array.isArray(entries)||new Set(entries.map(entry=>entry.id)).size!==entries.length)throw new Error('战斗状态引用无效');
      owners.add(id);for(const entry of entries)if(typeof entry.id!=='string'||typeof entry.sourceId!=='string'||!Number.isFinite(entry.remainingMs)||entry.remainingMs<0)throw new Error('战斗状态记录无效');
    }
  }
  new CombatConditions().restoreState(copy.conditions);
  new ThreatLedger().restoreState(copy.threat);
  copy.conditions.temporary=[];copy.conditions.resourceCapacities=[];copy.conditions.resourceCapacityInputs=[];
  return copy;
}
