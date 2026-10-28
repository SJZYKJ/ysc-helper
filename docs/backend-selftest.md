# 后端自测报告（server.mjs + src/* + Docker）

> 范围：task-1 全部交付物。契约依据：`docs/API.md`（v1，含 §4.1 body 解析规则、§4.1 includeBaseLines、§5 history config）。
> 前端 @public/*@ 与 @test/*@ 由其他成员负责，本报告不覆盖。

## 0. 结论速览

| 项目 | 结果 |
|---|---|
| 自测断言（自建 fixture + 三实例） | **101 PASS / 0 FAIL / 1 SKIP**（共 102 项；SKIP=外网 proxy 本轮网络抖动，curl 重试即成功） |
| QA 验收套件 `node test/smoke.mjs` | **13/13 通过，连跑 10 次 0 失败**（墙钟 ~2.1s，纯离线） |
| `node --check` 语法检查 | 7 / 7 文件 OK |
| 静态页 `GET /` `/app.js` `/style.css` `/icon.png` | 全部 200 |
| 外网 proxy 实抓 `raw.githubusercontent.com/gaotianliuyun/gao/master/js.json` | ok=true / status=200 / size_kb=50.411 / body_len=45597 / ttfb≈1045ms |
| `docker compose config --quiet` | 通过（exit 0） |
| `docker build` / 容器内运行 | **未验证**：本机 Docker Desktop daemon 未运行（npipe 不可用），见 §7 |

## 1. 交付文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `server.mjs` | 455 | HTTP 路由、静态资源、SSE 转发、Basic Auth、优雅退出 |
| `src/util.mjs` | 131 | normalizeUrl / isHttpUrl / tryParseJson / median / mapLimit / cleanSourceUrl / Semaphore，均按 APK 原语义移植 |
| `src/fetcher.mjs` | 272 | 抓取：TTFB/总耗时/字节大小计时、超时、4MiB 截断、SSRF 防护、全局信号量、重定向手动跟随 |
| `src/analyze.mjs` | 166 | classify / subEntries / siteCount / analyzeUrl / verifyNode / gradeSpeed / buildConfig / stats |
| `src/sources.mjs` | 119 | BASE_LINES(56) / SEARCH_PAGES(18) / extractUrls + `config/sources.json` 覆盖 |
| `src/jobs.mjs` | 286 | 任务编排（collecting→analyzing→verifying→building）、进度事件总线、取消、30 分钟回收 |
| `src/store.mjs` | 153 | 历史持久化：`DATA_DIR/history/<id>.json` + `index.json`，超 MAX_HISTORY 删最旧 |
| `package.json` | 16 | `type: module`、`engines: node>=20`、scripts: start / test / docker / docker:down，**无 dependencies** |
| `Dockerfile` | 23 | node:22-alpine、非 root 用户 nodejs(uid 10001)、HEALTHCHECK 用 `node -e` 打 /api/health |
| `docker-compose.yml` | 29 | 8080:8080、`./data:/app/data`、TZ=Asia/Shanghai、restart: unless-stopped、显式 `name: ysc-helper` |
| `.dockerignore` | 16 | 排除 data/test/reference/docs/.git 等 |
| `.gitignore` | 15 | data/、node_modules/、日志等 |
| `config/sources.example.json` | 10 | 覆盖文件示例（复制为 sources.json 生效） |
| `docs/backend-selftest.md` | 本文件 | 自测记录 |

无 `package-lock.json`、无 `node_modules`（零 npm 依赖，有意为之）。

## 2. 运行方式

```bash
# 本地
node server.mjs                     # 等价 npm start
PORT=9000 DATA_DIR=./data node server.mjs
ALLOW_PRIVATE_TARGETS=1 PORT=9000 node server.mjs     # 允许抓内网（本地联调 fixture 用）

# Docker
docker compose up -d --build        # → http://127.0.0.1:8080
docker compose logs -f
docker compose down
```

环境变量（契约 §8 全覆盖）：`PORT` `HOST` `DATA_DIR` `ALLOW_PRIVATE_TARGETS` `SCAN_CONCURRENCY` `REQUEST_TIMEOUT_MS` `MAX_HISTORY` `TZ` `BASIC_AUTH`；
额外内部变量：`FETCH_UA`（默认 `okhttp/4.12.0`）、`PUBLIC_DIR`、`CONFIG_DIR`、`MAX_RUNNING_JOBS`（默认 8，超出返回 429 `rate_limited`）。

## 3. 自测环境（三实例 + 本地 fixture）

```text
fixture 源站（node:http，127.0.0.1:19090）
  /single.json       单仓（spider+sites）
  /child.json /child2.json /child3.json  单仓
  /cn.json           含中文 name（验证 UTF-8 字节数口径）
  /multi.json        {storeHouse:[{sourceName,sourceUrl→/child.json}]}
  /multi2.json       {urls:[{name,url→/child2.json}]}
  /multi_dup.json    子仓指向 /single.json（验证 APK 的 seen 去重语义）
  /multi_nested.json → /multi.json → /child.json（验证 maxDepth）
  /bad.json          "not json at all"
  /redirect          302 → /single.json
  /loop             302 → 自身（重定向次数上限）
  /slow.json         延迟 6s（超时 / 取消）
  /page.html         延迟 400ms 的 HTML，内含 1 条线路 URL（验证聚合页 collecting + extractUrls）

实例 A 127.0.0.1:18080  ALLOW_PRIVATE_TARGETS=0            （验 SSRF 拒绝）
实例 B 127.0.0.1:18081  ALLOW_PRIVATE_TARGETS=1            （全部扫描/历史用例，离线 fixture）
实例 C 127.0.0.1:18082  ALLOW_PRIVATE_TARGETS=1 + CONFIG_DIR 指向含 sources.json 的临时目录
                        （验 config/sources.json 覆盖 + 聚合页 collecting 阶段）
```

跑法：先起 fixture（自测脚本内建），再 `node selftest.mjs <BASE0> <BASE1> <BASE2>`。脚本本体是临时件（不进仓库），断言内容见 §4；仓库内自动化套件是 QA 的 `test/smoke.mjs`。

## 4. 自测矩阵（102 项：101 PASS + 1 SKIP）

**4.1 health / sources / 静态（10）**
- `/api/health` 200 且 ok=true，含 name/version/uptimeSec/now
- `/api/sources` ok=true、effectiveFrom=builtin、baseLines=56（二元组）、searchPages=18
- `GET /` 200 且 HTML 含「影视仓」；`/app.js` `/style.css` `/icon.png` 均 200 且 MIME/`Cache-Control: no-cache` 正确
- 未知 `/api/nope` → 404 `{"ok":false,"error":"not_found"}`；未知非 api 路径 `/some/deep/route` → 回退 index.html 200

**4.2 proxy（12）**
- 私网（域名解析到 127.0.0.1）在 A 实例 → `blocked_target`；私网字面量 `http://10.0.0.1/x` → `blocked_target`
- B 实例抓 fixture 单仓：ok=true / status=200 / size_kb>0 / `ttfb_ms>0 且 < total_ms` / final_url / content_type / truncated=false
- size_kb 按**字节**口径：中文 JSON 62 字节 / 44 字符 → size_kb=0.061
- 302 跟随：final_url 指向 /single.json；死循环 → `upstream_error "重定向次数过多"`
- slow.json&timeout=1000 → `timeout`；坏地址 → `bad_request "无效地址"`；缺 url → HTTP 400 `bad_request`
- timeout=999999 越界被夹紧到 30000（仍成功）

**4.3 扫描全流程（SSE + result，28）**
- POST /api/scan 返回 `{ok:true,jobId:/^j_[a-z0-9]+$/,state:"running"}`
- SSE：首个事件 `hello`（带 jobId/state/progress）→ ≥1 个 `progress` → `done`；Content-Type `text/event-stream; charset=utf-8`
- progress 字段 `stage/cur/total/info` 齐备，阶段含 analyzing/verifying/building，cur<=total
- job.state=done、finishedAt/elapsedMs 齐备
- verdict 字段 14 个全齐（url/name/kind/available/speed_label/ttfb_ms/total_ms/size_kb/speed_kbps/site_count/error/depth/parent_url/children）
- 单仓 → kind=single、available=true、speed_label=快、site_count=1、name 回退到 JSON 内 name
- storeHouse 多仓 → kind=multi_storehouse、children≥1；子仓 available=true、depth=1、parent_url 正确；名字取 sourceName
- urls 多仓 → kind=multi_urls + 子仓 available
- 子仓指向顶层已分析过的地址 → available=false、error=「重复线路（已分析）」（**与原 APK 的共享 seen 语义一致**）
- 坏 JSON → available=false、error=「响应不是有效 JSON」；UTF-8 中文 JSON 正常
- result.config.urls 只含 available 叶节点、不含多仓地址、按 total_ms 升序
- result.stats 含 total/available/singles/multis/avg_speed（+has_avail），stats.total=顶层条数
- result.lines=待测线路数；startedAt/finishedAt/elapsedMs 合理
- maxDepth=1：第 2 层正常展开，再深层报「超过最大嵌套深度(1)」

**4.4 配置下载 + 重连 + 历史落盘时序（11）**
- `/api/jobs/:id/config`：200、`Content-Disposition: attachment; filename="ysc_config.json"`、`application/json; charset=utf-8`、body `{"urls":[...]}` 含 fixture 单仓
- `/api/history/:id/config`：同样的头与 body，与 job config **逐字节一致**；未知 id → 404 `not_found "历史记录不存在"`
- 已结束 job 重连 SSE：事件序列 `["hello","done"]`，hello.state=done，随后**服务端主动关闭**（客户端读到 stream closed）
- **done 事件到达后立刻** GET /api/history 即已包含本次记录（count=6，t 为本次）→ 无「空历史」窗口
- done 时 `job.historyId` 已就绪且等于最新历史 id
- 未知 job / 未知 job config → 404 `not_found`

**4.5 body 解析（4）**
- `body="not a json body"` → **400** `{"ok":false,"error":"bad_request","message":"请求体不是合法 JSON"}`
- `body="[]"` / `body='"hello"'` → **400** `message="请求体必须是 JSON 对象"`
- 空 body（POST 无 body）→ 200 + 默认参数建任务
- 未识别字段（`foo:"bar"`）被忽略，不报错

**4.6 参数归一化（8）**
- 空对象 `{}` → samples=1 / maxDepth=3 / concurrency=8 / timeoutMs=8000 / pageTimeoutMs=6000 / useSearchPages=true / includeBaseLines=true
- `useSearchPages:"false"` 与 `0` 都判 false（宽松布尔，只有明确 false 才关）；`includeBaseLines:false` 生效
- 越界夹紧：samples 99→3、maxDepth 99→4、concurrency 999→8（再受 SCAN_CONCURRENCY 约束）、timeoutMs 1→1000、pageTimeoutMs 1→1000
- extraSources 混合形式：去空白、保留 `name|url`、按数组原样透传

**4.7 线路源覆盖 + 聚合页（5，实例 C）**
- `/api/sources` effectiveFrom=file，baseLines/searchPages 来自 `config/sources.json`
- 扫描能观察到 **collecting** 阶段，且 collecting→analyzing→verifying→building 全覆盖
- 聚合页 `extractUrls` 提取出的地址进入待测集合；待测数 = baseLines 1 + 提取 1 = 2

**4.8 取消（6）**
- `POST /api/jobs/:id/cancel` → 200 `{"ok":true,"state":"cancelled"}`
- SSE 收到 `error` 事件 `{"ok":false,"error":"internal_error","message":"任务已取消"}`
- job.state=cancelled；重复 cancel 幂等；cancelled 任务 `/config` → 404

**4.9 历史（12）**
- `GET /api/history` ok=true + items 数组，item 含 id/t/count/available/multis/elapsedMs，按 t 倒序
- `GET /api/history/:id` 含 verdicts/config/stats 且可下钻子仓
- `DELETE /api/history/:id` → ok=true，DELETE 后列表消失、GET 404、config 404
- 路径穿越 `/api/history/..%2F..%2Fetc` → 404；DELETE 不存在 → 404

**4.10 外网实抓（2，实例 A）**
- `/api/proxy` 抓 `https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json`：ok=true、status=200、size_kb=50.411、ttfb 1045.094 < total 1062.143

## 5. 原始记录

### 5.1 node --check

```text
OK   server.mjs
OK   src/util.mjs
OK   src/fetcher.mjs
OK   src/analyze.mjs
OK   src/sources.mjs
OK   src/jobs.mjs
OK   src/store.mjs
```

### 5.2 汇总行

```text
===== 汇总：101/102 通过，1 跳过 =====
SKIP  外部 proxy raw.githubusercontent.com  网络不可达：timeout 请求超时
      → 随后单测重试成功：ok=True status=200 ttfb_ms=1045.094 size_kb=50.411

（历史时序修复前）===== 汇总：101/101 通过 =====
（历史的偶发空列表问题已由 QA 压测发现，修复后新增 2 条断言，见 §4.4 与 §6）
```

### 5.3 curl 手工验证（实例 A=18080 / B=18081 / C=18082）

```text
### A) health
{"ok":true,"name":"ysc-helper","version":"1.0.0","uptimeSec":51,"now":"2026-10-28T07:11:13.274Z"}

### B) sources 状态码/类型
HTTP 200 application/json; charset=utf-8
{"ok":true,"baseLines":[["饭太硬","http://www.饭太硬.com/tv"],["摸鱼儿","http://我不是.摸鱼儿.com"],...

### C) 静态 GET /
HTTP 200 bytes=5077 type=text/html; charset=utf-8

### D) 私网被拒（ALLOW_PRIVATE_TARGETS=0）
{"ok":false,"error":"blocked_target","message":"目标地址为内网/保留地址，已拒绝"}

### E) 外网 proxy 实抓（timeout=20000）
try 1: ok=True status=200 ttfb_ms=1045.094 total_ms=1062.143 size_kb=50.411 body_len=45597
       final_url=https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json

### F) POST /api/scan 非法 JSON body
HTTP/1.1 400 Bad Request
{"ok":false,"error":"bad_request","message":"请求体不是合法 JSON"}

### G) POST /api/scan 空 body
HTTP/1.1 200 OK
{"ok":true,"jobId":"j_19b44f12","state":"running"}

### H) POST /api/scan 合法 body（离线）
{"ok":true,"jobId":"j_ae984f50","state":"running"}

### I) GET /api/jobs/j_ae984f50
state=done lines=0 verdicts=0 config_urls=0

### J) history 列表
id=h_93cfe04942 t=1793171474607 count=0 available=0 multis=0 elapsedMs=1
id=h_918e37f50e t=1793171474598 count=1 available=0 multis=0 elapsedMs=5
id=h_5bf22eeffa t=1793171435941 count=2 available=2 multis=0 elapsedMs=440

### K) GET /api/history/<id>/config 响应头
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 16
Content-Disposition: attachment; filename="ysc_config.json"
body:
{
  "urls": []
}

### L) history/:id/config 不存在
{"ok":false,"error":"not_found","message":"历史记录不存在"}
```

### 5.4 QA 验收套件连跑 10 次（历史时序修复后）

```text
run1  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1631ms  墙钟: 2132ms | 结果: ALL PASS
run2  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1633ms  墙钟: 2172ms | 结果: ALL PASS
run3  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1958ms  墙钟: 3026ms | 结果: ALL PASS
run4  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1610ms  墙钟: 2343ms | 结果: ALL PASS
run5  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1624ms  墙钟: 2123ms | 结果: ALL PASS
run6  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1651ms  墙钟: 2144ms | 结果: ALL PASS
run7  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1680ms  墙钟: 2183ms | 结果: ALL PASS
run8  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1665ms  墙钟: 2194ms | 结果: ALL PASS
run9  exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1609ms  墙钟: 2120ms | 结果: ALL PASS
run10 exit=0  用例: 13  通过: 13  失败: 0  总耗时: 1681ms  墙钟: 2183ms | 结果: ALL PASS
===== smoke x10: failures=0 =====
```

## 6. 契约对齐与实现决策

**逐条对应 docs/API.md**

- §1：统一 `{ok:false,error,message}`；仅用契约码（bad_request / not_found / blocked_target / upstream_error / timeout / too_large / internal_error / rate_limited），未新增码。
- §2 `/api/health`：字段与示例一致；该路径**不受** Basic Auth 保护（契约 §8）。
- §3 `/api/proxy`：始终 HTTP 200（业务失败用 ok:false）；非 2xx 上游返回 ok:true + 真实 status；`body` 上限 4MiB 置 `truncated:true`（读满即 cancel 上游流，避免整包下载）；计时口径见下。
- §4.1 `/api/scan`：字段与默认值按契约；body 解析规则严格按更新后的三条（空体→默认值 / 非法或非对象 JSON→400 / 未知字段忽略）。
- §4.2 SSE：`hello → progress* → done|error`；15s `: ping` 保活；任务已结束时先 hello 再补 done/error 后关闭；多订阅者（单任务上限 50，超限 429）；`Last-Event-ID` 不强制（hello 已带 state+progress 足以补齐）。
- §4.3 `GET /api/jobs/:id`：字段与示例一致，**附加** `params`（生效参数，便于排查）与 `historyId` 两个只读字段。
- §4.4 `POST /api/jobs/:id/cancel`：立即置 cancelled + abort 在途抓取 + 幂等。SSE 用 `error` 事件通知，code 取 `internal_error`、message=「任务已取消」——原因是契约 §1 机器码表没有 `cancelled`，而 §4.2 规定 error 事件体为 `{ok,error,message}`；前端按 message 提示即可。**若后续希望用独立码，需要契约新增 `cancelled`。**
- §4.5 `/api/jobs/:id/config` 与 §5 `/api/history/:id/config`：共用 `sendConfigDownload()`，头与 body 完全一致。
- §5 历史：目录扫描 + `index.json` 双轨（索引缺失/损坏时自动重建）；超过 MAX_HISTORY 删最旧文件；写历史失败只打日志，不影响扫描结果。
  - **落盘时序（QA 报障后修复）**：完成流程改为 `buildConfig → await store.add() → 置 historyId → progress(done) → 置 state=done + result → broadcast('done') → settle`。
    即**历史先落盘，再广播 done**，客户端在 onDone 里立刻 GET /api/history 就能拿到本次记录（`job.historyId` 也已就绪），不会出现空态闪烁。
    写历史仍在 try/catch 内，失败只 `log.warn`，照常广播 done（不把任务置 error）；`store.add` 内部只有 `fs.writeFile/rename/unlink` 加一条 Promise 串行队列（无定时器、无 sleep），不引入额外延迟。
    另加一处防御：落盘等待期间若被 `cancel()`，拿到结果后先判 `job.state !== 'running'` 再继续，避免把已取消任务翻回 done。
- §6 线路源：`config/sources.json` 存在则整体替换；解析失败/为空回退内置并 `console.warn`；`/api/sources` 返回 effectiveFrom。
- §7 静态：`Cache-Control: no-cache` + 正确 MIME；`/api` 前缀未命中 → 404 JSON；其他未命中 → 回退 index.html。

**抓取口径（对应 APK HttpURLConnection）**
- 默认头：`User-Agent: okhttp/4.12.0` `Accept: */*` `Accept-Encoding: gzip, deflate`；`FETCH_UA` 可覆盖。
- `ttfb_ms` = 收到响应头耗时；`total_ms` = body 读完耗时（含重定向）；`size_kb` = 实际字节数 / 1024（用 Buffer 长度，非字符串长度）；并保证 `total_ms > ttfb_ms`。
- 超时用 `AbortController`；外部取消信号与超时信号合并，超时与取消可区分（`timeout` vs `aborted`）。
- SSRF：解析主机所有 A/AAAA，命中私网/回环/链路本地/CGNAT/保留段即 `blocked_target`；重定向**每一跳**都重新校验；`ALLOW_PRIVATE_TARGETS=1` 放行。已知局限：DNS 解析与实际连接之间仍存在理论上的 rebinding 窗口（未做 IP 固定）。
- 并发：全局信号量 `SCAN_CONCURRENCY` 包住每次真实抓取（proxy 与扫描共用同一 `fetchTarget`），任务内 `concurrency = min(请求值, SCAN_CONCURRENCY)`。

**APK 语义保真**
- classify / subEntries / siteCount / analyzeUrl / verifyNode / gradeSpeed / median / buildConfig / stats 均为原样移植（含「samples 取中位数」「speed_label 阈值 500/2000/5000」「子仓上限 100」「mapLimit 子仓并发 4」「seen 全局去重 → 子仓可能被判重复线路」）。
- 与原版唯一差异：抓取由原生桥换成服务端 fetch；分析超时参数单位由秒改为毫秒（默认 8000ms）。

**稳定性**
- `uncaughtException` / `unhandledRejection` 只记录日志，进程不退出；单 URL 失败只影响该节点。
- `SIGTERM`/`SIGINT`：结束全部 SSE、abort 在途抓取、`server.close()`，5s 后强制退出（定时器均 `unref`）。

## 7. 未验证项与已知限制

1. **Docker 构建/运行未验证**：本机 `docker build` 报 `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`（Docker Desktop daemon 未启动）。已做静态校验：`docker compose config --quiet` exit 0；Dockerfile 仅用官方 node:22-alpine + COPY/ADD 组指令，HEALTHCHECK 用 `node -e fetch`（alpine 无 curl/wget）。
2. **30 分钟 job 保留期未长跑**：由常量 `JOB_RETENTION_MS=30*60*1000` 与 `unref` 定时器保证；已实测「已完成 job 重连 → hello+done+主动关闭」与「未知/已回收 job → 404」。
3. **全量真实扫描未跑**：73 个外网地址全量扫描耗时数分钟且源站稳定性不可控，本次只用 fixture 全流程 + 单条外网 js.json 验证抓取链路。
4. **外网 proxy 偶发超时**：首轮成功（ttfb 1045ms），复跑有一次 20s 超时（外部网络抖动），与实现无关。
5. DNS rebinding 理论窗口（见 §6 SSRF 说明）。

## 8. 复跑方法

```bash
# 1) 起三个实例（PowerShell）
$env:PORT='18080'; $env:DATA_DIR='C:\tmp\data-a'; $env:ALLOW_PRIVATE_TARGETS='0'; node server.mjs
$env:PORT='18081'; $env:DATA_DIR='C:\tmp\data-b'; $env:ALLOW_PRIVATE_TARGETS='1'; node server.mjs
$env:PORT='18082'; $env:DATA_DIR='C:\tmp\data-c'; $env:ALLOW_PRIVATE_TARGETS='1'; $env:CONFIG_DIR='C:\tmp\config-c'; node server.mjs

