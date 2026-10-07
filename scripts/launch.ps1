<#
.SYNOPSIS
  VariDub（综译）启动器 —— 双击启动.bat 的全部逻辑都在这里。

.DESCRIPTION
  为什么中文放这个文件而不是 .bat：
  cmd 按「字节」定位批处理行，中文一旦和控制台代码页不一致就会错位，
  把 rem 注释当命令执行（'ectron-vite' is not recognized）；而 PowerShell 通过
  Unicode API 写控制台，与代码页无关，中文永远不乱。所以 .bat 只留纯 ASCII 转发。

.USAGE
  双击 双击启动.bat            出编号菜单
  .\双击启动.bat mock          跳过菜单直接启动（packaged / mock / dev / smoke）
#>
[CmdletBinding()]
param([string] $Mode = '')

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Exe = Join-Path $Root 'release\win-unpacked\VariDub.exe'
$DataDir = Join-Path $env:APPDATA 'VariDub'

function Say([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::Gray) {
  Write-Host $Text -ForegroundColor $Color
}

function Show-Menu {
  Say ''
  Say ' VariDub（综译）· 选一个启动方式，输入编号后回车：' -ForegroundColor White
  Say ''
  Say '   [1] 正式版          打开 release\win-unpacked\VariDub.exe（推荐，起得最快）'
  Say '   [2] 正式版 + Mock   云端不发真实请求、不消耗 API-KEY，先熟悉界面用这个'
  Say '   [3] 开发模式        源码热更新，改完立刻生效（需要 Node，不用重新打包）'
  Say '   [4] 无窗口自检      在本窗口跑一遍 ①→⑥ 并打印结果'
  Say '   [0] 退出'
  Say ''
}

function Test-Node {
  $null = Get-Command node -ErrorAction SilentlyContinue
  return $?
}

function Warn-IfRunning {
  # 单实例锁挂在 userData 上，且点窗口 × 只是收进托盘：旧进程会静默吃掉新启动
  $running = @(Get-Process -Name 'VariDub' -ErrorAction SilentlyContinue)
  if ($running.Count -eq 0) { return }
  Say ''
  Say " 注意：VariDub 已经在后台运行（$($running.Count) 个进程，PID $($running[0].Id) 起）。" -ForegroundColor Yellow
  Say ' 现在再启动一个也不会生效 —— 界面由先启动的那个实例提供。' -ForegroundColor Yellow
  Say ' 要换版本：右下角托盘图标 右键「退出 VariDub」，再重新打开。' -ForegroundColor Yellow
  Say ''
}

function Warn-IfExeStale {
  # exe 是打包那一刻的快照：源码比它新，双击看到的就是旧界面（踩过两次）
  if (-not (Test-Path $Exe)) { return }
  $exeTime = (Get-Item $Exe).LastWriteTime
  $srcNewest = Get-ChildItem (Join-Path $Root 'src') -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $srcNewest) { return }
  if ($srcNewest.LastWriteTime -le $exeTime) { return }
  Say ''
  Say " 提醒：源码比 exe 新（$($srcNewest.Name) 改于 $($srcNewest.LastWriteTime.ToString('MM-dd HH:mm'))，" -ForegroundColor DarkYellow
  Say "       exe 打包于 $($exeTime.ToString('MM-dd HH:mm'))）—— 这个窗口的界面可能不是最新的。" -ForegroundColor DarkYellow
  Say '       想让 exe 跟上：先退出实例，再跑 npm run dist；调 UI 建议直接选 [3] 开发模式。' -ForegroundColor DarkYellow
  Say ''
}

function Start-Packaged([bool]$Mock) {
  Warn-IfRunning
  Warn-IfExeStale
  if ($Mock) { $env:VARIDUB_MOCK = '1' }
  Start-Process -FilePath $Exe | Out-Null
  if ($Mock) {
    Say ' VariDub 已启动 · Mock 模式（界面顶部有 Mock 徽章，产物是假的、不消耗 API-KEY）' -ForegroundColor Green
  } else {
    Say ' VariDub 已启动 · 正式版（云端调用真实计费，未配 API-KEY 时步骤① 会提示）' -ForegroundColor Green
  }
  Say " 数据目录：$DataDir"
  Say ' 没看到窗口就去任务栏或右下角托盘找；退出请托盘图标 右键「退出 VariDub」。'
  return $true   # 需要停留等按键
}

function Start-Smoke {
  Warn-IfRunning
  Say ' 无窗口自检中（①→⑥ 全链路，Mock 云端，约 1-2 分钟）：' -ForegroundColor Cyan
  & $Exe --mock --smoke
  Say " 自检退出码 $LASTEXITCODE"
  return $false
}

function Start-Dev {
  if (-not (Test-Node)) {
    Say ' 这台机器没有 Node.js。两种选择：' -ForegroundColor Red
    Say '   1) 装 Node 18+（https://nodejs.org），再双击本文件'
    Say '   2) 直接用免安装包：release\VariDub-0.1.0-portable.exe'
    return $true
  }
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Say ' 首次运行：安装依赖 npm install（可能要几分钟，期间别关窗口）' -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { Say ' npm install 失败了，把上面的报错贴给我。' -ForegroundColor Red; return $true }
  }
  Warn-IfRunning
  Say ' 开发模式启动（改渲染层代码即时生效；关掉这个窗口或按 Ctrl+C 就停止）' -ForegroundColor Cyan
  npm run dev
  return $false
}

function Show-NoBuild {
  Say ' 还没有打包产物（release\win-unpacked\VariDub.exe）。' -ForegroundColor Red
  Say ' 先执行一次：npm run dist      之后就能双击本文件选 [1]。'
  Say ' 也可以选 [3] 开发模式：自动装依赖并热更新启动。'
  return $true
}

# --------------------------------------------------------------- 入口分发

$pick = switch ($Mode.ToLowerInvariant()) {
  'packaged' { '1' }
  'mock'     { '2' }
  'dev'      { '3' }
  'smoke'    { '4' }
  default    { '' }
}

$needPause = $false
$tries = 0
while ($true) {
  if ($pick -eq '') {
    Show-Menu
    $def = if (Test-Path $Exe) { '1' } else { '3' }
    $pick = Read-Host " 请输入 1 / 2 / 3 / 4 / 0（直接回车=$def）"
    if ([string]::IsNullOrWhiteSpace($pick)) { $pick = $def }
    $pick = $pick.Trim()
  }

  $again = $false
  switch ($pick) {
    '0' { Say ' 已退出。' DarkGray }
    '1' { if (Test-Path $Exe) { $needPause = Start-Packaged $false } else { $needPause = Show-NoBuild } }
    '2' { if (Test-Path $Exe) { $needPause = Start-Packaged $true } else { $needPause = Show-NoBuild } }
    '3' { $needPause = Start-Dev }
    '4' { if (Test-Path $Exe) { $needPause = Start-Smoke } else { $needPause = Show-NoBuild } }
    default { Say " 没这个编号（$pick），再选一次。" -ForegroundColor Yellow; $again = $true }
  }

  # 重选最多 5 次：管道里读到 EOF 时 Read-Host 会一直返回空，不能死循环
  $tries++
  if ($again -and $tries -lt 5) { $pick = ''; continue }
  break
}

# 双击进去的窗口要停住等按键；输入被重定向（脚本调用/自动化）时不等，否则会挂住
if ($needPause -and -not [Console]::IsInputRedirected) {
  Say ''
  Read-Host ' 按回车关闭本窗口' | Out-Null
}
