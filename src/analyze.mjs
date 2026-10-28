/**
 * 线路分析 / 测速 / 配置生成。
 * classify / subEntries / siteCount / analyzeUrl / verifyNode / gradeSpeed / median /
 * buildConfig / stats 全部从 reference/apk/assets/index.html 移植，语义保持一致。
 */
import { normalizeUrl, isHttpUrl, tryParseJson, median, mapLimit, cleanSourceUrl } from './util.mjs';
import { fetchTarget } from './fetcher.mjs';

/** 线路类型枚举（与 APK 的 T 一致） */
export const T = { single: 'single', store: 'multi_storehouse', urls: 'multi_urls', unknown: 'unknown' };
const SINGLE_KEYS = ['spider', 'sites', 'lives', 'parses'];

/** 单仓/多仓类型识别（原语义） */
export function classify(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return T.unknown;
  const sh = obj['storeHouse'];
  if (Array.isArray(sh) && sh.length && sh.some(x => x && x['sourceUrl'])) return T.store;
  const urls = obj['urls'];
  if (Array.isArray(urls) && urls.length && urls.some(x => x && x['url'])) return T.urls;
  if (SINGLE_KEYS.some(k => obj[k])) return T.single;
  return T.unknown;
}

/** 取出子仓 [name, url] 列表（原语义） */
export function subEntries(obj) {
  const out = [];
  const sh = obj['storeHouse'];
  if (Array.isArray(sh)) sh.forEach(x => { if (x && typeof x === 'object') out.push([x['sourceName'] || '', x['sourceUrl'] || '']); });
  const urls = obj['urls'];
  if (Array.isArray(urls)) urls.forEach(x => { if (x && typeof x === 'object') out.push([x['name'] || '', x['url'] || '']); });
  return out;
}

/** sites 数量（原语义） */
export function siteCount(obj) {
  return Array.isArray(obj && obj['sites']) ? obj['sites'].length : 0;
}

/** 速度分级：<500 快 / <2000 中 / <5000 慢 / 其余（含 null）不可用 */
export function gradeSpeed(totalMs) {
  if (totalMs == null) return '不可用';
  if (totalMs < 500) return '快';
  if (totalMs < 2000) return '中';
  if (totalMs < 5000) return '慢';
  return '不可用';
}

/**
 * 递归分析一个地址的结构（不测速）。
 * 与 APK 的 analyzeUrl(url, name, depth, parentUrl, seen, maxDepth, analyzeTimeout, onNode) 同签名，
 * 仅把 analyzeTimeout 的单位从「秒」改为「毫秒」。
 * @param {AbortSignal} [signal] 任务取消信号（可选，追加参数）
 */
export async function analyzeUrl(url, name, depth, parentUrl, seen, maxDepth, timeoutMs, onNode, signal) {
  const node = {
    url, name: name || '', kind: T.unknown, status: 'pending', error: '',
    ttfb_ms: null, total_ms: null, size_kb: null, speed_kbps: null, site_count: 0,
    children: [], depth, parent_url: parentUrl
  };
  const norm = normalizeUrl(url);
  if (!isHttpUrl(url)) { node.status = 'fail'; node.error = '无效地址'; return node; }
  if (seen.has(norm)) { node.status = 'fail'; node.error = '重复线路（已分析）'; return node; }
  seen.add(norm);
  if (onNode) onNode(node, '分析');

  const r = await fetchTarget(url, { timeoutMs: timeoutMs, signal: signal });
  node.ttfb_ms = r.ttfb_ms;
  node.total_ms = r.total_ms;
  node.size_kb = r.size_kb;
  node.speed_kbps = (r.ttfb_ms != null && r.total_ms != null && r.size_kb != null)
    ? r.size_kb / Math.max(r.total_ms - r.ttfb_ms, 1) * 1000
    : null;

  if (r.error) { node.status = 'fail'; node.error = r.message || r.error; return node; }
  if (r.status != null && r.status >= 400) { node.status = 'fail'; node.error = 'HTTP ' + r.status; return node; }

  const obj = tryParseJson(r.body);
  if (obj === null) { node.status = 'fail'; node.error = '响应不是有效 JSON'; return node; }

  node.kind = classify(obj);
  node.site_count = siteCount(obj);
  if (!node.name && obj && typeof obj === 'object') node.name = obj['name'] || node.name;

  if (node.kind === T.single) {
    node.status = 'ok';
  } else if (node.kind === T.store || node.kind === T.urls) {
    if (depth >= maxDepth) { node.status = 'fail'; node.error = '超过最大嵌套深度(' + maxDepth + ')'; return node; }
    const entries = subEntries(obj).filter(pair => isHttpUrl(pair[1])).slice(0, 100); // 单节点子仓上限 100
    node.children = await mapLimit(entries, 4, async (pair) =>
      await analyzeUrl(pair[1], pair[0], depth + 1, url, seen, maxDepth, timeoutMs, onNode, signal));
    node.status = 'ok';
  } else {
    node.status = 'fail';
    node.error = '结构不可识别（非单仓/多仓）';
  }
  return node;
}

