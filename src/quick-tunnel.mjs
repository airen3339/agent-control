import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import QRCode from "qrcode";
import { defaultDataDir } from "./instance-identity.mjs";
import {
  cloudflaredInstallHint,
  killProcessTreeCrossPlatform,
  providerCandidatePaths,
  resolveExecutableCrossPlatform,
  spawnCrossPlatform,
} from "./platform.mjs";

export const PROXY_SIGNAL_HEADERS = Object.freeze([
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "true-client-ip",
]);

const PROXY_SIGNAL_HEADER_SET = new Set(PROXY_SIGNAL_HEADERS);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_TUNNEL_SESSIONS = 16;

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hashToken(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function parseCookies(headerValue) {
  const out = {};
  for (const part of String(headerValue || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const rawVal = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rawVal);
    } catch {
      out[name] = rawVal;
    }
  }
  return out;
}

function readHeader(headers, targetLower) {
  if (!headers || typeof headers !== "object") return "";
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== targetLower) continue;
    if (Array.isArray(value)) return value.join(", ");
    return String(value ?? "");
  }
  return "";
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function tunnelAuthPath(dataDir = defaultDataDir()) {
  return resolve(dataDir, "tunnel-auth.json");
}

export function isLoopbackSocketAddress(remoteAddress) {
  const addr = String(remoteAddress || "").trim().toLowerCase();
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function parseHostHeaderHostname(hostHeader) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw || raw.includes(",") || /[\s/@\\?#]/.test(raw)) return "";
  if (raw.startsWith("[")) {
    const match = raw.match(/^(\[[0-9a-f:.]+\])(?::(\d+))?$/);
    if (!match) return "";
    if (match[2] && Number(match[2]) > 65535) return "";
    return match[1];
  }
  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount > 1) return "";
  if (colonCount === 1) {
    const idx = raw.lastIndexOf(":");
    const port = raw.slice(idx + 1);
    if (!/^\d+$/.test(port) || Number(port) > 65535) return "";
    return raw.slice(0, idx);
  }
  return raw;
}

export function isDirectLoopbackRequest(request) {
  if (!isLoopbackSocketAddress(request?.socket?.remoteAddress)) return false;
  const headers = request?.headers || {};
  for (const [name, value] of Object.entries(headers)) {
    if (!PROXY_SIGNAL_HEADER_SET.has(name.toLowerCase())) continue;
    const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
    if (text.trim()) return false;
  }
  const hostname = parseHostHeaderHostname(readHeader(headers, "host"));
  return LOOPBACK_HOSTNAMES.has(hostname);
}

export function isHttpsForwardedRequest(request) {
  if (request?.socket?.encrypted) return true;
  const headers = request?.headers || {};
  const proto = readHeader(headers, "x-forwarded-proto").split(",")[0].trim().toLowerCase();
  if (proto === "https") return true;
  const cfVisitor = readHeader(headers, "cf-visitor").trim();
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      if (String(parsed?.scheme || "").toLowerCase() === "https") return true;
    } catch {}
  }
  return false;
}

