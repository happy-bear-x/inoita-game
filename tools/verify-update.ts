import { spawnSync } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  diffManifests, parseManifest, parsePointer, sha256Hex, verifyBytes,
  type UpdateManifest, type UpdatePointer,
} from './update-manifest.ts';
import { readUpdatePublicKey } from './update-key.ts';

const USAGE = '用法：node tools/verify-update.ts --apk <APK 路径> --url <线上基址>';

interface Options { apk: string; base: string }

function parseArgs(argv: string[]): Options {
  let apk = '';
  let base = '';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--apk') apk = argv[++index] ?? '';
    else if (value.startsWith('--apk=')) apk = value.slice('--apk='.length);
    else if (value === '--url') base = argv[++index] ?? '';
    else if (value.startsWith('--url=')) base = value.slice('--url='.length);
  }
  if (!apk || !base) throw new Error(USAGE);
  return { apk: path.resolve(apk), base: base.replace(/\/+$/, '') };
}

function apkEntry(apk: string, name: string): Buffer {
  const result = spawnSync('unzip', ['-p', apk, name], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`APK 内缺少 ${name}`);
  return result.stdout;
}

function jsonOf(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label} 不是有效 JSON`); }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchSignedJson<T>(
  base: string, relative: string, parse: (value: unknown) => T, publicKey: KeyObject, label: string,
): Promise<T> {
  const [bytes, signature] = await Promise.all([
    fetchBytes(`${base}/${relative}`),
    fetchBytes(`${base}/${relative}.sig`),
  ]);
  if (!verifyBytes(bytes, signature.toString('utf8'), publicKey)) throw new Error(`${label}签名无效`);
  return parse(jsonOf(bytes, label));
}

async function verifyOnline(base: string, publicKey: KeyObject): Promise<{ pointer: UpdatePointer; manifest: UpdateManifest }> {
  const pointer = await fetchSignedJson(base, 'update/latest.json', parsePointer, publicKey, '线上指针');
  const manifestBytes = await fetchBytes(`${base}/${pointer.manifest}`);
  if (sha256Hex(manifestBytes) !== pointer.manifestSha256) throw new Error('线上清单 SHA-256 与指针不一致');
  const signature = await fetchBytes(`${base}/${pointer.manifest}.sig`);
  if (!verifyBytes(manifestBytes, signature.toString('utf8'), publicKey)) throw new Error('线上清单签名无效');
  const manifest = parseManifest(jsonOf(manifestBytes, '线上清单'));
  if (manifest.buildId !== pointer.buildId) throw new Error('线上清单 buildId 与指针不一致');
  return { pointer, manifest };
}

function apkBaseline(apk: string, publicKey: KeyObject): { pointer: UpdatePointer; manifest: UpdateManifest } {
  const pointerBytes = apkEntry(apk, 'assets/update/latest.json');
  const pointerSignature = apkEntry(apk, 'assets/update/latest.json.sig');
  if (!verifyBytes(pointerBytes, pointerSignature.toString('utf8'), publicKey))
    throw new Error('APK 基线指针签名无效');
  const pointer = parsePointer(jsonOf(pointerBytes, 'APK 基线指针'));
  const manifestBytes = apkEntry(apk, `assets/${pointer.manifest}`);
  if (sha256Hex(manifestBytes) !== pointer.manifestSha256) throw new Error('APK 基线清单 SHA-256 与指针不一致');
  const manifest = parseManifest(jsonOf(manifestBytes, 'APK 基线清单'));
  if (manifest.buildId !== pointer.buildId) throw new Error('APK 基线清单 buildId 与指针不一致');
  return { pointer, manifest };
}

async function main(): Promise<number> {
  const { apk, base } = parseArgs(process.argv.slice(2));
  if (!existsSync(apk)) throw new Error(`找不到 APK：${apk}`);
  const publicKey = readUpdatePublicKey();
  const baseline = apkBaseline(apk, publicKey);
  const online = await verifyOnline(base, publicKey);
  const diff = diffManifests(baseline.manifest, online.manifest);
  console.log(`APK 基线：${baseline.pointer.buildId}（${baseline.manifest.files.length} 个文件）`);
  console.log(`线上版本：${online.pointer.buildId}（${online.manifest.files.length} 个文件）`);
  console.log(`差量文件：${diff.changed.length} 个，缺失字节：${diff.downloadBytes}（${(diff.downloadBytes / 1024 / 1024).toFixed(2)} MB）`);
  if (diff.removed.length) console.log(`线上删除：${diff.removed.length} 个文件`);
  if (!diff.changed.length && !diff.removed.length) console.log('无差量，APK 基线已是最新。');
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invoked) {
  main().then(code => process.exit(code), error => {
    console.error(`[verify-update] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
