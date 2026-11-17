import type Phaser from 'phaser';
import type { ActorDefinition, EntityPlacement, Facing, WorldMap } from '../domain/content.ts';
import type { Cooldown } from '../domain/combat.ts';
import type { DropReward } from '../domain/drops.ts';
import type { CharacterVisual } from '../rendering/characters.ts';
import type { MovementWorld } from '../rendering/movement-world.ts';

/** 战斗使用引擎场景绘制，世界协作只通过这里列出的能力。 */
export interface CombatWorldHost extends Phaser.Scene {
  readonly canCombatControl:boolean;
  readonly map?:WorldMap;
  readonly entities:readonly EntityPlacement[];
  readonly player?:CharacterVisual;
  readonly movement?:MovementWorld;
  facing:Facing;
  combatEnemyIds():string[];
  equipmentAppearance(id:string):ActorDefinition|undefined;
  handleCombatDefeat():void;
  offensiveSkillCompleted(actorId:string):void;
  preparePartyMember(id:string,signal?:AbortSignal,options?:{full?:boolean;pin?:boolean}):Promise<void>;
  preparePlayerAppearance(signal?:AbortSignal):Promise<void>;
  refreshCombatHud(cooldowns?:Readonly<Record<string,Cooldown>>):void;
  refreshCombatTarget():void;
  reviveMember(id:string):{ok:boolean;reason?:string};
  spawnLootOnMap(map:string,x:number,y:number,rewards:readonly DropReward[],render?:boolean):void;
  lootLanding(map:string,x:number,y:number):{x:number;y:number};
  refreshGroundLoot():void;
  syncControlledCharacter(resetExitTrigger?:boolean):void;
}
