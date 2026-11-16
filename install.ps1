param(
  [ValidateSet("auto", "cloudflare", "relay", "local")]
  [string]$Remote = "auto",
  [string]$RelayUrl = "",
  [string]$InviteCode = "",
  [string]$HostLabel = "",
  [string]$InstallDir = "$env:LOCALAPPDATA\agent-control\app",
  [int]$Port = 43310,
  [switch]$NoService,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$RepoUrl = if ($env:AGENT_CONTROL_REPO_URL) { $env:AGENT_CONTROL_REPO_URL } else { "https://github.com/guuguo/agent-control.git" }
$RepoBranch = if ($env:AGENT_CONTROL_BRANCH) { $env:AGENT_CONTROL_BRANCH } else { "main" }

if ($Remote -eq "auto") {
  if ($env:AGENT_CONTROL_REMOTE -in @("cloudflare", "relay", "local")) {
    $Remote = $env:AGENT_CONTROL_REMOTE
  } elseif ([Environment]::UserInteractive) {
    Write-Host ""
    Write-Host "请选择手机远程接入方案（安装后可随时在页面切换）：" -ForegroundColor Cyan
    Write-Host "  [1] Cloudflare 免费临时隧道（推荐，自动检测安装 cloudflared；免服务器，每次地址随机）"
    Write-Host "  [2] 自托管固定中继（连接自己的 relay 服务器；域名固定、自动重连，需自备服务器）"
    Write-Host "  [3] 仅本机使用（不安装额外隧道组件，后续随时可切换）"
    $choice = Read-Host "请输入选项 [1/2/3]（默认 1）"
    switch ($choice) {
      "2" { $Remote = "relay" }
      "3" { $Remote = "local" }
      default { $Remote = "cloudflare" }
    }
  } else {
    $Remote = "cloudflare"
  }
}

if ($Remote -eq "relay" -and -not $RelayUrl -and [Environment]::UserInteractive) {
  $RelayUrl = Read-Host "请输入自托管中继地址（留空跳过，稍后在界面配对）"
  if ($RelayUrl) {
    $InviteCode = Read-Host "请输入配对邀请码"
  }
}

Write-Host "[1/5] 检查 Node.js (>= 22) 与 Git 环境..." -ForegroundColor Cyan
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Error "未检测到 Node.js。请先安装 Node.js 22+：winget install OpenJS.NodeJS.LTS"
  exit 1
}

$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 22) {
  Write-Error "当前 Node.js 版本过低（需要 >= 22.0.0）：$(& node -v)。请升级后重试。"
  exit 1
}

$appDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "src\server.mjs")) -and (Test-Path (Join-Path $PSScriptRoot "package.json"))) {
  $appDir = $PSScriptRoot
  Write-Host "[2/5] 使用本地源码目录: $appDir" -ForegroundColor Cyan
} else {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "未检测到 Git。请先安装 Git：winget install Git.Git"
    exit 1
  }
  $parentDir = Split-Path -Parent $InstallDir
  if (-not (Test-Path $parentDir)) {
    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
  }
  if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "[2/5] 正在更新仓库: $InstallDir" -ForegroundColor Cyan
    & git -C $InstallDir fetch --depth 1 origin $RepoBranch
    & git -C $InstallDir checkout -B $RepoBranch "origin/$RepoBranch"
  } else {
    Write-Host "[2/5] 正在克隆 Agent Control 到: $InstallDir" -ForegroundColor Cyan
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    & git clone --depth 1 --branch $RepoBranch $RepoUrl $InstallDir
  }
  $appDir = $InstallDir
}

Write-Host "[3/5] 正在安装依赖..." -ForegroundColor Cyan
Push-Location $appDir
try {
  & npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if ($Remote -eq "cloudflare") {
    Write-Host "[4/5] 正在检查 Cloudflare 免费临时隧道 (cloudflared)..." -ForegroundColor Cyan
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
      if (Get-Command winget -ErrorAction SilentlyContinue) {
        try {
          & winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements
        } catch {
          Write-Warning "自动安装 cloudflared 失败，可稍后手动执行：winget install --id Cloudflare.cloudflared"
        }
      } else {
        Write-Warning "未检测到 winget，请手动安装 cloudflared：winget install --id Cloudflare.cloudflared"
      }
    }
  } else {
    Write-Host "[4/5] 已选择远程模式: $Remote（跳过自动安装 cloudflared）" -ForegroundColor Cyan
  }

  $env:PORT = "$Port"
  if (-not $NoService) {
    Write-Host "[5/5] 正在安装并启动 Windows 后台任务 (端口 $Port)..." -ForegroundColor Cyan
    & node scripts\service.mjs install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
} finally {
  Pop-Location
}

$desktopDir = [Environment]::GetFolderPath("Desktop")
if ($desktopDir -and (Test-Path $desktopDir)) {
  $shortcutPath = Join-Path $desktopDir "Agent Control.url"
  $urlContent = "[InternetShortcut]`r`nURL=http://127.0.0.1:$Port/`r`n"
  Set-Content -Path $shortcutPath -Value $urlContent -Encoding ASCII
}

$healthy = $false
if (-not $NoService) {
  for ($i = 0; $i -lt 20; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1 -UseBasicParsing
      if ($resp.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 400
  }
}

$relayNote = ""
if ($Remote -eq "relay" -and $RelayUrl -and $InviteCode -and $healthy) {
  try {
    $pairBody = @{ relayUrl = $RelayUrl; inviteCode = $InviteCode; label = $HostLabel } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/remote/pair" -ContentType "application/json" -Body $pairBody | Out-Null
    $relayNote = "已完成固定中继配对 ($RelayUrl)"
  } catch {
    $relayNote = "自动配对失败，请在页面「手机远程 -> 自托管固定中继」中重试"
  }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Agent Control 安装完成" -ForegroundColor Green
Write-Host "  源码目录: $appDir"
Write-Host "  本地控制台: http://127.0.0.1:$Port"
Write-Host "  远程模式: $Remote（可在界面「手机远程」随时切换 Cloudflare / 固定中继）"
if ($relayNote) {
  Write-Host "  中继状态: $relayNote"
}
Write-Host "  桌面快捷方式: $desktopDir\Agent Control.url"
if ($healthy) {
  Write-Host "  服务状态: 运行中"
}
Write-Host "==================================================" -ForegroundColor Green

if (-not $NoOpen -and -not $NoService) {
  Start-Process "http://127.0.0.1:$Port"
}
