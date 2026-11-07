import fs from 'node:fs/promises';
import path from 'node:path';

/** 保留的旧日志份数；当前文件 + 一份 previous + 这些编号文件。 */
const MAX_OLDER_LOGS = 6;
/** 旧客户端在每个逻辑帧都报同一条检查点诊断；同一个会话在同一张图 60 秒内只留一条。 */
const NOISY_KIND = 'checkpoint-kept-waiting-encounter';
const NOISY_WINDOW_MS = 60_000;
const lastNoisyAt = new Map();

function withoutRepeatedNoise(entries) {
  const now = Date.now();
  const kept = [];
  for (const entry of entries) {
    if (entry.kind !== NOISY_KIND) { kept.push(entry); continue; }
    const map = typeof entry.details?.map === 'string' ? entry.details.map : '';
    const key = `${entry.session ?? ''}\u0000${map}`;
    const last = lastNoisyAt.get(key) ?? 0;
    if (now - last < NOISY_WINDOW_MS) continue;
    lastNoisyAt.set(key, now);
    kept.push(entry);
  }
  if (lastNoisyAt.size > 512) {
    for (const [key, at] of lastNoisyAt) if (now - at > NOISY_WINDOW_MS * 5) lastNoisyAt.delete(key);
  }
  return kept;
}

/** 开发服务与 4002 打包静态服务共用。JSONL 每行一条记录，并保留多份轮转文件。 */
export function createDiagnosticMiddleware(root) {
  const directory = path.join(root, '.diagnostics');
  const file = path.join(directory, 'client-errors.jsonl');
  const previous = path.join(directory, 'client-errors.previous.jsonl');
  const older = index => path.join(directory, `client-errors.previous-${index}.jsonl`);
  let writes = Promise.resolve();
  async function moveIfExists(from, to) {
    try { await fs.rename(from, to); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function rotate() {
    for (let index = MAX_OLDER_LOGS; index >= 2; index -= 1) await moveIfExists(older(index - 1), older(index));
    await moveIfExists(previous, older(1));
    await fs.rename(file, previous);
  }
  async function save(entries) {
    await fs.mkdir(directory, { recursive: true });
    let size = 0;
    try { size = (await fs.stat(file)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const receivedAt = new Date().toISOString();
    const text = entries.map(entry => JSON.stringify({ receivedAt, ...entry }) + '\n').join('');
    if (size + Buffer.byteLength(text) > 2 * 1024 * 1024) await rotate();
    await fs.appendFile(file, text, 'utf8');
  }
  return function diagnostics(req, res, next) {
    if (req.url?.split('?')[0] !== '/__diagnostics/report') { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    // 离线 APK 的页面源是 WebView 的本地 HTTPS 域，上报跨到本服务，需要放行这一来源。
    const origin = req.headers.origin;
    const allowedOrigin = origin === 'https://appassets.androidplatform.net'
      || origin === 'http://appassets.androidplatform.net';
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!allowedOrigin) { res.writeHead(403); res.end(); return; }
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.writeHead(204); res.end(); return;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.writeHead(405); res.end(); return; }
    let bytes = 0, oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) {
        if (!oversized) { oversized = true; chunks.length = 0; res.writeHead(413); res.end(); }
      } else if (!oversized) chunks.push(chunk);
    });
    req.on('error', () => { if (!res.writableEnded) { res.writeHead(400); res.end(); } });
    req.on('end', () => {
      if (oversized) return;
      let entries;
      try {
        const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        entries = report.entries;
        if (report.version !== 1 || !Array.isArray(entries) || !entries.length || entries.length > 3
          || entries.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.kind !== 'string'
            || typeof entry.time !== 'string' || JSON.stringify(entry).length > 12000)) throw new Error('Invalid report');
      } catch { res.writeHead(400); res.end(); return; }
      const kept = withoutRepeatedNoise(entries);
      if (!kept.length) { res.writeHead(204); res.end(); return; }
      const write = writes.then(() => save(kept));
      writes = write.catch(() => {});
      void write.then(() => { res.writeHead(204); res.end(); }, () => { res.writeHead(500); res.end(); });
    });
  };
}
