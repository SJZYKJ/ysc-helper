/**
 * 历史持久化：DATA_DIR/history/<id>.json + DATA_DIR/history/index.json 索引。
 * 最多保留 MAX_HISTORY 条，超出删最旧（同时删文件）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomId } from './util.mjs';

const ID_RE = /^h_[a-z0-9]+$/;

function isSummary(x) {
  return !!x && typeof x === 'object' && ID_RE.test(String(x.id));
}

function summaryOf(rec) {
  const s = rec && rec.stats ? rec.stats : {};
  return {
    id: String(rec.id),
    t: Number(rec.t) || 0,
    count: Number(rec.count) || (Array.isArray(rec.verdicts) ? rec.verdicts.length : 0),
    available: Number(rec.available) || Number(s.available) || 0,
    multis: Number(rec.multis) || Number(s.multis) || 0,
    elapsedMs: Number(rec.elapsedMs) || 0
  };
}

/**
 * @param {{dataDir:string, maxHistory?:number, logger?:Console}} options
 */
export function createStore(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || 'data');
  const histDir = path.join(dataDir, 'history');
  const indexFile = path.join(histDir, 'index.json');
  const maxHistory = Math.max(1, Number(opts.maxHistory) || 20);
  const log = opts.logger || console;

  let items = [];
  let ready = false;
  let queue = Promise.resolve();

  function enqueue(fn) {
    const p = queue.then(fn, fn);
    queue = p.then(() => undefined, () => undefined);
    return p;
  }

  function fileFor(id) {
    return path.join(histDir, id + '.json');
  }

  async function persistIndex() {
    const tmp = indexFile + '.' + randomId(6) + '.tmp';
    const body = JSON.stringify({ v: 1, items }, null, 1);
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, indexFile);
  }

  async function loadIndexFile() {
    try {
      const obj = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
      if (obj && Array.isArray(obj.items)) return obj.items.filter(isSummary);
    } catch (e) { /* 索引缺失/损坏则重建 */ }
    return null;
  }

  async function rebuildIndex() {
    const names = await fsp.readdir(histDir);
    const list = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const rec = JSON.parse(await fsp.readFile(path.join(histDir, name), 'utf8'));
        list.push(summaryOf(rec));
      } catch (e) {
        log.warn('[store] 忽略损坏的历史文件：' + name);
      }
    }
    return list;
  }

  async function prune() {
    try {
      const names = await fsp.readdir(histDir);
      const keep = new Set(items.map(i => i.id));
      for (const name of names) {
        if (!name.endsWith('.json') || name === 'index.json') continue;
        const id = name.slice(0, -5);
        if (ID_RE.test(id) && !keep.has(id)) {
          await fsp.unlink(path.join(histDir, name)).catch(() => undefined);
        }
      }
    } catch (e) { /* ignore */ }
  }

  /** 初始化：建目录、载入/重建索引、按上限修剪 */
  async function init() {
    await fsp.mkdir(histDir, { recursive: true });
    let list = await loadIndexFile();
    if (!list) list = await rebuildIndex();
    list.sort((a, b) => b.t - a.t);
    items = list.slice(0, maxHistory);
    ready = true;
    await prune();
    await persistIndex().catch(() => undefined);
    return { dataDir, histDir, count: items.length };
  }

  /** 新增一条历史（串行化，避免并发写坏索引） */
  function add(record) {
    return enqueue(async () => {
      const rec = record || {};
      const id = 'h_' + randomId(10);
      const t = Number(rec.t) || Date.now();
      const full = {
        id, t,
        count: Number(rec.count) || (Array.isArray(rec.verdicts) ? rec.verdicts.length : 0),
        available: Number(rec.available) || 0,
        multis: Number(rec.multis) || 0,
        elapsedMs: Number(rec.elapsedMs) || 0,
        verdicts: Array.isArray(rec.verdicts) ? rec.verdicts : [],
        config: rec.config && typeof rec.config === 'object' ? rec.config : { urls: [] },
        stats: rec.stats && typeof rec.stats === 'object' ? rec.stats : {}
      };
      await fsp.writeFile(fileFor(id), JSON.stringify(full), 'utf8');
      items = [summaryOf(full), ...items].sort((a, b) => b.t - a.t);
      const dropped = items.slice(maxHistory);
      items = items.slice(0, maxHistory);
      await Promise.all(dropped.map(d => fsp.unlink(fileFor(d.id)).catch(() => undefined)));
      await persistIndex();
      return id;
    });
  }

  /** 列表（t 倒序） */
  async function list() {
    if (!ready) return [];
    return items.slice().sort((a, b) => b.t - a.t).map(x => Object.assign({}, x));
  }

  /** 取一条完整记录 */
  async function read(id) {
    id = String(id || '');
    if (!ID_RE.test(id)) return null;
    try {
      const rec = JSON.parse(await fsp.readFile(fileFor(id), 'utf8'));
      if (!rec || rec.id !== id) return null;
      return rec;
    } catch (e) {
      return null;
    }
  }

  /** 删除一条 */
  function remove(id) {
    return enqueue(async () => {
      id = String(id || '');
      if (!ID_RE.test(id)) return false;
      const existed = items.some(x => x.id === id);
      let unlinked = false;
      try { await fsp.unlink(fileFor(id)); unlinked = true; } catch (e) { /* 文件不存在 */ }
      if (!existed && !unlinked) return false;
      items = items.filter(x => x.id !== id);
      await persistIndex();
      return true;
    });
  }

  return { init, add, list, read, remove, dirs: () => ({ dataDir, histDir }), maxHistory };
}
