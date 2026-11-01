import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import {
  CLOUD_SAVE_MAX_BYTES,
  cloudRateLimitedMessage,
  parseCloudSaveSlotId,
} from '../src/domain/cloud-save.ts';
import {
  CloudStoreError,
  createCloudSaveStore,
  type CloudSaveStore,
  type CloudStoreErrorCode,
} from './cloud-save-store.ts';

const AUTH_BODY_LIMIT = 8 * 1024;
const BODY_IDLE_TIMEOUT_MS = 15_000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_LOGIN_LIMIT = 10;
const DEFAULT_REGISTER_LIMIT = 3;
const RATE_MAP_LIMIT = 10_000;
const DEFAULT_ALLOWED_ORIGINS = ['https://appassets.androidplatform.net'];

const STORE_STATUS: Record<CloudStoreErrorCode, number> = {
  'invalid-input': 400,
  'account-exists': 409,
  'invalid-credentials': 401,
  locked: 423,
  unauthorized: 401,
  'save-not-found': 404,
  'too-large': 413,
  'storage-full': 507,
  'cloud-full': 503,
  'cloud-unavailable': 503,
  server: 500,
};

export interface CloudRateLimitOptions {
  loginPerFiveMinutes?: number;
  registerPerHour?: number;
}

export interface CloudSaveServiceOptions {
  dataDir: string;
  now?: () => number;
  allowedOrigins?: readonly string[];
  /** `false` 关闭限流；测试或内网部署可关。 */
  rateLimit?: false | CloudRateLimitOptions;
  /** 测试用：注入 store，或缩小配额避免造大文件。 */
  store?: CloudSaveStore;
  saveQuotaBytes?: number;
  maxAccounts?: number;
  sessionTtlMs?: number;
}

export type CloudSaveMiddleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

interface RateEntry { count: number; windowStart: number }
type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };
type BodyResult = { ok: true; value: unknown } | { ok: false };

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const values = forwarded.split(',').map(value => value.trim()).filter(Boolean);
    if (values.length) return values[values.length - 1]!;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function sameOrigin(req: IncomingMessage, origin: string): boolean {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  const hostname = host.split(':')[0]?.toLowerCase();
  if (!hostname || parsed.hostname.toLowerCase() !== hostname) return false;
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = typeof forwarded === 'string'
    ? forwarded.split(',')[0]?.trim().toLowerCase()
    : (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  return parsed.protocol === `${protocol}:`;
}

function applyCors(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Record<string, string | number> = {},
): void {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    ...extra,
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(204, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  res.end();
}

function requireJson(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { error: 'unsupported-media-type', message: '请求必须是 JSON。' });
    return false;
  }
  return true;
}

function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<BodyResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      settled = true;
      sendJson(res, 408, { error: 'invalid-input', message: '请求读取超时。' });
      req.destroy();
      resolve({ ok: false });
    }, BODY_IDLE_TIMEOUT_MS);
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) {
        sendJson(res, 413, { error: 'too-large', message: '请求内容过大。' });
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      sendJson(res, 400, { error: 'invalid-input', message: '请求读取失败。' });
      finish({ ok: false });
    });
    req.on('aborted', () => finish({ ok: false }));
    req.on('end', () => {
      if (settled) return;
      if (!chunks.length) {
        sendJson(res, 400, { error: 'invalid-input', message: '请求内容为空。' });
        finish({ ok: false });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        sendJson(res, 400, { error: 'invalid-input', message: '请求内容不是有效 JSON。' });
        finish({ ok: false });
      }
    });
  });
}

function credentialsOf(value: unknown): { account: string; password: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { account?: unknown; password?: unknown };
  if (typeof record.account !== 'string' || typeof record.password !== 'string') return undefined;
  return { account: record.account, password: record.password };
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function pruneRateMap(map: Map<string, RateEntry>, windowMs: number, nowMs: number): void {
  if (map.size <= RATE_MAP_LIMIT) return;
  for (const [key, entry] of map) if (nowMs - entry.windowStart >= windowMs) map.delete(key);
  if (map.size > RATE_MAP_LIMIT) map.clear();
}

function checkRate(map: Map<string, RateEntry>, ip: string, limit: number, windowMs: number, nowMs: number): RateResult {
  pruneRateMap(map, windowMs, nowMs);
  const entry = map.get(ip);
  if (!entry || nowMs - entry.windowStart >= windowMs) {
    map.set(ip, { count: 1, windowStart: nowMs });
    return { ok: true };
  }
  if (entry.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + windowMs - nowMs) / 1000)) };
  }
  entry.count += 1;
  return { ok: true };
}

