# 影视仓接口助手 · Web/Docker 版接口契约（v1）

> 本文件是前后端并行开发的唯一契约。任何一方改动接口，必须先改本文件。
> 原 APK = 单文件 WebView 页面（`reference/apk/assets/index.html`），靠 `window.YscAndroid.captureAsync` 绕过 CORS 抓取。
> Web 版改为：**零依赖 Node 服务端**承担抓取/分析/测速/持久化，前端只做 UI。

## 0. 总体设计

```
浏览器 (public/*)  ──HTTP/SSE──▶  Node 服务端 (server.mjs + src/*)  ──HTTPS──▶ 各线路源站
```

- 服务端零 npm 依赖，仅用 Node 内置模块（`node:http` / `fetch` / `node:fs`）。Node >= 20。
- 扫描在服务端以「任务(job)」形式执行，前端通过 SSE 订阅进度；刷新/关页不丢任务。
- 结果落盘到 `DATA_DIR`（默认 `./data`），形成服务端历史，多设备共享。

## 1. 通用约定

- 所有 API 前缀 `/api`，请求/响应均为 UTF-8 JSON（`Content-Type: application/json; charset=utf-8`）。
- 错误响应：HTTP 4xx/5xx + `{"ok":false,"error":"<机器码>","message":"<人话>"}`。
  机器码取值：`bad_request` `not_found` `blocked_target` `upstream_error` `timeout` `too_large` `internal_error` `rate_limited`。
- 成功响应一律带 `"ok":true`。
- 所有对外 URL 参数必须 `encodeURIComponent`。

## 2. 健康检查

`GET /api/health` → `{"ok":true,"name":"ysc-helper","version":"1.0.0","uptimeSec":123,"now":"2026-10-28T07:00:00.000Z"}`

## 3. 单地址抓取（CORS 代理）

`GET /api/proxy?url=<enc>&timeout=<ms,可选,默认8000,范围1000..30000>`

成功：
```json
{"ok":true,"status":200,"body":"<原始文本>","final_url":"https://...","ttfb_ms":123.4,
 "total_ms":456.7,"size_kb":51.6,"content_type":"application/json","truncated":false}
```

失败（HTTP 仍为 200，业务失败用 ok:false 表示，便于前端统一处理）：
```json
{"ok":false,"error":"timeout","message":"请求超时"}
```
- `body` 上限 4 MiB，超出置 `truncated:true`。
- 非 2xx 上游：`ok:true` 且带真实 `status`（与原 APK 语义一致，交由前端判断 >=400）。
- SSRF 防护：默认拒绝私网/回环/链路本地/保留地址（见 §8）。

## 4. 任务（扫描）

### 4.1 创建任务

`POST /api/scan` body：
```json
{
  "samples": 1,
  "maxDepth": 3,
  "concurrency": 8,
  "timeoutMs": 8000,
  "pageTimeoutMs": 6000,
  "extraSources": ["http://example.com/tv", "饭太硬|http://www.饭太硬.com/tv"],
  "useSearchPages": true,
  "includeBaseLines": true
}
```
- 全部字段可选。`samples` 1..3（默认1）；`maxDepth` 0..4（默认3）；`concurrency` 1..32（默认8）。
- `extraSources`：字符串数组，`url` 或 `name|url`。**始终包含**在待测列表里。
- **body 解析规则**（避免"静默退化为默认参数然后真去抓 73 个外网地址"的隐性失败）：
  - 空 body / 无 `Content-Type` 且 body 为空 → 视为全部默认值，200 正常建任务；
  - 非空但**非法 JSON**，或解析结果不是对象（数组/字符串/数字） → `400 {"ok":false,"error":"bad_request"}`，
    **绝不**退化成默认参数建任务；
  - 合法对象中的未知字段一律忽略，不报错。
