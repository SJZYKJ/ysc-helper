/**
 * 通用工具。
 * 其中 normalizeUrl / isHttpUrl / tryParseJson / median / mapLimit / cleanSourceUrl
 * 全部从 reference/apk/assets/index.html 原样移植，语义保持一致，不要重新发明规则。
 */
import { randomBytes } from 'node:crypto';

/** 标准化 URL：去尾部斜杠、路径小写（仅用于去重比较，不用于请求） */
export function normalizeUrl(url) {
  url = (url || '').trim();
  if (!url) return url;
  const i = url.indexOf('://');
  if (i < 0) return url;
  const scheme = url.slice(0, i);
  const rest = url.slice(i + 3).replace(/\/+$/, '');
  const slash = rest.indexOf('/');
  if (slash < 0) return scheme + '://' + rest;
  return scheme + '://' + rest.slice(0, slash) + '/' + rest.slice(slash + 1).toLowerCase();
}

/** 是否为合法的 http/https 地址（APK 原语义：host 必须含点） */
export function isHttpUrl(url) {
  url = (url || '').trim();
  if (!url) return false;
  const i = url.indexOf('://');
  if (i < 0) return false;
  const s = url.slice(0, i).toLowerCase();
  if (s !== 'http' && s !== 'https') return false;
  const host = url.slice(i + 3).split('/')[0];
  return !!host && host.includes('.');
}

/** 宽松 JSON 解析：剥 BOM、剥首行 // 注释、容错失败返回 null（APK 原语义） */
export function tryParseJson(text) {
  if (!text) return null;
  text = text.replace(/^\uFEFF/, '').trim();
  if (text.startsWith('//')) {
    const b = text.indexOf('{');
    const a = text.indexOf('[');
    const s = (a < 0 ? b : b < 0 ? a : Math.min(a, b));
    if (s < 0) return null;
    text = text.slice(s);
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** 中位数（忽略 null） */
export function median(arr) {
  const v = arr.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** 并发受限的 map（保持输入顺序返回） */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  const n = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/**
 * 清洗 sourceUrl：剥离 GitHub 代理前缀、修正双重协议，供影视仓直接加载。
 * 与原 APK 的 cleanSourceUrl 语义一致，但修掉一个继承来的缺陷：
 *   原地址 https://gh-proxy.com/raw.githubusercontent.com/a/b.json（代理后不带第二段协议）
 *   剥离前缀后只剩 "raw.githubusercontent.com/a/b.json"，原实现直接返回，导出的配置项无协议头、
 *   影视仓无法加载。这里在剥离后补回 https://。
 */
export function cleanSourceUrl(u) {
  u = (u || '').trim();
  if (!u) return u;
  const proxyRe = /^https?:\/\/[^\/]*?(gh-proxy\.com|ghproxy\.net|ghproxy\.com|ghproxy\.cc|ghfast\.top|gh\.proxy\.ustclug\.org|mirror\.ghproxy\.com|github\.moeyy\.xyz|gh\.api\.99988866\.xyz)\//i;
  const before = u;
  u = u.replace(proxyRe, '');
  u = u.replace(/^https?:\/\/https?:\/\//i, 'https://');
  if (u.startsWith('//')) u = 'https:' + u;                       // 协议相对地址
  else if (u !== before && !/^https?:\/\//i.test(u)) u = 'https://' + u;  // 代理剥离后只剩主机/路径
  return u;
}

/** 宽松布尔解析：true/'true'/1/'1'/'yes' 等视为 true；只有明确假值才是 false */
export function toBoolLoose(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'null', 'undefined'].includes(s)) return false;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  return dflt;
}

/** 整数截断并夹在 [min,max] 内；非法值返回默认值 */
export function clampInt(v, min, max, dflt) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v.trim());
  else n = NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 保留 digits 位小数 */
export function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return v == null ? v : null;
  const d = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(v * d) / d;
}

/** 随机 id 片段（小写十六进制） */
export function randomId(len) {
  const n = Math.max(1, Number(len) || 8);
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms == null ? 0 : ms));

/** 简易全局信号量（抓取并发上限），无第三方依赖 */
export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
  stats() { return { limit: this.limit, active: this.active, waiting: this.queue.length }; }
}
