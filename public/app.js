"use strict";
/* ==========================================================================
   影视仓接口助手 · Web 版前端（原生 JS：无框架 / 无构建 / 无 CDN 依赖）
   --------------------------------------------------------------------------
   原型：reference/apk/assets/index.html（APK 内 WebView 单文件页面）。
   相对原型的改动（前后端唯一契约见 docs/API.md）：
     1. 删除全部 Android 桥：window.YscAndroid / __yscOnCapture /
        __yscOnCaptureError / rawFetchUrl / __yscSaveResult / yscBridgeSelfTest；
     2. 抓取、结构分析、测速、配置生成全部由服务端 job 完成：
        POST /api/scan 提交 → EventSource 订阅 /api/jobs/:id/events →
        渲染 result.verdicts（§4.3 顶层数组，子仓在 children 里递归）与 result.stats；
     3. 删除 localStorage 存档（saveProgress / loadProgress / 历史键），
        历史改由服务端 /api/history 持久化，多设备共享；
     4. 「下载配置」改为 <a download> 直连后端（契约 §4.5 / §5）：
        实时任务 → /api/jobs/<jobId>/config；历史恢复 → /api/history/<histId>/config；
        两者皆无或 config 为空时禁用（不再有 Blob 兜底）。另提供「复制 JSON」。
   ========================================================================== */

const $ = (id) => document.getElementById(id);

/* 契约 §4.2：progress.stage → 中文文案 */
const STAGE_LABEL = {
  collecting: "抓取聚合页搜集线路",
  analyzing: "分析线路结构",
  verifying: "测速验证",
  building: "生成配置",
  done: "完成"
};

/* 契约 §4.3：verdicts[].kind */
const T = { single: "single", store: "multi_storehouse", urls: "multi_urls", unknown: "unknown" };

/* 会话级只记录当前任务 id（不是结果存档），用于刷新页面后重连 SSE */
const LAST_JOB_KEY = "ysc_web_last_job";

const state = {
  jobId: null,      // 当前活动任务 id（展示历史记录时为 null）
  historyId: null,  // 当前展示的历史记录 id（展示实时任务结果时为 null）
  configUrl: null,  // 「下载配置」直连地址，二选一：/api/jobs/:id/config 或 /api/history/:id/config
  running: false,
  verdicts: [],
  config: null,
  stats: null,
  es: null,
  reconnects: 0,
  history: []
};

/* ================= 基础工具 ================= */
function esc(s) {
  const d = document.createElement("div");
  d.textContent = (s == null ? "" : String(s));
  return d.innerHTML;
}
function fmtMs(v) { return v == null ? "-" : Number(v).toFixed(0) + "ms"; }
function fmtSpeed(v) {
  if (v == null) return "-";
  const n = Number(v);
  return n >= 1024 ? (n / 1024).toFixed(2) + "MB/s" : n.toFixed(0) + "KB/s";
}
function fmtDate(t) {
  const d = new Date(Number(t) || Date.now());
  return d.toLocaleDateString() + " " + d.toLocaleTimeString();
}
function fmtSec(ms) {
  if (ms == null) return "-";
  const s = Number(ms) / 1000;
  return s >= 60 ? (s / 60).toFixed(1) + " 分钟" : s.toFixed(1) + " 秒";
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
}
function parseData(ev) {
  const raw = ev && typeof ev.data === "string" ? ev.data : "";
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ================= HTTP 封装（契约 §1：成功带 ok:true，失败 4xx/5xx + 错误码） ================= */
async function request(path, opts) {
  const options = Object.assign({ method: "GET" }, opts || {});
  options.headers = Object.assign({ "Accept": "application/json" }, (opts && opts.headers) || {});
  const res = await fetch(path, options);
  let text = "";
  try { text = await res.text(); } catch (e) { text = ""; }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
  if (!res.ok) {
    const err = new Error((data && data.message) || ("请求失败（HTTP " + res.status + "）"));
    err.code = (data && data.error) || ("http_" + res.status);
    throw err;
  }
  if (data && data.ok === false) {
    const bizErr = new Error(data.message || "请求失败");
    bizErr.code = data.error || "unknown";
    throw bizErr;
  }
  return data || {};
}
function postJSON(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {})
  });
}

