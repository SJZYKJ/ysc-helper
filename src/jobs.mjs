/**
 * 任务（job）管理：扫描流程编排 + 进度事件总线 + 取消 + 30 分钟回收。
 * 扫描流程与 APK 一致：
 *   collecting（baseLines + extraSources + 聚合页 extractUrls 去重）
 *   → analyzing（递归展开，depth<=maxDepth，子仓上限 100）
 *   → verifying（samples 次采样取中位数，speed_label 阈值 500/2000/5000）
 *   → building（buildConfig 只取 available 叶节点、cleanSourceUrl、按 total_ms 升序去重）
 */
import { fetchTarget } from './fetcher.mjs';
import { analyzeUrl, verifyNode, buildConfig, stats, countNodes, T } from './analyze.mjs';
import { extractUrls } from './sources.mjs';
import { normalizeUrl, isHttpUrl, mapLimit, clampInt, randomId } from './util.mjs';

const JOB_RETENTION_MS = 30 * 60 * 1000;   // 任务结束后保留 30 分钟
const PING_INTERVAL_MS = 15000;           // SSE 保活
const MAX_SUBS = 50;                      // 单任务订阅者上限

/**
 * @param {{sources:object, store?:object, logger?:Console, maxRunningJobs?:number}} options
 */
export function createJobManager(options) {
  const opts = options || {};
  const sources = opts.sources || { baseLines: [], searchPages: [] };
  const store = opts.store || null;
  const log = opts.logger || console;
  const maxRunning = Math.max(1, clampInt(opts.maxRunningJobs, 1, 128, 8));
  const jobs = new Map();

  function get(id) {
    id = String(id || '');
    return jobs.get(id) || null;
  }

  function runningCount() {
    let n = 0;
    for (const j of jobs.values()) if (j.state === 'running') n++;
    return n;
  }

  function writeEvent(sub, event, data) {
    try {
      sub.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    } catch (e) { /* 客户端已断开 */ }
  }

  function broadcast(job, event, data) {
    for (const sub of job.subs) writeEvent(sub, event, data);
  }

  function emitProgress(job, p) {
    if (job.state !== 'running') return;
    job.progress = p;
    broadcast(job, 'progress', p);
  }

  function emitLog(job, level, msg) {
    if (job.state !== 'running') return;
    broadcast(job, 'log', { level, msg });
  }

  /** 结束所有订阅并安排回收 */
  function settle(job) {
    for (const sub of job.subs) {
      clearInterval(sub.ping);
      try { sub.res.end(); } catch (e) { /* ignore */ }
    }
    job.subs.clear();
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.cleanupTimer = setTimeout(() => {
      jobs.delete(job.id);
      log.log('[jobs] 回收任务 ' + job.id);
    }, JOB_RETENTION_MS);
    if (job.cleanupTimer.unref) job.cleanupTimer.unref();
  }

  /**
   * 创建并启动任务。
   * @param {object} params 已归一化的扫描参数
   * @returns {{ok:true, job:object} | {ok:false, error:string, message:string}}
   */
  function create(params) {
    if (runningCount() >= maxRunning) {
      return { ok: false, error: 'rate_limited', message: '同时运行的任务过多（上限 ' + maxRunning + '），请稍后再试' };
    }
    const id = 'j_' + randomId(8);
    const job = {
      id,
      state: 'running',
      createdAt: Date.now(),
      finishedAt: null,
      progress: { stage: 'collecting', cur: 0, total: 0, info: '' },
      error: null,
      result: null,
      params,
      historyId: null,
      subs: new Set(),
      aborter: new AbortController(),
      cleanupTimer: null
    };
    jobs.set(id, job);
    log.log('[jobs] 创建任务 ' + id + ' 参数=' + JSON.stringify(params));
    run(job).catch((e) => {
      log.error('[jobs] 任务 ' + id + ' 未捕获异常：' + (e && e.stack ? e.stack : String(e)));
    });
    return { ok: true, job };
  }

  /** 订阅 SSE；已结束的任务会先发 hello 再补 done/error 后关闭 */
  function subscribe(job, req, res) {
    if (job.subs.size >= MAX_SUBS) {
      try { res.statusCode = 429; } catch (e) { /* ignore */ }
      return false;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const sub = { res, ping: null };
    writeEvent(sub, 'hello', { jobId: job.id, state: job.state, progress: job.progress });

    if (job.state !== 'running') {
      if (job.state === 'done') writeEvent(sub, 'done', job.result);
      else if (job.state === 'error') writeEvent(sub, 'error', job.error || { ok: false, error: 'internal_error', message: '任务失败' });
      else writeEvent(sub, 'error', { ok: false, error: 'internal_error', message: '任务已取消' });
      try { res.end(); } catch (e) { /* ignore */ }
      return true;
    }

    job.subs.add(sub);
    sub.ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, PING_INTERVAL_MS);
    if (sub.ping.unref) sub.ping.unref();

    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      clearInterval(sub.ping);
      job.subs.delete(sub);
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
    return true;
  }

  /** 取消任务：立刻置 cancelled、abort 在途抓取、广播 error 并收尾 */
  function cancel(job) {
    if (job.state !== 'running') return job.state;
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    job.error = { ok: false, error: 'internal_error', message: '任务已取消' };
    try { job.aborter.abort(); } catch (e) { /* ignore */ }
    emitLog(job, 'warn', '任务已取消');   // emitLog 只在 running 时生效，此处不会发出
    broadcast(job, 'error', job.error);
    settle(job);
    log.log('[jobs] 取消任务 ' + job.id);
    return job.state;
  }

  /** 汇总待测线路：baseLines / extraSources / 聚合页 extractUrls 三者取并集去重 */
  async function collect(job, signal, throwIfCancelled) {
    const params = job.params;
    const lines = [];
    const seen = new Set();
    const push = (n, u) => {
      u = String(u == null ? '' : u).trim();
      if (!isHttpUrl(u) || seen.has(normalizeUrl(u))) return;
      seen.add(normalizeUrl(u));
      lines.push({ name: n || '', url: u });
    };

    if (params.includeBaseLines) {
      for (const pair of sources.baseLines || []) push(pair[0], pair[1]);
    }
    for (const raw of params.extraSources || []) {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) continue;
      const idx = s.indexOf('|');
      if (idx > 0) push(s.slice(0, idx).trim(), s.slice(idx + 1).trim());
      else push('', s);
    }

    if (!params.useSearchPages) {
      emitProgress(job, { stage: 'collecting', cur: 1, total: 1, info: '已跳过聚合页抓取（includeBaseLines=' + params.includeBaseLines + '）' });
      return lines;
    }

    const pages = (sources.searchPages || []).map((u, i) => ({ u, i }));
    const total = pages.length;
    let cur = 0;
    emitProgress(job, { stage: 'collecting', cur: 0, total, info: '正在抓取聚合页搜集线路' });
    await mapLimit(pages, Math.min(4, params.concurrency), async (page) => {
      throwIfCancelled();
      const r = await fetchTarget(page.u, { timeoutMs: params.pageTimeoutMs, signal });
      if (r.ok && r.body) {
        for (const u of extractUrls(r.body)) push('', u);
      }
      cur++;
      emitProgress(job, { stage: 'collecting', cur, total, info: page.u });
    });
    emitProgress(job, { stage: 'collecting', cur: total, total, info: '去重整理线路：' + lines.length + ' 条' });
    return lines;
  }

  async function run(job) {
    const startedAt = Date.now();
    const params = job.params;
    const signal = job.aborter.signal;
    const throwIfCancelled = () => {
      if (job.state === 'cancelled' || signal.aborted) {
        const e = new Error('任务已取消');
        e.code = 'cancelled';
        throw e;
      }
    };

    try {
      emitLog(job, 'info', '任务参数：' + JSON.stringify(params));
      const lines = await collect(job, signal, throwIfCancelled);
      throwIfCancelled();
      emitLog(job, 'info', '搜集到 ' + lines.length + ' 条待测线路');

      // ---- analyzing：递归展开结构 ----
      const seen = new Set();
      let aDone = 0;
      emitProgress(job, { stage: 'analyzing', cur: 0, total: lines.length, info: '并发抓取中...' });
      const nodes = await mapLimit(lines, params.concurrency, async (line) => {
        throwIfCancelled();
        const node = await analyzeUrl(line.url, line.name, 0, '', seen, params.maxDepth, params.timeoutMs, null, signal);
        aDone++;
        emitProgress(job, { stage: 'analyzing', cur: aDone, total: lines.length, info: line.url });
        return node;
      });
      throwIfCancelled();

      // ---- verifying：samples 次采样取中位数 ----
      const totalNodes = nodes.reduce((s, n) => s + countNodes(n), 0);
      let vDone = 0;
      emitProgress(job, { stage: 'verifying', cur: 0, total: totalNodes, info: '并发测速中...' });
      const onNode = (node) => {
        vDone++;
        emitProgress(job, { stage: 'verifying', cur: vDone, total: totalNodes, info: node.url });
      };
      const verdicts = await mapLimit(nodes, params.concurrency, async (n) => {
        throwIfCancelled();
        return await verifyNode(n, params.samples, params.timeoutMs, onNode, signal);
      });
      throwIfCancelled();

      // ---- building：生成影视仓配置 ----
      emitProgress(job, { stage: 'building', cur: 0, total: 1, info: '生成配置中...' });
      const config = buildConfig(verdicts);
      const finishedAt = Date.now();
      const result = {
        verdicts,
        config,
        stats: stats(verdicts),
        startedAt,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
        lines: lines.length
      };
      // 历史先落盘，再发 done：保证客户端「收到 done ⇒ GET /api/history 立刻可查」，
      // 且 done 事件里带出的 job.historyId 已就绪。写失败只打日志，不影响扫描结果。
      if (store) {
        try {
          job.historyId = await store.add({
            t: finishedAt,
            count: verdicts.length,
            available: result.stats.available,
            multis: result.stats.multis,
            elapsedMs: result.elapsedMs,
            verdicts,
            config,
            stats: result.stats
          });
        } catch (e) {
          log.warn('[jobs] 历史写入失败（不影响扫描结果）：' + (e && e.message ? e.message : String(e)));
        }
      }
      // 落盘期间可能被 cancel()：此时任务已收尾，不能再翻回 done
      if (job.state !== 'running') return;

      emitProgress(job, { stage: 'done', cur: 1, total: 1, info: '' });
      job.result = result;
      job.state = 'done';
      job.finishedAt = finishedAt;
      broadcast(job, 'done', result);
      settle(job);
      log.log('[jobs] 任务完成 ' + job.id + ' 顶层=' + verdicts.length + ' 可用=' + result.stats.available + ' 耗时=' + result.elapsedMs + 'ms' + (job.historyId ? ' 历史=' + job.historyId : ''));
    } catch (e) {
      if (job.state !== 'running') return;   // 已被 cancel() 收尾
      job.state = 'error';
      job.finishedAt = Date.now();
      job.error = { ok: false, error: 'internal_error', message: (e && e.message) || '任务执行失败' };
      broadcast(job, 'error', job.error);
      settle(job);
      log.error('[jobs] 任务失败 ' + job.id + '：' + (e && e.stack ? e.stack : String(e)));
    }
  }

  /** 进程退出：结束全部 SSE 与任务 */
  function closeAll() {
    for (const job of jobs.values()) {
      for (const sub of job.subs) {
        clearInterval(sub.ping);
        try { sub.res.end(); } catch (e) { /* ignore */ }
      }
      job.subs.clear();
      if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
      try { job.aborter.abort(); } catch (e) { /* ignore */ }
    }
    jobs.clear();
  }

  return { create, get, subscribe, cancel, closeAll, runningCount, list: () => Array.from(jobs.values()) };
}

export { T };