export function createCloudSaveService(options: CloudSaveServiceOptions): CloudSaveMiddleware {
  const now = options.now ?? Date.now;
  const allowedOrigins = new Set<string>(DEFAULT_ALLOWED_ORIGINS);
  for (const origin of options.allowedOrigins ?? []) allowedOrigins.add(origin);
  for (const value of (process.env.STORY_CLOUD_ORIGINS ?? '').split(',')) {
    const trimmed = value.trim();
    if (trimmed) allowedOrigins.add(trimmed);
  }
  const rateLimit = options.rateLimit === false ? undefined : {
    login: options.rateLimit?.loginPerFiveMinutes ?? DEFAULT_LOGIN_LIMIT,
    register: options.rateLimit?.registerPerHour ?? DEFAULT_REGISTER_LIMIT,
  };
  const loginLimits = new Map<string, RateEntry>();
  const registerLimits = new Map<string, RateEntry>();
  let store = options.store;
  if (!store) {
    try {
      store = createCloudSaveStore({
        dataDir: options.dataDir,
        now: options.now,
        saveQuotaBytes: options.saveQuotaBytes,
        maxAccounts: options.maxAccounts,
        sessionTtlMs: options.sessionTtlMs,
      });
    } catch (error) {
      console.error('云存档存储初始化失败', error);
    }
  }

  const sendStoreError = (res: ServerResponse, error: unknown): void => {
    if (!(error instanceof CloudStoreError)) {
      console.error('云存档服务错误', error);
      sendJson(res, 500, { error: 'server', message: '云存档服务暂时不可用。' });
      return;
    }
    const headers: Record<string, string | number> = {};
    if (error.retryAfterSeconds !== undefined) headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfterSeconds)));
    sendJson(res, STORE_STATUS[error.code] ?? 500, {
      error: error.code,
      message: error.message,
      ...(error.remainingAttempts !== undefined ? { remainingAttempts: error.remainingAttempts } : {}),
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    }, headers);
  };

  const rateLimited = (res: ServerResponse, retryAfterSeconds: number): void => {
    sendJson(res, 429, {
      error: 'rate-limited',
      message: cloudRateLimitedMessage(retryAfterSeconds),
      retryAfterSeconds,
    }, { 'Retry-After': String(retryAfterSeconds) });
  };

  const authenticate = async (req: IncomingMessage, activeStore: CloudSaveStore): Promise<{ accountKey: string; account: string }> => {
    const token = bearerToken(req);
    if (!token) throw new CloudStoreError('unauthorized', '登录已失效，请重新登录。');
    return activeStore.authenticate(token);
  };

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, activeStore: CloudSaveStore): Promise<void> {
    const pathname = url.pathname;
    if (pathname === '/__cloud/register' && req.method === 'POST') {
      if (!requireJson(req, res)) return;
      const body = await readBody(req, res, AUTH_BODY_LIMIT);
      if (!body.ok) return;
      const credentials = credentialsOf(body.value);
      if (!credentials) { sendJson(res, 400, { error: 'invalid-input', message: '账号和密码不能为空。' }); return; }
      if (rateLimit) {
        const limited = checkRate(registerLimits, clientIp(req), rateLimit.register, REGISTER_WINDOW_MS, now());
        if (!limited.ok) { rateLimited(res, limited.retryAfterSeconds); return; }
      }
      const result = await activeStore.register(credentials.account, credentials.password);
      sendJson(res, 201, { token: result.token, account: result.account, expiresAt: result.expiresAt });
      return;
    }
    if (pathname === '/__cloud/login' && req.method === 'POST') {
      if (!requireJson(req, res)) return;
      const body = await readBody(req, res, AUTH_BODY_LIMIT);
      if (!body.ok) return;
      const credentials = credentialsOf(body.value);
      if (!credentials) { sendJson(res, 400, { error: 'invalid-input', message: '账号和密码不能为空。' }); return; }
      if (rateLimit) {
        const limited = checkRate(loginLimits, clientIp(req), rateLimit.login, LOGIN_WINDOW_MS, now());
        if (!limited.ok) { rateLimited(res, limited.retryAfterSeconds); return; }
      }
      const result = await activeStore.login(credentials.account, credentials.password);
      sendJson(res, 200, { token: result.token, account: result.account, expiresAt: result.expiresAt });
      return;
    }
    if (pathname === '/__cloud/logout' && req.method === 'POST') {
      const token = bearerToken(req);
      if (token) await activeStore.logout(token);
      sendNoContent(res);
      return;
    }
    if (pathname === '/__cloud/saves' && req.method === 'GET') {
      const auth = await authenticate(req, activeStore);
      const saves = await activeStore.listSaves(auth.accountKey);
      sendJson(res, 200, { account: auth.account, saves });
      return;
    }
    const slotMatch = /^\/__cloud\/saves\/([^/]+)$/.exec(pathname);
    if (slotMatch) {
      const slot = parseCloudSaveSlotId(slotMatch[1] ?? '');
      if (slot === undefined) { sendJson(res, 400, { error: 'invalid-input', message: '存档槽位无效。' }); return; }
      if (req.method === 'PUT') {
        const auth = await authenticate(req, activeStore);
        if (!requireJson(req, res)) return;
        const body = await readBody(req, res, CLOUD_SAVE_MAX_BYTES);
        if (!body.ok) return;
        const entry = await activeStore.uploadSave(auth.accountKey, slot, body.value);
        sendJson(res, 200, entry);
        return;
      }
      if (req.method === 'GET') {
        const auth = await authenticate(req, activeStore);
        const game = await activeStore.downloadSave(auth.accountKey, slot);
        sendJson(res, 200, game);
        return;
      }
    }
    sendJson(res, 404, { error: 'not-found', message: '接口不存在。' });
  }

  return function cloudSave(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { sendJson(res, 400, { error: 'invalid-input', message: '请求地址无效。' }); return; }
    if (!url.pathname.startsWith('/__cloud')) { next(); return; }
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin) && !sameOrigin(req, origin)) {
        sendJson(res, 403, { error: 'forbidden', message: '当前来源不允许访问云存档。' });
        return;
      }
      applyCors(res, origin);
    }
    if (req.method === 'OPTIONS') { sendNoContent(res); return; }
    const activeStore = store;
    if (!activeStore) {
      sendJson(res, 503, { error: 'cloud-unavailable', message: '云存档暂不可用，本机存档不受影响。' });
      return;
    }
    void handle(req, res, url, activeStore).catch(error => sendStoreError(res, error));
  };
}
