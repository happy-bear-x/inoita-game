# 游戏音频

`public/content/audio.json` 是运行时的音频目录，当前结构版本为 3。`AudioScene` 常驻，`GameAudio` 使用 Phaser 全局 SoundManager（声音管理器），地图场景重启后仍能控制音乐、环境音和音效。目录字段定义在 `src/application/game-audio.ts`，加载入口是 `src/scenes/audio-scene.ts`，跨文件引用校验在 `src/application/content-relations.ts`，行为测试在 `tests/game-audio.test.ts`。

地图进场按 `maps[mapId]` 切换曲目。原版用 255 表示“这张图不更换音轨”，导出成 `null`，所以地图的 `music: null` 和 `ambience: null` 都表示保留此前音轨，而不是停止。返回标题、进入剧情或显式传入 `null` 才会停止。剧情 `setStoryMusic(null)` 明确停止音乐，与地图的保留语义不同。世界快照保存持续音乐与环境音，恢复时验证目录引用后切换。

标题设置和游戏设置分别提供音乐与音效音量滑动条，范围 0–1（界面显示百分比），最左边为静音。音效音量也控制环境音，音乐音量只控制背景音乐。设置保存在 `localStorage` 的 `inotia4.audio.v1`；旧档里的布尔值会迁移成满音量或静音。挂起时暂停，恢复时沿 SoundManager 生命周期继续。

基础界面音和通用战斗反馈在启动时准备并保留。战斗层提供当前队伍已学技能、武器、地图敌人和动作分支音效的完整清单，`prepareCombat` 每次替换上一份清单；剧情使用 `prepareStoryEffects` 替换当前段落的声音清单，可随准备请求取消。分批预加载不阻塞地图战斗就绪。未加载的音效等待本次加载完成后补播一次，同一加载期间重复请求不叠加补播。换地图、进入剧情或返回标题会增加上下文编号，过期补播被丢弃；关闭音效或挂起时也不补播。失败资源等待五秒后才再次尝试。

切换循环音轨会停止并销毁当前声音。背景音乐保留当前及上一首的解码缓存（`MUSIC_CACHE_RETENTION` 为 1），返回标题清空上一局音乐历史。环境音与战斗、剧情共用同一份缓存，失去最后一个使用者时释放。一次加载因切歌、静音或剧情取消而作废后，加载完成时会释放无使用者的缓存。一次性音效持有声音实例到播放完成、停止或销毁；暂停期间仍保留，播放结束后只保留基础反馈和当前准备清单需要的声音。目录的 `unbound` 保存未明确接入用途的音效。

音频目录由 `public/content/audio.json` 提供。改动后运行 `npm run validate:content`，行为有变化时再运行 `npm test -- tests/game-audio.test.ts`。实际设备格式支持、触摸解锁、音量及后台恢复需要在游戏入口验收。
