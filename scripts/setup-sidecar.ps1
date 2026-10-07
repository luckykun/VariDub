#Requires -Version 5.1
<#
.SYNOPSIS
    sidecar Python 环境引导（SPEC-001 §7.4 / sidecar/README.md「手动搭建」的脚本化版本）。

.DESCRIPTION
    在 sidecar\.venv 建虚拟环境并安装推理依赖，与主进程的「一键引导」使用同一条解释器查找顺序
    （py -3.11 → py -3 → python → python3），Microsoft Store 的占位 python 会因探针失败被跳过。
    CUDA 版 requirements.txt 装不上时自动回退 requirements-cpu.txt（能跑通功能，速度另计）。

.PARAMETER Python
    指定基座解释器（默认自动探测）。例：-Python "C:\Program Files\Python311\python.exe"

.PARAMETER Cpu
    跳过 CUDA 版，直接装 requirements-cpu.txt。

.PARAMETER ModelsRoot
    模型根目录，默认 %LOCALAPPDATA%\VariDub\models（与主进程 modelsDir() 一致）。

.PARAMETER WithModels
    依赖装完后顺带下载 Demucs 权重（约 80MB）。

.PARAMETER Recreate
    已存在 .venv 时先删掉重建。

.EXAMPLE
    npm run sidecar:install
    powershell -File scripts\setup-sidecar.ps1 -Cpu -WithModels
#>
[CmdletBinding()]
param(
    [string]$Python = '',
    [switch]$Cpu,
    [string]$ModelsRoot = '',
    [switch]$WithModels,
    [switch]$Recreate
)

# pip / python 会往 stderr 写警告与进度，Windows PowerShell 在 Stop 下会把它当异常中断，
# 因此统一用退出码 + 显式 throw 判定失败
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SidecarDir = Join-Path $RepoRoot 'sidecar'
$VenvDir = Join-Path $SidecarDir '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
if (-not $ModelsRoot) {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = $env:APPDATA }
    $ModelsRoot = Join-Path (Join-Path $local 'VariDub') 'models'
}

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Dim($text) { Write-Host "   $text" -ForegroundColor DarkGray }

