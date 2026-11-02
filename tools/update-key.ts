import {
  createPrivateKey, createPublicKey, generateKeyPairSync,
  sign as signWithKey, verify as verifyWithKey, type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 热更新签名私钥：仓库外，PKCS#8 EC P-256 PEM，权限 600。 */
export const UPDATE_KEY_DIR = path.join(os.homedir(), '.config', 'inoita');
export const UPDATE_KEY_PATH = path.join(UPDATE_KEY_DIR, 'update-signing.pem');
/** 公钥：base64(SPKI DER)，单行，随 APK 一起分发。 */
export const UPDATE_PUBLIC_KEY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'android', 'update-public-key.txt');

export interface UpdateKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  created: boolean;
}

export function tryReadUpdateKey(): KeyObject | undefined {
  if (!existsSync(UPDATE_KEY_PATH)) return undefined;
  return createPrivateKey(readFileSync(UPDATE_KEY_PATH));
}

export function publicKeyBase64(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function writePublicKey(key: KeyObject): void {
  mkdirSync(path.dirname(UPDATE_PUBLIC_KEY_PATH), { recursive: true });
  writeFileSync(UPDATE_PUBLIC_KEY_PATH, publicKeyBase64(key));
}

export function readUpdatePublicKey(): KeyObject {
  if (!existsSync(UPDATE_PUBLIC_KEY_PATH))
    throw new Error(`缺少更新公钥：${UPDATE_PUBLIC_KEY_PATH}；先运行 npm run update:key`);
  return createPublicKey({
    key: Buffer.from(readFileSync(UPDATE_PUBLIC_KEY_PATH, 'utf8').trim(), 'base64'),
    format: 'der',
    type: 'spki',
  });
}

/** 首次调用生成私钥并写出公钥；之后只同步公钥，不覆盖私钥。 */
export function ensureUpdateKey(): UpdateKey {
  mkdirSync(UPDATE_KEY_DIR, { recursive: true, mode: 0o700 });
  let privateKey = tryReadUpdateKey();
  const created = !privateKey;
  if (!privateKey) {
    privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    writeFileSync(UPDATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    chmodSync(UPDATE_KEY_PATH, 0o600);
  }
  const publicKey = createPublicKey(privateKey);
  writePublicKey(publicKey);
  return { privateKey, publicKey, created };
}

/** ECDSA P-256 DER，base64；签的是文件原始字节。 */
export function signBytes(bytes: Buffer, privateKey: KeyObject): string {
  return signWithKey('sha256', bytes, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
}

export function verifyBytes(bytes: Buffer, signature: string, publicKey: KeyObject): boolean {
  try {
    return verifyWithKey('sha256', bytes, { key: publicKey, dsaEncoding: 'der' },
      Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { created } = ensureUpdateKey();
    console.log(`[update-key] ${created ? '已生成' : '使用现有'}私钥：${UPDATE_KEY_PATH}`);
    console.log(`[update-key] 公钥：${UPDATE_PUBLIC_KEY_PATH}`);
    if (created) console.log('[update-key] 请立即备份私钥；首次公开分发后丢失，已安装客户端将不再信任新清单。');
  } catch (error) {
    console.error(`[update-key] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
