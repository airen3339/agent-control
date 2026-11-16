# 安全政策

Agent Control 能够远程查看历史对话、向本机 **Codex**、**Claude Code** 与 **Antigravity** 下发指令并响应工具/命令授权，因此应严格按照本机远程执行控制台管理其部署边界。

## 报告漏洞

请勿公开披露尚未修复的安全问题，也不要在工单或文档中附带真实邀请码、`RELAY_KEY`、主机凭证（`relay-auth.json`）、Cloudflare Tunnel Token 或 kubeconfig。

## 当前安全边界

- **本地回环隔离**：本机控制服务默认仅绑定 `127.0.0.1:43310`，不向局域网或公网开放入站监听端口。
- **出站隧道中继**：由 Mac 主动建立出站 WebSocket（HTTPS/WSS），无需在家庭或办公路由器暴露端口。
- **实例级 Cookie 隔离**：手机通过一次性配对链接 `/connect/:instanceId/:token` 校验后获发 `HttpOnly`、`SameSite=Strict`、作用域限定为 `Path=/i/<instanceId>/` 的会话 Cookie。
- **最小读取原则**：多实例配置发现只提取展示用途的账号名/邮箱与目录路径，不读取或透传任何 OAuth token 或私钥。
- **工具授权透明**：除明确切换为 `full`（完全访问）外，所有高危命令、文件修改及 Claude `AskUserQuestion` / ACP 权限请求均会暂停等待你在网页或手机端明确确认。
- **加密前提**：公网部署中继时必须位于 HTTPS/WSS 反向代理（如 Cloudflare Tunnel、Nginx/Caddy TLS 或 Sealos Ingress）之后；明文转发模式下中继节点本身在技术上可读取经过的数据流，请仅使用自己部署并信任的中继。
