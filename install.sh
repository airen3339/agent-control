#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGENT_CONTROL_REPO_URL:-https://github.com/guuguo/agent-control.git}"
REPO_BRANCH="${AGENT_CONTROL_BRANCH:-main}"
INSTALL_DIR="${AGENT_CONTROL_HOME:-$HOME/.local/share/agent-control/app}"
PORT="${PORT:-43310}"
LOCAL_BIN="$HOME/.local/bin"

INSTALL_SERVICE="true"
INSTALL_APP="true"
OPEN_AFTER="true"

usage() {
  cat <<'EOF'
Agent Control 一键安装脚本 (macOS / Linux)

用法:
  curl -fsSL https://raw.githubusercontent.com/guuguo/agent-control/main/install.sh | bash
  或本地仓库运行: ./install.sh [选项]

选项:
  --dir <路径>    指定安装目录（默认: ~/.local/share/agent-control/app）
  --port <端口>   指定本地控制台端口（默认: 43310）
  --no-service    仅拉取依赖，不注册开机后台服务
  --no-app        macOS 不构建安装 /Applications/Agent Control.app
  --no-open       安装完成后不自动打开界面
  -h, --help      显示帮助信息
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="${2:?--dir 需要提供路径}"
      shift 2
      ;;
    --port)
      PORT="${2:?--port 需要提供端口号}"
      shift 2
      ;;
    --no-service)
      INSTALL_SERVICE="false"
      shift
      ;;
    --no-app)
      INSTALL_APP="false"
      shift
      ;;
    --no-open)
      OPEN_AFTER="false"
      shift
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

OS_NAME="$(uname -s)"
if [[ "$OS_NAME" != "Darwin" && "$OS_NAME" != "Linux" ]]; then
  echo "[错误] install.sh 仅支持 macOS 与 Linux。Windows 用户请使用 install.ps1。" >&2
  exit 1
fi