<# 探针：能打印版本号才算真实可用的解释器，返回 @{Path;Version} 或 $null #>
function Test-BasePython {
    param([string]$Exe, [string[]]$PreArgs = @())
    if ([string]::IsNullOrWhiteSpace($Exe)) { return $null }
    if (-not (Get-Command $Exe -ErrorAction SilentlyContinue) -and -not (Test-Path $Exe)) { return $null }
    $code = 'import sys;print(".".join(map(str,sys.version_info[:3])));print(sys.executable)'
    $probe = @($PreArgs) + @('-c', $code)
    try { $out = & $Exe @probe 2>$null } catch { return $null }
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    $lines = @($out | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' })
    if ($lines.Count -lt 2) { return $null }
    $version = $lines[0].Trim()
    $realPath = if ($lines[1] -match '^.*python(\.exe)?$') { $lines[1].Trim() } else { $Exe }
    if ($version -notmatch '^3\.\d+\.\d+$') { return $null }
    # torch 2.4 的官方 wheel 覆盖 3.9–3.12
    $minor = [int](($version -split '\.')[1])
    if ($minor -lt 9 -or $minor -gt 12) { return $null }
    return @{ Path = $realPath; Version = $version }
}

function Find-BasePython {
    param([string]$Explicit)
    if ($Explicit) {
        $direct = Test-BasePython -Exe $Explicit
        if (-not $direct) { throw "指定的解释器不可用或版本不在 3.9–3.12：$Explicit" }
        return $direct
    }
    # 与 manager.ts findSystemPython() 同序，避免脚本装好了、应用却找不到
    foreach ($c in @(
        @{ Exe = 'py'; Pre = @('-3.11') },
        @{ Exe = 'py'; Pre = @('-3') },
        @{ Exe = 'python'; Pre = @() },
        @{ Exe = 'python3'; Pre = @() }
    )) {
        $hit = Test-BasePython -Exe $c.Exe -PreArgs $c.Pre
        if ($hit) { return $hit }
    }
    return $null
}

function Invoke-Native($filePath, [string[]]$Arguments, $failMessage) {
    & $filePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$failMessage（退出码 $LASTEXITCODE）" }
}

Write-Host 'VariDub sidecar 环境引导' -ForegroundColor Green
Write-Dim "sidecar 目录：$SidecarDir"
Write-Dim "模型根目录：  $ModelsRoot"

if (-not (Test-Path (Join-Path $SidecarDir 'server.py'))) {
    throw "未找到 sidecar/server.py，请在仓库根目录运行本脚本"
}

Write-Step '1/4 探测基座 Python'
$base = Find-BasePython -Explicit $Python
if (-not $base) {
    throw '未找到可用的 Python 3.9–3.12。安装官方版本（https://www.python.org/downloads/windows/ 3.11 x64，勾选 Add to PATH），或直接用应用设置页的「一键引导环境」下载便携版。'
}
Write-Host "   使用 $($base.Path) （Python $($base.Version)）" -ForegroundColor Green

Write-Step '2/4 创建虚拟环境'
if (-not (Test-Path $ModelsRoot)) { New-Item -ItemType Directory -Path $ModelsRoot -Force | Out-Null }
if (Test-Path $VenvPython) {
    if ($Recreate) {
        Write-Dim 'Recreate：删除旧 .venv'
        Remove-Item -LiteralPath $VenvDir -Recurse -Force
        if (Test-Path $VenvPython) { throw "旧 .venv 删不掉（可能被 sidecar 进程占用），先关掉应用或 npm run sidecar:run 的窗口" }
    } else {
        Write-Host "   .venv 已存在，复用：$VenvDir" -ForegroundColor Yellow
    }
}
if (-not (Test-Path $VenvPython)) {
    Invoke-Native $base.Path @('-m', 'venv', $VenvDir) 'venv 创建失败'
}
if (-not (Test-Path $VenvPython)) { throw "venv 创建后找不到 $VenvPython" }

Write-Step '3/4 安装依赖'
Invoke-Native $VenvPython @('-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel') 'pip 升级失败'

$cudaReq = Join-Path $SidecarDir 'requirements.txt'
$cpuReq = Join-Path $SidecarDir 'requirements-cpu.txt'
$installedFrom = ''

# 用 Out-Host 把 pip 输出直接写到控制台，否则函数返回值会被这些文本污染
function Try-InstallRequirements($reqFile, $note) {
    Write-Host "   安装 $note" -ForegroundColor Green
    Write-Dim "   清单：$reqFile"
    # torch 的 wheel 上百 MB，这里不做进度条，交给 pip 自己的输出
    & $VenvPython -m pip install -r $reqFile | Out-Host
    return ($LASTEXITCODE -eq 0)
}

if ($Cpu) {
    if (-not (Try-InstallRequirements $cpuReq 'CPU 版（-Cpu 指定）')) { throw 'CPU 依赖安装失败，请检查网络或代理后重试' }
    $installedFrom = $cpuReq
} elseif (Try-InstallRequirements $cudaReq 'CUDA 12.1 版') {
    $installedFrom = $cudaReq
} else {
    Write-Host '   CUDA 版安装失败，回退 CPU 版（功能一致，速度明显更慢）' -ForegroundColor Yellow
    if (-not (Try-InstallRequirements $cpuReq 'CPU 版')) { throw 'CUDA 与 CPU 两套依赖都装不上，请查看上方 pip 报错' }
    $installedFrom = $cpuReq
}

# 只确认「能 import」，不去真的初始化 CUDA（首次探测可能耗时数秒，交给 sidecar 后台预热）
& $VenvPython -c 'import importlib.util as u;names=["torch","torchaudio","demucs","cv2","huggingface_hub"];print(", ".join(n for n in names if u.find_spec(n)))'
if ($LASTEXITCODE -ne 0) { throw '依赖校验失败' }
& $VenvPython -c 'import torch,demucs;print("torch",torch.__version__,"cuda",torch.cuda.is_available())' 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host '   torch/demucs 导入失败，请贴出上面的报错' -ForegroundColor Yellow }

Write-Step '4/4 模型权重'
if ($WithModels) {
    Invoke-Native $VenvPython @(
        (Join-Path $SidecarDir 'download_models.py'),
        '--models-root', $ModelsRoot,
        '--which', 'demucs'
    ) '权重下载失败'
} else {
    Write-Dim '跳过（首次启动时应用会自动引导下载；也可稍后手动执行）'
    Write-Dim "& '$VenvPython' '$(Join-Path $SidecarDir 'download_models.py')' --models-root '$ModelsRoot' --which all"
}

Write-Host "`n完成。" -ForegroundColor Green
Write-Host "  环境：$VenvDir"
Write-Host "  清单：$installedFrom"
Write-Host "  单独跑服务验证：npm run sidecar:run"
Write-Host "  口型（MuseTalk）为可插拔后端，见 sidecar\README.md；未接入时步骤⑥ 跳过口型仍出成片。"
