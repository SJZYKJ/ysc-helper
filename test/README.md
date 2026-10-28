# test/ — 端到端烟囱测试（契约 docs/API.md §10）

零依赖、纯离线的自动化验收测试。一条命令起本地 fixture 源站 + 目标服务子进程，跑完 14 组用例，
打印每项 PASS/FAIL 与耗时汇总；任何一项失败 → 退出码 1。

```bash
node test/smoke.mjs      # 等价于 npm test
```

- 要求：Node >= 20（只用到全局 `fetch` / `AbortController` 与 `node:` 内置模块），**无需 npm install**。
- 全程只连 `127.0.0.1`，不访问外网，可在无网机器、CI、Docker 容器内原样复跑。
- 全程使用随机端口 + 临时 `DATA_DIR`（`os.tmpdir()/ysc-smoke-*`），不污染仓库里的 `data/`。
- 无论成功失败都会杀掉全部子进程、关闭 fixture、删除临时目录；有 240s 看门狗兜底强退。

## 1. 运行前做了什么

1. 预检 `server.mjs`、`public/index.html`、`public/app.js`、`public/style.css` 是否存在，缺文件直接退出 1 并提示。
2. 用 `node:http` 在 `127.0.0.1:0` 起 **fixture 源站**。
3. 用 `node:child_process.spawn(process.execPath, ['server.mjs'])` 起目标服务（`cwd` = 仓库根），
   端口先由 `net.createServer().listen(0)` 探测空闲端口再交给子进程，随后轮询 `/api/health` 等就绪（25s 超时，
   子进程提前退出时会把它的 stdout/stderr 尾巴打进报错）。
4. 起 3 个实例：
   | 实例 | 关键 env | 用途 |
   |---|---|---|
   | A | `ALLOW_PRIVATE_TARGETS=1` | 主流程（抓 fixture、扫描、配置、历史、静态页） |
   | B | `ALLOW_PRIVATE_TARGETS=0` | 验证 SSRF 拦截（私网/回环/localhost → `blocked_target`） |
   | C | `BASIC_AUTH=qa:secret` | 验证 Basic 认证（`/api/health` 免认证，其余 401/200） |
   所有实例都设 `PORT=<随机>`、`HOST=127.0.0.1`、`DATA_DIR=<临时目录>`。

## 2. fixture 源站端点

| 路径 | 响应 | 用途 |
|---|---|---|
| `/single.json` | `{"spider":"...","sites":[3 条],"name":"fixture-single"}` | 可解析单仓 |
| `/single2.json` | 同上（另一 tag） | 多仓的第二个（不重复的）子仓 |
| `/multi.json` | `{"name":"fixture-multi","storeHouse":[{sourceName,sourceUrl}...]}` | 多仓，子仓指向 `/single.json` 与 `/single2.json` |
| `/bad.json` | `text/plain` 的 `not json at all` | 坏 JSON → `available=false` |
| `/slow.json` | 延迟 **6s** 才响应 | 代理超时（`timeout=1000`）、任务取消 |
| `/chunked.json` | 立即发响应头、220ms 后发 body | 稳定验证 `ttfb_ms < total_ms` |
| `/status404.json` | HTTP 404 + JSON | 验证「非 2xx 上游 → `ok:true` + 真实 status」（§3） |

> 用 `/chunked.json` 而不是 `/single.json` 断言 `ttfb < total`：小响应体下两个值可能只差零点几毫秒，
> 分块延迟能把差值拉开到 ~200ms，避免误报。

## 3. 用例清单

