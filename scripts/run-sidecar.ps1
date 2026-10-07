#Requires -Version 5.1
<#
.SYNOPSIS
    单独拉起 sidecar/server.py（联调用，SPEC-001 §7.8：主进程与 sidecar 可独立重启）。

.DESCRIPTION
    解释器查找顺序与主进程 manager.ts 完全一致：sidecar\.venv → 便携版 → 系统 Python。
    会把 ffmpeg-static 的二进制通过 --ffmpeg / VARIDUB_FFMPEG 注入，避免「手动跑就没 ffmpeg」。
    服务在前台运行，Ctrl+C 停止；stdout 首行 {"event":"ready","port":N,...} 就是实际监听端口。

.PARAMETER Port
    监听端口，默认 0（随机）。固定端口便于另开终端 curl。

.PARAMETER Python
    强制指定解释器（跳过自动查找）。

.PARAMETER ModelsRoot
    模型根目录，默认 %LOCALAPPDATA%\VariDub\models。

.PARAMETER Ffmpeg
    ffmpeg 可执行文件路径，默认取 node_modules\ffmpeg-static\ffmpeg.exe。

.PARAMETER Cpu
    传 --cpu 给 server.py（强制 CUDA_VISIBLE_DEVICES=-1，用于对比实测）。

.EXAMPLE
    npm run sidecar:run
    powershell -File scripts\run-sidecar.ps1 -Port 8765
    curl.exe http://127.0.0.1:8765/health
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$Python = '',
    [string]$ModelsRoot = '',
    [string]$Ffmpeg = '',
    [switch]$Cpu
)

# python 会往 stderr 写警告，Windows PowerShell 在 Stop 下会把它当异常，这里统一用退出码判定
$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SidecarDir = Join-Path $RepoRoot 'sidecar'
$Script = Join-Path $SidecarDir 'server.py'

if (-not (Test-Path $Script)) { throw "未找到 $Script" }

if (-not $ModelsRoot) {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = $env:APPDATA }
    $ModelsRoot = Join-Path (Join-Path $local 'VariDub') 'models'
}
if (-not (Test-Path $ModelsRoot)) { New-Item -ItemType Directory -Path $ModelsRoot -Force | Out-Null }

<# 按 manager.ts 的顺序挑解释器：venv → 便携版 → 系统 #>
function Select-SidecarPython {
    param([string]$Explicit, [string]$Root, [string]$Models)
    if ($Explicit) {
        if (-not (Test-Path $Explicit) -and -not (Get-Command $Explicit -ErrorAction SilentlyContinue)) {
            throw "指定的解释器不存在：$Explicit"
        }
        return $Explicit
    }
    $venv = Join-Path (Join-Path $Root '.venv') 'Scripts\python.exe'
    if (Test-Path $venv) { return $venv }
    $portable = Join-Path (Join-Path (Split-Path -Parent $Models) 'python') 'python.exe'
    if (Test-Path $portable) { return $portable }
    foreach ($name in @('py', 'python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        try { & $cmd.Path -c 'import sys' 2>$null | Out-Null } catch { continue }
        if ($LASTEXITCODE -eq 0) {
            if ($name -eq 'py') { return @{ Exe = $cmd.Path; Pre = @('-3.11') } }
            return $cmd.Path
        }
    }
    return $null
}

function Select-Ffmpeg {
    param([string]$Explicit, [string]$Repo)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "指定的 ffmpeg 不存在：$Explicit" }
        return $Explicit
    }
    $static = Join-Path (Join-Path (Join-Path $Repo 'node_modules') 'ffmpeg-static') 'ffmpeg.exe'
    if (Test-Path $static) { return $static }
    $onPath = Get-Command 'ffmpeg' -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Path }
    return ''
}

$chosen = Select-SidecarPython -Explicit $Python -Root $SidecarDir -Models $ModelsRoot
if (-not $chosen) {
    throw '没有找到可用 Python。先跑 npm run sidecar:install 建 venv，或用应用设置页的「一键引导环境」。'
}
$ff = Select-Ffmpeg -Explicit $Ffmpeg -Repo $RepoRoot

$pyExe = $chosen
$pyPre = @()
if ($chosen -is [hashtable]) { $pyExe = $chosen.Exe; $pyPre = $chosen.Pre }

$env:VARIDUB_MODEL_ROOT = $ModelsRoot
if ($ff) { $env:VARIDUB_FFMPEG = $ff }
$env:PYTHONUNBUFFERED = '1'

$serverArgs = @('--port', [string]$Port, '--models-root', $ModelsRoot)
if ($ff) { $serverArgs += @('--ffmpeg', $ff) }
if ($Cpu) { $serverArgs += '--cpu' }
# 解释器前置参数（如 py 的 -3.11）→ 脚本路径 → 服务参数
$argv = @($pyPre) + @($Script) + $serverArgs

Write-Host 'VariDub sidecar（独立运行）' -ForegroundColor Green
Write-Host "  解释器：$pyExe"
Write-Host "  模型根：$ModelsRoot"
Write-Host "  ffmpeg ：$(if ($ff) { $ff } else { '未找到，/health 会给出提示' })"
Write-Host "  端口：  $(if ($Port -eq 0) { '随机（看下面 ready 行）' } else { $Port })"
Write-Host 'Ctrl+C 停止。另开终端可 curl http://127.0.0.1:<port>/health' -ForegroundColor DarkGray
Write-Host ''

& $pyExe @argv
exit $LASTEXITCODE
