/**
 * 抓取层：带 TTFB / 总耗时 / 大小计时 + 超时 + 4MiB 截断 + SSRF 防护 + 全局并发信号量。
 * /api/proxy 与扫描流程共用本函数（不写两份逻辑）。
 *
 * 与 APK 原生桥对齐（dex 里只有 UA 字符串，走的是 HttpURLConnection）：
 *   - 默认请求头 User-Agent: okhttp/4.12.0，可用 FETCH_UA 覆盖
 *   - 返回字段 ok / status / body / ttfb_ms / total_ms / size_kb / final_url / error
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { Semaphore, clampInt, round } from './util.mjs';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_UA = 'okhttp/4.12.0';
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function intEnv(name, dflt, min, max) {
  const v = process.env[name];
  const n = v == null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 全局抓取并发上限（SCAN_CONCURRENCY）；任务内 concurrency 只能更小 */
export const fetchSemaphore = new Semaphore(intEnv('SCAN_CONCURRENCY', 8, 1, 64));

/** 默认单次抓取超时（REQUEST_TIMEOUT_MS） */
export const DEFAULT_TIMEOUT_MS = intEnv('REQUEST_TIMEOUT_MS', 8000, 1000, 60000);

export function allowPrivateTargets() {
  return process.env.ALLOW_PRIVATE_TARGETS === '1';
}

/* ============================ SSRF 防护 ============================ */

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8],       // 本网络
  ['10.0.0.0', 8],      // 私网
  ['100.64.0.0', 10],   // CGNAT
  ['127.0.0.0', 8],     // 回环
  ['169.254.0.0', 16],  // 链路本地
  ['172.16.0.0', 12],   // 私网
  ['192.0.0.0', 24],    // IETF 协议分配
  ['192.0.2.0', 24],    // TEST-NET-1
  ['192.88.99.0', 24],  // 6to4 中继
  ['192.168.0.0', 16],  // 私网
  ['198.18.0.0', 15],   // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24],  // TEST-NET-3
  ['224.0.0.0', 4],     // 组播
  ['240.0.0.0', 4]      // 保留
].map(([ip, bits]) => {
  const base = ipv4ToInt(ip);
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return [(base & mask) >>> 0, mask];
});

/** 是否为私网/回环/链路本地/保留地址 */
export function isBlockedIp(ip) {
  if (!ip) return true;
  let s = String(ip).trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const ver = net.isIP(s);
  if (ver === 4) {
    const n = ipv4ToInt(s);
    for (const pair of V4_BLOCKED) {
      if (((n & pair[1]) >>> 0) === pair[0]) return true;
    }
    return false;
  }
  if (ver === 6) {
    const low = s.toLowerCase();
    if (low === '::' || low === '::1') return true;
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (/^f[cd]/.test(low)) return true;          // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(low)) return true;       // fe80::/10 链路本地
    if (/^ff/.test(low)) return true;             // 组播
    return false;
  }
  return true;
}

const BLOCKED_MESSAGE = '目标地址为内网/保留地址，已拒绝';

/**
 * 校验目标主机是否允许抓取。
 * @returns {Promise<{ok:boolean, error?:string, message?:string, resolved?:string[]}>}
 */
export async function assertTargetAllowed(hostname) {
  const bare = String(hostname || '').replace(/^\[/, '').replace(/\]$/, '').trim().toLowerCase();
  if (!bare) return { ok: false, error: 'bad_request', message: '缺少主机名' };
  if (allowPrivateTargets()) return { ok: true, resolved: [] };
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
    return { ok: false, error: 'blocked_target', message: BLOCKED_MESSAGE };
  }
  if (net.isIP(bare)) {
    if (isBlockedIp(bare)) return { ok: false, error: 'blocked_target', message: BLOCKED_MESSAGE };
    return { ok: true, resolved: [bare] };
  }
  let list;
  try {
    list = await dns.lookup(bare, { all: true, verbatim: true });
  } catch (e) {
    return { ok: false, error: 'upstream_error', message: '域名解析失败：' + bare };
  }
  if (!list || !list.length) return { ok: false, error: 'upstream_error', message: '域名解析失败：' + bare };
  for (const a of list) {
    if (isBlockedIp(a.address)) return { ok: false, error: 'blocked_target', message: BLOCKED_MESSAGE };
  }
  return { ok: true, resolved: list.map(a => a.address) };
}

/* ============================ 抓取实现 ============================ */

function buildHeaders(extra) {
  const h = {
    'User-Agent': process.env.FETCH_UA || DEFAULT_UA,
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate'
  };
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (v != null) h[k] = String(v);
    }
  }
  return h;
}

function describeError(e) {
  if (!e) return 'unknown error';
  const cause = e.cause;
  const code = (cause && (cause.code || cause.name)) || e.code || e.name || '';
  const msg = (cause && cause.message) || e.message || String(e);
  return code && !String(msg).includes(String(code)) ? code + ': ' + msg : String(msg);
}