/* ================= 进度（契约 §4.2 progress 事件） ================= */
function renderProgress(p) {
  if (!p) return;
  $("progressWrap").style.display = "block";
  const stageKey = p.stage || "";
  const label = STAGE_LABEL[stageKey] || stageKey || "处理中";
  const cur = Number(p.cur) || 0;
  const total = Number(p.total) || 0;
  const pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : (stageKey === "done" ? 100 : 0);
  $("progressBar").style.width = pct + "%";
  $("pctText").textContent = pct + "%";
  $("stageText").textContent = label + (total > 0 ? "（" + cur + "/" + total + "）" : "");
  $("progressInfo").textContent = p.info ? "正在处理：" + p.info : "";
}

/* ================= 统计（契约 §4.3 result.stats） ================= */
function walkV(vs) {
  const out = [];
  const go = (v) => {
    if (!v || typeof v !== "object") return;
    out.push(v);
    (Array.isArray(v.children) ? v.children : []).forEach(go);
  };
  (Array.isArray(vs) ? vs : []).forEach(go);
  return out;
}
function computeStats(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const all = walkV(list);
  const avg = (() => {
    const s = all.map((v) => v.total_ms).filter((x) => x != null);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  })();
  return {
    total: list.length,
    available: all.filter((v) => v.available).length,
    singles: all.filter((v) => v.kind === T.single && v.available).length,
    multis: all.filter((v) => (v.kind === T.store || v.kind === T.urls) && v.available).length,
    avg_speed: avg
  };
}
function statsOf() {
  const c = computeStats(state.verdicts);
  const s = state.stats || {};
  const num = (a, b) => (typeof a === "number" && isFinite(a) ? a : b);
  return {
    total: num(s.total, c.total),
    available: num(s.available, c.available),
    singles: num(s.singles, c.singles),
    multis: num(s.multis, c.multis),
    avg_speed: s.avg_speed != null ? s.avg_speed : c.avg_speed
  };
}

/* ================= 渲染 ================= */
function badge(text) {
  const c = {
    可用: "#16a34a", 不可用: "#dc2626", 快: "#16a34a", 中: "#d97706", 慢: "#dc2626",
    单线路: "#2563eb", 多仓: "#7c3aed", 未知: "#6b7280"
  };
  return '<span class="badge" style="background:' + (c[text] || "#6b7280") + '">' + esc(text) + "</span>";
}
function kindLabel(k) {
  return k === T.single ? "单线路" : (k === T.store || k === T.urls) ? "多仓" : "未知";
}
/* 卡片标题取值：有 name 用 name；没有则用「主机名 + /…/尾段」，
   避免副行已展示完整 URL 时标题再重复一遍（尾段仅 .json/.txt 才显示，否则只留主机名）。 */
