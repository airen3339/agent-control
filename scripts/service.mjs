import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePlatform,
  resolvePlatformDataDir,
  resolveUserHome,
} from "../src/platform.mjs";
import { isProcessAlive } from "../src/runtime-lease.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = resolve(ROOT_DIR, "src", "server.mjs");
const LAUNCHD_LABEL = "com.guuguo.agent-control";
const SYSTEMD_UNIT = "agent-control.service";
const WIN_TASK_NAME = "AgentControl";

function xmlEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdQuote(str) {
  return `"${String(str || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function renderLaunchdPlist({
  nodeBin = process.execPath,
  rootDir = ROOT_DIR,
  serverEntry = SERVER_ENTRY,
  port = "43310",
  dataDir = resolvePlatformDataDir({ platform: "darwin" }),
  homeDir = resolveUserHome(process.env, "darwin"),
} = {}) {
  const logDir = join(dataDir, "logs");
  const pathValue = `/opt/homebrew/bin:/usr/local/bin:${homeDir}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(serverEntry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(rootDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${xmlEscape(port)}</string>
    <key>AGENT_CONTROL_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "stderr.log"))}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit({
  nodeBin = process.execPath,
  rootDir = ROOT_DIR,
  serverEntry = SERVER_ENTRY,
  port = "43310",
  dataDir = resolvePlatformDataDir({ platform: "linux" }),
} = {}) {
  const logDir = join(dataDir, "logs");
  return `[Unit]
Description=Agent Control Local Console
After=network.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(rootDir)}
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(serverEntry)}
Environment=${systemdQuote(`PORT=${port}`)}
Environment=${systemdQuote(`AGENT_CONTROL_DATA_DIR=${dataDir}`)}
Restart=always
RestartSec=3
StandardOutput=append:${join(logDir, "stdout.log")}
StandardError=append:${join(logDir, "stderr.log")}

[Install]
WantedBy=default.target
`;
}