export function resolveCloudflaredExecutable(env = process.env, {
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  return resolveExecutableCrossPlatform({
    envVar: "CLOUDFLARED_BIN",
    candidates: providerCandidatePaths("cloudflared", { env, homeDir, platform }),
    binaryName: "cloudflared",
    env,
    platform,
    strictExplicit: true,
    preferPath: true,
  });
}

export function extractQuickTunnelUrl(text) {
  const input = String(text || "");
  if (!input) return "";
  const customMatch = input.match(/AGENT_CONTROL_TUNNEL_URL=(https?:\/\/[^\s"'|<>]+)/i);
  if (customMatch?.[1]) {
    return customMatch[1].replace(/\/+$/, "");
  }
  const cfMatches = input.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/ig);
  for (const match of cfMatches) {
    const sub = String(match[1] || "").toLowerCase();
    if (!sub || sub === "api") continue;
    return match[0].replace(/\/+$/, "");
  }
  return "";
}

export function isTunnelConnectionRegistered(text) {
  const input = String(text || "");
  if (!input) return false;
  return /Registered tunnel connection/i.test(input) || /AGENT_CONTROL_TUNNEL_URL=/i.test(input);
}

export class TunnelAuthGateway {
  #dataDir;
  #instanceId;
  #state = null;
  #writeQueue = Promise.resolve();

  constructor({ dataDir = defaultDataDir(), instanceId = "local" } = {}) {
    this.#dataDir = dataDir;
    this.#instanceId = String(instanceId || "local");
  }

  get browserToken() {
    return this.#state?.browserToken || "";
  }

  cookieName() {
    return `ac_tunnel_${this.#instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  }

  #newState({ sessionHashes = [] } = {}) {
    const browserToken = randomBytes(24).toString("base64url");
    return {
      browserToken,
      browserTokenHash: hashToken(browserToken),
      sessionHashes: [...sessionHashes].slice(-MAX_TUNNEL_SESSIONS),
      updatedAt: Date.now(),
    };
  }

  async #persist(snapshot) {
    const targetPath = tunnelAuthPath(this.#dataDir);
    const task = this.#writeQueue.then(async () => {
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
      await writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, targetPath);
    });
    this.#writeQueue = task.catch(() => {});
    return task;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(tunnelAuthPath(this.#dataDir), "utf8"));
      if (
        typeof parsed?.browserToken === "string"
        && parsed.browserToken
        && typeof parsed?.browserTokenHash === "string"
        && constantTimeEqual(hashToken(parsed.browserToken), parsed.browserTokenHash)
      ) {
        const sessionHashes = Array.isArray(parsed.sessionHashes)
          ? parsed.sessionHashes.filter((item) => typeof item === "string" && item.length > 0).slice(-MAX_TUNNEL_SESSIONS)
          : [];
        this.#state = {
          browserToken: parsed.browserToken,
          browserTokenHash: parsed.browserTokenHash,
          sessionHashes,
          updatedAt: Number(parsed.updatedAt) || Date.now(),
        };
        return this.#state;
      }
    } catch {
      // Fall through to mint fresh gateway credentials.
    }
    this.#state = this.#newState();
    await this.#persist(this.#state);
    return this.#state;
  }

  async redeemConnectToken(candidateToken) {
    if (!this.#state) await this.load();
    const candidate = String(candidateToken || "").trim();
    if (!candidate || !this.#state?.browserTokenHash) return null;
    if (!constantTimeEqual(hashToken(candidate), this.#state.browserTokenHash)) {
      return null;
    }
    const sessionToken = randomBytes(32).toString("base64url");
    const nextHashes = [...(this.#state.sessionHashes || []), hashToken(sessionToken)].slice(-MAX_TUNNEL_SESSIONS);
    this.#state = {
      ...this.#state,
      sessionHashes: nextHashes,
      updatedAt: Date.now(),
    };
    await this.#persist(this.#state);
    return sessionToken;
  }

  isAuthenticatedRequest(request) {
    if (!this.#state?.sessionHashes?.length) return false;
    const cookies = parseCookies(readHeader(request?.headers, "cookie"));
    const sessionToken = cookies[this.cookieName()];
    if (!sessionToken) return false;
    const sessionHash = hashToken(sessionToken);
    let matched = false;
    for (const storedHash of this.#state.sessionHashes) {
      if (constantTimeEqual(sessionHash, storedHash)) {
        matched = true;
      }
    }
    return matched;
  }

  async rotateToken({ revokeSessions = true } = {}) {
    if (!this.#state) await this.load();
    const preserved = revokeSessions ? [] : (this.#state?.sessionHashes || []);
    this.#state = this.#newState({ sessionHashes: preserved });
    await this.#persist(this.#state);
    return this.#state.browserToken;
  }

  unauthorizedHtml(detail = "") {
    const message = detail
      ? escapeHtml(detail)
      : "当前连接经过远程隧道或外部代理访问，已由 Agent Control 本地隧道鉴权网关拦截。";
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Agent Control · 需要扫码配对</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
      background: #0b0f14;
      color: #e8eef7;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Text", sans-serif;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #121821;
      border: 1px solid #283244;
      border-radius: 16px;
      padding: 24px;
      box-sizing: border-box;
      text-align: center;
    }
    .badge {
      display: inline-block;
      margin-bottom: 12px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      color: #82b2ff;
      background: rgba(76, 141, 255, 0.14);
      border: 1px solid rgba(76, 141, 255, 0.35);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 18px;
      line-height: 1.4;
    }
    p {
      margin: 0 0 10px;
      font-size: 14px;
      color: #93a1b5;
      line-height: 1.6;
    }
    p:last-child {
      margin-bottom: 0;
    }
    strong {
      color: #e8eef7;
    }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">Agent Control · 本地鉴权网关</span>
    <h1>访问受保护，请先扫码配对</h1>
    <p>${message}</p>
    <p>请在本机打开控制台，点击左侧 <strong>「手机远程」</strong>，用手机相机或微信扫描当前二维码完成一次性登录。</p>
  </main>
</body>
</html>`;
  }
}

export class QuickTunnelManager {
  #targetOrigin;
  #env;
  #platform;
  #authGateway;
  #disabled;
  #onStateChange;
  #state;
  #publicUrl = "";
  #startedAt = null;
  #lastError = "";
  #child = null;
  #stopping = false;
  #startPromise = null;

  constructor({
    targetOrigin = "",
    env = process.env,
    platform = process.platform,
    authGateway = null,
    disabled = false,
    onStateChange = () => {},
  } = {}) {
    this.#targetOrigin = String(targetOrigin || "").trim().replace(/\/+$/, "");
    this.#env = env;
    this.#platform = platform;
    this.#authGateway = authGateway;
    this.#disabled = Boolean(disabled);
    this.#onStateChange = onStateChange;
    this.#state = this.#disabled ? "disabled" : "stopped";
  }

  setTargetOrigin(origin) {
    this.#targetOrigin = String(origin || "").trim().replace(/\/+$/, "");
  }

  statusSnapshot({ includeSecrets = false } = {}) {
    const installed = Boolean(resolveCloudflaredExecutable(this.#env, { platform: this.#platform }));
    const rawToken = includeSecrets ? (this.#authGateway?.browserToken || "") : "";
    const pairUrl = (includeSecrets && this.#publicUrl && rawToken)
      ? `${this.#publicUrl}/connect/${encodeURIComponent(rawToken)}`
      : "";
    return {
      disabled: this.#disabled,
      installed,
      state: this.#state,
      publicUrl: this.#publicUrl,
      startedAt: this.#startedAt,
      lastError: this.#lastError,
      installHint: cloudflaredInstallHint(this.#platform),
      pairUrl,
    };
  }

  #emitState() {
    this.#onStateChange(this.statusSnapshot({ includeSecrets: false }));
  }

  async status({ includeQr = false, includeSecrets = false } = {}) {
    const base = this.statusSnapshot({ includeSecrets });
    if (includeQr && includeSecrets && base.pairUrl) {
      base.qrDataUrl = await QRCode.toDataURL(base.pairUrl, { margin: 1, width: 260 });
    }
    return base;
  }

  async #terminateChild(child = this.#child) {
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.#child === child) this.#child = null;
      return;
    }
    await new Promise((resolveExit) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(killTimer);
        if (this.#child === child) this.#child = null;
        resolveExit();
      };
      const killTimer = setTimeout(() => {
        killProcessTreeCrossPlatform(child, { signal: "SIGKILL", platform: this.#platform });
        done();
      }, 1500);
      killTimer.unref?.();
      child.once("close", done);
      child.once("error", done);
      try {
        killProcessTreeCrossPlatform(child, { signal: "SIGTERM", platform: this.#platform });
      } catch {
        done();
      }
    });
  }

  async start({ waitReadyMs = 25_000 } = {}) {
    if (this.#disabled) {
      throw Object.assign(new Error("当前实例禁用了快速隧道"), { status: 400 });
    }
    if (!this.#targetOrigin) {
      throw Object.assign(new Error("本地控制服务地址尚未就绪"), { status: 500 });
    }
    if (this.#state === "running" && this.#child && this.#child.exitCode === null && this.#publicUrl) {
      return this.status({ includeQr: true, includeSecrets: true });
    }
    if (this.#startPromise) {
      await this.#startPromise;
      return this.status({ includeQr: true, includeSecrets: true });
    }

    const startTask = (async () => {
      const binPath = resolveCloudflaredExecutable(this.#env, { platform: this.#platform });
      if (!binPath) {
        const hint = cloudflaredInstallHint(this.#platform);
        this.#state = "missing_binary";
        this.#publicUrl = "";
        this.#startedAt = null;
        this.#lastError = `未检测到 cloudflared，请先在终端执行：${hint}`;
        this.#emitState();
        throw Object.assign(new Error(this.#lastError), {
          status: 400,
          code: "cloudflared_missing",
        });
      }

      if (this.#child) {
        this.#stopping = true;
        await this.#terminateChild(this.#child);
      }

      // Clash / TUN Fake-IP (198.18.x.x) environments often pass UDP prechecks yet hang QUIC registration (Error 1033);
      // default to HTTP/2 over TCP and skip UDP prechecks unless overridden via AGENT_CONTROL_CLOUDFLARED_PROTOCOL.
      const protocol = String(this.#env?.AGENT_CONTROL_CLOUDFLARED_PROTOCOL || "http2").trim().toLowerCase();
      const args = [
        "tunnel",
        "--no-autoupdate",
        "--no-prechecks",
        ...(protocol && protocol !== "auto" ? ["--protocol", protocol] : []),
        "--url",
        this.#targetOrigin,
      ];

      this.#stopping = false;
      this.#state = "starting";
      this.#publicUrl = "";
      this.#startedAt = null;
      this.#lastError = "";
      this.#emitState();

      const child = spawnCrossPlatform(binPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.#env,
      }, { platform: this.#platform });
      this.#child = child;

      const tailLines = [];
      let lineRemainder = "";
      await new Promise((resolveReady, rejectReady) => {
        let settled = false;
        let candidateUrl = "";
        let registered = false;
        const failStart = (message, status = 502, code = "tunnel_start_failed") => {
          if (settled) return;
          settled = true;
          clearTimeout(readyTimer);
          rejectReady(Object.assign(new Error(message), { status, code }));
        };

        const readyTimer = setTimeout(() => {
          const message = candidateUrl
            ? "cloudflared 已分配地址但边缘连接注册超时（请检查网络或代理设置）"
            : "等待 cloudflared 分配公网地址超时";
          this.#stopping = true;
          this.#state = "error";
          this.#publicUrl = "";
          this.#startedAt = null;
          this.#lastError = message;
          this.#emitState();
          void this.#terminateChild(child);
          failStart(message, 504, "tunnel_timeout");
        }, waitReadyMs);
        readyTimer.unref?.();

        const processLine = (rawLine) => {
          const clean = String(rawLine || "").trim();
          if (!clean) return;
          tailLines.push(clean);
          if (tailLines.length > 16) tailLines.shift();
          const url = extractQuickTunnelUrl(clean);
          if (url) candidateUrl = url;
          if (isTunnelConnectionRegistered(clean)) registered = true;
          if (candidateUrl && registered && !settled && !this.#stopping && this.#child === child) {
            settled = true;
            clearTimeout(readyTimer);
            this.#state = "running";
            this.#publicUrl = candidateUrl;
            this.#startedAt = Date.now();
            this.#lastError = "";
            this.#emitState();
            resolveReady();
          }
        };

        const onChunk = (chunk) => {
          lineRemainder += String(chunk || "");
          const parts = lineRemainder.split(/\r?\n/);
          lineRemainder = parts.pop() || "";
          for (const line of parts) processLine(line);
          if (lineRemainder && (extractQuickTunnelUrl(lineRemainder) || isTunnelConnectionRegistered(lineRemainder))) {
            const flushed = lineRemainder;
            lineRemainder = "";
            processLine(flushed);
          }
        };

        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);

        child.once("error", (err) => {
          if (lineRemainder) processLine(lineRemainder);
          if (this.#child === child) this.#child = null;
          if (this.#stopping) {
            failStart("隧道已停止", 499, "tunnel_stopped");
            return;
          }
          const msg = err?.message || "启动 cloudflared 失败";
          this.#state = "error";
          this.#publicUrl = "";
          this.#startedAt = null;
          this.#lastError = msg;
          this.#emitState();
          failStart(msg);
        });

        child.once("close", (code, signal) => {
          if (lineRemainder) {
            processLine(lineRemainder);
            lineRemainder = "";
          }
          if (this.#child === child) this.#child = null;
          if (this.#stopping) {
            failStart("隧道已停止", 499, "tunnel_stopped");
            return;
          }
          const diagnostic = tailLines.slice(-4).join(" | ")
            || `cloudflared 异常退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）`;
          this.#state = "error";
          this.#publicUrl = "";
          this.#startedAt = null;
          this.#lastError = diagnostic;
          this.#emitState();
          failStart(diagnostic);
        });
      });
    })();

    this.#startPromise = startTask;
    try {
      await startTask;
      return this.status({ includeQr: true, includeSecrets: true });
    } finally {
      if (this.#startPromise === startTask) {
        this.#startPromise = null;
      }
    }
  }

  async stop({ revokeSessions = true } = {}) {
    this.#stopping = true;
    await this.#terminateChild(this.#child);
    this.#publicUrl = "";
    this.#startedAt = null;
    this.#lastError = "";
    this.#state = this.#disabled ? "disabled" : "stopped";
    if (revokeSessions && this.#authGateway) {
      await this.#authGateway.rotateToken({ revokeSessions: true });
    }
    this.#emitState();
    return this.status({ includeQr: false, includeSecrets: true });
  }

  async rotate() {
    if (this.#authGateway) {
      await this.#authGateway.rotateToken({ revokeSessions: true });
    }
    this.#emitState();
    return this.status({ includeQr: Boolean(this.#publicUrl), includeSecrets: true });
  }

  async close() {
    this.#stopping = true;
    await this.#terminateChild(this.#child);
    this.#publicUrl = "";
    this.#startedAt = null;
    this.#state = this.#disabled ? "disabled" : "stopped";
  }
}
