# 把本地已构建的镜像推送到你的 Docker Hub
# 用法：
#   .\scripts\publish-dockerhub.ps1 -User <你的DockerHub用户名>
#   .\scripts\publish-dockerhub.ps1 -User <用户名> -Version 1.0.0
# 首次运行会交互式要求输入 Access Token（Docker Hub → Account settings → Security → New Access Token，Read & Write）
param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Version = "1.0.0",
  [string]$Source = "ysc-helper:$Version"
)

$ErrorActionPreference = "Stop"
$repo = "$User/ysc-helper"

Write-Host "==> 检查本地镜像 $Source" -ForegroundColor Cyan
docker image inspect $Source *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "本地没有 $Source，先构建：docker build -t $Source ." -ForegroundColor Yellow
  exit 1
}

Write-Host "==> 登录 Docker Hub（用户名 $User）" -ForegroundColor Cyan
docker login -u $User
if ($LASTEXITCODE -ne 0) { Write-Host "登录失败，已中止" -ForegroundColor Red; exit 1 }

Write-Host "==> 打标签" -ForegroundColor Cyan
docker tag $Source "${repo}:${Version}"
docker tag $Source "${repo}:latest"

Write-Host "==> 推送（镜像约 240MB，首次较慢）" -ForegroundColor Cyan
docker push "${repo}:${Version}"
docker push "${repo}:latest"

Write-Host "==> 完成" -ForegroundColor Green
Write-Host "   docker pull ${repo}:latest"
Write-Host "   docker run -d -p 8080:8080 -v ysc-data:/app/data ${repo}:latest"
