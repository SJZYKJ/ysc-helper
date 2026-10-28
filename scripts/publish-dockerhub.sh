#!/usr/bin/env bash
# 把本地已构建的镜像推送到你的 Docker Hub
#   ./scripts/publish-dockerhub.sh <你的DockerHub用户名> [版本号]
# 首次运行会交互式要求输入 Access Token（Docker Hub → Account settings → Security → New Access Token，Read & Write）
set -euo pipefail
USER_NAME="${1:?用法: ./scripts/publish-dockerhub.sh <用户名> [版本]}"
VERSION="${2:-1.0.0}"
SOURCE="ysc-helper:${VERSION}"
REPO="${USER_NAME}/ysc-helper"

if ! docker image inspect "${SOURCE}" >/dev/null 2>&1; then
  echo "本地没有 ${SOURCE}，先构建：docker build -t ${SOURCE} ." >&2
  exit 1
fi

echo "==> 登录 Docker Hub（${USER_NAME}）"
docker login -u "${USER_NAME}"

echo "==> 打标签"
docker tag "${SOURCE}" "${REPO}:${VERSION}"
docker tag "${SOURCE}" "${REPO}:latest"

echo "==> 推送（约 240MB，首次较慢）"
docker push "${REPO}:${VERSION}"
docker push "${REPO}:latest"

echo "==> 完成"
echo "   docker pull ${REPO}:latest"
echo "   docker run -d -p 8080:8080 -v ysc-data:/app/data ${REPO}:latest"
