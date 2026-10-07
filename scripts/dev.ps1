#Requires -Version 5.1
<#
.SYNOPSIS
    开发模式启动（electron-vite dev，热更新）。

.PARAMETER Mock
    置 VARIDUB_MOCK=1：所有云端调用返回本地可播放/可显示的假产物（SPEC-001 §7.8），
    不消耗 API-KEY，用来验证编排与门禁。

.PARAMETER DataDir
    用独立数据目录启动（多实例联调），默认 %APPDATA%\VariDub。

.EXAMPLE
    .\scripts\dev.ps1
    .\scripts\dev.ps1 -Mock -DataDir .\out\dev-data
#>
[CmdletBinding()]
param(
    [switch]$Mock,
    [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Host '首次运行：安装依赖' -ForegroundColor Yellow
    # npm 会往 stderr 写警告，Stop 下会被误判为异常，这里统一用退出码判定
    $ErrorActionPreference = 'Continue'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    $ErrorActionPreference = 'Stop'
}

if ($Mock) {
    $env:VARIDUB_MOCK = '1'
    Write-Host 'Mock 模式：云端调用不发真实请求' -ForegroundColor Cyan
}
if ($DataDir) {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    $env:VARIDUB_DATA_DIR = (Resolve-Path $DataDir).Path
    Write-Host "独立数据目录：$($env:VARIDUB_DATA_DIR)" -ForegroundColor Cyan
}

$ErrorActionPreference = 'Continue'
npm run dev
exit $LASTEXITCODE
