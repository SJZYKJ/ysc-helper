# 影视仓接口助手 · Web / Docker 版

[![Docker Pulls](https://img.shields.io/docker/pulls/chungg/ysc-helper)](https://hub.docker.com/r/chungg/ysc-helper)
[![Image Size](https://img.shields.io/docker/image-size/chungg/ysc-helper/latest)](https://hub.docker.com/r/chungg/ysc-helper)
[![GitHub Workflow Status](https://img.shields.io/github/actions/workflow/status/SJZYKJ/ysc-helper/docker-publish.yml?label=build)](https://github.com/SJZYKJ/ysc-helper/actions)

镜像已发布，可直接用，不用自己构建：

```bash
docker pull chungg/ysc-helper:latest          # Docker Hub
docker pull ghcr.io/sjzykj/ysc-helper:latest  # GitHub Container Registry（CI 自动构建）
```

一行起服务（数据在 `/root/ysc`、对外 3080、带 Basic Auth，详见 [docs/DEPLOY.md](docs/DEPLOY.md)）：

```bash
mkdir -p /root/ysc && chown -R 10001:10001 /root/ysc
docker run -d --name ysc-helper -p 3080:8080 -v /root/ysc:/app/data \
  -e TZ=Asia/Shanghai -e BASIC_AUTH='用户名:密码' \
  --restart unless-stopped chungg/ysc-helper:latest
```

把原 `影视仓接口助手_1.0.apk`（82 KB 的 WebView 壳 + 单文件 HTML）改造成**不依赖 Android、可网页访问、可 Docker 部署**的服务。

原 APK 的全部逻辑都在 `assets/index.html` 里：抓取公开线路 → 递归识别单仓/多仓 → 多采样测速 → 生成影视仓可直接导入的 `{"urls":[...]}` 配置。
其中"抓取"依赖 Java 桥 `YscAndroid.captureAsync` 来绕过浏览器 CORS —— 这正是它不能直接当网页用的根因。

Web 版把这一步挪到服务端：**零依赖 Node 服务端**负责抓取/分析/测速/持久化，浏览器只管 UI。

```
浏览器 (public/)  ──HTTP + SSE──▶  Node 服务端 (server.mjs + src/)  ──HTTPS──▶  各线路源站
```

## 特性

- **零 npm 依赖**：只用 Node 内置模块，`npm install` 都不用跑；镜像 240 MB（几乎全是 `node:22-alpine` 基础层）。
- **服务端扫描**：扫描在后台 job 里跑，页面刷新/关掉都不中断；SSE 实时推送阶段、百分比与当前 URL。
- **不再受 CORS 限制**：服务端直连源站，抓取能力与 APK 原生桥等价。
- **服务端历史**：结果落盘到 `DATA_DIR`，换设备/换浏览器也能恢复，最多保留 `MAX_HISTORY` 条。
- **多仓递归展开**：与原版一致，最多 4 层、每层 100 个子仓。
- **可配置线路源**：内置基础线路 + 聚合页，支持 `config/sources.json` 覆盖，或在界面「高级选项」里临时追加。
- **SSRF 防护**：默认拒绝内网/回环地址，避免把代理接口暴露成内网探测工具。

## 界面

| 任务页（移动端） | 结果页（移动端） |
|---|---|
| ![任务页](docs/screenshots/task-mobile.png) | ![结果页](docs/screenshots/result-mobile.png) |

| 扫描中（SSE 实时进度） | 实时结果（含子仓展开） |
|---|---|
| ![进度](docs/screenshots/progress-mobile.png) | ![实时结果](docs/screenshots/live-result-mobile.png) |

| 结果页（桌面端） | 深色模式 |
|---|---|
| ![桌面端](docs/screenshots/result-desktop.png) | ![深色](docs/screenshots/result-desktop-dark.png) |

## 目录结构

```
.
├─ server.mjs            # HTTP 入口：路由 / 静态 / SSE / Basic Auth
├─ src/
│  ├─ fetcher.mjs        # 计时抓取 + 超时 + 体积截断 + SSRF 防护
│  ├─ analyze.mjs        # 类型识别、递归展开、测速、配置生成
│  ├─ sources.mjs        # 内置线路与聚合页（config/sources.json 可覆盖）
│  ├─ jobs.mjs           # 扫描任务与进度事件
│  ├─ store.mjs          # 历史持久化
│  └─ util.mjs           # URL/JSON/并发工具
├─ public/               # 前端（index.html + style.css + app.js，无构建）
├─ test/smoke.mjs        # 离线端到端验收测试
├─ config/
│  └─ sources.example.json # 复制为 sources.json 即可覆盖内置线路源
├─ data/                 # 运行期生成：历史记录（Docker 用命名卷 ysc-data）
├─ docs/
│  ├─ API.md             # 接口契约（前后端唯一约定）
│  ├─ backend-selftest.md# 服务端自测报告
│  └─ screenshots/       # 界面截图
├─ reference/apk/        # 原 APK 解包产物（仅存档对照，不参与运行）
├─ Dockerfile
└─ docker-compose.yml
```

## 本地运行

需要 Node.js ≥ 20（推荐 22 LTS），**无需 npm install**。

```bash
node server.mjs
# 打开 http://127.0.0.1:8080
```

自定义端口 / 数据目录：

```bash
PORT=9000 DATA_DIR=./data node server.mjs     # Linux / macOS
```
```powershell
$env:PORT=9000; node server.mjs               # Windows PowerShell
```

## Docker 部署

> 下面示例按"宿主机数据目录 `/root/ysc`、对外端口 `3080`"写。端口映射格式是 `-p 宿主:容器`，
> 容器内固定监听 8080，所以自定义端口只改冒号**左边**。完整服务器清单见 [docs/DEPLOY.md](docs/DEPLOY.md)。

### 方式一：一条命令版（服务器上最常用）

```bash
# 数据挂宿主机 /root/ysc，宿主 3080 → 容器 8080，开 Basic Auth 供外网访问
mkdir -p /root/ysc
chown -R 10001:10001 /root/ysc        # 容器内是非 root(uid 10001)，不改属主历史写不进去

docker run -d --name ysc-helper \
  -p 3080:8080 \
  -v /root/ysc:/app/data \
  -e TZ=Asia/Shanghai \
  -e BASIC_AUTH='用户名:密码' \
  --restart unless-stopped \
  chungg/ysc-helper:latest

# 打开 http://<服务器IP>:3080
```

不想管目录属主就换命名卷（数据在 Docker 卷 `ysc-data` 里，开箱即用）：

```bash
docker run -d --name ysc-helper \
  -p 3080:8080 \
  -v ysc-data:/app/data \
  -e TZ=Asia/Shanghai \
  -e BASIC_AUTH='用户名:密码' \
  --restart unless-stopped \
  chungg/ysc-helper:latest
```

### 方式二：compose 版（长期维护推荐）

用宿主机目录 `/root/ysc` 持久化、对外 3080 —— 把 `docker-compose.yml` 换成：

```yaml
services:
  ysc-helper:
    image: chungg/ysc-helper:latest
    container_name: ysc-helper
    ports:
      - "3080:8080"
    environment:
      TZ: Asia/Shanghai
      BASIC_AUTH: "${BASIC_AUTH:?请先在 .env 里设置 BASIC_AUTH}"
    volumes:
      - /root/ysc:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 5s
      retries: 3
```

同目录放 `.env`：

```bash
BASIC_AUTH=用户名:密码
```

启动与升级：

```bash
mkdir -p /root/ysc && chown -R 10001:10001 /root/ysc
docker compose up -d

# 以后升级（历史数据在 /root/ysc 里，不受影响）
docker compose pull && docker compose up -d
```

> 仓库自带的 `docker-compose.yml` 是**本地构建**版（`build:` + 命名卷 `ysc-data` + `.env.example` 模板），
> 要改代码或换内置线路源时用那个：`cp .env.example .env` 后 `docker compose up -d --build`。
>
> **为什么容器内是非 root**：镜像里用 `nodejs`(uid/gid 10001) 运行，绑定挂载宿主机目录时必须先 `chown`
> 把属主改成 10001，否则历史记录写不进去（页面照常能用，只是历史静默失败）。命名卷则无需处理。

### 方式三：自己构建镜像（改代码 / 换内置线路源时用）

```bash
docker build -t ysc-helper:1.0.0 .
docker run -d --name ysc-helper \
  -p 8080:8080 \
  -v ysc-data:/app/data \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  ysc-helper:1.0.0
```

（要挂宿主机目录就换成 `-v /root/ysc:/app/data`，并先 `sudo chown -R 10001:10001 /root/ysc`；
想对外开 Basic Auth 再加 `-e BASIC_AUTH='user:pass'`；端口同理加 `-p 3080:8080`。）

**拉不到基础镜像时**（Docker Hub 在国内常超时）：基础镜像可用构建参数替换，例如

```bash
BASE_IMAGE=docker.1ms.run/library/node:22-alpine docker compose up -d --build
# 或
docker build --build-arg BASE_IMAGE=docker.1ms.run/library/node:22-alpine -t ysc-helper:1.0.0 .
```

### 反向代理（可选）

对外的 3080 一般再套一层 HTTPS（Basic Auth 是明文）。注意 **SSE 不能缓冲**，否则进度条会一直卡在 0%：

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;              # 关键：SSE 必须关闭缓冲
    proxy_read_timeout 3600s;
}
```

Caddy 默认不缓冲，直接 `reverse_proxy 127.0.0.1:3080` 即可（自动签证书）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 历史落盘目录 |
| `ALLOW_PRIVATE_TARGETS` | `0` | `1` = 允许抓内网/回环地址 |
| `SCAN_CONCURRENCY` | `8` | 全局最大并发抓取数 |
| `REQUEST_TIMEOUT_MS` | `8000` | 单次抓取默认超时 |
| `MAX_HISTORY` | `20` | 历史保留条数（超出删最旧） |
| `MAX_RUNNING_JOBS` | `8` | 同时运行的扫描任务上限 |
| `BASIC_AUTH` | 空 | `user:pass`，非空则启用 HTTP Basic 认证 |
| `FETCH_UA` | `okhttp/4.12.0` | 抓取时使用的 User-Agent（与原 APK 一致） |
| `CONFIG_DIR` | `./config` | 线路源覆盖文件目录 |
| `PUBLIC_DIR` | `./public` | 前端静态目录 |
| `TZ` | `Asia/Shanghai` | 容器时区 |

**公网部署务必设置 `BASIC_AUTH`**：这个页面会把服务端变成通用 HTTP 抓取器。

## 测试

```bash
node test/smoke.mjs
```

完全离线（自建 fixture 源站，不访问外网），13 个用例覆盖抓取/SSRF/扫描/SSE/配置下载/历史/鉴权/错误码。

容器内复跑（镜像里不含 `test/`，用挂载即可）：

```bash
docker run --rm -v "$PWD:/app" -w /app --entrypoint node ysc-helper:1.0.0 test/smoke.mjs
```

Windows PowerShell 下 `npm test` 可能被执行策略拦截，直接用 `node test/smoke.mjs` 最稳。

## 与 APK 版的差异

| 能力 | APK 版 | Web 版 |
|---|---|---|
| 抓取 | Java 桥 `captureAsync`（绕 CORS） | 服务端直连，能力等价 |
| 运行位置 | 手机本地 | 服务端（可 7×24） |
| 页面关闭 | 任务中断 | 任务继续，重连即见 |
| 结果存储 | `localStorage`（本机 8 条） | 服务端磁盘（多设备共享） |
| 配置下载 | 系统「另存为」对话框 | 浏览器下载 / 复制 JSON |
| 网络要求 | 手机直连 | 服务器可出网（国内源站建议境外/国内均可达的出口） |

## 已知限制

- 线路源多为第三方公益地址，**随时可能失效**；失效条目前会标红并显示原因（超时 / HTTP 4xx / 非 JSON / 结构不可识别）。
- 单次全量扫描（约 90 条基础线路 + 聚合页提取）耗时取决于源站响应，慢源会拖长整体时间；可调小超时或减少并发等待。
- 速度分级沿用原版阈值：< 500 ms 快、< 2000 ms 中、< 5000 ms 慢，其余不可用。
- **任务状态在内存里**：服务重启/容器重建后，运行中的任务会丢失（`GET /api/jobs/:id` 返回 404），
  已完成的扫描结果因为落盘到历史而保留。长时间无人值守时不必担心，重启只需重跑一次。
- 抓取的是公开配置，请自行判断内容合法性与使用风险。

## 网络与代理

- 服务端**不支持 HTTP(S) 代理环境变量**（Node 内置 fetch 无代理支持），需要代理的出口请用 TUN/透明代理，
  或 `docker run --network host` 配合宿主机代理规则。
- 国内线路源大多可直连；`raw.githubusercontent.com` / `gitlab.com` 一类源站经常超时，
  这类条目会被标为不可用并显示原因（超时 / ETIMEDOUT / 域名解析失败 / 响应不是有效 JSON），属预期表现，多跑几次可用性会变化。
- 抓取并发由 `SCAN_CONCURRENCY` 全局限制（默认 8），源站敏感时可下调，避免被限流或拉黑。

## 发布镜像 / 同步到 GitHub

仓库已接入 CI：push 到 `main` 会自动构建并发布到 **GHCR**
（`ghcr.io/<用户名>/ysc-helper:latest`，另带 `:sha-xxxxxxx` 与版本 tag）。

本机推 Docker Hub 用脚本（交互式输入 Access Token，不会把 token 写进任何文件）：

```powershell
.\scripts\publish-dockerhub.ps1 -User <your-dockerhub-id>
```
```bash
./scripts/publish-dockerhub.sh <your-dockerhub-id>
```

手工等价的命令（把 `<your-dockerhub-id>` 换成你的账号）：

```bash
docker login -u <your-dockerhub-id>
docker tag ysc-helper:1.0.0 <your-dockerhub-id>/ysc-helper:1.0.0
docker tag ysc-helper:1.0.0 <your-dockerhub-id>/ysc-helper:latest
docker push <your-dockerhub-id>/ysc-helper:1.0.0
docker push <your-dockerhub-id>/ysc-helper:latest
# 别处部署：docker run -d -p 8080:8080 -v ysc-data:/app/data <your-dockerhub-id>/ysc-helper:latest
```

推到 GitHub 后，`.github/workflows/docker-publish.yml` 会在 push 到 `main`、打 `v*` 标签或手动触发时
自动构建并推 Docker Hub。需要在仓库 Settings → Secrets 里配置：

| Secret | 说明 |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（Read & Write，**不要用账号密码**） |

不配任何 secret 也能用：工作流默认把镜像推到 **GHCR**（GitHub 自带镜像仓库），地址为
`ghcr.io/<用户名>/ysc-helper:latest`，用仓库自带的 `GITHUB_TOKEN` 认证，无需额外配置。

```bash
docker pull ghcr.io/<用户名>/ysc-helper:latest
```

注意：GHCR 包首次发布后默认是 **Private**，需要在仓库首页右侧 Packages 里把包的可见性改成 Public，
否则别人（以及没登录的机器）`docker pull` 会 401。

## 许可

仅用于个人学习与网络自检。原 APK 版权归其作者。
