# Agent Control

> 在电脑和手机上统一查看、续跑与调度本机 **Codex**、**Claude Code**、**Antigravity** 与 **Grok** 会话的自托管控制台 —— 一行命令安装，自动配置后台常驻服务与 macOS 原生桌面端，还支持一键免费隧道手机扫码远程操控。
> 如果这个工具帮到了你，欢迎点击右上角 **Star ⭐️** 支持一下。

![Agent Control 桌面端主控制台](docs/tutorial/01-desktop-console.png)

<details>
<summary>查看更多实拍效果（手机远程总控与对话详情）</summary>

![手机端项目总控](docs/tutorial/05-mobile-paired-console.png)

![手机端远程对话详情](docs/tutorial/06-mobile-session-chat.png)

</details>

---

## ⚡ 一行命令接入

环境要求：Node.js `>= 22.0.0` 与 `git`。

**macOS / Linux**（打开「终端」粘贴运行）：

```bash
curl -fsSL https://raw.githubusercontent.com/guuguo/agent-control/main/install.sh | bash
```

**Windows**（打开 **PowerShell** 粘贴运行）：

```powershell
irm https://raw.githubusercontent.com/guuguo/agent-control/main/install.ps1 | iex
```

安装完成后会：
1. 自动配置开机自启后台服务（macOS LaunchAgent / Linux systemd / Windows 计划任务，默认监听 `http://127.0.0.1:43310`）；
2. **macOS 额外自动构建并安装 `/Applications/Agent Control.app`**（原生 `WKWebView` 桌面壳，点击 Dock 图标即可打开，关闭窗口自动后台常驻）；
3. 安装命令行工具 `agent-control`（支持 `open`、`status`、`restart`、`logs`、`update`、`uninstall`）。

---

## ✨ 核心特性

- **多智能体统一接入（只读无侵入）**：
  - 自动发现本机多账号/多实例配置（Codex / Claude Code / Antigravity / Grok），所有会话通过 `<provider>:<profileId>:<rawId>` 复合 ID 精确路由，不篡改原客户端数据库。
  - 重命名、归档、项目置顶、`/goal` 状态均持久化到独立数据目录（macOS: `~/Library/Application Support/Agent Control`）。
- **PC 原生体验 + 移动端卡片总控**：
  - macOS 提供独立原生 `.app` 包装（[AgentControl.swift](desktop/macos/AgentControl.swift)），支持自动拉起后台服务、文件选择/预览、原生确认框与麦克风权限。
  - 手机端自动切换紧凑总控与抽屉式布局，支持 SSE 实时流式推送、`/goal` 自动续跑、任务排队与运行中插话、工具权限审批与语音输入播报。
- **零门槛手机远程控制（免服务器 · 5 秒扫码）**：
  - 内置 **一键免费隧道（Cloudflare Quick Tunnel + 本地鉴权网关）**，点一下即可生成 256-bit 一次性配对二维码，未扫码访问一律拦截。
  - 同时也保留自托管固定中继（`relay/relay-server.mjs` + Docker Compose / Sealos）。
  - 👉 [查看手机扫码远程控制完整图文教程](教程.md)

---

## 🗑️ 一行命令卸载

随时可停止服务并移除安装文件（默认保留你的本地元信息与日志；如需彻底清理可加 `--purge` / `-Purge`）：

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/guuguo/agent-control/main/uninstall.sh | bash
```

**Windows (PowerShell)：**

```powershell
irm https://raw.githubusercontent.com/guuguo/agent-control/main/uninstall.ps1 | iex
```

---

## 进阶用法与开发

<details>
<summary>展开查看常用命令、中继部署、环境变量与零消耗测试说明</summary>

### 常用命令（macOS / Linux）

```bash
agent-control open       # 打开桌面应用或控制台
agent-control status     # 查看服务状态
agent-control logs       # 查看最近日志
agent-control restart    # 重启后台服务
agent-control update     # 从 GitHub 拉取更新并重装服务/桌面端
agent-control desktop    # 单独重新编译安装 macOS 桌面端
```

### 手动源码运行与跨平台服务脚本

```bash
git clone https://github.com/guuguo/agent-control.git
cd agent-control
npm install
npm start                # 前台启动，默认 http://127.0.0.1:43310
npm run service -- install
npm run desktop:install  # macOS 构建安装 /Applications/Agent Control.app
```

### 自托管固定中继（可选）

1. 启动中继（Docker Compose + Cloudflare Tunnel 或 Sealos 清单 `deploy/sealos/relay.yaml`）：

```bash
cp .env.example .env
# 填写 RELAY_KEY 与 RELAY_PUBLIC_URL 后：
docker compose up -d relay
```

2. 签发一次性配对邀请码并在控制台右上角「手机远程」配对：

```bash
RELAY_PUBLIC_URL=https://relay.example.com RELAY_KEY=你的密钥 npm run invite -- "My Mac"
```

### 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `43310` | 本地控制 HTTP/SSE 监听端口 |
| `HOST` | `127.0.0.1` | 建议保持仅回环地址 |
| `AGENT_CONTROL_DATA_DIR` | macOS: `~/Library/Application Support/Agent Control`<br>Windows: `%APPDATA%\Agent Control`<br>Linux: `$XDG_DATA_HOME/agent-control` | 实例标识、元信息、Goal 状态、日志目录 |
| `AGENT_CONTROL_DISABLE_RELAY` | `0` | 设为 `1` 时禁用远程中继桥 |
| `AGENT_CONTROL_TITLE_RULES_FILE` | `<dataDir>/title-rules.json` | 可选：自定义项目标题前缀映射规则 |
| `AGENT_CONTROL_CODEX_HOMES` | 自动发现 | 自定义 Codex 实例列表 |
| `AGENT_CONTROL_CLAUDE_CONFIG_DIRS` | 自动发现 | 自定义 Claude Code 配置目录列表 |
| `AGENT_CONTROL_AGY_APP_DATA_DIRS` | 自动发现 | 自定义 Antigravity `app-data-dir` 列表 |
| `CODEX_BIN` / `CLAUDE_BIN` / `AGY_BIN` | 自动探测 | 显式覆盖各 CLI 可执行文件路径 |

### 校验与零消耗测试

```bash
npm run check
npm test
```

全部自动测试均使用 `tests/helpers/mock-*-cli.mjs` 模拟智能体进程，**不消耗任何真实模型 Token**。

</details>

## License

[AGPL-3.0-only](LICENSE)
