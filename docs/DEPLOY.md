# 服务器部署清单（外网访问 / 自定端口 / 宿主机目录）

面向"在一台有公网 IP 的 Linux 服务器上长期运行"的场景。镜像已发布，不需要构建。

示例约定：宿主机数据目录 `/root/ysc`，对外端口 `3080`（容器内固定 8080）。

## 1. 一条命令版

```bash
# 数据目录挂到宿主机 /root/ysc，宿主端口 3080 → 容器 8080，开 Basic Auth 给外网用
mkdir -p /root/ysc
chown -R 10001:10001 /root/ysc          # 容器内是非 root(uid 10001)，不改属主历史写不进去

docker run -d --name ysc-helper \
  -p 3080:8080 \
  -v /root/ysc:/app/data \
  -e TZ=Asia/Shanghai \
  -e BASIC_AUTH='用户名:密码' \
  --restart unless-stopped \
  chungg/ysc-helper:latest

# 打开 http://<服务器IP>:3080
```

不想处理目录属主就用命名卷（数据在 Docker 自己的卷里，开箱即用）：

```bash
docker run -d --name ysc-helper \
  -p 3080:8080 \
  -v ysc-data:/app/data \
  -e TZ=Asia/Shanghai \
  -e BASIC_AUTH='用户名:密码' \
  --restart unless-stopped \
  chungg/ysc-helper:latest
```

## 2. compose 版（长期维护推荐）

`docker-compose.yml`：

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

同目录 `.env`：

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

## 3. 验证

```bash
docker ps --filter name=ysc-helper                  # 应显示 (healthy)
curl -s http://127.0.0.1:3080/api/health            # 健康检查免认证，返回 {"ok":true,...}
curl -s -u '用户名:密码' http://127.0.0.1:3080/api/history
docker exec ysc-helper ls -la /app/data/history     # 属主应为 nodejs
```

跑一次扫描后，`/root/ysc/history/` 下会出现 `h_xxxxxxxxxx.json` 与 `index.json` —— 这两个文件出现，就说明挂载与权限都对了。

## 4. 开放端口

```bash
ufw allow 3080/tcp                                      # Ubuntu / Debian
firewall-cmd --permanent --add-port=3080/tcp && firewall-cmd --reload   # CentOS / RHEL
ss -lntp | grep 3080                                    # 先确认端口没被占用
```

云服务器还要在**安全组**里放行 3080/tcp。

## 5. 反向代理 + HTTPS（强烈建议）

Basic Auth 是明文传输，长期跑公网建议套一层 HTTPS。注意 **SSE 不能缓冲**，否则进度条会卡在 0%。

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

## 6. 安全

- **必须设置 `BASIC_AUTH`**：这个服务本质是一个通用 HTTP 抓取器，裸奔等于把代理借给别人。
- SSRF 防护默认开启（`ALLOW_PRIVATE_TARGETS=0`），内网 / 回环地址会被拒绝；**不要**为了"多抓点"把它设成 1。
- 密码避免用 `!`、`$` 等 shell 特殊字符，或整体用单引号包住 `-e BASIC_AUTH='user:pass'`。

## 7. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 扫描完没有历史记录 | `/root/ysc` 属主不对（容器内 uid 10001 写不进去）。`chown -R 10001:10001 /root/ysc` 后重启容器 |
| 启动即退出 | `docker logs ysc-helper` 看日志；常见是端口被占用或 `BASIC_AUTH` 格式不是 `user:pass` |
| 页面能开、进度条不动 | 走了反向代理且没关 `proxy_buffering` |
| 一直 401 | 浏览器缓存的旧凭据；换无痕窗口，或检查 `BASIC_AUTH` 里没有多余空格 |
| 扫描全是"超时/ETIMEDOUT" | 服务器到源站网络问题；线路源本身也常年失效，换时间重试或多加自定义线路 |
| 大量 "域名解析失败" | 容器 DNS 异常；`docker run` 加 `--dns 223.5.5.5` |

## 8. 备份

历史记录就是 `/root/ysc/history/` 下的 JSON 文件，直接打包即可：

```bash
tar czf ysc-history-$(date +%F).tar.gz -C /root/ysc history
```

恢复时解回同一路径，重启容器即生效。
