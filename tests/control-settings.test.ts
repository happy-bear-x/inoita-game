import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlSettings, controlSettings, nextControlMode, type ControlMode, type MoveControlStyle, type StorageLike
} from '../src/application/control-settings.ts';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('controlSettings defaults to stick and notifies subscribers on change', () => {
  const events: MoveControlStyle[] = [];
  const unsubscribe = controlSettings.subscribe(style => events.push(style));

  controlSettings.setMoveStyle('dpad');
  assert.equal(controlSettings.moveStyle, 'dpad');
  assert.deepEqual(events, ['dpad']);

  controlSettings.setMoveStyle('stick');
  assert.equal(controlSettings.moveStyle, 'stick');
  assert.deepEqual(events, ['dpad', 'stick']);

  unsubscribe();
  controlSettings.setMoveStyle('dpad');
  assert.equal(events.length, 2, 'Unsubscribed listener should not receive events');

  controlSettings.setMoveStyle('stick');
  assert.equal(controlSettings.moveStyle, 'stick');
});

test('nextControlMode cycles through the three operation modes in order', () => {
  assert.equal(nextControlMode('stick'), 'dpad');
  assert.equal(nextControlMode('dpad'), 'keyboard');
  assert.equal(nextControlMode('keyboard'), 'stick');
});

test('control mode persists, keeps the last touch style, and reads legacy storage', () => {
  const storage = new MemoryStorage();
  const settings = new ControlSettings(storage);
  assert.equal(settings.mode, 'stick');
  settings.setMode('keyboard');
  assert.equal(settings.moveStyle, 'stick', '电脑模式保留最近一次触屏样式');
  assert.equal(new ControlSettings(storage).mode, 'keyboard', '刷新后仍是电脑模式');

  const legacy = new MemoryStorage();
  legacy.setItem('inotia4.control.style.v1', JSON.stringify({ moveStyle: 'dpad' }));
  const legacySettings = new ControlSettings(legacy);
  assert.equal(legacySettings.mode, 'dpad');
  assert.equal(legacySettings.moveStyle, 'dpad');

  const kept = new MemoryStorage();
  kept.setItem('inotia4.control.style.v1', JSON.stringify({ mode: 'keyboard', moveStyle: 'dpad' }));
  const keptSettings = new ControlSettings(kept);
  assert.equal(keptSettings.mode, 'keyboard');
  assert.equal(keptSettings.moveStyle, 'dpad', '切回触屏时恢复十字键');
});

test('style subscription ignores keyboard mode, mode subscription sees every change', () => {
  const settings = new ControlSettings(null);
  const styles: MoveControlStyle[] = [];
  const modes: ControlMode[] = [];
  settings.subscribe(style => styles.push(style));
  settings.subscribeMode(mode => modes.push(mode));
  settings.setMode('dpad');
  settings.setMode('keyboard');
  settings.setMoveStyle('stick');
  assert.deepEqual(styles, ['dpad', 'stick']);
  assert.deepEqual(modes, ['dpad', 'keyboard', 'stick']);
});
