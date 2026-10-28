#!/usr/bin/env node
/**
 * test/smoke.mjs — 零依赖端到端验收测试（契约 docs/API.md §10）
 *
 * 运行：node test/smoke.mjs
 * 设计：
 *   - 自起一个本地 fixture 源站（node:http，随机端口），提供单仓/多仓/坏 JSON/慢响应/分块响应/
 *     404 等端点；所有断言只访问 127.0.0.1，不依赖外网（可离线 / 可在容器内复跑）。
 *   - 以子进程启动目标服务（PORT 随机、DATA_DIR 指向临时目录）：
 *       A 实例：ALLOW_PRIVATE_TARGETS=1  → 允许抓 fixture，跑主流程
 *       B 实例：ALLOW_PRIVATE_TARGETS=0  → 验证 SSRF 拦截
 *   - 全部用例结束（无论成败）都会杀掉子进程、关闭 fixture、清理临时目录，不留僵尸。
 * 退出码：全部通过 0，任何失败 1。
 */

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(ROOT, 'server.mjs');

/* ============================ 迷你断言/用例框架 ============================ */

const results = [];
let currentOk = true;
let currentLines = [];

function log(s) { process.stdout.write(s + '\n'); }

async function runCase(name, fn, ctx) {
  currentOk = true;
  currentLines = [];
  const t0 = Date.now();
  const api = {
    assert(label, cond, detail) {
      if (cond) {
        currentLines.push('     \u2713 ' + label);
      } else {
        currentOk = false;
        currentLines.push('     \u2717 ' + label + (detail === undefined ? '' : '\n         expected/actual: ' + String(detail)));
      }
    },
    info(label) { currentLines.push('     \u00b7 ' + label); },
    ok(label, cond) { this.assert(label, !!cond); },
    eq(label, actual, expected) { this.assert((label + ' == ' + JSON.stringify(expected)), actual === expected, 'actual=' + JSON.stringify(actual)); },
    gt(label, actual, min) { this.assert(label + ' > ' + min, typeof actual === 'number' && actual > min, 'actual=' + JSON.stringify(actual)); },
    gte(label, actual, min) { this.assert(label + ' >= ' + min, typeof actual === 'number' && actual >= min, 'actual=' + JSON.stringify(actual)); },
    has(label, haystack, needle) { this.assert(label + ' 包含 ' + JSON.stringify(needle), typeof haystack === 'string' && haystack.includes(needle), 'actual=' + JSON.stringify(String(haystack).slice(0, 300))); },
    isArray(label, v, minLen = 0) { this.assert(label + ' 是数组且长度>=' + minLen, Array.isArray(v) && v.length >= minLen, 'actual=' + JSON.stringify(v)?.slice(0, 300)); },
  };
  try {
    await fn(api, ctx);
  } catch (e) {
    currentOk = false;
    currentLines.push('     \u2717 用例抛异常: ' + ((e && e.stack) || e));
  }
  const ms = Date.now() - t0;
  results.push({ name, ok: currentOk, ms });
  log((currentOk ? 'PASS  ' : 'FAIL  ') + name + '  (' + ms + 'ms)');
  for (const line of currentLines) log(line);
  return currentOk;
}

/* ============================ 通用子进程/端口工具 ============================ */

const cleanups = [];

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingTimers.delete(t); resolve(); }, ms);
    pendingTimers.add(t);
  });
}
const pendingTimers = new Set();

async function waitForHealth(base, child, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt';
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error('服务进程提前退出，exitCode=' + child.exitCode + '\n--- stderr ---\n' + tail(child.stderrBuf) + '\n--- stdout ---\n' + tail(child.stdoutBuf));
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1500);
      const res = await fetch(base + '/api/health', { signal: ac.signal });
      clearTimeout(timer);
      const text = await res.text();
      if (res.status === 200 && text.includes('"ok":true')) return text;
      lastErr = 'HTTP ' + res.status + ' ' + text.slice(0, 200);
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
    await delay(200);
  }
  throw new Error('等待 /api/health 超时（' + timeoutMs + 'ms），最后错误: ' + lastErr);
}

function tail(s, n = 4000) {
  if (!s) return '(empty)';
  return s.length > n ? '...' + s.slice(-n) : s;
}

async function startService({ dataDir, allowPrivate, label, extraEnv = {} }) {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    ALLOW_PRIVATE_TARGETS: allowPrivate ? '1' : '0',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdoutBuf = '';
  child.stderrBuf = '';
  child.stdout.on('data', (d) => { child.stdoutBuf += d.toString(); });
  child.stderr.on('data', (d) => { child.stderrBuf += d.toString(); });
  child.on('error', (e) => { child.stderrBuf += '\n[spawn error] ' + e.message; });

  const base = 'http://127.0.0.1:' + port;
  await waitForHealth(base, child);
  const handle = { label, port, base, child, dataDir };
  cleanups.push(() => stopService(handle));
  return handle;
}

async function stopService(handle) {
  const child = handle.child;
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const done = () => { clearTimeout(force); resolve(); };
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(force); resolve(); }
  });
}

/* ============================ HTTP 辅助 ============================ */

