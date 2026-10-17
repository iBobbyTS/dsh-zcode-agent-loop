#!/bin/sh
# 容器入口：计算本容器 eth0 的具体 IPv4（dsh web 拒绝通配绑定），再以
# --public-url 通告宿主侧发布地址，使启动行打出的带 token 链接可直接使用。
set -eu

: "${PORT:=8377}"
: "${PUBLIC_URL:=http://127.0.0.1:8391}"

AUTHORITY="${PUBLIC_URL#http://}"
AUTHORITY="${AUTHORITY#https://}"
AUTHORITY="${AUTHORITY%/}"
LOCAL_PORT="${AUTHORITY##*:}"

HOST_IP=$(node -e '
const os = require("os");
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const addr of addrs ?? []) {
    if (addr.family === "IPv4" && !addr.internal) { process.stdout.write(addr.address); process.exit(0); }
  }
}
process.stdout.write("127.0.0.1");
')

mkdir -p /data/workspace
cd /data/workspace

exec node /opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web \
  --patch /data/patches/repo.patch.yml \
  --patch /data/patches/web-overlay.yml \
  --host "$HOST_IP" \
  --port "$PORT" \
  --no-open \
  --public-url "$PUBLIC_URL" \
  --trusted-host "$AUTHORITY" \
  --trusted-host "localhost:${LOCAL_PORT}"
