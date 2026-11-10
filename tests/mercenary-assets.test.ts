import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BattleCatalog } from '../src/domain/battle.ts';
import type { ClipName, WorldIndex } from '../src/domain/content.ts';
import type { CompanionCatalog } from '../src/domain/party.ts';
import type { WardrobeCatalog } from '../src/domain/wardrobe.ts';
import { characterAssets, effectAssets } from '../src/rendering/combat-asset-descriptors.ts';
import { partyMemberCombatAssets } from '../src/rendering/combat-assets.ts';
import { residentCombatAssets } from '../src/rendering/resident-combat-assets.ts';

const read=<T>(name:string):T=>JSON.parse(readFileSync(new URL(`../public/content/${name}.json`,import.meta.url),'utf8'));
const battle=read<BattleCatalog>('battle'),wardrobe=read<WardrobeCatalog>('wardrobe'),
  companions=read<CompanionCatalog>('companions'),world=read<WorldIndex>('world');

test('all companion base appearances are resident; skill clips load with their users',()=>{
  const mercenaries=Object.values(companions.definitions).filter(definition=>(definition.source??'mercenary')==='mercenary');
  const pack=residentCombatAssets({battle,wardrobe,world,companions,baseOnlyCompanions:true});
  const keys=new Set(pack.assets.map(asset=>asset.key));
  assert.equal(keys.size,pack.assets.length,'贴图键需要去重');
  for(const definition of mercenaries){
    const actor=world.actors[definition.actor]!;
    for(const asset of characterAssets(actor,['idle-south']))
      assert.ok(keys.has(asset.key),`伙伴 ${definition.id} 的基础待机素材应在常驻包中：${asset.key}`);
    const baseClips=(Object.keys(actor.clips) as ClipName[]).filter(name=>!name.startsWith('skill-'));
    const baseKeys=new Set(characterAssets(actor,baseClips).map(asset=>asset.key));
    const skillOnly=characterAssets(actor,(Object.keys(actor.clips) as ClipName[]).filter(name=>name.startsWith('skill-')))
      .filter(asset=>!baseKeys.has(asset.key));
    if(skillOnly.length)
      assert.ok(skillOnly.some(asset=>!keys.has(asset.key)),`伙伴 ${definition.id} 的技能动作不应常驻`);
  }
  // 技能动作走使用者路径：招募后 `partyMemberCombatAssets` 必须能装好完整外观。
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
  // 特效也走图集页，不能再用单个纹理键判断；比较 firestorm 实际需要的页/纹理。
  const firestorm=effectAssets({'firestorm-swing':battle.attackEffects['firestorm-swing']}).map(asset=>asset.key);
  const without=keys(['dark-strike']),withFirestorm=keys(['dark-strike','firestorm']);
  const firestormOnly=firestorm.filter(key=>!without.has(key));
  assert.ok(firestormOnly.length>0,'未学 firestorm 时不加载它的姿态特效');
  for(const key of firestormOnly)assert.ok(withFirestorm.has(key),`学会 firestorm 后下一场战斗能加载到 ${key}`);
});
