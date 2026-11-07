# 头像素材与槽位

HUD、人物页、队伍页和背包预览的头像来源不同。渲染时只按目标框等比缩放并裁掉多出来的边，不把宽高同时写死去拉伸原图。计算集中在 `src/ui/portrait-fit.ts`；菜单用 `UiSurface.imageCover`，HUD 直接调用 `fitPortrait`。

## 素材来源

- 主角与剧情同伴的大立绘：`assets/ui/menus/character-<portrait>.png`，252×271，来自原版状态图集。
- 佣兵的大立绘：`assets/ui/menus/class-<classId>.png`，252×271，来自原版 `UI_portrait_status_002/003/004` 的 252×271 裁切。
- 小头像：`assets/ui/menus/character-party-*.png` 与 `party-class-*.png`。
- HUD 的通用主角/队友头像：`assets/ui/status/player-portrait*.png`、`member-portrait*.png`。

### 重采样记录

主角和剧情同伴的小头像与 HUD 头像取自 `assets/ui/story/portrait-*.png` 的原始像素：原 UI 把 508×508/612 的对白立绘裁一块后缩小到 78×81 或 86×96。重新导出时按原缩小倍率 0.3 找回裁切区域，再从原图裁切并缩放到 3×。

| 产物 | 原图裁切 (x,y,w,h) |
|---|---|
| `status/player-portrait.png` | `portrait-kiyan.png` (53,50,260,270) |
| `menus/character-party-kiyan.png` | `portrait-kiyan.png` (73,43,287,320) |
| `menus/character-party-azad-053.png` | `portrait-azad-053.png` (164,79,307,343) |
| `menus/character-party-portia.png` | `portrait-portia.png` (141,79,297,331) |
| `menus/character-party-shinty.png` | `portrait-shinty.png` (173,17,292,325) |

`character-party-olaf.png` 的构图与对白立绘不同，按原图 3× 重采样。

佣兵职业立绘来自原版状态图集，职业与图幅对应如下：

| 职业 | 原图 | 裁切 (x,y,w,h) |
|---|---|---|
| dark-knight | `UI_portrait_status_002` | (2,2,252,271) |
| assassin | `UI_portrait_status_002` | (257,239,252,271) |
| warlock | `UI_portrait_status_003` | (2,2,252,271) |
| priest | `UI_portrait_status_003` | (257,239,252,271) |
| ranger | `UI_portrait_status_004` | (2,2,252,271) |
| warrior | `UI_portrait_status_004` | (257,239,252,271) |

佣兵职业图 `party-class-*.png` 没有更大的原图，按 2× 重采样。

## 维护

- 新增角色或职业时，大立绘、小头像和 HUD 头像都要有图；佣兵额外检查 `character.classPortraits`。
- 替换素材后运行 `npm run atlas:ui` 和 `npm run validate:content`，图集与内容清单一并提交。
- 换图时先确认人脸在框里的位置，再调 `imageCover` / `fitPortrait` 的 `anchorY`；默认 0.35，顶部留得少、底部裁得多。