async function api(base, pathname, opts = {}) {
  const { method = 'GET', body, headers = {}, timeoutMs = 20000, raw = false } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init = { method, signal: ac.signal, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!('content-type' in init.headers)) init.headers['content-type'] = 'application/json; charset=utf-8';
    }
    const res = await fetch(base + pathname, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, headers: res.headers, text, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

/** 读取 SSE 流直到 done/error 事件或超时；返回 { events, hello, done, error, comments } */
async function readSSE(url, { timeoutMs = 120000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const out = { events: [], hello: null, progress: 0, done: null, error: null, comments: 0, pings: 0, raw: '' };
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
    if (res.status !== 200) throw new Error('SSE HTTP ' + res.status);
    out.contentType = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let block = { event: 'message', dataLines: [] };
    let aborted = false;
    while (!aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (block.dataLines.length) {
            const ev = { event: block.event, data: block.dataLines.join('\n') };
            try { ev.json = JSON.parse(ev.data); } catch { ev.json = null; }
            out.events.push(ev);
            if (ev.event === 'hello') out.hello = ev.json;
            else if (ev.event === 'progress') out.progress += 1;
            else if (ev.event === 'done') { out.done = ev.json; aborted = true; }
            else if (ev.event === 'error') { out.error = ev.json; aborted = true; }
          }
          block = { event: 'message', dataLines: [] };
          if (aborted) break;
        } else if (line.startsWith(':')) {
          out.comments += 1;
          if (line.includes('ping')) out.pings += 1;
          out.raw += line + '\n';
        } else if (line.startsWith('event:')) {
          block.event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          block.dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    try { await reader.cancel(); } catch {}
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ 本地 fixture 源站 ============================ */

function singleFixture(name, tag) {
  return {
    spider: 'https://example.invalid/spider.jar;md5;deadbeef',
    sites: [
      { key: tag + '-1', name: 'Fixture 线路一', type: 3, api: 'https://example.invalid/api.php/provide/vod/', searchable: 1, quickSearch: 1, filterable: 1 },
      { key: tag + '-2', name: 'Fixture 线路二', type: 1, api: 'https://example.invalid/api.php/provide/vod2/', searchable: 1, quickSearch: 0, filterable: 1 },
      { key: tag + '-3', name: 'Fixture 线路三', type: 1, api: 'https://example.invalid/api.php/provide/vod3/', searchable: 1, quickSearch: 1, filterable: 1 },
    ],
    lives: [],
    name,
  };
}

async function startFixture() {
  const timers = new Set();
  const sockets = new Set();
  const state = { hits: {} };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const p = url.pathname;
    state.hits[p] = (state.hits[p] || 0) + 1;
    // 客户端已取消（超时场景）时静默处理，避免 fixture 自身报错
    res.on('error', () => {});

    const sendJson = (status, obj) => {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      res.end(body);
    };

    if (p === '/single.json') return sendJson(200, singleFixture('fixture-single', 's'));
    if (p === '/single2.json') return sendJson(200, singleFixture('fixture-single-2', 's2'));
    if (p === '/multi.json') {
      return sendJson(200, {
        name: 'fixture-multi',
        storeHouse: [
          { sourceName: 's1', sourceUrl: origin + '/single.json' },
          { sourceName: 's2', sourceUrl: origin + '/single2.json' },
        ],
      });
    }
    if (p === '/bad.json') {
      const body = Buffer.from('not json at all', 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length) });
      return res.end(body);
    }
    if (p === '/slow.json') {
      // 延迟 6s 才响应：用于超时 / 取消场景
      const t = setTimeout(() => {
        timers.delete(t);
        if (res.destroyed || res.writableEnded) return;
        sendJson(200, singleFixture('fixture-slow', 'slow'));
      }, 6000);
      timers.add(t);
      res.on('close', () => { if (!res.writableEnded) { clearTimeout(t); timers.delete(t); } });
      return;
    }
    if (p === '/chunked.json') {
      // 先发响应头，200ms 后再发 body：保证 ttfb_ms 与 total_ms 有明显差值
      const body = Buffer.from(JSON.stringify(singleFixture('fixture-chunked', 'chunk')), 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const t = setTimeout(() => {
        timers.delete(t);
        if (res.destroyed || res.writableEnded) return;
        res.end(body);
      }, 220);
      timers.add(t);
      res.on('close', () => { if (!res.writableEnded) { clearTimeout(t); timers.delete(t); } });
      return;
    }
    if (p === '/status404.json') {
      return sendJson(404, { ok: false, reason: 'fixture-404' });
    }
    if (p === '/sources.json') {
      return sendJson(200, { baseLines: [['fixture-line', origin + '/single.json']], searchPages: [] });
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('fixture: not found');
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const fixture = {
    origin,
    hits: state.hits,
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of sockets) { try { s.destroy(); } catch {} }
      sockets.clear();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  cleanups.push(() => fixture.close());
  return fixture;
}

/* ============================ 主流程 ============================ */

const norm = (u) => String(u || '').trim().toLowerCase().replace(/\/+$/, '');

async function main() {
  const startWall = Date.now();
  let failed2 = false;
  log('=== 影视仓接口助手 Web 版 · 烟囱测试（docs/API.md §10）===');
  log('项目根目录: ' + ROOT);

  // 预检：后端/前端产物是否就绪
  const missing = [];
  for (const rel of ['server.mjs', 'public/index.html', 'public/app.js', 'public/style.css']) {
    try { await access(path.join(ROOT, rel)); } catch { missing.push(rel); }
  }
  if (missing.length) {
    log('\n[前置条件不满足] 缺少文件: ' + missing.join(', '));
    log('后端起好后重跑: node test/smoke.mjs');
    process.exitCode = 1;
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ysc-smoke-'));
  const dataA = path.join(tmpRoot, 'dataA');
  const dataB = path.join(tmpRoot, 'dataB');
  cleanups.push(async () => { try { await rm(tmpRoot, { recursive: true, force: true }); } catch {} });

  const fixture = await startFixture();
  log('fixture 源站: ' + fixture.origin + '  (/single.json /single2.json /multi.json /bad.json /slow.json /chunked.json /status404.json)');

  const svcA = await startService({ dataDir: dataA, allowPrivate: true, label: 'A(ALLOW_PRIVATE_TARGETS=1)' });
  log('目标服务 ' + svcA.label + ': ' + svcA.base + '  DATA_DIR=' + dataA);
  const svcB = await startService({ dataDir: dataB, allowPrivate: false, label: 'B(ALLOW_PRIVATE_TARGETS=0)' });
  log('目标服务 ' + svcB.label + ': ' + svcB.base + '  DATA_DIR=' + dataB);
  log('');

  const fxSingle = fixture.origin + '/single.json';
  const fxMulti = fixture.origin + '/multi.json';
  const fxBad = fixture.origin + '/bad.json';

  /* ---- 1) 健康检查 ---- */
  await runCase('1) GET /api/health', async (t) => {
    const r = await api(svcA.base, '/api/health');
    t.eq('HTTP 状态', r.status, 200);
    t.ok('响应为 JSON', !!r.json);
    t.eq('ok', r.json && r.json.ok, true);
    t.ok('带 name 字段', !!(r.json && r.json.name));
    t.ok('带 version 字段', !!(r.json && r.json.version));
    t.ok('uptimeSec 是数字', !!(r.json && typeof r.json.uptimeSec === 'number'));
    t.ok('now 是 ISO 字符串', !!(r.json && typeof r.json.now === 'string' && !Number.isNaN(Date.parse(r.json.now))));
  });

  /* ---- 2) /api/proxy 抓 fixture ---- */
  await runCase('2) GET /api/proxy 抓 fixture 单仓（status/size/ttfb/total）', async (t) => {
    const r = await api(svcA.base, '/api/proxy?url=' + encodeURIComponent(fxSingle) + '&timeout=5000', { timeoutMs: 15000 });
    t.eq('HTTP 状态', r.status, 200);
    t.ok('响应为 JSON', !!r.json, r.text.slice(0, 200));
    t.eq('ok', r.json.ok, true);
    t.eq('status', r.json.status, 200);
    t.gt('size_kb', r.json.size_kb, 0);
    t.gt('ttfb_ms', r.json.ttfb_ms, 0);
    t.gt('total_ms', r.json.total_ms, 0);
    t.ok('body 为原始文本（含 "fixture-single"）', typeof r.json.body === 'string' && r.json.body.includes('fixture-single'), String(r.json.body).slice(0, 200));
    t.ok('final_url 已返回', typeof r.json.final_url === 'string' && r.json.final_url.length > 0, r.json.final_url);
    t.ok('content_type 已返回', typeof r.json.content_type === 'string' && r.json.content_type.length > 0, r.json.content_type);
    t.eq('truncated', r.json.truncated, false);

    // ttfb < total：用分块响应的 fixture 保证两者有明显差值
    const rc = await api(svcA.base, '/api/proxy?url=' + encodeURIComponent(fixture.origin + '/chunked.json') + '&timeout=5000', { timeoutMs: 15000 });
    t.eq('分块响应 HTTP 状态', rc.status, 200);
    t.eq('分块响应 ok', rc.json && rc.json.ok, true);
    t.gt('分块响应 ttfb_ms', rc.json && rc.json.ttfb_ms, 0);
    t.assert('ttfb_ms < total_ms（' + (rc.json && rc.json.ttfb_ms) + ' < ' + (rc.json && rc.json.total_ms) + '）',
      !!(rc.json && rc.json.ttfb_ms < rc.json.total_ms), JSON.stringify(rc.json && { ttfb_ms: rc.json.ttfb_ms, total_ms: rc.json.total_ms }));

    // 非 2xx 上游：ok:true 且带真实 status（契约 §3）
    const r4 = await api(svcA.base, '/api/proxy?url=' + encodeURIComponent(fixture.origin + '/status404.json'), { timeoutMs: 15000 });
    t.eq('404 上游 HTTP 状态', r4.status, 200);
    t.eq('404 上游 ok', r4.json && r4.json.ok, true);
    t.eq('404 上游 status', r4.json && r4.json.status, 404);

    // 超时：slow.json(6s) + timeout=1000 → ok:false / error=timeout
    const rt = await api(svcA.base, '/api/proxy?url=' + encodeURIComponent(fixture.origin + '/slow.json') + '&timeout=1000', { timeoutMs: 20000 });
    t.eq('超时场景 HTTP 状态', rt.status, 200);
    t.eq('超时场景 ok', rt.json && rt.json.ok, false);
    t.eq('超时场景 error 码', rt.json && rt.json.error, 'timeout');
  });

  /* ---- 3) SSRF：ALLOW_PRIVATE_TARGETS=0 实例拦截私网 ---- */
  await runCase('3) SSRF 拦截（ALLOW_PRIVATE_TARGETS=0 → blocked_target）', async (t) => {
    const r = await api(svcB.base, '/api/proxy?url=' + encodeURIComponent(fxSingle), { timeoutMs: 15000 });
    t.ok('返回 JSON', !!r.json, r.text.slice(0, 200));
    const errCode = (r.json && r.json.error) || '';
    t.assert('error == blocked_target（' + JSON.stringify(errCode) + '）', errCode === 'blocked_target', JSON.stringify(r.json).slice(0, 300));
    t.assert('HTTP 状态符合契约（200 业务失败 或 4xx/5xx）', r.status === 200 || (r.status >= 400 && r.status < 600), 'status=' + r.status);
    if (r.status !== 200) t.eq('ok', r.json && r.json.ok, false);
    // 回环 & localhost 同样应被拦截
    for (const u of ['http://127.0.0.1:' + svcB.port + '/api/health', 'http://localhost:' + fixture.origin.split(':')[2] + '/single.json']) {
      const rr = await api(svcB.base, '/api/proxy?url=' + encodeURIComponent(u), { timeoutMs: 15000 });
      t.eq('拦截 ' + u + ' → blocked_target', rr.json && rr.json.error, 'blocked_target');
    }
  });

  /* ---- 4) POST /api/scan + SSE 订阅 ---- */
  const scanBody = {
    samples: 1,
    maxDepth: 2,
    concurrency: 4,
    timeoutMs: 3000,
    pageTimeoutMs: 3000,
    extraSources: [fxSingle, fxMulti, fxBad],
    useSearchPages: false,
    // §4.1：includeBaseLines=false → 只用 extraSources，不带内置 BASE_LINES，保证完全离线
    includeBaseLines: false,
  };
  const scanCtx = { jobId: null, job: null, done: null, sse: null, config: null };
  const histCtx = { id: null, item: null, detail: null };

  await runCase('4) POST /api/scan → SSE progress/done → state=done', async (t) => {
    const r = await api(svcA.base, '/api/scan', { method: 'POST', body: scanBody });
    t.eq('POST /api/scan HTTP 状态', r.status, 200);
    t.eq('ok', r.json && r.json.ok, true);
    t.ok('返回 jobId（形如 j_xxx）', typeof (r.json && r.json.jobId) === 'string' && r.json.jobId.length > 0, JSON.stringify(r.json));
    t.eq('创建时 state=running', r.json && r.json.state, 'running');
    scanCtx.jobId = r.json.jobId;
    if (!scanCtx.jobId) return;

    const sse = await readSSE(svcA.base + '/api/jobs/' + encodeURIComponent(scanCtx.jobId) + '/events', { timeoutMs: 150000 });
    scanCtx.sse = sse;
    t.assert('SSE Content-Type 为 text/event-stream（' + (sse.contentType || '') + '）', String(sse.contentType || '').includes('text/event-stream'), sse.contentType);
    t.ok('收到 hello 事件', !!sse.hello);
    t.ok('hello.state 合法', !!(sse.hello && ['running', 'done', 'error', 'cancelled'].includes(sse.hello.state)), JSON.stringify(sse.hello));
    t.gte('收到 progress 事件数', sse.progress, 1);
    t.ok('收到 done 事件（未收到 error 事件）', !!sse.done && !sse.error, sse.error ? JSON.stringify(sse.error) : 'done=' + (sse.done ? 'yes' : 'no'));
    if (sse.error) t.info('error 事件: ' + JSON.stringify(sse.error));
    t.ok('done 事件与 §4.3 result 同构（含 verdicts 数组）', !!(sse.done && Array.isArray(sse.done.verdicts)), JSON.stringify(sse.done)?.slice(0, 300));
    scanCtx.done = sse.done;

    // 用 GET /api/jobs/:id 校正最终状态（SSE 的权威来源）
    const j = await api(svcA.base, '/api/jobs/' + encodeURIComponent(scanCtx.jobId), { timeoutMs: 20000 });
    t.eq('GET /api/jobs/:id HTTP 状态', j.status, 200);
    t.eq('job.id', j.json && j.json.id, scanCtx.jobId);
    t.eq('state', j.json && j.json.state, 'done');
    t.ok('finishedAt 已写入', !!(j.json && typeof j.json.finishedAt === 'number'), JSON.stringify(j.json && j.json.finishedAt));
    t.ok('result 存在', !!(j.json && j.json.result));
    scanCtx.job = j.json;

    // §4.2：任务已结束后重新订阅，仍应先发 hello（state=done）再发 done/历史进度，然后关闭
    const sse2 = await readSSE(svcA.base + '/api/jobs/' + encodeURIComponent(scanCtx.jobId) + '/events', { timeoutMs: 30000 });
    t.ok('重连：先收到 hello', !!sse2.hello);
    t.eq('重连：hello.state', sse2.hello && sse2.hello.state, 'done');
    t.ok('重连：随后收到 done 事件或补发历史进度', !!(sse2.done || sse2.progress >= 1), 'done=' + (sse2.done ? 'yes' : 'no') + ' progress=' + sse2.progress);
  });

  /* ---- 5) result.verdicts 结构断言 ---- */
  await runCase('5) result.verdicts：单仓/多仓/坏 JSON', async (t) => {
    const verdicts = (scanCtx.job && scanCtx.job.result && scanCtx.job.result.verdicts) || [];
    t.isArray('verdicts', verdicts, 3);
    t.info('verdicts 条数=' + verdicts.length + '，URL: ' + verdicts.map((v) => v.url).join(' | ').slice(0, 500));

    // §4.1 三开关独立：includeBaseLines:false + useSearchPages:false → 待测集合恰好是 3 个 extraSources
    t.assert('verdicts 恰好 3 条（多出即 includeBaseLines 未生效/访问了外网）', verdicts.length === 3, 'actual=' + verdicts.length + ' urls=' + JSON.stringify(verdicts.map((v) => v.url)).slice(0, 600));
    const allowed = new Set([norm(fxSingle), norm(fxMulti), norm(fxBad)]);
    const extras = verdicts.filter((v) => !allowed.has(norm(v.url))).map((v) => v.url);
    t.assert('verdicts 中不含任何额外（外网/内置）地址', extras.length === 0, 'extra=' + JSON.stringify(extras).slice(0, 600));

    const find = (u) => verdicts.find((v) => norm(v.url) === norm(u)) || null;

    const single = find(fxSingle);
    t.ok('存在 fixture single.json 的 verdict', !!single);
    if (single) {
      t.eq('single.kind', single.kind, 'single');
      t.eq('single.available', single.available, true);
      t.eq('single.speed_label 取值合法', ['快', '中', '慢', '不可用'].includes(single.speed_label), true);
      t.gt('single.total_ms', single.total_ms, 0);
      t.gt('single.size_kb', single.size_kb, 0);
      t.eq('single.site_count', single.site_count, 3);
      t.eq('single.error 为空', single.error, '');
      t.isArray('single.children', single.children, 0);
    }

    const multi = find(fxMulti);
    t.ok('存在 fixture multi.json 的 verdict', !!multi);
    if (multi) {
      t.eq('multi.kind', multi.kind, 'multi_storehouse');
      t.eq('multi.available', multi.available, true);
      t.gte('multi.children 长度', multi.children && multi.children.length, 1);
      t.ok('multi.children[].kind 为 single', (multi.children || []).some((c) => c.kind === 'single'), JSON.stringify((multi.children || []).map((c) => [c.url, c.kind, c.available])));
      t.ok('multi.children 至少一个可用', (multi.children || []).some((c) => c.available === true), JSON.stringify((multi.children || []).map((c) => [c.url, c.available, c.error])));
      t.eq('multi.depth', multi.depth, 0);
      t.eq('multi.children[0].parent_url', multi.children && multi.children[0] && norm(multi.children[0].parent_url), norm(fxMulti));
    }

    const bad = find(fxBad);
    t.ok('存在 fixture bad.json 的 verdict', !!bad);
    if (bad) {
      t.eq('bad.available', bad.available, false);
      t.ok('bad.error 非空', typeof bad.error === 'string' && bad.error.length > 0, JSON.stringify(bad.error));
      t.eq('bad.speed_label', bad.speed_label, '不可用');
    }

    const result = scanCtx.job && scanCtx.job.result || {};
    t.ok('stats 存在', !!result.stats, JSON.stringify(result.stats));
    if (result.stats) {
      t.eq('stats.total == verdicts.length', result.stats.total, verdicts.length);
      t.gt('stats.available', result.stats.available, 0);
      t.gt('stats.multis', result.stats.multis, 0);
    }
    t.ok('elapsedMs 是数字', typeof result.elapsedMs === 'number', JSON.stringify(result.elapsedMs));
    t.ok('lines 是数字', typeof result.lines === 'number', JSON.stringify(result.lines));
  });

  /* ---- 6) GET /api/jobs/:id/config ---- */
  await runCase('6) GET /api/jobs/:id/config 返回 {"urls":[...]}', async (t) => {
    if (!scanCtx.jobId) return t.assert('前置：jobId 存在', false);
    const r = await api(svcA.base, '/api/jobs/' + encodeURIComponent(scanCtx.jobId) + '/config', { timeoutMs: 20000 });
    t.eq('HTTP 状态', r.status, 200);
    const ct = r.headers.get('content-type') || '';
    t.has('Content-Type 含 application/json', ct, 'application/json');
    const cd = r.headers.get('content-disposition') || '';
    t.has('Content-Disposition 含 attachment', cd, 'attachment');
    t.has('Content-Disposition 含 ysc_config.json', cd, 'ysc_config.json');
    t.ok('body 可解析为 JSON', !!r.json, r.text.slice(0, 200));
    t.isArray('urls', r.json && r.json.urls, 1);
    const urls = (r.json && r.json.urls) || [];
    t.info('config urls: ' + JSON.stringify(urls).slice(0, 500));
    t.ok('含 fixture single.json 地址', urls.some((x) => norm(x && x.url) === norm(fxSingle)), JSON.stringify(urls).slice(0, 400));
    t.ok('每项含 name/url', urls.every((x) => x && typeof x.url === 'string' && x.url.length > 0 && typeof x.name === 'string'), JSON.stringify(urls).slice(0, 400));
    t.ok('不含不可用的 bad.json', !urls.some((x) => norm(x && x.url) === norm(fxBad)), JSON.stringify(urls).slice(0, 400));
    // 端到端不变量：导出配置里每条 url 都必须带协议头（废址的典型症状就是丢了 http(s)://）
    const noScheme = urls.filter((x) => !/^https?:\/\//i.test(String((x && x.url) || '').trim()));
    t.assert('每条 config.url 都带 http(s):// 协议头', noScheme.length === 0, 'offenders=' + JSON.stringify(noScheme).slice(0, 400));
    scanCtx.config = r.json;
  });

  /* ---- 7) 历史记录：列表 + 下钻（删除在用例 13 中做，便于复用同一 id） ---- */
  await runCase('7) /api/history 列表 → 下钻', async (t) => {
    // 严格断言：后端保证「done 之前历史已落盘」，故这里不轮询、不 sleep，直接立即查询。
    // 若哪天退回异步落盘，这条会立刻红 —— 届时须先改契约 §5 / README 语义，而不是给测试加等待。
    const list = await api(svcA.base, '/api/history', { timeoutMs: 15000 });
    const items = (list.json && list.json.items) || [];
    t.eq('GET /api/history HTTP 状态', list.status, 200);
    t.eq('ok', list.json && list.json.ok, true);
    t.isArray('items（done 后立即查询即可见，不轮询）', list.json && list.json.items, 1);
    t.info('history items: ' + JSON.stringify(items).slice(0, 600));
    // 若后端附带 job.historyId（附加字段），按它精确取记录，否则取第一条
    const item = items.find((x) => x && scanCtx.job && x.id === scanCtx.job.historyId)
      || items.find((x) => x && typeof x.id === 'string');
    t.ok('至少一条历史记录', !!item);
    if (!item) return;
    if (scanCtx.job && scanCtx.job.historyId) t.eq('job.historyId 指向该条历史记录', scanCtx.job.historyId, item.id);
    histCtx.id = item.id;
    histCtx.item = item;
    t.gt('历史 count', item.count, 0);
    // 同一次扫描的一致性：同一个完成时刻、count 对应顶层 verdict 数
    const finishedAt = scanCtx.job && scanCtx.job.result && scanCtx.job.result.finishedAt;
    const vLen = ((scanCtx.job && scanCtx.job.result && scanCtx.job.result.verdicts) || []).length;
    t.assert('历史 t 与 result.finishedAt 落在同一轮（差值 < 5s）',
      typeof item.t === 'number' && typeof finishedAt === 'number' && Math.abs(item.t - finishedAt) < 5000,
      't=' + item.t + ' finishedAt=' + finishedAt);
    t.eq('历史 count == 顶层 verdicts 数', item.count, vLen);
    t.ok('历史 t 是时间戳', typeof item.t === 'number' && item.t > 0, JSON.stringify(item.t));
    t.ok('历史 available 是数字', typeof item.available === 'number', JSON.stringify(item.available));
    t.ok('历史 elapsedMs 是数字', typeof item.elapsedMs === 'number', JSON.stringify(item.elapsedMs));

    const detail = await api(svcA.base, '/api/history/' + encodeURIComponent(item.id), { timeoutMs: 15000 });
    t.eq('GET /api/history/:id HTTP 状态', detail.status, 200);
    t.eq('ok', detail.json && detail.json.ok, true);
    t.isArray('历史 verdicts', detail.json && detail.json.verdicts, 3);
    t.ok('历史 config.urls 存在', !!(detail.json && detail.json.config && Array.isArray(detail.json.config.urls)), JSON.stringify(detail.json && detail.json.config).slice(0, 200));
    t.ok('历史 stats 存在', !!(detail.json && detail.json.stats));
    histCtx.detail = detail.json;
  });

  /* ---- 8) 静态资源 ---- */
  await runCase('8) 静态资源 GET / /app.js /style.css', async (t) => {
    const idx = await api(svcA.base, '/', { timeoutMs: 15000 });
    t.eq('GET / HTTP 状态', idx.status, 200);
    t.has('GET / Content-Type 含 text/html', idx.headers.get('content-type') || '', 'text/html');
    t.has('GET / HTML 含「影视仓」', idx.text, '影视仓');
    t.has('GET / 引用 app.js', idx.text, 'app.js');
    t.has('GET / 引用 style.css', idx.text, 'style.css');
    t.eq('GET / Cache-Control', idx.headers.get('cache-control'), 'no-cache');

    const js = await api(svcA.base, '/app.js', { timeoutMs: 15000 });
    t.eq('GET /app.js HTTP 状态', js.status, 200);
    t.has('GET /app.js Content-Type 含 javascript', js.headers.get('content-type') || '', 'javascript');
    t.ok('GET /app.js 非空', js.text.length > 200, 'len=' + js.text.length);

    const css = await api(svcA.base, '/style.css', { timeoutMs: 15000 });
    t.eq('GET /style.css HTTP 状态', css.status, 200);
    t.has('GET /style.css Content-Type 含 css', css.headers.get('content-type') || '', 'css');
    t.ok('GET /style.css 非空', css.text.length > 200, 'len=' + css.text.length);

    // 未知 /api 路径 → 404 JSON；未知非 /api 路径 → 回退 index.html（SPA）
    const nf = await api(svcA.base, '/api/does-not-exist', { timeoutMs: 15000 });
    t.eq('未知 /api 路径 HTTP 状态', nf.status, 404);
    t.eq('未知 /api 路径 error', nf.json && nf.json.error, 'not_found');
    const spa = await api(svcA.base, '/some/deep/route', { timeoutMs: 15000 });
    t.eq('SPA 回退 HTTP 状态', spa.status, 200);
    t.has('SPA 回退返回 index.html', spa.text, '影视仓');
  });

  /* ---- 9) /api/sources（契约 §6） ---- */
  await runCase('9) GET /api/sources', async (t) => {
    const r = await api(svcA.base, '/api/sources', { timeoutMs: 15000 });
    t.eq('HTTP 状态', r.status, 200);
    t.eq('ok', r.json && r.json.ok, true);
    t.isArray('baseLines', r.json && r.json.baseLines, 1);
    t.isArray('searchPages', r.json && r.json.searchPages, 0);
    t.ok('effectiveFrom 为 builtin|file', ['builtin', 'file'].includes(r.json && r.json.effectiveFrom), JSON.stringify(r.json && r.json.effectiveFrom));
    t.ok('baseLines 每项为 [name,url]', (r.json.baseLines || []).every((x) => Array.isArray(x) && x.length === 2 && typeof x[1] === 'string'), JSON.stringify(r.json.baseLines).slice(0, 200));
  });

  /* ---- 10) 取消任务（契约 §4.4） ---- */
  await runCase('10) POST /api/jobs/:id/cancel', async (t) => {
    const r = await api(svcA.base, '/api/scan', {
      method: 'POST',
      body: { samples: 1, maxDepth: 1, concurrency: 4, timeoutMs: 8000, pageTimeoutMs: 8000, extraSources: [fixture.origin + '/slow.json'], useSearchPages: false, includeBaseLines: false },
      timeoutMs: 20000,
    });
    t.eq('创建任务 ok', r.json && r.json.ok, true);
    const jobId = r.json && r.json.jobId;
    t.ok('返回 jobId', typeof jobId === 'string' && jobId.length > 0, JSON.stringify(r.json));
    if (!jobId) return;
    const c = await api(svcA.base, '/api/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST', timeoutMs: 20000 });
    t.eq('cancel HTTP 状态', c.status, 200);
    t.eq('cancel ok', c.json && c.json.ok, true);
    t.assert('cancel 返回 state=cancelled（' + JSON.stringify(c.json && c.json.state) + '）', (c.json && c.json.state) === 'cancelled', JSON.stringify(c.json));
    // 轮询确认最终状态已收敛（允许短暂 running）
    let state = null;
    for (let i = 0; i < 25; i++) {
      const j = await api(svcA.base, '/api/jobs/' + encodeURIComponent(jobId), { timeoutMs: 15000 });
      state = j.json && j.json.state;
      if (state === 'cancelled') break;
      await delay(200);
    }
    t.eq('GET /api/jobs/:id state', state, 'cancelled');
  });

  /* ---- 11) 错误码契约（§1：bad_request / not_found） ---- */
  await runCase('11) 错误码契约 bad_request / not_found', async (t) => {
    const noUrl = await api(svcA.base, '/api/proxy', { timeoutMs: 10000 });
    t.assert('缺 url → bad_request（或 HTTP 400）', ((noUrl.json && noUrl.json.error) === 'bad_request') || noUrl.status === 400, 'status=' + noUrl.status + ' body=' + noUrl.text.slice(0, 200));
    if (noUrl.json) t.eq('缺 url ok=false', noUrl.json.ok, false);

    const badUrl = await api(svcA.base, '/api/proxy?url=' + encodeURIComponent('not-a-url'), { timeoutMs: 10000 });
    t.assert('非法 url → bad_request（或 HTTP 400）', ((badUrl.json && badUrl.json.error) === 'bad_request') || badUrl.status === 400, 'status=' + badUrl.status + ' body=' + badUrl.text.slice(0, 200));

    const badJson = await api(svcA.base, '/api/scan', { method: 'POST', body: 'not a json body', timeoutMs: 10000 });
    t.assert('非法 JSON body → bad_request（或 HTTP 400）', ((badJson.json && badJson.json.error) === 'bad_request') || badJson.status === 400, 'status=' + badJson.status + ' body=' + badJson.text.slice(0, 200));
    // 防御：若实现误建了任务（宽松解析），立刻取消，避免测试意外触发对外网的扫描
    if (badJson.json && badJson.json.jobId) {
      t.info('实现宽松解析了非法 body，已取消误建任务 ' + badJson.json.jobId);
      try { await api(svcA.base, '/api/jobs/' + encodeURIComponent(badJson.json.jobId) + '/cancel', { method: 'POST', timeoutMs: 10000 }); } catch {}
    }

    const jf = await api(svcA.base, '/api/jobs/j_does_not_exist', { timeoutMs: 10000 });
    t.eq('未知 job HTTP 状态', jf.status, 404);
    t.eq('未知 job error', jf.json && jf.json.error, 'not_found');

    const hf = await api(svcA.base, '/api/history/h_does_not_exist', { timeoutMs: 10000 });
    t.eq('未知历史 HTTP 状态', hf.status, 404);
    t.eq('未知历史 error', hf.json && hf.json.error, 'not_found');
  });

  /* ---- 12) BASIC_AUTH（§8） ---- */
  await runCase('12) BASIC_AUTH 保护非 /api/health 请求', async (t) => {
    const svcC = await startService({ dataDir: path.join(tmpRoot, 'dataC'), allowPrivate: true, label: 'C(BASIC_AUTH)', extraEnv: { BASIC_AUTH: 'qa:secret' } });
    const health = await api(svcC.base, '/api/health', { timeoutMs: 10000 });
    t.eq('/api/health 免认证 HTTP 状态', health.status, 200);
    t.eq('/api/health ok', health.json && health.json.ok, true);

    const noAuth = await api(svcC.base, '/api/history', { timeoutMs: 10000 });
    t.eq('无凭据 /api/history HTTP 状态', noAuth.status, 401);
    t.has('401 带 WWW-Authenticate', noAuth.headers.get('www-authenticate') || '', 'Basic');

    const rootNoAuth = await api(svcC.base, '/', { timeoutMs: 10000 });
    t.eq('无凭据 GET / HTTP 状态', rootNoAuth.status, 401);

    const bad = await api(svcC.base, '/api/history', { headers: { authorization: 'Basic ' + Buffer.from('qa:wrong').toString('base64') }, timeoutMs: 10000 });
    t.eq('错误凭据 HTTP 状态', bad.status, 401);

    const good = await api(svcC.base, '/api/history', { headers: { authorization: 'Basic ' + Buffer.from('qa:secret').toString('base64') }, timeoutMs: 10000 });
    t.eq('正确凭据 HTTP 状态', good.status, 200);
    t.eq('正确凭据 ok', good.json && good.json.ok, true);
  });

  /* ---- 13) 历史配置下载（§5 GET /api/history/:id/config） ---- */
  await runCase('13) GET /api/history/:id/config 历史配置下载', async (t) => {
    if (!histCtx.id) return t.assert('前置：存在一条由本轮扫描写入的历史记录', false);

    // a) 复用前面 scan 写入的历史 id：响应头与 body 都要与 §4.5 一致
    const hr = await api(svcA.base, '/api/history/' + encodeURIComponent(histCtx.id) + '/config', { timeoutMs: 20000 });
    t.eq('a) HTTP 状态', hr.status, 200);
    t.has('a) Content-Type 含 application/json', hr.headers.get('content-type') || '', 'application/json');
    const cd = hr.headers.get('content-disposition') || '';
    t.has('a) Content-Disposition 含 attachment', cd, 'attachment');
    t.assert('a) Content-Disposition 含 filename="ysc_config.json"（' + cd + '）',
      /filename\*?=(?:UTF-8'')?"?ysc_config\.json"?/i.test(cd), cd);

    let body = null;
    try { body = JSON.parse(hr.text); } catch { /* 非 JSON */ }
    t.ok('a) body 为可解析 JSON', !!body, hr.text.slice(0, 200));
    t.isArray('a) urls', body && body.urls, 1);

    // 与 /api/jobs/:id/config 内容一致（按 url 排序后深比较，忽略顺序差异）
    const normCfg = (o) => JSON.stringify((o && Array.isArray(o.urls) ? o.urls.slice() : [])
      .sort((x, y) => String(x && x.url).localeCompare(String(y && y.url))));
    const jobCfg = scanCtx.config;
    t.eq('a) urls 条数与 job config 一致', ((body && body.urls) || []).length, ((jobCfg && jobCfg.urls) || []).length);
    t.assert('a) 历史 config 与 /api/jobs/:id/config 深比较一致', normCfg(body) === normCfg(jobCfg),
      'history=' + normCfg(body) + '  job=' + normCfg(jobCfg));
    t.info('history config urls: ' + (normCfg(body) || '').slice(0, 400));

    // b) 不存在的历史 id
    const miss = await api(svcA.base, '/api/history/h_doesnotexist/config', { timeoutMs: 15000 });
    t.eq('b) 未知历史 id HTTP 状态', miss.status, 404);
    t.eq('b) 未知历史 id error', miss.json && miss.json.error, 'not_found');
    t.eq('b) 未知历史 id ok', miss.json && miss.json.ok, false);

    // c) 删除历史后 → 明细与配置下载都应 404 not_found，列表清空
    const del = await api(svcA.base, '/api/history/' + encodeURIComponent(histCtx.id), { method: 'DELETE', timeoutMs: 15000 });
    t.eq('c) DELETE HTTP 状态', del.status, 200);
    t.eq('c) DELETE ok', del.json && del.json.ok, true);

    const after = await api(svcA.base, '/api/history', { timeoutMs: 15000 });
    const items2 = (after.json && after.json.items) || [];
    t.assert('c) 删除后列表中不再包含该记录', !items2.some((x) => x && x.id === histCtx.id), JSON.stringify(items2).slice(0, 300));
    t.eq('c) 删除后列表为空', items2.length, 0);

    const goneDetail = await api(svcA.base, '/api/history/' + encodeURIComponent(histCtx.id), { timeoutMs: 15000 });
    t.assert('c) 删除后 /api/history/:id 返回 404 not_found（' + goneDetail.status + '）',
      goneDetail.status === 404 && goneDetail.json && goneDetail.json.error === 'not_found', 'status=' + goneDetail.status + ' body=' + goneDetail.text.slice(0, 200));

    const goneCfg = await api(svcA.base, '/api/history/' + encodeURIComponent(histCtx.id) + '/config', { timeoutMs: 15000 });
    t.assert('c) 删除后 /api/history/:id/config 返回 404 not_found（' + goneCfg.status + '）',
      goneCfg.status === 404 && goneCfg.json && goneCfg.json.error === 'not_found', 'status=' + goneCfg.status + ' body=' + goneCfg.text.slice(0, 200));
  });

  /* ---- 14) cleanSourceUrl 单元级清洗（离线，直接 import src/util.mjs） ---- */
  await runCase('14) cleanSourceUrl 清洗（单元级）', async (t) => {
    let mod;
    try {
      mod = await import(new URL('../src/util.mjs', import.meta.url).href);
    } catch (e) {
      return t.assert('可导入 src/util.mjs', false, String((e && e.message) || e));
    }
    const fn = mod && mod.cleanSourceUrl;
    t.eq('导出 cleanSourceUrl 为函数', typeof fn, 'function');
    if (typeof fn !== 'function') return;

    const cases = [
      // [输入, 期望, 说明]
      ['https://gh-proxy.com/raw.githubusercontent.com/a/b.json', 'https://raw.githubusercontent.com/a/b.json', '代理前缀 + 无第二段协议（曾丢失协议头的缺陷）'],
      ['https://gh-proxy.com/https://raw.githubusercontent.com/a/b.json', 'https://raw.githubusercontent.com/a/b.json', '代理前缀 + 双段协议'],
      ['https://ghproxy.net/https://raw.githubusercontent.com/a/b.json', 'https://raw.githubusercontent.com/a/b.json', 'ghproxy.net 代理'],
      ['https://github.moeyy.xyz/https://raw.githubusercontent.com/a/b.json', 'https://raw.githubusercontent.com/a/b.json', 'moeyy 代理（新增白名单）'],
      ['https://raw.githubusercontent.com/a/b.json', 'https://raw.githubusercontent.com/a/b.json', '普通地址原样保留'],
      ['http://plain.example/tv', 'http://plain.example/tv', '不能把 http 强改成 https'],
      ['//raw.githubusercontent.com/a/b.json', 'https://raw.githubusercontent.com/a/b.json', '协议相对地址补 https'],
      ['', '', '空串原样返回'],
    ];
    for (const [input, expected, why] of cases) {
      t.eq('cleanSourceUrl(' + JSON.stringify(input) + ') —— ' + why, fn(input), expected);
    }

    // 不变量：任何非空输出都必须以 http(s):// 开头（导出配置可用性的底线）
    const probe = [
      'https://gh-proxy.com/raw.githubusercontent.com/x/y.json',
      'https://ghproxy.cc/https://raw.githubusercontent.com/x/y.json',
      'https://gh.api.99988866.xyz/https://raw.githubusercontent.com/x/y.json',
      '//raw.githubusercontent.com/x/y.json',
      'http://plain.example/tv',
      '   https://gh-proxy.com/raw.githubusercontent.com/x/y.json   ',
    ];
    const bad = probe.map((u) => [u, fn(u)]).filter(([, out]) => out !== '' && !/^https?:\/\//i.test(out));
    t.assert('非空输出一律以 http(s):// 开头', bad.length === 0, JSON.stringify(bad).slice(0, 400));
    t.eq('首尾空白会被 trim', fn('   https://gh-proxy.com/raw.githubusercontent.com/x/y.json   '), 'https://raw.githubusercontent.com/x/y.json');
  });

  /* ---- 汇总 ---- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const wallMs = Date.now() - startWall;
  log('');
  log('=== 汇总 ===');
  for (const r of results) log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + '  (' + r.ms + 'ms)');
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  log('');
  log('用例: ' + results.length + '  通过: ' + passed + '  失败: ' + failed + '  总耗时: ' + totalMs + 'ms  墙钟: ' + wallMs + 'ms');
  // 纯本地 fixture，不应触碰外网：整体应在数十秒内完成
  log('离线判定: 墙钟 ' + wallMs + 'ms ' + (wallMs < 45000 ? '（符合离线预期 <45s）' : '（偏慢：检查是否访问了外网）'));
  if (wallMs >= 45000) failed2 = true;
  log(failed === 0 && !failed2 ? '结果: ALL PASS ✅' : '结果: FAILED ❌');
  process.exitCode = (failed === 0 && !failed2) ? 0 : 1;
}

let cleanupDone = false;
async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  for (const t of pendingTimers) clearTimeout(t);
  pendingTimers.clear();
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch (e) { log('[cleanup] ' + ((e && e.message) || e)); }
  }
}

const hardWatchdog = setTimeout(async () => {
  log('\n[看门狗] 测试超过 240s 未结束，强制退出');
  await cleanup();
  process.exit(1);
}, 240000);
hardWatchdog.unref();

try {
  await main();
} catch (e) {
  log('\n[致命错误] ' + ((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  await cleanup();
}
