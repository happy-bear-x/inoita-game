import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {BattleCharacter} from '../src/domain/character-stats.ts';
import {CombatConditions} from '../src/domain/combat-conditions.ts';
import {CombatCooldownStore} from '../src/domain/combat-cooldowns.ts';
import {CombatHitResolution} from '../src/domain/combat-hit-resolution.ts';
import {CombatThreatSystem,type CombatThreatActor} from '../src/domain/combat-threat-system.ts';
import {SummonLifecycle} from '../src/domain/summon-lifecycle.ts';

const hook=registerHooks({resolve(specifier,context,next){return specifier==='phaser'
  ?{url:'data:text/javascript,export default {BlendModes:{},Scene:class{},Physics:{Arcade:{Body:class{}}}}',shortCircuit:true}
  :next(specifier,context);}});
const {WorldCombat}=await import('../src/scenes/world-combat.ts');hook.deregister();
const invoke=(host:object,name:string,...args:unknown[])=>Reflect.get(WorldCombat.prototype,name).call(host,...args);
const read=(name:string)=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));

function lifeFixture(){
  const hero=new BattleCharacter('dark-knight',read('character-stats'),read('items'));
  hero.setHealth(30);
  const hitResolution=new CombatHitResolution(),events:string[]=[],fallen=new Set<string>();
  const host=Object.setPrototypeOf({hero,hitResolution,fallen,pendingDefeats:new Set(),arena:[],
    conditions:new CombatConditions(),partyPassives:()=>[],memberOf:(id:string)=>id==='player'?hero:undefined,
    scene:{refreshCombatTarget:()=>events.push('refresh')},
    threat:{damage:()=>events.push(`threat:awaiting=${hitResolution.isAwaitingDefeat('player')}`)},
    showHit:()=>events.push('feedback'),
    memberDefeated:(id:string)=>{fallen.add(id);events.push(`defeat:${id}`);},
  },WorldCombat.prototype);
  hero.subscribe(()=>invoke(host,'onHeroChanged'));
  const damage=()=>invoke(host,'settleHit',{casterId:'enemy',targetId:'player'},{kind:'hit',damage:50},hero);
  return {host,hero,hitResolution,events,fallen,damage};
}

test('real hero subscription registers pending death before threat and permits recovery in the same hit chain',()=>{
  const f=lifeFixture();
  f.hitResolution.run(()=>{
    f.damage();
    assert.equal(f.hero.player.health,0);
    assert.equal(f.hitResolution.isAwaitingDefeat('player'),true);
    assert.equal(f.fallen.has('player'),false);
    assert.ok(f.events.includes('threat:awaiting=true'));
    invoke(f.host,'restoreHealth','player',10);
    assert.equal(f.hero.player.health,10);
  });
  assert.equal(f.fallen.has('player'),false);
  assert.equal(f.events.some(event=>event.startsWith('defeat:')),false);
  assert.equal(f.hitResolution.isAwaitingDefeat('player'),false);
});

test('real hero subscription and lethal damage share one final death check after the hit chain',()=>{
  const f=lifeFixture();
  f.hitResolution.run(()=>{
    f.damage();
    assert.equal(f.fallen.has('player'),false);
    f.events.push('remaining-hit-work');
  });
  assert.equal(f.hero.player.health,0);
  assert.equal(f.fallen.has('player'),true);
  assert.deepEqual(f.events.filter(event=>event.startsWith('defeat:')),['defeat:player']);
  assert.equal(f.events.at(-1),'defeat:player');
});

test('a direct hero health change outside a hit chain still starts defeat immediately',()=>{
  const f=lifeFixture();
  f.hero.setHealth(0);
  assert.equal(f.fallen.has('player'),true);
  assert.equal(f.hitResolution.isAwaitingDefeat('player'),false);
  assert.deepEqual(f.events,['refresh','defeat:player']);
});

test('host actor departure clears the current enemy target without deleting its third-party threat',()=>{
  const actor=(id:string,team:string):CombatThreatActor=>({id,team,active:true,level:1,
    tracksThreat:team==='hostile',sightRangeUnits:10,position:{x:0,y:0},bounds:{x:0,y:0,width:8,height:8}});
  const actors=new Map([actor('player','party'),actor('departing','party'),actor('watcher','hostile')].map(value=>[value.id,value]));
  let current:string|undefined='departing';
  const threat=new CombatThreatSystem({actor:id=>actors.get(id),actors:()=>[...actors.values()],
    currentTarget:()=>current,logicTick:()=>1,generationRate:()=>1000,reductionRate:()=>0,
    normalDamage:()=>({physical:10,magic:0}),tauntSource:()=>undefined,applyTaunt:()=>{}});
  threat.restoreState({entries:[{ownerId:'watcher',sourceId:'departing',score:100,updatedTick:1},
    {ownerId:'watcher',sourceId:'player',score:80,updatedTick:1},
    {ownerId:'departing',sourceId:'player',score:20,updatedTick:1}]});
  const notifications:unknown[][]=[];
  const departing={key:'departing',controller:{targetRemoved:()=>{},dispose:()=>{}},presenter:{clear:()=>{}},
    visual:{container:{destroy:()=>{}}}};
  const watcher={key:'watcher',controller:{targetRemoved:(id:string,reason?:string)=>{
    notifications.push([id,reason]);
    if(current===id){if(reason==='inactive')threat.clearOwner('watcher');current=undefined;}
  }}};
  const host=Object.setPrototypeOf({threat,arena:[departing,watcher],pendingDefeats:new Set(),
    app:{session:{cooldowns:new CombatCooldownStore(()=>0)}},
    conditions:new CombatConditions(),partyControllers:new Map(),summons:new SummonLifecycle(),
    movement:{remove:()=>{}},roster:{removeEnemy:(id:string)=>actors.delete(id)},
    scene:{refreshCombatTarget:()=>{}},
  },WorldCombat.prototype);
  invoke(host,'removeEnemy','departing');
  assert.deepEqual(notifications,[['departing',undefined]]);
  assert.equal(current,undefined);
  assert.deepEqual(threat.captureState().entries,[{ownerId:'watcher',sourceId:'player',score:80,updatedTick:1}]);
  assert.equal(threat.select('watcher',current),'player');
});
