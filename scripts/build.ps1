#Requires -Version 5.1
<#
.SYNOPSIS
    构建链路一键脚本：类型检查 → 打包渲染产物 →（可选）冒烟 →（可选）出安装包。

.PARAMETER Smoke
    构建完跑 10s 样片的 ①→⑥ 冒烟测试（云端 mock，SPEC-001 §7.8）。

.PARAMETER Dist
    用 electron-builder 出 NSIS 安装版 + portable 版到 release\。

.PARAMETER SkipTypecheck
    跳过 tsc（只在赶时间时用）。

.EXAMPLE
    .\scripts\build.ps1
    .\scripts\build.ps1 -Smoke -Dist
#>
[CmdletBinding()]
param(
    [switch]$Smoke,
    [switch]$Dist,
    [switch]$SkipTypecheck
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# npm / electron-builder 会往 stderr 写进度与警告，Windows PowerShell 在 Stop 下会把它当异常，
# 所以跨阶段调用统一用 Continue + 显式检查 $LASTEXITCODE
function Invoke-Stage($name, [scriptblock]$body) {
    Write-Host "`n== $name" -ForegroundColor Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $body } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw "$name 失败（退出码 $LASTEXITCODE）" }
}

if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Invoke-Stage '安装依赖' { npm install }
}

# 图标是派生产物：缺失就按脚本重生，保证窗口/托盘/安装包都有图
if (-not (Test-Path (Join-Path $RepoRoot 'resources\icon.png')) -or -not (Test-Path (Join-Path $RepoRoot 'build\icon.ico'))) {
    Invoke-Stage '生成应用图标' { node scripts\make-icon.mjs }
}

if (-not $SkipTypecheck) {
    Invoke-Stage '类型检查' { npm run typecheck }
}

Invoke-Stage '构建（electron-vite）' { npm run build }

if ($Smoke) {
    Invoke-Stage '冒烟测试 ①→⑥' { node scripts\smoke-test.mjs }
}

if ($Dist) {
    Invoke-Stage '打包安装程序（electron-builder）' { npx electron-builder --win }
    Write-Host "`n产物目录：$(Join-Path $RepoRoot 'release')" -ForegroundColor Green
    Get-ChildItem (Join-Path $RepoRoot 'release') -Filter *.exe -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "  $($_.Name)  ($([math]::Round($_.Length / 1MB, 1)) MB)" }
}

Write-Host "`n完成。" -ForegroundColor Green