| # | 用例 | 主要断言 |
|---|---|---|
| 1 | `GET /api/health` | 200、`ok:true`、`name/version/uptimeSec/now` 字段齐全 |
| 2 | `GET /api/proxy` 抓 fixture | 200、`ok:true`、`status=200`、`size_kb>0`、`ttfb_ms>0`、`total_ms>0`、`ttfb<total`、`body` 原文、`final_url/content_type/truncated`；404 上游 → `ok:true,status:404`；`slow.json+timeout=1000` → `ok:false,error:"timeout"` |
| 3 | SSRF 拦截 | B 实例上 `/api/proxy` 私网/回环/localhost 均 `error:"blocked_target"`，HTTP 为 200 业务失败或 4xx |
| 4 | `POST /api/scan` + SSE | 返回 `jobId`、`state:"running"`；SSE `Content-Type: text/event-stream`；先 `hello` 再至少 1 个 `progress`，最后 `done`（无 `error`）；`done` 与 §4.3 `result` 同构；`GET /api/jobs/:id` → `state=done`、`finishedAt` 已写；任务结束后**重新订阅**仍先 `hello`（`state=done`）再 `done`/补发进度（§4.2 断线重连） |
| 5 | `result.verdicts` 结构与语义 | **恰好 3 条**且无任何额外地址（校验 `includeBaseLines:false` 生效、没碰外网）；single → `kind=single`/`available=true`/`site_count=3`/`error=""`；multi → `kind=multi_storehouse`/`children.length>=1`/子项 `kind=single` 且至少一个可用/子项 `parent_url` 正确；bad → `available=false`/`error` 非空/`speed_label="不可用"`；`stats.total==verdicts.length` |
| 6 | `GET /api/jobs/:id/config` | 200、`Content-Type` 含 `application/json`、`Content-Disposition: attachment; filename="ysc_config.json"`、`urls` 含 fixture 单仓地址、不含坏 JSON 地址；**每条 `config.url` 必须带 `http(s)://` 协议头**（配置可用性的端到端不变量） |
| 7 | 历史列表 + 下钻 | `GET /api/history` 有记录且字段齐全 → `GET /api/history/:id` 能下钻到 `verdicts/config/stats`；若后端附 `job.historyId` 则校验其指向该条记录（删除放到用例 13，复用同一 id）。**严格模式：done 后立即查询即可见，不轮询、不 sleep**（后端保证落盘先于 done 广播）；另校验 `item.t` 与 `result.finishedAt` 同一轮、`item.count == 顶层 verdicts 数` |
| 8 | 静态资源 | `GET /` 200 + `text/html` + 含「影视仓」+ 引用 `app.js`/`style.css` + `Cache-Control: no-cache`；`/app.js`、`/style.css` 200 且 MIME 正确；未知 `/api/*` → 404 `not_found`；未知非 API 路径 → 回退 index.html |
| 9 | `GET /api/sources` | 200、`baseLines` 为 `[name,url]` 数组、`searchPages` 数组、`effectiveFrom ∈ {builtin,file}` |
| 10 | `POST /api/jobs/:id/cancel` | 返回 `state:"cancelled"`，并在 5s 内 `GET /api/jobs/:id` 收敛为 `cancelled` |
| 11 | 错误码契约 | 缺 `url` / 非法 `url` / 非法 JSON body → `bad_request` 或 400；未知 job / 未知 history → 404 `not_found` |
| 12 | `BASIC_AUTH` | `/api/health` 免认证 200；无凭据 `/api/history`、`GET /` → 401 且带 `WWW-Authenticate: Basic`；错误凭据 401；正确凭据 200 |
| 13 | `GET /api/history/:id/config`（§5） | a) 复用扫描写入的历史 id：200、`Content-Type` 含 `application/json`、`Content-Disposition` 含 `attachment` 且 `filename="ysc_config.json"`、`body` 为 `{urls:[...]}` 且与 `GET /api/jobs/:id/config` **深比较一致**（按 url 排序后比，忽略顺序）；b) 未知历史 id → 404 `not_found`；c) `DELETE` 后列表为空、`/api/history/:id` 与 `/api/history/:id/config` 均 404 `not_found` |
| 14 | `cleanSourceUrl` 清洗（单元级） | 直接 `import('../src/util.mjs')` 调 `cleanSourceUrl`：①`gh-proxy.com` 前缀且**不带第二段协议** → 补回 `https://`（曾把地址洗成无协议头的缺陷）；②代理前缀 + 双段协议；③`ghproxy.net`；④`github.moeyy.xyz`；⑤普通 https 原样；⑥`http://` 不被强改 https；⑦`//` 协议相对地址补 `https://`；⑧空串原样；另含「非空输出一律带 `http(s)://`」不变量与 trim 行为 |

扫描请求固定为（§4.1 三个开关互相独立，必须同时关掉外网来源）：

```json
{"samples":1,"maxDepth":2,"concurrency":4,"timeoutMs":3000,"pageTimeoutMs":3000,
 "extraSources":["<fixture>/single.json","<fixture>/multi.json","<fixture>/bad.json"],
 "useSearchPages":false,"includeBaseLines":false}
```

## 4. 如何加用例

用例就是一个 `await runCase('标题', async (t) => { ... })`，放 `main()` 里即可（顺序执行，共享前置的 `svcA/svcB/fixture`）：

```js
await runCase('15) 我的新用例', async (t) => {
  const r = await api(svcA.base, '/api/whatever', { timeoutMs: 10000 });   // api() 返回 {status,headers,text,json}
  t.eq('HTTP 状态', r.status, 200);          // 严格相等
  t.ok('布尔断言', !!r.json?.ok);
  t.gt('数值下界', r.json.count, 0);          // > min
  t.gte('数值下界（含）', r.json.count, 1);    // >= min
  t.has('字符串包含', r.text, '影视仓');
  t.isArray('数组且长度', r.json.items, 1);
  t.assert('自由条件', cond, '失败时的 expected/actual 说明');
  t.info('仅打印的上下文');
});
```

