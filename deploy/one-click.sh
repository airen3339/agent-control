#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

PUBLIC_URL=""
CF_TOKEN=""
HOST_LABEL="My Workstation"
RELAY_KEY_INPUT=""

usage() {
  cat <<'EOF'
Agent Control 中继服务一键容器部署脚本 (Docker Compose)

用法:
  ./deploy/one-click.sh --url <公网HTTPS地址> [选项]

选项:
  --url <url>        中继公网 HTTPS 地址（必填，如 https://relay.example.com）
  --cf-token <token> 可选：Cloudflare Named Tunnel Token（无需开放服务器 80/443 入站端口）
  --relay-key <key>  可选：自定义 RELAY_KEY（默认自动生成 64 位随机密钥）
  --label <name>     可选：生成首个配对邀请码的主机备注名（默认: My Workstation）
  -h, --help         显示帮助信息
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      PUBLIC_URL="${2:?--url 需要提供公网 HTTPS 地址}"
      shift 2
      ;;
    --cf-token)
      CF_TOKEN="${2:?--cf-token 需要提供 Tunnel Token}"
      shift 2
      ;;
    --relay-key)
      RELAY_KEY_INPUT="${2:?--relay-key 需要提供密钥}"
      shift 2
      ;;
    --label)
      HOST_LABEL="${2:?--label 需要提供备注名称}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[错误] 未知参数: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "[错误] 请通过 --url 指定中继公网 HTTPS 地址，例如：" >&2
  echo "  ./deploy/one-click.sh --url https://relay.example.com" >&2
  exit 1
fi

PUBLIC_URL="${PUBLIC_URL%/}"
if [[ ! "$PUBLIC_URL" =~ ^https?:// ]]; then
  echo "[错误] --url 必须以 https:// 或 http:// 开头" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[错误] 未检测到 docker，请先安装 Docker Desktop 或 Docker Engine。" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[错误] 未检测到 docker compose 插件，请升级 Docker 后重试。" >&2
  exit 1
fi

if [[ -n "$RELAY_KEY_INPUT" ]]; then
  RELAY_KEY="$RELAY_KEY_INPUT"
elif [[ -f "$ENV_FILE" ]] && grep -qE '^RELAY_KEY=.+' "$ENV_FILE"; then
  RELAY_KEY="$(grep -E '^RELAY_KEY=' "$ENV_FILE" | head -n 1 | cut -d= -f2-)"
else
  if command -v openssl >/dev/null 2>&1; then
    RELAY_KEY="$(openssl rand -hex 32)"
  else
    RELAY_KEY="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64)"
  fi
fi

cat > "$ENV_FILE" <<EOF
RELAY_KEY=$RELAY_KEY
RELAY_PUBLIC_URL=$PUBLIC_URL
CLOUDFLARE_TUNNEL_TOKEN=$CF_TOKEN
EOF
chmod 600 "$ENV_FILE"

cd "$ROOT_DIR"
if [[ -n "$CF_TOKEN" ]]; then
  echo "[1/3] 启动中继容器与 Cloudflare Tunnel..."
  docker compose --profile cloudflare up -d --build
else
  echo "[1/3] 启动独立中继容器 (监听 127.0.0.1:8080)..."
  docker compose up -d --build relay
fi

echo "[2/3] 等待中继健康检查通过..."
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:8080/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "[3/3] 部署完成，正在签发首个主机配对邀请码..."
echo "=================================================="
echo "  中继地址: $PUBLIC_URL"
echo "  配置文件: $ENV_FILE (权限 600)"
if command -v node >/dev/null 2>&1 && [[ -f "$ROOT_DIR/scripts/create-invite.mjs" ]]; then
  RELAY_PUBLIC_URL="$PUBLIC_URL" RELAY_KEY="$RELAY_KEY" node "$ROOT_DIR/scripts/create-invite.mjs" "$HOST_LABEL" || true
else
  echo "  签发邀请码命令:"
  echo "  RELAY_PUBLIC_URL=$PUBLIC_URL RELAY_KEY=<见 .env> npm run invite -- \"$HOST_LABEL\""
fi
if [[ -z "$CF_TOKEN" ]]; then
  echo ""
  echo "  提示: 请确保反向代理（Nginx / Caddy）将 $PUBLIC_URL 转发到本机 127.0.0.1:8080（支持 WebSocket）"
fi
echo "=================================================="
