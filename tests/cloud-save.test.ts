import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_ACCOUNT_MAX_LENGTH,
  CLOUD_PASSWORD_MAX_LENGTH,
  cloudAccountIdentity,
  cloudLockedMessage,
  cloudRateLimitedMessage,
  cloudSaveSlotId,
  cloudSlotLabel,
  cloudWrongPasswordMessage,
  normalizeCloudAccount,
  parseCloudSaveSlotId,
  sanitizeCloudAccountInput,
  validateCloudAccount,
  validateCloudPassword,
} from '../src/domain/cloud-save.ts';
import { AUTO_SAVE_SLOT, SAVE_FORMAT, saveFormatStatus } from '../src/domain/save-game.ts';

test('account rules allow Chinese, letters, digits and underscore but not spaces',()=>{
  assert.equal(validateCloudAccount('玩家一'),undefined);
  assert.equal(validateCloudAccount('Player_1'),undefined);
  assert.match(validateCloudAccount('ab') ?? '',/3–24/);
  assert.match(validateCloudAccount('a'.repeat(CLOUD_ACCOUNT_MAX_LENGTH+1)) ?? '',/3–24/);
  assert.match(validateCloudAccount('玩家 一') ?? '',/字母、数字、下划线或汉字/);
  assert.equal(normalizeCloudAccount('  玩家一  '),'玩家一');
  assert.equal(sanitizeCloudAccountInput('玩家 一!Ab_'),'玩家一Ab_');
  assert.equal(cloudAccountIdentity('  Player_1  '),'player_1');
});

test('password rules keep case and reject lengths outside 6–64',()=>{
  assert.equal(validateCloudPassword('abc123'),undefined);
  assert.equal(validateCloudPassword('AbC 123'),undefined);
  assert.match(validateCloudPassword('12345') ?? '',/6–64/);
  assert.match(validateCloudPassword('a'.repeat(CLOUD_PASSWORD_MAX_LENGTH+1)) ?? '',/6–64/);
});

test('cloud slot ids round-trip and reject out-of-range values',()=>{
  assert.equal(cloudSaveSlotId(AUTO_SAVE_SLOT),'auto');
  assert.equal(cloudSaveSlotId(0),'0');
  assert.equal(cloudSaveSlotId(9),'9');
  assert.equal(parseCloudSaveSlotId('auto'),AUTO_SAVE_SLOT);
  assert.equal(parseCloudSaveSlotId('0'),0);
  assert.equal(parseCloudSaveSlotId('9'),9);
  assert.equal(parseCloudSaveSlotId('10'),undefined);
  assert.equal(parseCloudSaveSlotId('-1'),undefined);
  assert.equal(parseCloudSaveSlotId('01'),undefined);
  assert.equal(cloudSlotLabel(AUTO_SAVE_SLOT),'自动存档');
  assert.equal(cloudSlotLabel(3),'存档槽 4');
});

test('lock and retry messages name the number of attempts and the wait',()=>{
  assert.match(cloudLockedMessage(900),/15 分钟/);
  assert.match(cloudWrongPasswordMessage(2),/2 次/);
  assert.match(cloudRateLimitedMessage(60),/1 分钟/);
});

test('save formats distinguish readable, future and obsolete versions',()=>{
  assert.equal(saveFormatStatus(SAVE_FORMAT),'ok');
  assert.equal(saveFormatStatus(SAVE_FORMAT-1),'ok');
  assert.equal(saveFormatStatus(SAVE_FORMAT+1),'future');
  assert.equal(saveFormatStatus(SAVE_FORMAT-7),'obsolete');
  assert.equal(saveFormatStatus(SAVE_FORMAT-0.5),'unknown');
  assert.equal(saveFormatStatus('39'),'unknown');
});
