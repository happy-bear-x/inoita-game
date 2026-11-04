import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** 构建版本：只随对应目录的内容变化，不随 checkout 时间或重新构建变化。 */
interface BuildVersions {
  assetVersion: string;
  contentVersion: string;
}

export interface BuildMeta extends BuildVersions {
  schema: 1;
  builtAt: string;
}

export const BUILD_META_FILENAME = '.build-meta.json';

function filesUnder(directory: string, relative = ''): { relative: string; absolute: string }[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const result: { relative: string; absolute: string }[] = [];
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(childAbsolute, childRelative));
    else if (entry.isFile()) result.push({ relative: childRelative, absolute: childAbsolute });
  }
  return result;
}

/**
 * 目录内容哈希：按相对路径排序后，依次把「路径 + NUL + 内容 + NUL」写入 SHA-256。
 * 读取的是实际内容，所以重新 checkout、touch 或重新构建都不会让缓存失效。
 */
export function hashTree(directory: string): string {
  let files: { relative: string; absolute: string }[];
  try {
    files = filesUnder(directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`构建版本目录不存在或不可读：${directory}（${reason}）`);
  }
  files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(readFileSync(file.absolute));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function computeVersions(publicDir: string): BuildVersions {
  return {
    assetVersion: hashTree(path.join(publicDir, 'assets')),
    contentVersion: hashTree(path.join(publicDir, 'content')),
  };
}

function appendVersion(url: string, version: string): string {
  if (!url || !version || /[?&]v=/.test(url)) return url;
  const fragment = url.indexOf('#');
  const base = fragment >= 0 ? url.slice(0, fragment) : url;
  const suffix = fragment >= 0 ? url.slice(fragment) : '';
  return `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}${suffix}`;
}

/** 给 index.html 里的 assets 预载/图标补版本；不碰 bundles、外链与 data URI。 */
export function versionHtmlAssets(html: string, assetVersion: string): string {
  if (!assetVersion) return html;
  return html.replace(/\b(href|src)=(["'])([^"']+)\2/g, (match, attribute: string, quote: string, url: string) => {
    if (!/^(?:\.\/|\/)?assets\//.test(url)) return match;
    return `${attribute}=${quote}${appendVersion(url, assetVersion)}${quote}`;
  });
}