find_node_bin() {
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=(
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "$HOME/.local/bin/node"
    "$HOME/.volta/bin/node"
    "$HOME/.fnm/aliases/default/bin/node"
  )
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    local nvm_node
    for nvm_node in "$HOME/.nvm/versions/node"/*/bin/node; do
      [[ -x "$nvm_node" ]] && candidates+=("$nvm_node")
    done
  fi
  local bin major
  for bin in "${candidates[@]}"; do
    if [[ -x "$bin" ]]; then
      major="$("$bin" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
      if [[ "$major" -ge 22 ]]; then
        printf '%s' "$bin"
        return 0
      fi
    fi
  done
  return 1
}

NODE_BIN="$(find_node_bin || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "[错误] 需要 Node.js >= 22.0.0。" >&2
  if [[ "$OS_NAME" == "Darwin" ]]; then
    echo "请先执行: brew install node@22  或从 https://nodejs.org 下载安装。" >&2
  else
    echo "请先安装 Node.js 22+（https://nodejs.org），然后重新执行本脚本。" >&2
  fi
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

if ! command -v npm >/dev/null 2>&1; then
  echo "[错误] 未检测到 npm，请确认 Node.js 安装完整。" >&2
  exit 1
fi

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

APP_DIR=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/src/server.mjs" && -f "$SCRIPT_DIR/package.json" ]]; then
  APP_DIR="$SCRIPT_DIR"
  echo "[1/4] 检测到本地源码目录，直接使用: $APP_DIR"
else
  if ! command -v git >/dev/null 2>&1; then
    echo "[错误] 缺少 git，请先安装 git（macOS 可执行 xcode-select --install 或 brew install git）。" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "[1/4] 正在更新 Agent Control 源码: $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$INSTALL_DIR" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH" >/dev/null 2>&1 || git -C "$INSTALL_DIR" reset --hard "origin/$REPO_BRANCH"
  else
    echo "[1/4] 正在克隆 Agent Control 仓库到: $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  APP_DIR="$INSTALL_DIR"
fi

echo "[2/4] 正在安装运行依赖..."
(
  cd "$APP_DIR"
  npm install --omit=dev --no-audit --no-fund
)

mkdir -p "$LOCAL_BIN"
CLI_PATH="$LOCAL_BIN/agent-control"
cat > "$CLI_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$APP_DIR"
NODE_BIN="$NODE_BIN"
PORT="\${PORT:-$PORT}"

usage() {
  cat <<'HELP'
Agent Control 命令行工具

用法:
  agent-control [命令]

命令:
  open        打开桌面应用或本地控制台页面（默认）
  start       安装并启动后台常驻服务
  restart     重启后台常驻服务
  stop        停止并移除后台常驻服务
  status      查看运行状态与监听端口
  logs        查看最近服务日志
  run         前台运行服务（调试用）
  desktop     macOS 重新编译并安装 /Applications/Agent Control.app
  update      从 GitHub 拉取最新版本并重启服务
  uninstall   卸载 Agent Control
HELP
}

cmd="\${1:-open}"
shift || true

case "\$cmd" in
  open)
    if [[ "\$(uname -s)" == "Darwin" && -d "/Applications/Agent Control.app" ]]; then
      open -a "/Applications/Agent Control.app"
    elif [[ "\$(uname -s)" == "Darwin" ]]; then
      open "http://127.0.0.1:\${PORT}"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://127.0.0.1:\${PORT}" >/dev/null 2>&1 &
    else
      echo "请在浏览器打开: http://127.0.0.1:\${PORT}"
    fi
    ;;
  start|install)
    PORT="\$PORT" "\$NODE_BIN" "\$APP_DIR/scripts/service.mjs" install
    ;;
  restart)
    PORT="\$PORT" "\$NODE_BIN" "\$APP_DIR/scripts/service.mjs" restart
    ;;
  stop)
    PORT="\$PORT" "\$NODE_BIN" "\$APP_DIR/scripts/service.mjs" uninstall
    ;;
  status|logs|run)
    PORT="\$PORT" "\$NODE_BIN" "\$APP_DIR/scripts/service.mjs" "\$cmd"
    ;;
  desktop)
    PORT="\$PORT" bash "\$APP_DIR/desktop/macos/build-app.sh" --install
    ;;
  update)
    if [[ -d "\$APP_DIR/.git" ]]; then
      git -C "\$APP_DIR" pull --ff-only
      (cd "\$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
    fi
    PORT="\$PORT" "\$NODE_BIN" "\$APP_DIR/scripts/service.mjs" install
    if [[ "\$(uname -s)" == "Darwin" && -d "/Applications/Agent Control.app" ]] && command -v swiftc >/dev/null 2>&1; then
      PORT="\$PORT" bash "\$APP_DIR/desktop/macos/build-app.sh" --install
    fi
    echo "Agent Control 已更新完成。"
    ;;
  uninstall)
    exec bash "\$APP_DIR/uninstall.sh" "\$@"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "未知命令: \$cmd" >&2
    usage >&2
    exit 2
    ;;
esac
EOF
chmod +x "$CLI_PATH"

if [[ "$INSTALL_SERVICE" == "true" ]]; then
  echo "[3/4] 正在注册并启动本地后台服务 (端口 $PORT)..."
  PORT="$PORT" "$NODE_BIN" "$APP_DIR/scripts/service.mjs" install
else
  echo "[3/4] 已跳过后台服务安装 (--no-service)"
fi

INSTALLED_APP_PATH=""
if [[ "$OS_NAME" == "Darwin" && "$INSTALL_APP" == "true" ]]; then
  if command -v swiftc >/dev/null 2>&1; then
    echo "[4/4] 正在构建并安装 macOS 原生桌面端 (/Applications/Agent Control.app)..."
    PORT="$PORT" bash "$APP_DIR/desktop/macos/build-app.sh" --install
    INSTALLED_APP_PATH="/Applications/Agent Control.app"
  else
    echo "[4/4] 未检测到 swiftc，已跳过原生 .app 构建（可随时安装 Xcode CLI Tools 后执行: agent-control desktop）"
  fi
else
  echo "[4/4] 已完成 CLI 与服务部署。"
fi

HEALTH_OK="false"
if [[ "$INSTALL_SERVICE" == "true" ]] && command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      HEALTH_OK="true"
      break
    fi
    sleep 0.4
  done
fi

echo ""
echo "=================================================="
echo "  Agent Control 安装完成"
echo "=================================================="
echo "  源码目录: $APP_DIR"
echo "  本地控制台: http://127.0.0.1:${PORT}"
if [[ -n "$INSTALLED_APP_PATH" ]]; then
  echo "  桌面应用: $INSTALLED_APP_PATH"
fi
echo "  命令行工具: $CLI_PATH"
if [[ "$INSTALL_SERVICE" == "true" ]]; then
  if [[ "$HEALTH_OK" == "true" ]]; then
    echo "  服务状态: 运行中 (http://127.0.0.1:${PORT}/health 正常)"
  else
    echo "  服务状态: 已配置（如端口尚未就绪，可执行 agent-control logs 查看日志）"
  fi
fi
echo ""
echo "  常用命令:"
echo "    agent-control open      打开控制台"
echo "    agent-control status    查看服务状态"
echo "    agent-control update    一键升级到最新版"
echo "    agent-control uninstall 卸载"
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
  echo ""
  echo "  提示: 请将 ~/.local/bin 加入 PATH，或直接使用 $CLI_PATH"
fi
echo "=================================================="

if [[ "$OPEN_AFTER" == "true" && "$INSTALL_SERVICE" == "true" ]]; then
  if [[ "$OS_NAME" == "Darwin" && -n "$INSTALLED_APP_PATH" ]]; then
    open -a "$INSTALLED_APP_PATH" >/dev/null 2>&1 || true
  elif [[ "$OS_NAME" == "Darwin" ]]; then
    open "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || true
  fi
fi
