import type { SceneSnapshot } from './scene-snapshot.ts';
import type { StoryRuntimeSnapshot } from './story-runtime.ts';
import type { StoryStageSnapshot } from './story-performance.ts';

/**
 * 把运行中的剧情快照转成存档检查点。
 *
 * 运行中的舞台快照会为每个演员缓存一份完整外观（`ActorDefinition` 含所有动画帧和图层），
 * 但这份外观能从世界角色、队伍装备和剧情外观覆盖重新算出来。存档只保留无法重建的
 * 演出状态（位置、朝向、显隐、姿态和镜头），外观在恢复时由舞台重新解析。
 *
 * 版本 3 表示这份快照已经去掉缓存外观；版本 2 是仍在运行的完整快照。没有舞台时不改版本。
 */
export function toPlaybackCheckpoint(runtime: StoryRuntimeSnapshot): StoryRuntimeSnapshot {
  let hasStage = false;
  // 写时复制：只有带演员外观的舞台才需要新的 run / 舞台 / 场景对象，其余保持引用。
  const runs = runtime.runs.map(run => {
    if (!run.stage) return run;
    hasStage = true;
    return { ...run, stage: withoutStageAppearance(run.stage) };
  });
  if (!hasStage) return runtime;
  return { ...runtime, runs, version: 3 };
}

function withoutStageAppearance(stage: StoryStageSnapshot): StoryStageSnapshot {
  const scene = withoutSceneAppearance(stage.scene);
  const scenes = stage.scenes?.map(withoutSceneAppearance);
  if (scene === stage.scene && scenes?.every((value, index) => value === stage.scenes![index])) return stage;
  return { ...stage, scene, ...(scenes ? { scenes } : {}) };
}

function withoutSceneAppearance(scene: SceneSnapshot): SceneSnapshot {
  if (!scene.actors.some(actor => actor.appearance !== undefined)) return scene;
  return { ...scene, actors: scene.actors.map(actor => {
    if (actor.appearance === undefined) return actor;
    const copy = { ...actor };
    delete copy.appearance;
    return copy;
  }) };
}
