import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { WorldIndex } from '../src/domain/content.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { characterAssets } from '../src/rendering/combat-asset-descriptors.ts';
import { partyMemberCombatAssets } from '../src/rendering/combat-assets.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read<BattleCatalog>('battle'),wardrobe=read<WardrobeCatalog>('wardrobe'),
  companions=read<CompanionCatalog>('companions'),world=read<WorldIndex>('world');

test('owned mercenary appearances are resident; unowned ones load on demand',()=>{
  const mercenaries=Object.values(companions.definitions).filter(definition=>(definition.source??'mercenary')==='mercenary');
  const owned=mercenaries.slice(0,3),ownedActors=new Set(owned.map(definition=>definition.actor));
  const pack=residentCombatAssets({battle,wardrobe,world,companions,ownedCompanionIds:owned.map(definition=>definition.id)});
  const keys=new Set(pack.assets.map(asset=>asset.key));
  assert.equal(keys.size,pack.assets.length,'贴图键需要去重');
  for(const definition of owned)for(const layer of world.actors[definition.actor]!.clips['idle-south']!.layers)
    assert.ok(keys.has(layer.key),`已拥有伙伴 ${definition.id} 的待机图层应在常驻包中`);
  for(const actor of new Set(mercenaries.map(definition=>definition.actor))){
    if(ownedActors.has(actor))continue;
    assert.ok(world.actors[actor]!.clips['idle-south']!.layers.some(layer=>!keys.has(layer.key)),
      `未拥有伙伴 ${actor} 不应常驻`);
  }
  // 未拥有的佣兵走按需路径：招募后 `partyMemberCombatAssets` 必须能装好完整外观。
  for(const definition of mercenaries){
    if(definition.recruitable===false)continue;
    const actor=world.actors[definition.actor];
    assert.ok(actor,`${definition.id} 缺少角色外观`);
    const loaded=new Set(partyMemberCombatAssets(battle,wardrobe,definition.classId,actor).map(asset=>asset.key));
    for(const asset of characterAssets(actor))
      assert.ok(loaded.has(asset.key),`${definition.id} 的按需路径缺少 ${asset.key}`);
  }
});

test('omitting the owned set keeps the build-time full companion coverage',()=>{
  const pack=residentCombatAssets({battle,wardrobe,world,companions});
  const actors=new Set(Object.values(companions.definitions).map(definition=>definition.actor));
  for(const actor of actors)assert.ok(pack.actorIds.has(actor),`全量校验应包含 ${actor}`);
});

test('party member combat assets only include learned skill stances',()=>{
  const definition=companions.definitions['mercenary-black-knight']!;
  const actor=world.actors[definition.actor]!;
  const keys=(learned:string[])=>new Set(partyMemberCombatAssets(battle,wardrobe,definition.classId,actor,new Set(learned)).map(asset=>asset.key));
  const effectKey='firestorm-swing-default-screen';
  assert.equal(keys(['dark-strike']).has(effectKey),false,'未学 firestorm 时不加载它的姿态特效');
  assert.equal(keys(['dark-strike','firestorm']).has(effectKey),true,'学会 firestorm 后下一场战斗能加载到');
});