- `t.assert` 失败只记录 + 标记该用例 FAIL，不中断后续用例；异常抛出也只影响当前用例。
- 需要新 fixture 端点：在 `startFixture()` 的 `http.createServer` 里加分支（`p === '/xxx'`）；
  有延迟的响应记得把定时器放进 `timers` Set，fixture 关闭时会清理。
- 需要新服务实例：`await startService({ dataDir: path.join(tmpRoot, 'dataD'), allowPrivate: true, label: 'D', extraEnv: {...} })`，
  返回值有 `base/port/child`，会自动登记进 `cleanups`。
- `process.exitCode` 由汇总逻辑统一设置，用例里不要自己 `process.exit()`。

## 5. CI / 容器内跑法

```bash
# 本机（Windows PowerShell / Linux / macOS 通用）
node test/smoke.mjs

# CI（无 npm 依赖，不需要 install）
npm test

# Windows PowerShell 若报「禁止运行脚本 · npm.ps1」：
npm.cmd test        # 或直接用 node test/smoke.mjs

# 容器内跑（测试会自己再起 server.mjs 子进程；不需要 docker compose 起服务）
docker run --rm -v "$PWD:/app" -w /app node:22-alpine node test/smoke.mjs

# 已构建的应用镜像默认不含 test/（Dockerfile 只 COPY 运行所需文件）；要跑就挂进去：
docker run --rm -v "$PWD/test:/app/test:ro" -w /app ysc-helper:latest node test/smoke.mjs
```

> 容器里 `127.0.0.1` 指向容器自身，fixture 与目标服务都在同一容器内，因此可正常互通。
> 若 CI 用 `--network none`，测试同样能跑（全程不依赖外网）。

注意：测试自己用随机端口监听 `127.0.0.1`，所以**不要**在 `HOST=0.0.0.0` 的已有服务上复用它——
它是自包含的，和已部署实例互不影响。若宿主机禁止 `127.0.0.1` 绑定（少见），任何用例都会在
「等待 /api/health 超时」处失败，报错里会带子进程 stderr 尾巴。

## 6. 失败排查

| 现象 | 多半是 |
|---|---|
| `[前置条件不满足] 缺少文件` | 后端/前端产物还没生成（`server.mjs`、`public/*`） |
| 用例 4/5 `verdicts 恰好 3 条` 失败、墙钟 > 45s | `includeBaseLines:false` 没生效，扫描去抓了内置外网线路 |
| 用例 2 `ttfb_ms < total_ms` 失败 | 服务器在读完 body 之后才记 ttfb |
| 用例 5 `multi.children` 为空 | 多仓递归展开没实现，或 depth 被误判为「超过最大深度」 |
| 用例 7 「删除后列表为空」失败 | 历史条数被 `MAX_HISTORY` 之外的写路径污染（同一测试实例里只应有一次成功扫描写入） |
| 用例 11 `bad_request` 失败 | `readJsonBody` 宽松退化；非法 JSON 应回 400 而非静默建任务 |
| 用例 13 深比较不一致 | 历史配置没有复用 task result 的 `config`（重新生成导致顺序/内容漂移），或没走 `cleanSourceUrl` |
| 用例 7「done 后立即查询即可见」失败 | 完成流程又变成先广播 `done` 再落盘（回归），或 `store.add` 写失败被吞 / `DATA_DIR` 不可写 |
| 用例 14 失败 / 用例 6 冒出无协议头地址 | `cleanSourceUrl` 回归：剥离代理前缀后没补回 `https://`（原 APK 的老缺陷） |
| 用例 12 401/200 不符 | `BASIC_AUTH` 未覆盖静态页或漏掉 `/api/health` 豁免 |

## 7. 契约备注

- 契约 §4.1 的 `includeBaseLines`（默认 true）是本测试能「完全离线」的前提：
  `待测集合 = (includeBaseLines ? BASE_LINES : []) ∪ extraSources ∪ (useSearchPages ? extractUrls(聚合页) : [])`。
- 契约 §3 允许代理业务失败时 HTTP 仍为 200 + `ok:false`，§1 又规定错误响应为 4xx/5xx，
  因此用例 2/3/11 对「200 + `ok:false`」和「4xx + `ok:false`」两种形态都接受，但机器码必须严格匹配。
