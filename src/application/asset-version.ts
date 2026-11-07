export const GAME_VERSION = 'v0.0.8';

declare const __STORY_ASSET_VERSION__: string;
declare const __STORY_CONTENT_VERSION__: string;

/** 构建期注入的版本；Node 测试与直接 import 时不存在，退化为空字符串。 */
const injected = (name: 'asset' | 'content'): string => {
  if (name === 'asset') return typeof __STORY_ASSET_VERSION__ === 'string' ? __STORY_ASSET_VERSION__ : '';
  return typeof __STORY_CONTENT_VERSION__ === 'string' ? __STORY_CONTENT_VERSION__ : '';
};

/**
 * 给资源 URL 追加 `v=<版本>`。空版本、外链与 data/blob 原样返回；
 * 已有 `v` 参数时保持幂等；参数插在 fragment 之前。
 */
export function withVersion(url: string, version: string | undefined): string {
  if (!url || !version) return url;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url) || /^(?:data|blob):/i.test(url)) return url;
  if (/[?&]v=/.test(url)) return url;
  const fragment = url.indexOf('#');
  const base = fragment >= 0 ? url.slice(0, fragment) : url;
  const suffix = fragment >= 0 ? url.slice(fragment) : '';
  return `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}${suffix}`;
}

export function versionedAsset(url: string): string {
  return withVersion(url, injected('asset'));
}

export function versionedContent(url: string): string {
  return withVersion(url, injected('content'));
}

/** 页面构建时注入的内容版本；生产内容哨兵用它核对服务端清单。 */
export function contentVersionNow(): string {
  return injected('content');
}