/** 读取响应体，最多 maxBytes 字节 */
async function readCapped(resp, maxBytes) {
  if (!resp.body) return { bytes: 0, text: '', truncated: false };
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    const value = step.value;
    if (!value || !value.byteLength) continue;
    if (total + value.byteLength > maxBytes) {
      const remain = maxBytes - total;
      if (remain > 0) chunks.push(value.subarray(0, remain));
      total = maxBytes;
      truncated = true;
      try { await reader.cancel(); } catch (e) { /* ignore */ }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return { bytes: buf.length, text: buf.toString('utf8'), truncated };
}

/**
 * 抓取一个地址。
 * @param {string} rawUrl
 * @param {{timeoutMs?:number, signal?:AbortSignal, maxBytes?:number, maxRedirects?:number, headers?:object}} [options]
 * @returns {Promise<{ok:boolean,status:number|null,body:string,final_url:string,ttfb_ms:number|null,
 *   total_ms:number|null,size_kb:number|null,content_type:string,truncated:boolean,error:string|null,message:string}>}
 */
export async function fetchTarget(rawUrl, options) {
  const opts = options || {};
  const timeoutMs = clampInt(opts.timeoutMs, 1, 60000, DEFAULT_TIMEOUT_MS);
  const maxBytes = clampInt(opts.maxBytes, 1024, 64 * 1024 * 1024, MAX_BODY_BYTES);
  const maxRedirects = clampInt(opts.maxRedirects, 0, 10, 5);
  const externalSignal = opts.signal || null;

  const out = {
    ok: false, status: null, body: '', final_url: String(rawUrl == null ? '' : rawUrl),
    ttfb_ms: null, total_ms: null, size_kb: null, content_type: '', truncated: false,
    error: null, message: ''
  };

  let target;
  try {
    target = new URL(String(rawUrl == null ? '' : rawUrl).trim());
  } catch (e) {
    out.error = 'bad_request';
    out.message = '无效地址';
    return out;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    out.error = 'bad_request';
    out.message = '仅支持 http/https 地址';
    return out;
  }
  out.final_url = target.href;
  if (externalSignal && externalSignal.aborted) {
    out.error = 'aborted';
    out.message = '已取消';
    return out;
  }

  await fetchSemaphore.acquire();
  const t0 = performance.now();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { ctrl.abort(); } catch (e) { /* ignore */ }
  }, timeoutMs);
  const onExternalAbort = () => { try { ctrl.abort(); } catch (e) { /* ignore */ } };
  if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort);

  try {
    let current = target;
    for (let hop = 0; ; hop++) {
      const guard = await assertTargetAllowed(current.hostname);
      if (!guard.ok) {
        out.error = guard.error || 'blocked_target';
        out.message = guard.message || BLOCKED_MESSAGE;
        return out;
      }
      const resp = await fetch(current.href, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: buildHeaders(opts.headers)
      });
      const location = resp.headers.get('location');
      if (REDIRECT_CODES.has(resp.status) && location) {
        if (hop >= maxRedirects) {
          try { if (resp.body) await resp.body.cancel(); } catch (e) { /* ignore */ }
          out.error = 'upstream_error';
          out.message = '重定向次数过多';
          return out;
        }
        try { if (resp.body) await resp.body.cancel(); } catch (e) { /* ignore */ }
        let next;
        try { next = new URL(location, current.href); }
        catch (e) { out.error = 'upstream_error'; out.message = '重定向地址无效'; return out; }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          out.error = 'blocked_target';
          out.message = '重定向到非 http(s) 协议，已拒绝';
          return out;
        }
        current = next;
        continue;
      }

      const ttfbAt = performance.now();
      out.status = resp.status;
      out.final_url = resp.url || current.href;
      out.content_type = resp.headers.get('content-type') || '';
      const read = await readCapped(resp, maxBytes);
      const totalAt = performance.now();

      const ttfb = Math.max(0, ttfbAt - t0);
      const total = Math.max(0, totalAt - t0);
      let ttfbR = round(ttfb, 3);
      let totalR = round(total, 3);
      if (totalR == null) totalR = ttfbR;
      if (ttfbR == null) ttfbR = 0;
      if (!(totalR > ttfbR)) totalR = round(ttfbR + 0.001, 3);

      out.ttfb_ms = ttfbR;
      out.total_ms = totalR;
      out.size_kb = round(read.bytes / 1024, 3);
      out.truncated = read.truncated;
      out.body = read.text;
      out.ok = true;
      return out;
    }
  } catch (e) {
    if (timedOut) {
      out.error = 'timeout';
      out.message = '请求超时';
    } else if (externalSignal && externalSignal.aborted) {
      out.error = 'aborted';
      out.message = '已取消';
    } else {
      out.error = 'upstream_error';
      out.message = describeError(e);
    }
    out.total_ms = round(Math.max(0, performance.now() - t0), 3);
    return out;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    fetchSemaphore.release();
  }
}