export function renderWindowsRunScripts({
  nodeBin = process.execPath,
  rootDir = ROOT_DIR,
  serverEntry = SERVER_ENTRY,
  port = "43310",
  dataDir = resolvePlatformDataDir({ platform: "win32" }),
} = {}) {
  const binDir = join(dataDir, "bin");
  const logDir = join(dataDir, "logs");
  const cmdPath = join(binDir, "run-server.cmd");
  const vbsPath = join(binDir, "run-hidden.vbs");
  const stdoutLog = join(logDir, "stdout.log");
  const stderrLog = join(logDir, "stderr.log");

  const cmdContent = [
    "@echo off",
    "setlocal",
    `set "PORT=${String(port)}"`,
    `set "AGENT_CONTROL_DATA_DIR=${String(dataDir)}"`,
    `cd /d "${String(rootDir)}"`,
    `"${String(nodeBin)}" "${String(serverEntry)}" >> "${stdoutLog}" 2>> "${stderrLog}"`,
    "",
  ].join("\r\n");

  const vbsContent = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${cmdPath}""", 0, False`,
    "",
  ].join("\r\n");

  return { cmdPath, vbsPath, cmdContent, vbsContent };
}

function readLease(dataDir) {
  const leaseFile = join(dataDir, "control-runtime.json");
  if (!existsSync(leaseFile)) return null;
  try {
    return JSON.parse(readFileSync(leaseFile, "utf8"));
  } catch {
    return null;
  }
}

function printLogs(dataDir) {
  const logDir = join(dataDir, "logs");
  let any = false;
  for (const name of ["stdout.log", "stderr.log"]) {
    const file = join(logDir, name);
    if (!existsSync(file)) continue;
    any = true;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    process.stdout.write(`==> ${file} <==\n${lines.slice(-60).join("\n")}\n`);
  }
  if (!any) {
    process.stdout.write("暂无日志\n");
  }
}

function printStatus(dataDir) {
  const lease = readLease(dataDir);
  const leaseFile = join(dataDir, "control-runtime.json");
  if (!lease) {
    process.stderr.write(`未检测到运行中的 Agent Control 租约 (${leaseFile})\n`);
    process.exit(1);
  }
  const alive = isProcessAlive(lease.pid);
  process.stdout.write(`${JSON.stringify({ ...lease, alive }, null, 2)}\n`);
  if (!alive) process.exit(1);
}

function tryExec(bin, args, opts = {}) {
  try {
    execFileSync(bin, args, { stdio: "pipe", windowsHide: true, ...opts });
    return true;
  } catch {
    return false;
  }
}

function stopWindowsInstance(dataDir) {
  const lease = readLease(dataDir);
  if (lease?.pid && isProcessAlive(lease.pid)) {
    tryExec("taskkill", ["/PID", String(lease.pid), "/T", "/F"]);
    try { process.kill(Number(lease.pid)); } catch {}
  }
}

function runCommand(cmd = "run") {
  const platform = normalizePlatform(process.platform);
  const port = String(process.env.PORT || "43310");
  const homeDir = resolveUserHome(process.env, platform, os.homedir());
  const dataDir = resolvePlatformDataDir({
    customDir: process.env.AGENT_CONTROL_DATA_DIR,
    env: process.env,
    homeDir,
    platform,
  });
  const logDir = join(dataDir, "logs");

  if (cmd === "run") {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
    return;
  }

  if (cmd === "status") {
    printStatus(dataDir);
    return;
  }

  if (cmd === "logs") {
    printLogs(dataDir);
    return;
  }

  if (platform === "darwin") {
    const plistPath = join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    if (cmd === "install") {
      mkdirSync(dirname(plistPath), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      writeFileSync(plistPath, renderLaunchdPlist({ port, dataDir, homeDir }), "utf8");
      tryExec("launchctl", ["unload", plistPath]);
      execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });
      process.stdout.write(`已安装并启动 LaunchAgent: ${plistPath}\n`);
      return;
    }
    if (cmd === "restart") {
      if (!existsSync(plistPath)) {
        process.stderr.write(`未检测到已安装的 LaunchAgent (${plistPath})，请先执行 install\n`);
        process.exit(1);
      }
      const uid = typeof process.getuid === "function" ? process.getuid() : "";
      if (uid !== "" && tryExec("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`])) {
        process.stdout.write(`已重启 LaunchAgent: ${LAUNCHD_LABEL}\n`);
      } else {
        tryExec("launchctl", ["unload", plistPath]);
        execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });
        process.stdout.write(`已重新加载 LaunchAgent: ${plistPath}\n`);
      }
      return;
    }
    if (cmd === "uninstall") {
      tryExec("launchctl", ["unload", plistPath]);
      rmSync(plistPath, { force: true });
      process.stdout.write(`已移除 LaunchAgent: ${plistPath}\n`);
      return;
    }
  } else if (platform === "linux") {
    const unitPath = join(homeDir, ".config", "systemd", "user", SYSTEMD_UNIT);
    if (cmd === "install") {
      mkdirSync(dirname(unitPath), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      writeFileSync(unitPath, renderSystemdUnit({ port, dataDir }), "utf8");
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "inherit" });
      process.stdout.write(`已安装并启动 systemd 用户服务: ${unitPath}\n`);
      return;
    }
    if (cmd === "restart") {
      if (!existsSync(unitPath)) {
        process.stderr.write(`未检测到 systemd 服务 (${unitPath})，请先执行 install\n`);
        process.exit(1);
      }
      execFileSync("systemctl", ["--user", "restart", SYSTEMD_UNIT], { stdio: "inherit" });
      process.stdout.write(`已重启 systemd 用户服务: ${SYSTEMD_UNIT}\n`);
      return;
    }
    if (cmd === "uninstall") {
      tryExec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      rmSync(unitPath, { force: true });
      tryExec("systemctl", ["--user", "daemon-reload"]);
      process.stdout.write(`已移除 systemd 用户服务: ${unitPath}\n`);
      return;
    }
  } else if (platform === "win32") {
    const scripts = renderWindowsRunScripts({ port, dataDir });
    if (cmd === "install") {
      mkdirSync(dirname(scripts.cmdPath), { recursive: true });
      mkdirSync(logDir, { recursive: true });
      writeFileSync(scripts.cmdPath, scripts.cmdContent, "utf8");
      writeFileSync(scripts.vbsPath, scripts.vbsContent, "utf8");
      const taskCmd = `wscript.exe "${scripts.vbsPath}"`;
      execFileSync(
        "schtasks",
        ["/Create", "/TN", WIN_TASK_NAME, "/SC", "ONLOGON", "/TR", taskCmd, "/F"],
        { stdio: "inherit", windowsHide: true },
      );
      stopWindowsInstance(dataDir);
      const child = spawn("wscript.exe", [scripts.vbsPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      process.stdout.write(`已安装 Windows 登录自启任务 (${WIN_TASK_NAME}) 并在后台启动\n`);
      return;
    }
    if (cmd === "restart") {
      if (!existsSync(scripts.vbsPath)) {
        process.stderr.write(`未检测到启动脚本 (${scripts.vbsPath})，请先执行 install\n`);
        process.exit(1);
      }
      stopWindowsInstance(dataDir);
      const child = spawn("wscript.exe", [scripts.vbsPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      process.stdout.write(`已重启 Windows 后台服务: ${WIN_TASK_NAME}\n`);
      return;
    }
    if (cmd === "uninstall") {
      stopWindowsInstance(dataDir);
      tryExec("schtasks", ["/Delete", "/TN", WIN_TASK_NAME, "/F"]);
      rmSync(scripts.cmdPath, { force: true });
      rmSync(scripts.vbsPath, { force: true });
      process.stdout.write(`已移除 Windows 自启任务: ${WIN_TASK_NAME}\n`);
      return;
    }
  }

  process.stdout.write(
    "用法: node scripts/service.mjs <run|install|restart|uninstall|status|logs>\n",
  );
  process.exit(2);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCommand(process.argv[2] || "run");
}