function displayName(v) {
  const name = v && typeof v.name === "string" ? v.name.trim() : "";
  if (name) return name;
  const url = v && typeof v.url === "string" ? v.url : "";
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.host || "";
    if (!host) return url;
    const segs = String(u.pathname || "").split("/").filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : "";
    return /\.(json|txt)$/i.test(last) ? host + "/…/" + last : host;
  } catch (e) {
    return url;   /* 解析失败（非绝对 URL 等）→ 原样回退 */
  }
}
function renderLoading(text) {
  $("tree").innerHTML = '<div class="loading">' + esc(text) + "</div>";
}
function renderSummary() {
  const s = statsOf();
  $("summary").innerHTML = '<div class="cards">' +
    '<div class="card"><div class="num">' + s.total + '</div><div class="label">总线路</div></div>' +
    '<div class="card ok"><div class="num">' + s.available + '</div><div class="label">可用</div></div>' +
    '<div class="card"><div class="num">' + s.multis + '</div><div class="label">可用多仓</div></div>' +
    "</div>";
}
/* 递归渲染 verdict 树（逻辑移植自原页面 renderRow；verdicts 为顶层数组，子仓在 children） */
function renderRow(v, indent) {
  if (!v || typeof v !== "object") return "";
  const kids = Array.isArray(v.children) ? v.children : [];
  const attrs = 'data-kind="' + esc(v.kind || T.unknown) + '"' +
    ' data-status="' + (v.available ? "ok" : "bad") + '"' +
    ' data-speed="' + esc(v.speed_label || "") + '"' +
    ' data-search="' + esc(((v.name || "") + " " + (v.url || "")).trim()) + '"' +
    ' style="margin-left:' + (indent * 14) + 'px"';

  if (v.kind === T.store || v.kind === T.urls) {
    /* 多仓：折叠头部 + 子仓卡片，并标注可用子仓数 */
    const subOk = kids.filter((c) => c && c.available).length;
    return '<div class="line-card" ' + attrs + ">" +
      '<div class="head">' +
        '<span class="name">' + esc(displayName(v)) + "</span>" +
        badge(kindLabel(v.kind)) + " " + badge(v.available ? "可用" : "不可用") +
      "</div>" +
      '<div class="url">' + esc(v.url) + "</div>" +
      '<div class="meta">' +
        '<span class="stat">⏱ <b>' + fmtMs(v.total_ms) + "</b></span>" +
        '<span class="stat">📦 <b>' + kids.length + "</b> 子仓</span>" +
        (subOk > 0 ? '<span class="stat" style="color:var(--ok)">✓ <b>' + subOk + "</b> 可用</span>" : "") +
      "</div>" +
      kids.map((c) => renderRow(c, indent + 1)).join("") +
      "</div>";
  }

  const sp = v.available ? badge(v.speed_label) : "";
  const meta = v.available
    ? '<span class="stat">⏱ <b>' + fmtMs(v.total_ms) + "</b></span>" +
      (v.ttfb_ms != null ? '<span class="stat">⚡ <b>' + fmtSpeed(v.speed_kbps) + "</b></span>" : "") +
      (v.site_count > 0 ? '<span class="stat">📦 <b>' + v.site_count + "</b> 站点</span>" : "")
    : '<span class="stat" style="opacity:.6">— ' + esc(v.error || "不可用") + "</span>";

  return '<div class="line-card' + (v.available ? "" : " bad") + '" ' + attrs + ">" +
    '<div class="head">' +
      '<span class="name">' + esc(displayName(v)) + "</span>" +
      badge(kindLabel(v.kind)) + " " + badge(v.available ? "可用" : "不可用") +
      (sp ? " " + sp : "") +
    "</div>" +
    '<div class="url">' + esc(v.url) + "</div>" +
    '<div class="meta">' + meta + "</div>" +
    "</div>";
}
function renderResult(result, source) {
  /* source：实时任务 { jobId } 或历史记录 { historyId }，决定「下载配置」直连地址 */
  state.jobId = (source && source.jobId) || null;
  state.historyId = (source && source.historyId) || null;
  state.configUrl = state.jobId
    ? "/api/jobs/" + encodeURIComponent(state.jobId) + "/config"
    : state.historyId
      ? "/api/history/" + encodeURIComponent(state.historyId) + "/config"
      : null;
  state.verdicts = result && Array.isArray(result.verdicts) ? result.verdicts : [];
  state.config = (result && result.config) || null;
  state.stats = (result && result.stats) || null;

  renderSummary();
  const rows = state.verdicts.map((v) => renderRow(v, 0)).join("");
  $("tree").innerHTML = rows
    ? '<div class="line-list" id="linelist">' + rows + "</div>"
    : '<div class="empty">没有解析到任何线路</div>';
  $("filters").style.display = "flex";
  applyFilters();
  updateDownload();
  updateRestoreHint();
  switchTab("result");
}
function applyFilters() {
  const q = ($("kw").value || "").trim().toLowerCase();
  const k = $("f-kind").value;
  const s = $("f-status").value;
  const sp = $("f-speed").value;
  let shown = 0;
  document.querySelectorAll("#tree .line-card").forEach((el) => {
    const ok = (!q || (el.dataset.search || "").toLowerCase().indexOf(q) >= 0) &&
      (!k || el.dataset.kind === k) &&
      (!s || el.dataset.status === s) &&
      (!sp || el.dataset.speed === sp);
    el.style.display = ok ? "" : "none";
    if (ok) shown++;
  });
  $("cnt").textContent = "显示 " + shown + " 条";
}

/* ================= 下载配置 / 复制 JSON（契约 §4.5） ================= */
function updateDownload() {
  const a = $("dlAll");
  const cfg = state.config;
  const urls = cfg && Array.isArray(cfg.urls) ? cfg.urls : [];
  if (!urls.length || !state.configUrl) {
    a.removeAttribute("href");
    a.removeAttribute("download");
    a.setAttribute("aria-disabled", "true");
    a.classList.add("disabled");
    return;
  }
  /* 直接走后端下载端点（实时任务 §4.5 / 历史记录 §5），浏览器接管下载 */
  a.href = state.configUrl;
  a.setAttribute("download", "ysc_config.json");
  a.removeAttribute("aria-disabled");
  a.classList.remove("disabled");
}
async function copyConfig() {
  const cfg = state.config;
  if (!cfg || !Array.isArray(cfg.urls) || !cfg.urls.length) {
    toast("暂无可用线路配置");
    return;
  }
  const text = JSON.stringify(cfg, null, 2);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      toast("配置 JSON 已复制");
      return;
    }
    throw new Error("clipboard unavailable");
  } catch (e) {
    /* 降级：隐藏 textarea + execCommand */
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      toast(ok ? "配置 JSON 已复制" : "复制失败，请改用「下载配置」");
    } catch (e2) {
      toast("复制失败，请改用「下载配置」");
    }
  }
}