- `useSearchPages`：是否抓取聚合页并 `extractUrls`（默认 true）。**不影响** `baseLines`。
- `includeBaseLines`：是否带上内置基础线路 `BASE_LINES`（默认 true）。置 false 时只用 `extraSources`，
  用于离线测试/只测自建源。三个开关互相独立，语义不相干：
  `待测集合 = (includeBaseLines ? BASE_LINES : []) ∪ extraSources ∪ (useSearchPages ? extractUrls(聚合页) : [])`

响应：`{"ok":true,"jobId":"j_1a2b3c4d","state":"running"}`

### 4.2 订阅进度（SSE）

`GET /api/jobs/:id/events` → `text/event-stream`，事件：

| event | data |
|---|---|
| `hello` | `{"jobId":"...","state":"running|done|error|cancelled","progress":{...}}` 连接即发，用于补齐/断线重连 |
| `progress` | `{"stage":"...","cur":12,"total":90,"info":"正在处理：http://..."}` |
| `log` | `{"level":"info|warn|error","msg":"..."}` |
| `done` | 与 §4.3 的 result 同构 |
| `error` | `{"ok":false,"error":"...","message":"..."}` |

- 每 15s 发送一次注释行 `: ping` 保活。
- 任务已结束时，连接仍会先发 `hello` 再发 `done`（或补发历史进度）后关闭。
- `progress.stage` 取值：`collecting`（搜集线路） `analyzing`（分析结构） `verifying`（测速验证） `building`（生成配置） `done`。

### 4.3 查询任务

`GET /api/jobs/:id` →
```json
{"ok":true,"id":"j_x","state":"running|done|error|cancelled",
 "createdAt":1700000000000,"finishedAt":null,
 "progress":{"stage":"analyzing","cur":5,"total":90,"info":"..."},
 "error":null,
 "result": { ...见下... } }
```

**result 结构（前后端共用，勿改字段名）**
```json
{
  "verdicts": [
    {"url":"https://a/b.json","name":"某某","kind":"single|multi_storehouse|multi_urls|unknown",
     "available":true,"speed_label":"快|中|慢|不可用",
     "ttfb_ms":120.5,"total_ms":480.2,"size_kb":51.6,"speed_kbps":142.0,
     "site_count":12,"error":"","depth":0,"parent_url":"","children":[]}
  ],
  "config": {"urls":[{"name":"某某","url":"https://a/b.json"}]},
  "stats": {"total":12,"available":8,"singles":6,"multis":2,"avg_speed":480.2,"has_avail":true},
  "startedAt":1700000000000,"finishedAt":1700000006000,"elapsedMs":60000,
  "lines":1
}
```
- `verdicts` 是顶层数组，子仓在 `children` 里递归；`stats.total` = 顶层条数。
- `stats.has_avail`：是否存在任一可用线路（布尔）。属**可选扩展字段**，前端不得因此出错；
  除 `total/available/singles/multis/avg_speed/has_avail` 外的键一律视为内部字段。

### 4.4 取消任务
`POST /api/jobs/:id/cancel` → `{"ok":true,"state":"cancelled"}`

### 4.5 下载配置
`GET /api/jobs/:id/config` → 直接返回文件下载，头：
`Content-Type: application/json; charset=utf-8`，`Content-Disposition: attachment; filename="ysc_config.json"`。
body 为 `{"urls":[...]}`（经 `cleanSourceUrl` 清洗）。

## 5. 历史记录（服务端持久化）

- `GET /api/history` → `{"ok":true,"items":[{"id":"h_x","t":1700000000000,"count":12,"available":8,"multis":2,"elapsedMs":60000}]}`（按 t 倒序，最多 20 条）
- `GET /api/history/:id` → `{"ok":true,"id":"h_x","t":...,"count":..,"available":..,"multis":..,"verdicts":[...],"config":{...},"stats":{...}}`
- `GET /api/history/:id/config` → 直接返回文件下载，头与 §4.5 完全一致（`ysc_config.json`）。
  用于「历史恢复后下载配置」，避免前端用 Blob 兜底、行为与实时任务不一致。
