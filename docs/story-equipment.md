# 剧情人物装备（不掉落）

这份文档记录剧情人物的整套装备：武器、防具和饰品，共 **26 件**。它们在 `public/content/items.json` 里都是 `equipment.locked = true`，`Bag.slotsFor()` 会返回空槽位，玩家穿不上。这些装备保留物品定义、图标和数值，只从正常获取里移除。

## 规则

- 清单在 `items.json` 的 `storyEquipment` 里，必须恰好等于所有 `equipment.locked = true` 的装备。
- 普通掉落、商店、合成、任务奖励、初始物品和商人货架统一走 `blockedNormalAcquisitionIds()`，它包含付费保留道具和这份剧情装备清单。
- 保留掉落通道仍只认 `reservedAcquisitionIds()`（付费道具），不受这份清单影响。
- 剧情命令里 `item-give`、`equip`、`item-take` 仍可使用这些装备；`item-drop`（掉到地上）按正常获取处理，会被拦住。
- 旧存档里已经有的物品不会删除，只是继续穿不上。

## 武器（5 件）

| 物品 ID | 名称 | 类型 / 槽位 | 等级 | 当前获取 |
|---|---|---|---|---|
| `requiem-marble` | 镇魂之杖 | 法杖 / 主手 | 46 | 无 |
| `dragon-tooth-2` | 龙齿剑 | 双手武器 / 主手 | 28 | 无 |
| `dragon-tooth-3` | 龙齿剑 | 双手武器 / 主手 | 69 | 无 |
| `zwei-hander` | 悲伤巨剑 | 双手武器 / 主手 | 24 | 无 |
| `the-promised-sword` | 誓约之剑 | 长剑 / 主手 | 68 | 已从史诗固定掉落移除 |

## 防具（11 件）

| 物品 ID | 名称 | 类型 / 槽位 | 等级 | 当前获取 |
|---|---|---|---|---|
| `succubus-robe` | 女妖之法袍 | 布甲 / 身体 | 46 | 无 |
| `black-leather-boots` | 黑色皮长靴 | 鞋 / 脚部 | 46 | 无 |
| `illusionist-s-leather` | 神兽之皮甲 | 皮甲 / 身体 | 28 | 无 |
| `illusionist-s-leather-2` | 神兽之皮甲 | 皮甲 / 身体 | 69 | 已从史诗固定掉落移除 |
| `giant-s-footprint` | 巨人族的长靴 | 鞋 / 脚部 | 28 | 无 |
| `giant-s-footprint-2` | 巨人族的长靴 | 鞋 / 脚部 | 69 | 已从史诗固定掉落移除 |
| `black-steel-plate` | 黑铁板甲 | 板甲 / 身体 | 24 | 无 |
| `warrior-boots` | 战士的长靴 | 鞋 / 脚部 | 24 | 无 |
| `speed-boots` | 神速长靴 | 鞋 / 脚部 | 66 | 无 |
| `armor-of-truth` | 真实的板甲 | 板甲 / 身体 | 62 | 无 |
| `disguise-mask` | 伪装用面具 | 帽子 / 头部 | 1 | 仅剧情：`event-103`、`event-108` 穿戴与收回 |

## 饰品（10 件）

| 物品 ID | 名称 | 类型 / 槽位 | 等级 | 当前获取 |
|---|---|---|---|---|
| `red-crystal-necklace` | 红水晶项链 | 项链 / 颈部 | 46 | 无 |
| `third-eye-ring` | 心眼之戒 | 戒指 / 戒指 | 46 | 无 |
| `bloody-dragon-cloak` | 沾染龙血的斗篷 | 斗篷 / 背部 | 28 | 无 |
| `ice-frost-ring` | 冰焰戒指 | 戒指 / 戒指 | 28 | 无 |
| `bloody-dragon-cloak-2` | 沾染龙血的斗篷 | 斗篷 / 背部 | 69 | 无 |
| `ice-frost-ring-2` | 冰焰戒指 | 戒指 / 戒指 | 69 | 无 |
| `demon-s-fingerbone` | 恶魔之骨链 | 项链 / 颈部 | 28 | 无 |
| `demon-s-fingerbone-2` | 恶魔之骨链 | 项链 / 颈部 | 69 | 已从史诗固定掉落移除 |
| `steel-orc-warrior-symbol` | 钢之兽人战士的项链 | 项链 / 颈部 | 24 | 无 |
| `valor-s-ring` | 勇猛誓约之戒 | 戒指 / 戒指 | 24 | 无 |

## 维护

- 新增剧情装备时，把它加进 `items.json` 的 `storyEquipment`；如果它是锁定装备但忘了登记，`npm run validate:content` 会直接失败。
- 想把某件恢复成正常装备，需要同时处理 `equipment.locked`、`storyEquipment` 和掉落池，再更新本文档。
- `drops.json` 由 `../inoita` 工程的 `work/tools/game_content/drops.py` 生成；只改本仓库的 JSON，重新生成时四件史诗掉落会被加回来。运行时过滤仍会拦住，但生成器侧最好也同步排除。
- 修改后运行：`npm run validate:content`、`npm run test:content-build`、`npm run build`。