/* ================= 扫描主流程（契约 §4.1 / §4.2 / §4.4） ================= */
function buildScanBody() {
  const concurrency = clampInt($("optConcurrency").value, 1, 32, 8);
  const timeoutMs = clampInt($("optTimeout").value, 1000, 30000, 8000);
  $("optConcurrency").value = concurrency;
  $("optTimeout").value = timeoutMs;

  const body = {
    concurrency: concurrency,
    timeoutMs: timeoutMs,
    useSearchPages: !!$("optUseSearch").checked,
    includeBaseLines: !!$("optIncludeBase").checked
  };

  /* 自定义线路：每行 "url" 或 "名称|url"（契约 §4.1 extraSources，始终生效） */
  const lines = ($("optExtra").value || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const valid = [];
  let bad = 0;
  lines.forEach((line) => {
    const u = line.indexOf("|") >= 0 ? line.slice(line.indexOf("|") + 1).trim() : line;
    if (/^https?:\/\/[^\s]+$/i.test(u)) valid.push(line);
    else bad++;
  });
  if (bad > 0) toast("已忽略 " + bad + " 行无效自定义线路");
  if (valid.length) body.extraSources = valid;
  return body;
}
function setRunning(on) {
  const btn = $("searchBtn");
  btn.disabled = !!on;
  btn.textContent = on ? "⏳ 验证中..." : "🔍 全网搜寻和验证";
  const cbtn = $("cancelBtn");
  cbtn.hidden = !on;
  cbtn.disabled = false;
  ["optConcurrency", "optTimeout", "optUseSearch", "optIncludeBase", "optExtra"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !!on;
  });
}
async function doMain() {
  if (state.running) { toast("正在验证中，请稍候..."); return; }
  state.running = true;
  state.reconnects = 0;
  setRunning(true);

  $("summary").innerHTML = "";
  $("filters").style.display = "none";
  renderLoading("正在提交任务，请稍候...");
  switchTab("task");
  renderProgress({ stage: "collecting", cur: 0, total: 0, info: "提交任务..." });

  try {
    const body = buildScanBody();
    const r = await postJSON("/api/scan", body);
    state.jobId = r.jobId;
    try { sessionStorage.setItem(LAST_JOB_KEY, r.jobId); } catch (e) { /* 隐私模式忽略 */ }
    renderLoading("任务已提交，服务端正在搜集并验证线路...");
    subscribe(r.jobId);
  } catch (e) {
    state.running = false;
    setRunning(false);
    $("progressWrap").style.display = "none";
    $("tree").innerHTML = '<div class="empty">执行出错：' + esc(e.message || e) + "</div>";
    toast("提交失败：" + (e.message || e));
  }
}
function closeES() {
  if (state.es) {
    try { state.es.close(); } catch (e) { /* 忽略 */ }
    state.es = null;
  }
}
function subscribe(jobId) {
  closeES();
  state.jobId = jobId;
  const es = new EventSource("/api/jobs/" + encodeURIComponent(jobId) + "/events");
  state.es = es;

  /* hello：连接即发，用于补齐进度 / 断线重连后校正（契约 §4.2） */
  es.addEventListener("hello", (ev) => {
    const d = parseData(ev);
    if (!d) return;
    if (d.progress) renderProgress(d.progress);
    if (d.state === "cancelled") onCancelled();
  });
  es.addEventListener("progress", (ev) => {
    const d = parseData(ev);
    if (d) renderProgress(d);
  });
  es.addEventListener("log", (ev) => {
    const d = parseData(ev);
    if (!d) return;
    console.debug("[job " + d.level + "] " + d.msg);
    if (d.level === "error") toast("服务端提示：" + d.msg);
  });
  es.addEventListener("done", (ev) => {
    const d = parseData(ev);
    onDone(d, jobId);
  });
  es.addEventListener("error", (ev) => {
    /* 带 data 的是服务端业务 error 事件；原生连接错误是 Event（无 data） */
    if (ev && typeof ev.data === "string" && ev.data) {
      const d = parseData(ev) || {};
      onJobError({ error: d.error || "internal_error", message: d.message || "任务失败" });
      return;
    }
    onConnError();
  });
}
function onDone(result, jobId) {
  closeES();
  state.running = false;
  setRunning(false);
  if (!result || !Array.isArray(result.verdicts)) {
    onJobError({ error: "internal_error", message: "任务结果为空" });
    return;
  }
  renderProgress({ stage: "done", cur: 1, total: 1, info: "" });
  renderResult(result, { jobId: jobId || state.jobId });
  toast("验证完成，共 " + result.verdicts.length + " 条线路");
  loadHistory(true);
}
function onJobError(err) {
  closeES();
  state.running = false;
  setRunning(false);
  $("progressWrap").style.display = "none";
  const msg = (err && (err.message || err.error)) || "任务失败";
  $("tree").innerHTML = '<div class="empty">执行出错：' + esc(msg) + "</div>";
  toast("执行失败：" + msg);
  switchTab("result");
  loadHistory(true);
}
function onCancelled() {
  closeES();
  state.running = false;
  setRunning(false);
  $("progressWrap").style.display = "none";
  toast("任务已取消");
  renderLoading("任务已取消，可重新点击「全网搜寻和验证」");
  switchTab("result");
}
async function onConnError() {
  if (!state.running && !state.es) return;
  closeES();
  const jid = state.jobId;
  if (!jid) return;
  try {
    const job = await request("/api/jobs/" + encodeURIComponent(jid));
    if (job.state === "running") {
      /* 断线只重连一次，并已用 GET /api/jobs/:id 校正状态（契约 §9） */
      if (state.reconnects < 1) {
        state.reconnects += 1;
        toast("实时连接中断，正在重连...");
        setTimeout(() => { if (state.running) subscribe(jid); }, 900);
      } else {
        if (job.progress) renderProgress(job.progress);
        toast("实时连接已断开，任务仍在服务端运行，可稍后刷新页面查看");
      }
      return;
    }
    finishWithJob(job);
  } catch (e) {
    if (state.reconnects < 1) {
      state.reconnects += 1;
      setTimeout(() => { if (state.running) subscribe(jid); }, 1200);
    } else {
      toast("网络异常：" + (e.message || e));
    }
  }
}
function finishWithJob(job) {
  if (!job) return;
  if (job.state === "done" && job.result) { onDone(job.result, job.id || state.jobId); return; }
  if (job.state === "error") { onJobError(job.error || {}); return; }
  if (job.state === "cancelled") { onCancelled(); return; }
}
async function cancelJob() {
  if (!state.jobId) return;
  const btn = $("cancelBtn");
  btn.disabled = true;
  try {
    await postJSON("/api/jobs/" + encodeURIComponent(state.jobId) + "/cancel", {});
    toast("已请求取消");
  } catch (e) {
    toast("取消失败：" + (e.message || e));
  } finally {
    setTimeout(() => { btn.disabled = false; }, 800);
  }
}

