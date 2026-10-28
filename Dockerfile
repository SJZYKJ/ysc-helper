# 影视仓接口助手 · Web/Docker 版
# 零 npm 依赖：只用 Node 内置模块，无需 npm install
# 基础镜像可通过构建参数覆盖（国内网络拉不到 Docker Hub 时用镜像加速地址）：
#   docker build --build-arg BASE_IMAGE=docker.1ms.run/library/node:22-alpine -t ysc-helper:1.0.0 .
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    TZ=Asia/Shanghai

WORKDIR /app

# 服务端代码（无 node_modules）
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY config ./config

# 创建非 root 用户 nodejs(uid 10001)，并把应用目录/数据目录交给它
RUN addgroup -g 10001 -S nodejs \
 && adduser -u 10001 -S nodejs -G nodejs \
 && mkdir -p /app/data \
 && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8080
VOLUME ["/app/data"]

# alpine 无 curl/wget，直接用 node 打健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>r.json()).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
