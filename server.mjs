#!/usr/bin/env node
/**
 * 影视仓接口助手 · Web/Docker 版服务端（零 npm 依赖，仅 Node 内置模块）。
 *
 * 路由（契约见 docs/API.md）：
 *   GET    /api/health
 *   GET    /api/proxy?url=&timeout=
 *   GET    /api/sources
 *   POST   /api/scan
 *   GET    /api/jobs/:id
 *   GET    /api/jobs/:id/events         (SSE: hello → progress* → done/error)
 *   POST   /api/jobs/:id/cancel
 *   GET    /api/jobs/:id/config         (下载 ysc_config.json)
 *   GET    /api/history
 *   GET    /api/history/:id
 *   DELETE /api/history/:id
 *   静态：/ → public/index.html，/app.js /style.css /icon.png …，未知路径回退 index.html
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { fetchTarget, DEFAULT_TIMEOUT_MS, fetchSemaphore, allowPrivateTargets } from './src/fetcher.mjs';
import { createJobManager } from './src/jobs.mjs';
import { createStore } from './src/store.mjs';
import { loadSources } from './src/sources.mjs';
import { clampInt, toBoolLoose } from './src/util.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(ROOT_DIR, process.env.PUBLIC_DIR || 'public');
const CONFIG_DIR = path.resolve(ROOT_DIR, process.env.CONFIG_DIR || 'config');

const NAME = 'ysc-helper';
const VERSION = '1.0.0';

const PORT = clampInt(process.env.PORT, 1, 65535, 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
const MAX_HISTORY = clampInt(process.env.MAX_HISTORY, 1, 500, 20);
const REQUEST_TIMEOUT_MS = clampInt(process.env.REQUEST_TIMEOUT_MS, 1000, 60000, 8000);
const SCAN_CONCURRENCY = clampInt(process.env.SCAN_CONCURRENCY, 1, 64, 8);
const MAX_RUNNING_JOBS = clampInt(process.env.MAX_RUNNING_JOBS, 1, 128, 8);
const BASIC_AUTH = (process.env.BASIC_AUTH || '').trim();
const MAX_BODY_BYTES = 1024 * 1024;   // 请求体上限 1MiB

const log = console;
const startedAt = Date.now();

/* ============================== 组件 ============================== */

const sources = loadSources({ rootDir: ROOT_DIR, configDir: CONFIG_DIR, logger: log });
const store = createStore({ dataDir: DATA_DIR, maxHistory: MAX_HISTORY, logger: log });
const jobs = createJobManager({ sources, store, logger: log, maxRunningJobs: MAX_RUNNING_JOBS });

/* ============================ HTTP 工具 ============================ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  } catch (e) { /* 客户端已断开 */ }
}

function fail(res, status, error, message) {
  sendJson(res, status, { ok: false, error, message });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error('请求体过大'), { code: 'too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/**
 * 读 JSON body。
 * - 空体（无 body / 纯空白）→ {}，按契约 §4.1「字段全部可选」走默认参数
 * - 非空但非法 JSON、或 JSON 不是对象 → bad_request（契约 §1 错误码），
 *   避免「静默用默认参数跑全量外网扫描」这种隐性失败
 * - 超过 1MiB → too_large
 * @returns {Promise<{ok:true, body:object} | {ok:false, status:number, error:string, message:string}>}
 */
async function readJsonBody(req) {
  let buf;
  try {
    buf = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e && e.code === 'too_large') {
      return { ok: false, status: 413, error: 'too_large', message: '请求体过大（上限 1MiB）' };
    }
    return { ok: true, body: {} };   // 客户端中断：按空体处理
  }
  const text = buf.toString('utf8').trim();
  if (!text) return { ok: true, body: {} };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, status: 400, error: 'bad_request', message: '请求体不是合法 JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, status: 400, error: 'bad_request', message: '请求体必须是 JSON 对象' };
  }
  return { ok: true, body: obj };
}

/* ============================== 参数归一化 ============================== */

/** POST /api/scan 参数（宽松布尔：只有明确 false 才关闭开关；未识别字段忽略） */
function normalizeScanParams(body) {
  const b = body && typeof body === 'object' ? body : {};
  let extraSources = [];
  if (Array.isArray(b.extraSources)) {
    extraSources = b.extraSources.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  } else if (typeof b.extraSources === 'string') {
    extraSources = b.extraSources.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  }
  extraSources = extraSources.slice(0, 500);
  const requested = clampInt(b.concurrency, 1, 32, SCAN_CONCURRENCY);
  return {
    samples: clampInt(b.samples, 1, 3, 1),
    maxDepth: clampInt(b.maxDepth, 0, 4, 3),
    concurrency: Math.min(requested, SCAN_CONCURRENCY),   // 任务内并发再受全局上限约束
    timeoutMs: clampInt(b.timeoutMs, 1000, 30000, REQUEST_TIMEOUT_MS),
    pageTimeoutMs: clampInt(b.pageTimeoutMs, 1000, 30000, 6000),
    extraSources,
    useSearchPages: toBoolLoose(b.useSearchPages, true),
    includeBaseLines: toBoolLoose(b.includeBaseLines, true)
  };
}