/* ================= 历史（契约 §5，服务端持久化） ================= */
async function loadHistory(silent) {
  try {
    const r = await request("/api/history");
    state.history = Array.isArray(r.items) ? r.items : [];
    renderHistory();
    updateRestoreHint();
  } catch (e) {
    if (!silent) toast("历史加载失败：" + (e.message || e));
    $("historyList").innerHTML = '<div class="hist-empty">历史加载失败<br>' + esc(e.message || e) + "</div>";
    state.history = [];
    updateRestoreHint();
  }
}
function renderHistory() {
  const box = $("historyList");
  if (!state.history.length) {
    box.innerHTML = '<div class="hist-empty">暂无历史记录<br>完成一次「全网搜寻和验证」后自动保存</div>';
    return;
  }
  box.innerHTML = state.history.map((h) => {
    const id = esc(h.id);
    return '<div class="hist-item" data-id="' + id + '">' +
      '<div class="h-info">' +
        '<div class="h-title">' + esc(fmtDate(h.t)) + "</div>" +
        '<div class="h-sub">共 ' + esc(h.count || 0) + " 条 · " +
          '<span style="color:var(--ok)">可用 ' + esc(h.available || 0) + "</span> · 可用多仓 " + esc(h.multis || 0) +
          " · 耗时 " + esc(fmtSec(h.elapsedMs)) +
        "</div>" +
      "</div>" +
      '<button type="button" class="btn-ghost" data-load="' + id + '">恢复</button>' +
      '<button type="button" class="btn-ghost" data-del="' + id + '">删除</button>' +
      "</div>";
  }).join("");
}
/* 页面加载时有历史记录 → 任务页顶部提示「上次结果可恢复」 */
function updateRestoreHint() {
  const bar = $("restoreHint");
  if (!state.history.length || state.verdicts.length) {
    bar.hidden = true;
    return;
  }
  const h = state.history[0];
  $("restoreHintText").textContent = "上次结果可恢复：" + fmtDate(h.t) +
    " · 共 " + (h.count || 0) + " 条 · 可用 " + (h.available || 0);
  bar.hidden = false;
}
async function restoreHistory(id) {
  if (!id) return;
  try {
    const r = await request("/api/history/" + encodeURIComponent(id));
    if (!Array.isArray(r.verdicts) || !r.verdicts.length) { toast("该记录没有结果"); return; }
    /* 历史记录无 jobId：下载走 /api/history/:id/config（契约 §5） */
    renderResult({ verdicts: r.verdicts, config: r.config || null, stats: r.stats || null },
      { historyId: r.id || id });
    toast("已恢复 " + fmtDate(r.t) + " 的结果");
  } catch (e) {
    toast("恢复失败：" + (e.message || e));
  }
}
async function deleteHistory(id) {
  if (!id) return;
  if (!window.confirm("确定删除这条历史记录？")) return;
  try {
    await request("/api/history/" + encodeURIComponent(id), { method: "DELETE" });
    toast("已删除");
    await loadHistory(true);
  } catch (e) {
    toast("删除失败：" + (e.message || e));
  }
}