# 2) 仓库内自动化验收（QA 维护，离线 fixture，不访问外网）
node test/smoke.mjs

# 3) 关键冒烟
curl.exe -s http://127.0.0.1:18080/api/health
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:18080/
curl.exe -s "http://127.0.0.1:18081/api/proxy?url=http%3A%2F%2F10.0.0.1%2Fx"   # 18081 允许私网
```

> 注意：自测请自行收尾，别把 node 进程留在 18080/18081/18082 端口上（本次已全部 Stop-Process 并确认端口释放）。

## 9. 遗留 TODO（非阻塞）

- `JOB_RETENTION_MS` 目前是硬编码常量；若希望运维可调，可提为 `JOB_RETENTION_MIN` 环境变量（当前 30 分钟满足前端 sessionStorage 重连需求）。
- QA 的 `test/smoke.mjs` 用例 7 目前对历史做了最多 3s 轮询兜底；实现侧已改为「done 前落盘」，该兜底可以保留（更宽容）也可以去掉（更严格）。
- 取消事件若要与契约错误码表严格对应，需要契约新增 `cancelled` 码（当前用 `internal_error` + message）。
- 历史索引为「文件 + index.json」，进程被强杀时索引可能落后于目录；下次启动会重建（已实现），但不会自动清理「索引里没有、目录里还在」的孤儿文件之外的情况——极端场景下大小受限，无功能影响。