/* ============================== 静态资源 ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

async function sendFile(req, res, filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('not a file');
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
  stream.pipe(res);
}

async function serveIndex(req, res) {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  try {
    await sendFile(req, res, indexPath);
  } catch (e) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end('前端静态文件 public/index.html 缺失；API 仍可用（/api/health）。\n');
  }
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'bad_request', '静态资源仅支持 GET/HEAD');
  }
  let rel = pathname;
  try { rel = decodeURIComponent(pathname); } catch (e) { /* 保留原样 */ }
  if (rel === '/' || rel === '') rel = '/index.html';
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  const filePath = path.join(PUBLIC_DIR, normalized);
  const inside = filePath === path.join(PUBLIC_DIR, 'index.html')
    || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (!inside) return serveIndex(req, res);
  try {
    await sendFile(req, res, filePath);
  } catch (e) {
    // 未知路径回退 index.html（SPA）
    return serveIndex(req, res);
  }
}

/* ============================== 认证 ============================== */

function authOk(req) {
  if (!BASIC_AUTH) return true;
  const header = req.headers['authorization'] || '';
  if (!/^Basic /i.test(header)) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const a = Buffer.from(decoded, 'utf8');
  const b = Buffer.from(BASIC_AUTH, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch (e) { return false; }
}

/* ============================== API 处理 ============================== */

const RE_JOB = /^\/api\/jobs\/([^\/]+)$/;
const RE_JOB_EVENTS = /^\/api\/jobs\/([^\/]+)\/events$/;
const RE_JOB_CANCEL = /^\/api\/jobs\/([^\/]+)\/cancel$/;
const RE_JOB_CONFIG = /^\/api\/jobs\/([^\/]+)\/config$/;
const RE_HISTORY_ID = /^\/api\/history\/([^\/]+)$/;
const RE_HISTORY_CONFIG = /^\/api\/history\/([^\/]+)\/config$/;

/** 统一的配置下载响应（/api/jobs/:id/config 与 /api/history/:id/config 共用） */
function sendConfigDownload(req, res, config) {
  const body = JSON.stringify(config && typeof config === 'object' ? config : { urls: [] }, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': 'attachment; filename="ysc_config.json"',
    'Cache-Control': 'no-cache'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function jobPublic(job) {
  return {
    ok: true,
    id: job.id,
    state: job.state,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    error: job.error,
    result: job.result,
    params: job.params,
    historyId: job.historyId
  };
}

async function handleProxy(req, res, params) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'bad_request', '仅支持 GET');
  }
  const raw = params.get('url') || '';
  if (!raw.trim()) return fail(res, 400, 'bad_request', '缺少 url 参数');
  const timeoutMs = clampInt(params.get('timeout'), 1000, 30000, REQUEST_TIMEOUT_MS);
  const r = await fetchTarget(raw, { timeoutMs });
  if (!r.ok) {
    // 业务失败仍用 HTTP 200，便于前端统一处理
    return sendJson(res, 200, { ok: false, error: r.error || 'upstream_error', message: r.message || '抓取失败' });
  }
  sendJson(res, 200, {
    ok: true,
    status: r.status,
    body: r.body,
    final_url: r.final_url,
    ttfb_ms: r.ttfb_ms,
    total_ms: r.total_ms,
    size_kb: r.size_kb,
    content_type: r.content_type,
    truncated: r.truncated
  });
}