/* ================= Tab 切换 ================= */
function switchTab(name) {
  ["task", "result", "history"].forEach((n) => {
    $("pane-" + n).classList.toggle("active", n === name);
  });
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === name);
  });
}

/* ================= 刷新后重连未完成任务 ================= */
async function resumeLastJob() {
  let jid = null;
  try { jid = sessionStorage.getItem(LAST_JOB_KEY); } catch (e) { jid = null; }
  if (!jid) return;
  try {
    const job = await request("/api/jobs/" + encodeURIComponent(jid));
    if (job.state === "running") {
      state.jobId = jid;
      state.running = true;
      setRunning(true);
      switchTab("task");
      renderProgress(job.progress || { stage: "collecting", cur: 0, total: 0, info: "" });
      subscribe(jid);
    } else if (job.state === "done" || job.state === "error" || job.state === "cancelled") {
      try { sessionStorage.removeItem(LAST_JOB_KEY); } catch (e) { /* 忽略 */ }
    }
  } catch (e) {
    try { sessionStorage.removeItem(LAST_JOB_KEY); } catch (e2) { /* 忽略 */ }
  }
}

/* ================= 事件绑定 + 初始化 ================= */
function bindEvents() {
  $("searchBtn").onclick = doMain;
  $("cancelBtn").onclick = cancelJob;
  $("kw").oninput = applyFilters;
  $("f-kind").onchange = applyFilters;
  $("f-status").onchange = applyFilters;
  $("f-speed").onchange = applyFilters;
  $("copyBtn").onclick = copyConfig;

  $("dlAll").addEventListener("click", (e) => {
    const urls = state.config && Array.isArray(state.config.urls) ? state.config.urls : [];
    if (!urls.length) {
      e.preventDefault();
      toast("暂无可用线路配置");
    }
  });

  $("restoreHint").addEventListener("click", () => {
    switchTab("history");
    loadHistory(true);
  });

  /* 历史列表：事件委托，点击卡片=恢复，按钮=恢复/删除 */
  $("historyList").addEventListener("click", (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== "function") return;
    const loadBtn = t.closest("[data-load]");
    if (loadBtn) { restoreHistory(loadBtn.getAttribute("data-load")); return; }
    const delBtn = t.closest("[data-del]");
    if (delBtn) { deleteHistory(delBtn.getAttribute("data-del")); return; }
    const item = t.closest(".hist-item");
    if (item) restoreHistory(item.getAttribute("data-id"));
  });

  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.onclick = () => {
      const name = b.getAttribute("data-tab");
      switchTab(name);
      if (name === "history") loadHistory(true);
    };
  });
}

function init() {
  bindEvents();
  loadHistory(true);
  resumeLastJob();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
