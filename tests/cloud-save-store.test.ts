import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudStoreError, createCloudSaveStore, type CloudSaveStore } from '../tools/cloud-save-store.ts';
import { SAVE_FORMAT } from '../src/domain/save-game.ts';

interface Fixture {
  root: string;
  store: CloudSaveStore;
  clock: { value: number };
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'inoita-cloud-store-'));
  const clock = { value: 1_000_000 };
  const store = createCloudSaveStore({
    dataDir: root,
    now: () => clock.value,
    saveQuotaBytes: 64 * 1024,
    sessionTtlMs: 60_000,
  });
  await store.ready;
  return { root, store, clock };
}

function save(name = 'chapter'): unknown {
  return {
    format: SAVE_FORMAT,
    summary: {
      classId: 'dark-knight', className: '黑暗骑士', portrait: 'portrait.png',
      level: 3, mapId: 'camp-1', mapName: '营地', name,
    },
    session: { money: 1 },
    world: { location: { map: 'camp-1', x: 1, y: 2, facing: 'south' } },
  };
}

async function expectError(promise: Promise<unknown>, code: CloudStoreError['code']): Promise<CloudStoreError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CloudStoreError, String(error));
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test('register and login keep exactly one valid session per account',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const first=await f.store.register('Player_1','secret1');
  assert.equal(first.account,'Player_1');
  assert.equal((await f.store.authenticate(first.token)).account,'Player_1');
  const second=await f.store.login('player_1','secret1');
  assert.notEqual(second.token,first.token);
  await expectError(f.store.authenticate(first.token),'unauthorized');
  assert.equal((await f.store.authenticate(second.token)).account,'Player_1');
  const sessions=JSON.parse(await readFile(path.join(f.root,'sessions.json'),'utf8')) as {
    sessions: { account:string; tokenHash:string }[];
  };
  assert.equal(sessions.sessions.length,1,'sessions.json 每账号只有一条');
  assert.equal(sessions.sessions[0]!.account,'Player_1');
  assert.ok(!JSON.stringify(sessions).includes(first.token),'磁盘只存 token 哈希');
});

test('passwords are stored as scrypt hashes, never plaintext',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  await f.store.register('Player_1','secret1');
  const directory=path.join(f.root,'accounts');
  const files=(await readdir(directory)).filter(file=>file.endsWith('.json'));
  assert.equal(files.length,1);
  const text=await readFile(path.join(directory,files[0]!),'utf8');
  assert.ok(text.includes('scrypt$32768$8$1$'));
  assert.ok(!text.includes('secret1'),'账号文件不能出现明文密码');
});

test('three wrong passwords lock for 15 minutes, persist across restart, and do not kick the current session',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const session=await f.store.register('Player_1','secret1');
  const firstWrong=await expectError(f.store.login('Player_1','wrong1'),'invalid-credentials');
  assert.equal(firstWrong.remainingAttempts,2);
  await f.store.authenticate(session.token);
  const secondWrong=await expectError(f.store.login('Player_1','wrong2'),'invalid-credentials');
  assert.equal(secondWrong.remainingAttempts,1);
  const locked=await expectError(f.store.login('Player_1','wrong3'),'locked');
  assert.ok((locked.retryAfterSeconds??0)>=800);
  await expectError(f.store.login('Player_1','secret1'),'locked');
  await f.store.authenticate(session.token);

  const reopened=createCloudSaveStore({dataDir:f.root,now:()=>f.clock.value});
  await reopened.ready;
  await expectError(reopened.login('Player_1','secret1'),'locked');

  f.clock.value+=15*60*1000;
  const after=await reopened.login('Player_1','secret1');
  await expectError(reopened.authenticate(session.token),'unauthorized');
  assert.equal((await reopened.authenticate(after.token)).account,'Player_1');
});

test('cloud saves are isolated per account and round-trip by slot',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const first=await f.store.register('Player_1','secret1');
  const firstAuth=await f.store.authenticate(first.token);
  const entry=await f.store.uploadSave(firstAuth.accountKey,0,save());
  assert.equal(entry.slot,0);
  assert.equal(entry.format,SAVE_FORMAT);
  await f.store.uploadSave(firstAuth.accountKey,'auto',save('auto'));
  assert.equal((await f.store.listSaves(firstAuth.accountKey)).length,2);
  assert.deepEqual(await f.store.downloadSave(firstAuth.accountKey,0),save());
  assert.deepEqual(await f.store.downloadSave(firstAuth.accountKey,'auto'),save('auto'));

  const other=await f.store.register('Player_2','secret2');
  const otherAuth=await f.store.authenticate(other.token);
  assert.deepEqual(await f.store.listSaves(otherAuth.accountKey),[]);
  await expectError(f.store.downloadSave(otherAuth.accountKey,0),'save-not-found');
});

test('upload rejects bad shapes and oversized saves, and enforces the account quota',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const auth=await f.store.register('Player_1','secret1');
  const key=(await f.store.authenticate(auth.token)).accountKey;
  await expectError(f.store.uploadSave(key,0,{format:SAVE_FORMAT,summary:{},session:{},world:{}}),'invalid-input');
  await expectError(f.store.uploadSave(key,0,{...save() as Record<string,unknown>,format:'39'}),'invalid-input');
  const huge={...save() as Record<string,unknown>,session:{blob:'x'.repeat(2*1024*1024)}};
  await expectError(f.store.uploadSave(key,0,huge),'too-large');
  const big={...save() as Record<string,unknown>,session:{blob:'x'.repeat(40*1024)}};
  await f.store.uploadSave(key,0,big);
  await expectError(f.store.uploadSave(key,1,big),'storage-full');
});

test('a non-directory data dir fails closed instead of serving a half-initialized store',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'inoita-cloud-store-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const file=path.join(root,'not-a-dir');
  await writeFile(file,'x');
  assert.throws(()=>createCloudSaveStore({dataDir:file}),/数据目录不可用/);
});

test('changing the password rotates the token and invalidates the old password',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const first=await f.store.register('Player_1','secret1');
  const auth=await f.store.authenticate(first.token);
  const changed=await f.store.changePassword(auth.accountKey,'secret1','secret2');
  assert.notEqual(changed.token,first.token);
  await expectError(f.store.authenticate(first.token),'unauthorized');
  assert.equal((await f.store.authenticate(changed.token)).account,'Player_1');
  const oldLogin=await expectError(f.store.login('Player_1','secret1'),'invalid-credentials');
  assert.equal(oldLogin.remainingAttempts,2);
  const logged=await f.store.login('Player_1','secret2');
  assert.equal((await f.store.authenticate(logged.token)).account,'Player_1');
});

test('password change rejects same/invalid new passwords and wrong current passwords count toward the lock',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const first=await f.store.register('Player_1','secret1');
  const auth=await f.store.authenticate(first.token);
  await expectError(f.store.changePassword(auth.accountKey,'secret1','secret1'),'invalid-input');
  await expectError(f.store.changePassword(auth.accountKey,'secret1','12345'),'invalid-input');
  const firstWrong=await expectError(f.store.changePassword(auth.accountKey,'wrong1','secret2'),'invalid-credentials');
  assert.equal(firstWrong.remainingAttempts,2);
  await expectError(f.store.changePassword(auth.accountKey,'wrong2','secret2'),'invalid-credentials');
  await expectError(f.store.changePassword(auth.accountKey,'wrong3','secret2'),'locked');
  await f.store.authenticate(first.token);
});