async function handleApi(req, res, pathname, params) {
  // 健康检查（不受 Basic Auth 保护）
  if (pathname === '/api/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_request', '仅支持 GET');
    return sendJson(res, 200, {
      ok: true,
      name: NAME,
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      now: new Date().toISOString()
    });
  }

  if (pathname === '/api/proxy') return handleProxy(req, res, params);

  if (pathname === '/api/sources') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_request', '仅支持 GET');
    return sendJson(res, 200, {
      ok: true,
      baseLines: sources.baseLines,
      searchPages: sources.searchPages,
      effectiveFrom: sources.effectiveFrom
    });
  }

  if (pathname === '/api/scan') {
    if (req.method !== 'POST') return fail(res, 405, 'bad_request', '仅支持 POST');
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return fail(res, parsed.status || 400, parsed.error, parsed.message);
    const scanParams = normalizeScanParams(parsed.body);
    const created = jobs.create(scanParams);
    if (!created.ok) return fail(res, 429, created.error, created.message);
    return sendJson(res, 200, { ok: true, jobId: created.job.id, state: created.job.state });
  }

  if (pathname === '/api/history') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_request', '仅支持 GET');
    const items = await store.list();
    return sendJson(res, 200, { ok: true, items });
  }

  let m = pathname.match(RE_HISTORY_CONFIG);
  if (m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_request', '仅支持 GET');
    const rec = await store.read(m[1]);
    if (!rec) return fail(res, 404, 'not_found', '历史记录不存在');
    return sendConfigDownload(req, res, rec.config);
  }

  m = pathname.match(RE_HISTORY_ID);
  if (m) {
    const id = m[1];
    if (req.method === 'DELETE') {
      const removed = await store.remove(id);
      if (!removed) return fail(res, 404, 'not_found', '历史记录不存在');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rec = await store.read(id);
      if (!rec) return fail(res, 404, 'not_found', '历史记录不存在');
      return sendJson(res, 200, {
        ok: true,
        id: rec.id,
        t: rec.t,
        count: rec.count,
        available: rec.available,
        multis: rec.multis,
        verdicts: rec.verdicts,
        config: rec.config,
        stats: rec.stats
      });
    }
    return fail(res, 405, 'bad_request', '仅支持 GET/DELETE');
  }

  m = pathname.match(RE_JOB_EVENTS);
  if (m) {
    if (req.method !== 'GET') return fail(res, 405, 'bad_request', '仅支持 GET');
    const job = jobs.get(m[1]);
    if (!job) return fail(res, 404, 'not_found', '任务不存在');
    try { if (req.socket) req.socket.setTimeout(0); } catch (e) { /* ignore */ }
    const ok = jobs.subscribe(job, req, res);
    if (!ok) return fail(res, 429, 'rate_limited', '该任务订阅者过多');
    return;   // SSE 连接保持，直到任务结束或客户端断开
  }

  m = pathname.match(RE_JOB_CANCEL);
  if (m) {
    if (req.method !== 'POST') return fail(res, 405, 'bad_request', '仅支持 POST');
    const job = jobs.get(m[1]);
    if (!job) return fail(res, 404, 'not_found', '任务不存在');
    const state = jobs.cancel(job);
    return sendJson(res, 200, { ok: true, state });
  }

  m = pathname.match(RE_JOB_CONFIG);
  if (m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_request', '仅支持 GET');
    const job = jobs.get(m[1]);
    if (!job) return fail(res, 404, 'not_found', '任务不存在');
    if (job.state !== 'done' || !job.result || !job.result.config) {
      return fail(res, 404, 'not_found', '任务尚未完成，暂无配置可下载');
    }
    return sendConfigDownload(req, res, job.result.config);
  }

  m = pathname.match(RE_JOB);
  if (m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'bad_request', '仅支持 GET');
    const job = jobs.get(m[1]);
    if (!job) return fail(res, 404, 'not_found', '任务不存在');
    return sendJson(res, 200, jobPublic(job));
  }

  return fail(res, 404, 'not_found', '接口不存在：' + pathname);
}

/* ============================== 主处理 ============================== */

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  // Basic Auth：除 /api/health 外全站保护
  if (BASIC_AUTH && pathname !== '/api/health' && !authOk(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="ysc-helper", charset="UTF-8"',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized', message: '需要 HTTP Basic 认证' }));
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname, url.searchParams);
  }
  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log.error('[server] 请求处理异常 ' + req.method + ' ' + req.url + '：' + (e && e.stack ? e.stack : String(e)));
    if (!res.headersSent) fail(res, 500, 'internal_error', '服务器内部错误');
    else { try { res.end(); } catch (err) { /* ignore */ } }
  });
});

/* ============================== 优雅退出 ============================== */

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.log('[server] 收到 ' + signal + '，开始优雅退出...');
  try { jobs.closeAll(); } catch (e) { /* ignore */ }
  const force = setTimeout(() => {
    log.warn('[server] 超时强制退出');
    process.exit(0);
  }, 5000);
  if (force.unref) force.unref();
  server.close(() => {
    log.log('[server] HTTP 服务已关闭');
    process.exit(0);
  });
  const drop = setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }, 1200);
  if (drop.unref) drop.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  log.error('[fatal] 未捕获异常（进程继续运行）：' + (e && e.stack ? e.stack : String(e)));
});
process.on('unhandledRejection', (e) => {
  log.error('[fatal] 未处理的 Promise 拒绝（进程继续运行）：' + (e && e.stack ? e.stack : String(e)));
});

/* ============================== 启动 ============================== */

async function main() {
  const info = await store.init();
  log.log('[server] ' + NAME + ' v' + VERSION);
  log.log('[server] 数据目录：' + info.histDir + '（历史 ' + info.count + ' 条，上限 ' + MAX_HISTORY + '）');
  log.log('[server] 线路源：' + sources.effectiveFrom + '（baseLines=' + sources.baseLines.length + '，searchPages=' + sources.searchPages.length + '）');
  log.log('[server] 抓取并发上限：' + SCAN_CONCURRENCY + '，默认超时：' + REQUEST_TIMEOUT_MS + 'ms，允许内网目标：' + (allowPrivateTargets() ? '是' : '否'));
  if (BASIC_AUTH) log.log('[server] 已启用 HTTP Basic 认证');
  const hasIndex = await fsp.access(path.join(PUBLIC_DIR, 'index.html')).then(() => true).catch(() => false);
  if (!hasIndex) log.warn('[server] 未找到 ' + path.join(PUBLIC_DIR, 'index.html') + '（前端静态文件未就绪）');

  server.listen(PORT, HOST, () => {
    log.log('[server] 监听 http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
    log.log('[server] 健康检查：GET /api/health');
  });
}

main().catch((e) => {
  log.error('[server] 启动失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
