param(
  [string]$InstallDir = "$env:LOCALAPPDATA\agent-control\app",
  [int]$Port = 43310,
  [switch]$NoService,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$RepoUrl = if ($env:AGENT_CONTROL_REPO_URL) { $env:AGENT_CONTROL_REPO_URL } else { "https://github.com/guuguo/agent-control.git" }
$RepoBranch = if ($env:AGENT_CONTROL_BRANCH) { $env:AGENT_CONTROL_BRANCH } else { "main" }

Write-Host "[1/4] 检查 Node.js (>= 22) 与 Git 环境..." -ForegroundColor Cyan
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
  Write-Host "[2/4] 使用本地源码目录: $appDir" -ForegroundColor Cyan
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
    Write-Host "[2/4] 正在更新仓库: $InstallDir" -ForegroundColor Cyan
    & git -C $InstallDir fetch --depth 1 origin $RepoBranch
    & git -C $InstallDir checkout -B $RepoBranch "origin/$RepoBranch"
  } else {
    Write-Host "[2/4] 正在克隆 Agent Control 到: $InstallDir" -ForegroundColor Cyan
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    & git clone --depth 1 --branch $RepoBranch $RepoUrl $InstallDir
  }
  $appDir = $InstallDir
}

Write-Host "[3/4] 正在安装依赖..." -ForegroundColor Cyan
Push-Location $appDir
try {
  & npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $env:PORT = "$Port"
  if (-not $NoService) {
    Write-Host "[4/4] 正在安装并启动 Windows 后台任务 (端口 $Port)..." -ForegroundColor Cyan
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

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Agent Control 安装完成" -ForegroundColor Green
Write-Host "  源码目录: $appDir"
Write-Host "  本地控制台: http://127.0.0.1:$Port"
Write-Host "  桌面快捷方式: $desktopDir\Agent Control.url"
if ($healthy) {
  Write-Host "  服务状态: 运行中"
}
Write-Host "==================================================" -ForegroundColor Green

if (-not $NoOpen -and -not $NoService) {
  Start-Process "http://127.0.0.1:$Port"
}
