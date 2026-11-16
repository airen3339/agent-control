#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

HOST=""
NAMESPACE="${AGENT_CONTROL_NAMESPACE:-}"
RELAY_KEY_INPUT=""
HOST_LABEL="My Workstation"

usage() {
  cat <<'EOF'
Sealos 一键部署中继脚本（免手动建镜像与 ConfigMap）

用法:
  KUBECONFIG=~/.kube/sealos.yaml ./deploy/sealos/deploy.sh --host <你的中继域名> [选项]

选项:
  --host <domain>     必填：Sealos 分配或绑定的公网域名（不含 https://，如 relay.cloud.sealos.run）
  -n, --namespace <ns> 可选：Kubernetes Namespace（默认使用当前 kubeconfig 上下文）
  --relay-key <key>   可选：指定 RELAY_KEY（默认自动生成 64 位随机密钥）
  --label <name>      可选：签发首个配对邀请码的主机备注名
  -h, --help          显示帮助信息
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:?--host 需要提供域名}"
      shift 2
      ;;
    -n|--namespace)
      NAMESPACE="${2:?--namespace 需要提供命名空间}"
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

HOST="${HOST#https://}"
HOST="${HOST#http://}"
HOST="${HOST%%/*}"

if [[ -z "$HOST" ]]; then
  echo "[错误] 请通过 --host 指定中继域名，例如: --host my-relay.cloud.sealos.run" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "[错误] 未检测到 kubectl，请在 Sealos 终端执行或本机安装 kubectl 并配置 KUBECONFIG。" >&2
  exit 1
fi

NS_ARGS=()
if [[ -n "$NAMESPACE" ]]; then
  NS_ARGS=(-n "$NAMESPACE")
fi

if [[ -n "$RELAY_KEY_INPUT" ]]; then
  RELAY_KEY="$RELAY_KEY_INPUT"
elif command -v openssl >/dev/null 2>&1; then
  RELAY_KEY="$(openssl rand -hex 32)"
else
  RELAY_KEY="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64)"
fi

PUBLIC_URL="https://$HOST"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "[1/4] 打包中继源码 ConfigMap（无需拉取外部私有镜像）..."
(
  cd "$ROOT_DIR/relay"
  if [[ ! -d node_modules/ws ]]; then
    npm install --omit=dev --no-audit --no-fund >/dev/null
  fi
  tar -czf "$TMP_DIR/ws.tgz" -C node_modules ws
)

kubectl "${NS_ARGS[@]}" create configmap agent-control-relay-source-current \
  --from-file=relay-server.mjs="$ROOT_DIR/relay/relay-server.mjs" \
  --from-file=package.json="$ROOT_DIR/relay/package.json" \
  --from-file=package-lock.json="$ROOT_DIR/relay/package-lock.json" \
  --from-file=ws.tgz="$TMP_DIR/ws.tgz" \
  --dry-run=client -o yaml | kubectl "${NS_ARGS[@]}" apply -f -

echo "[2/4] 写入公网地址与密钥配置..."
kubectl "${NS_ARGS[@]}" create configmap agent-control-relay-config \
  --from-literal=public-url="$PUBLIC_URL" \
  --dry-run=client -o yaml | kubectl "${NS_ARGS[@]}" apply -f -

kubectl "${NS_ARGS[@]}" create secret generic agent-control-relay-secret \
  --from-literal=relay-key="$RELAY_KEY" \
  --dry-run=client -o yaml | kubectl "${NS_ARGS[@]}" apply -f -

echo "[3/4] 部署 Deployment / PVC / Ingress..."
kubectl "${NS_ARGS[@]}" apply -f "$SCRIPT_DIR/relay.yaml"

cat > "$TMP_DIR/ingress.yaml" <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agent-control-relay
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
spec:
  rules:
    - host: $HOST
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: agent-control-relay
                port:
                  number: 80
EOF
kubectl "${NS_ARGS[@]}" apply -f "$TMP_DIR/ingress.yaml"

echo "[4/4] 等待 Pod 就绪..."
kubectl "${NS_ARGS[@]}" rollout status deployment/agent-control-relay --timeout=120s

echo ""
echo "=================================================="
echo "  Sealos 中继部署完成"
echo "=================================================="
echo "  中继地址: $PUBLIC_URL"
echo "  RELAY_KEY: $RELAY_KEY"
if command -v node >/dev/null 2>&1 && [[ -f "$ROOT_DIR/scripts/create-invite.mjs" ]]; then
  echo ""
  RELAY_PUBLIC_URL="$PUBLIC_URL" RELAY_KEY="$RELAY_KEY" node "$ROOT_DIR/scripts/create-invite.mjs" "$HOST_LABEL" || true
fi
echo "=================================================="