/**
 * 测速 + 生成 verdict（children 递归）。
 * 与 APK verifyNode(node, samples, onNode) 同语义，追加 timeoutMs / signal。
 */
export async function verifyNode(node, samples, timeoutMs, onNode, signal) {
  const v = {
    url: node.url, name: node.name, kind: node.kind, available: false, speed_label: '不可用',
    ttfb_ms: node.ttfb_ms, total_ms: node.total_ms, size_kb: node.size_kb, speed_kbps: node.speed_kbps,
    site_count: node.site_count, error: node.error, depth: node.depth, parent_url: node.parent_url,
    children: []
  };
  if (node.status !== 'ok') {
    v.error = node.error || '线路不可用';
    if (onNode) onNode(node);
    v.children = await mapLimit(node.children, 4, c => verifyNode(c, samples, timeoutMs, onNode, signal));
    return v;
  }
  const ttfb = [];
  const total = [];
  const size = [];
  let ok = false;
  for (let i = 0; i < Math.max(1, samples); i++) {
    const r = await fetchTarget(node.url, { timeoutMs: timeoutMs, signal: signal });
    if (r.ok && !r.error) ok = true;
    ttfb.push(r.ttfb_ms);
    total.push(r.total_ms);
    size.push(r.size_kb);
  }
  v.available = ok;
  v.ttfb_ms = median(ttfb);
  v.total_ms = median(total);
  v.size_kb = median(size);
  if (v.total_ms != null && v.ttfb_ms != null && v.size_kb != null) {
    v.speed_kbps = v.size_kb / Math.max(v.total_ms - v.ttfb_ms, 1) * 1000;
  }
  v.speed_label = gradeSpeed(v.total_ms);
  if (onNode) onNode(node);
  v.children = await mapLimit(node.children, 4, c => verifyNode(c, samples, timeoutMs, onNode, signal));
  return v;
}

/** 遍历 verdict 树中所有节点（含自身） */
export function walkVerdicts(verdicts) {
  const out = [];
  const go = (v) => { out.push(v); (v.children || []).forEach(go); };
  (verdicts || []).forEach(go);
  return out;
}

/** analyze 树节点计数（含自身） */
export function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((s, c) => s + countNodes(c), 0);
}

/** 导出影视仓兼容配置：只取 available 叶节点，清洗 URL，按 total_ms 升序去重（原语义） */
export function buildConfig(verdicts) {
  const seen = new Set();
  const entries = [];
  const leaves = [];
  const walk = (v) => {
    if (v.kind === T.store || v.kind === T.urls) (v.children || []).forEach(walk);
    else if (v.available) leaves.push(v);
  };
  (verdicts || []).forEach(walk);
  leaves.forEach(l => {
    const url = cleanSourceUrl(l.url);
    const norm = normalizeUrl(url);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    entries.push({ _t: l.total_ms, _n: l.name || url, _u: url });
  });
  entries.sort((a, b) => (a._t == null ? 1 : 0) - (b._t == null ? 1 : 0)
    || ((a._t == null ? Infinity : a._t) - (b._t == null ? Infinity : b._t)));
  return { urls: entries.map(e => ({ name: e._n, url: e._u })) };
}

/** 统计（原语义 + has_avail 供前端判断下载按钮可用性） */
export function stats(verdicts) {
  const all = walkVerdicts(verdicts);
  const avail = all.filter(v => v.available);
  const speeds = all.map(v => v.total_ms).filter(x => x != null);
  return {
    total: (verdicts || []).length,
    available: avail.length,
    singles: all.filter(v => v.kind === T.single && v.available).length,
    multis: all.filter(v => (v.kind === T.store || v.kind === T.urls) && v.available).length,
    avg_speed: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null,
    has_avail: avail.length > 0
  };
}