- `DELETE /api/history/:id` → `{"ok":true}`
- 扫描成功（state=done）自动写入历史；写入失败不得影响扫描结果。

## 6. 线路源

- 内置基础线路与聚合页定义在 `src/sources.mjs`（从 APK 移植，保持原样）。
- 可选覆盖文件 `config/sources.json`：
  ```json
  {"baseLines":[["名称","url"]],"searchPages":["https://..."]}
  ```
  存在则整体替换内置值；文件损坏时回退内置并打日志。
- `GET /api/sources` → `{"ok":true,"baseLines":[[n,u]],"searchPages":[u],"effectiveFrom":"builtin|file"}`

## 7. 静态资源

- `GET /` → `public/index.html`
- `GET /app.js` `/style.css` `/icon.png` → 对应文件
- 其它未知路径：若是 `/api` 前缀返回 404 JSON；否则回退 index.html（SPA）。
- 静态响应带 `Cache-Control: no-cache`（便于迭代）与正确 MIME。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DATA_DIR` | ./data | 历史/缓存落盘目录 |
| `ALLOW_PRIVATE_TARGETS` | 0 | 1=允许抓取内网/回环地址（默认拒绝） |
| `SCAN_CONCURRENCY` | 8 | 服务端最大并发抓取数（任务内上限也受此值约束） |
| `REQUEST_TIMEOUT_MS` | 8000 | 单次抓取默认超时 |
| `MAX_HISTORY` | 20 | 历史保留条数 |
| `TZ` | Asia/Shanghai | 容器时区 |
| `BASIC_AUTH` | 空 | 形如 `user:pass`，非空时对所有非 /api/health 请求启用 HTTP Basic 认证 |

## 9. 前端要求

- 保留原 APK 的三 Tab（任务/结果/历史）+ 配色主题（浅色默认，深色跟随 `prefers-color-scheme`）。
- 点击「全网搜寻和验证」→ `POST /api/scan` → 打开 SSE 显示实时进度（阶段/百分比/当前 URL）→ done 后渲染结果树 → 自动切到「结果」页。
- 结果页筛选（关键词/类型/状态/速度）、统计卡、可用/不可用徽标、多仓折叠子仓（与原版一致）。
- 「下载配置」→ 直接跳转 `/api/jobs/:id/config`（浏览器下载），并提供「复制 JSON」。
- 历史页读写 `/api/history`，支持恢复/删除。
- 断线重连：SSE 断开后重连一次，并 `GET /api/jobs/:id` 校正状态。
- 移动端优先（`max-width:760px` 居中），桌面端不破版。
- 不得依赖 Android 桥（`window.YscAndroid` 相关代码全部移除，仅在注释中说明）。

## 10. 验收测试（`npm test`）

`test/smoke.mjs` 自起一个本地 fixture 源站（返回单仓/多仓/坏 JSON/超时四类响应）+ 目标服务，断言：

1. `/api/health` 200 且 ok。
2. `/api/proxy` 对 fixture 返回正确 status/size/ttfb>0；对私网地址返回 `blocked_target`（`ALLOW_PRIVATE_TARGETS=0` 时）。
3. `POST /api/scan`（`useSearchPages:false` + `includeBaseLines:false` + `extraSources` 指向 fixture）→ 完全离线；
   SSE 能收到至少 1 个 progress 与 done；result 中单仓 `kind=single` 且 `available=true`，多仓 `children` 非空，坏 JSON 项 `available=false`。
   （`useSearchPages` 只关聚合页，故测试必须同时传 `includeBaseLines:false` 才不得访问外网。）
4. `/api/jobs/:id/config` 返回 `{"urls":[...]}` 且含 fixture 单仓地址。
5. 历史写入后可 `GET /api/history` 列出、`GET /api/history/:id` 可取详情、
   `GET /api/history/:id/config` 返回 attachment 且含 fixture 地址、`DELETE` 后消失。
6. 静态页 `GET /` 200 且含 `影视仓`。
