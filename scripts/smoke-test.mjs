#!/usr/bin/env node
/**
 * 冒烟测试（SPEC-001 §7.8）：用 10s 合成样片在无窗口模式下跑通 ①→⑥，
 * 云端调用全部 mock（--mock），验证的是「编排 + 文件产物 + 门禁」而不是模型效果。
 *
 *   npm run smoke
 *
 * 可选环境变量：SMOKE_EXE=<打包后的 VariDub.exe>（跑打包产物）、SMOKE_VERBOSE=1（转发子进程输出）、
 * SMOKE_KEEP=1（不清理上次数据）、SMOKE_STEP_TIMEOUT=<秒>。
 *
 * 隔离：VARIDUB_DATA_DIR 指到 out/smoke/data，工作区/导出目录指到 out/smoke/{workspace,export}，
 * 不碰 %APPDATA%/VariDub 与 D:/Vardub_Workspace。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SMOKE = join(ROOT, 'out', 'smoke')
const DATA = join(SMOKE, 'data')
const WORKSPACE = join(SMOKE, 'workspace')
const EXPORT = join(SMOKE, 'export')
const SAMPLE = join(SMOKE, 'sample.mp4')

const STEP_LABELS = { 1: '视频解析', 2: '人声分离·识别', 3: '中→英翻译', 4: '音色克隆配音', 5: '3D 画面重绘', 6: '口型对齐·导出'
}
/** 每步等待上限（秒）：mock 云端，本地图处理走 ffmpeg，正常都在几十秒内 */
const STEP_TIMEOUT_S = Number(process.env.SMOKE_STEP_TIMEOUT ?? 300)

let apiBase = ''
const results = []

main().catch((err) => {
  console.error('\n冒烟测试失败：', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})

async function main() {
  for (const dir of [SMOKE, DATA, WORKSPACE, EXPORT]) mkdirSync(dir, { recursive: true })
  if (process.env.SMOKE_KEEP !== '1') clean(dir => rmSync(dir, { recursive: true, force: true }), [DATA, WORKSPACE, EXPORT])
  for (const dir of [DATA, WORKSPACE, EXPORT]) mkdirSync(dir, { recursive: true })

  console.log('① 准备 10s 合成样片（ffmpeg lavfi）')
  await makeSample()

  console.log('② 启动无窗口 Electron（--mock --smoke）')
  const electron = await startElectron()
  try {
    apiBase = await waitForApiReady(electron.proc)
    console.log(`   本地服务：${apiBase}`)
    await runPipeline()
  } finally {
    electron.proc.kill('SIGTERM')
  }

  report()
}

/* ------------------------------------------------------------ 环境准备 */

function clean(rm, dirs) {
  for (const dir of dirs) rm(dir)
}

function ffmpegBinary() {
  const mod = require('ffmpeg-static')
  const p = typeof mod === 'string' ? mod : mod?.default
  if (!p || !existsSync(p)) throw new Error('ffmpeg-static 未提供可执行文件，请先 npm install')
  return p
}

async function makeSample() {
  if (existsSync(SAMPLE) && statSync(SAMPLE).size > 10_000 && process.env.SMOKE_REUSE_SAMPLE === '1') {
    console.log('   复用已有样片')
    return
  }
  const ff = ffmpegBinary()
  const args = [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=10',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SAMPLE
  ]
  // ffmpeg-static 的构建一般含 libx264；没有就退回 mpeg4
  await run(ff, [...args, '-c:v', 'libx264', '-preset', 'veryfast'])
    .catch(() => run(ff, [...args, '-c:v', 'mpeg4', '-q:v', '5']))
  if (!existsSync(SAMPLE) || statSync(SAMPLE).size < 1000) throw new Error('样片生成失败')
  console.log(`   ${SAMPLE}（${(statSync(SAMPLE).size / 1024).toFixed(0)} KB）`)
}

async function startElectron() {
  // SMOKE_EXE 指到 release/win-unpacked/VariDub.exe 时跑的是打包产物（验 asar 解包、ffmpeg/原生模块路径）
  const packaged = process.env.SMOKE_EXE?.trim()
  const bin = packaged ?? String(require('electron'))
  const proc = spawn(bin, packaged ? ['--mock', '--smoke'] : [ROOT, '--mock', '--smoke'], {
    cwd: ROOT,
    env: { ...process.env, VARIDUB_DATA_DIR: DATA, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const errLines = []
  proc.stderr.on('data', (chunk) => {
    const text = String(chunk)
    errLines.push(text)
    if (process.env.SMOKE_VERBOSE === '1') process.stderr.write(text)
  })
  proc.stdout.on('data', (chunk) => {
    if (process.env.SMOKE_VERBOSE === '1') process.stdout.write(String(chunk))
  })
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Electron 提前退出（code ${code}）：\n${errLines.join('').slice(-2000)}`)
    }
  })
  return { proc }
}

function waitForApiReady(proc) {
  return new Promise((resolveP, rejectP) => {
    const rl = createInterface({ input: proc.stdout })
    const timer = setTimeout(() => {
      rl.close()
      rejectP(new Error('60s 内没等到 api-ready，Electron 可能启动失败（加 SMOKE_VERBOSE=1 看输出）'))
    }, 60_000)
    rl.on('line', (line) => {
      const m = /\{.*"event"\s*:\s*"api-ready".*\}/.exec(line)
      if (!m) return
      clearTimeout(timer)
      rl.close()
      try {
        const info = JSON.parse(m[0])
        resolveP(`http://127.0.0.1:${info.port}`)
      } catch (err) {
        rejectP(err)
      }
    })
  })
}

/* ------------------------------------------------------------ HTTP */

async function http(method, path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  const payload = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `HTTP ${res.status}`
    throw new Error(`${method} ${path} → ${message}`)
  }
  return payload
}

const get = (path) => http('GET', path)
const post = (path, body) => http('POST', path, body ?? {})
const patch = (path, body) => http('PATCH', path, body)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------ 渲染层外壳 */

function expect(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`   ${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 渲染层由内嵌服务提供（打包后走 asar），开窗前先把「能不能加载」验掉：
 * 只验 HTML 与入口脚本能 200 拿到，不跑 React。
 */
async function verifyRendererShell() {
  console.log('②.1 渲染层外壳（GET /）')
  const res = await fetch(`${apiBase}/`)
  const html = await res.text()
  expect('首页 HTML 200', res.status === 200 && html.length > 100, `${res.status} · ${html.length}B`)
  expect('HTML 含挂载点与入口脚本', /<div id="root"/.test(html) && /<script[^>]+src="[^"]+\.js"/.test(html), '')
  const asset = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1]
  if (asset) {
    const js = await fetch(new URL(asset, `${apiBase}/`).href)
    const type = js.headers.get('content-type') ?? ''
    expect('入口 JS 可加载且 MIME 正确', js.status === 200 && /javascript/.test(type), `${js.status} · ${type}`)
    await js.text()
  }
  const css = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1]
  if (css) {
    const sheet = await fetch(new URL(css, `${apiBase}/`).href)
    expect('样式表可加载', sheet.status === 200, `${sheet.status}`)
    await sheet.text()
  }
}

/* ------------------------------------------------------------ 流水线 */

async function runPipeline() {
  const system = await get('/api/system')
  if (!system.mockMode) throw new Error('未处于 mock 模式，冒烟测试会打真实云端')
  console.log(`   服务信息：v${system.version} · ffmpeg ${system.ffmpeg}`)

  await verifyRendererShell()

  // 工作区与导出目录指向冒烟目录
  await patch('/api/settings', { storage: { workspaceRoot: WORKSPACE, exportDir: EXPORT } })

  console.log('③ 创建项目')
  const precheck = await post('/api/precheck', { filePath: SAMPLE })
  const blocked = (precheck.items ?? []).filter((i) => i.blocking && !i.pass).map((i) => `${i.label}：${i.detail}`)
  if (blocked.length) throw new Error(`前置检查被阻断：${blocked.join('；')}`)
  for (const item of precheck.items ?? []) console.log(`   [${item.pass ? '通过' : item.blocking ? '阻断' : '提示'}] ${item.label} — ${item.detail}`)

  const project = await post('/api/projects', { filePath: SAMPLE, name: '冒烟样片' })
  console.log(`   项目 ${project.id} · ${project.durationMs}ms`)

  for (const step of [1, 2, 3, 4, 5, 6]) {
    await doStep(project.id, step)
  }

  await verifyArtifacts(project.id)
}

async function doStep(projectId, step) {
  console.log(`④.${step} 步骤${step}「${STEP_LABELS[step]}」`)
  const opts = stepOptions(step)
  const job = await post(`/api/projects/${projectId}/steps/${step}/run`, opts)
  const final = await waitJob(projectId, job.id, step)
  if (final.state !== 'succeeded') throw new Error(`步骤${step} 任务 ${final.state}：${final.error ?? final.message ?? ''}`)
  console.log(`   任务完成（${final.message ?? '无附加信息'}）`)

  // 满足本步门禁：③ 全部句确认；⑤ 全部分镜接受
  if (step === 3) {
    const res = await post(`/api/projects/${projectId}/lines/confirm-all`)
    console.log(`   已确认句子：${res.confirmed}`)
  }
  if (step === 5) {
    const res = await post(`/api/projects/${projectId}/shots/accept`, { shotIds: null })
    console.log(`   已接受分镜：${res?.accepted ?? 0}`)
  }

  const gate = await get(`/api/projects/${projectId}/steps/${step}/gate`)
  for (const issue of gate.issues ?? []) console.log(`   [门禁${issue.level}] ${issue.message}`)
  if (!gate.allowed) throw new Error(`步骤${step} 门禁未通过：${(gate.blocking ?? []).join('；') || gate.reason || '未知原因'}`)

  await post(`/api/projects/${projectId}/steps/${step}/confirm`, { force: true })
  console.log('   已确认，进入下一步')

  if (step === 6) {
    const exp = await post(`/api/projects/${projectId}/step6/export`, { destDir: EXPORT, name: '冒烟成片' })
    console.log(`   导出到：${exp.exportedTo}`)
  }
}

function stepOptions(step) {
  if (step === 3) return { batchSize: 10 }
  if (step === 4) return { includeUnconfirmed: true }
  if (step === 5) return { onlyMissing: false, consistency: 0.8 }
  if (step === 6) return { skipLipsync: true } // 冒烟环境无 MuseTalk（§3.6 降级路径）
  return {}
}

async function waitJob(projectId, jobId, step) {
  const deadline = Date.now() + STEP_TIMEOUT_S * 1000
  let last = null
  while (Date.now() < deadline) {
    const jobs = await get(`/api/projects/${projectId}/jobs`)
    const job = jobs.find((j) => j.id === jobId) ?? jobs[jobs.length - 1]
    if (job && job !== last) {
      last = job
      if (job.message || job.error) console.log(`   · ${job.state} ${Math.round((job.progress ?? 0) * 100)}% ${job.message ?? job.error ?? ''}`)
    }
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    await sleep(1_000)
  }
  throw new Error(`步骤${step} 等待超过 ${STEP_TIMEOUT_S}s`)
}

/* ------------------------------------------------------------ 产物校验 */

async function verifyArtifacts(projectId) {
  console.log('⑤ 校验产物')
  const overview = await get(`/api/projects/${projectId}/overview`)
  const { project, shots, lines, speakers, product, artifacts } = overview

  expect('分镜已生成', shots.length > 0, `${shots.length} 个`)
  expect('逐句文本已识别', lines.length > 0, `${lines.length} 句`)
  expect('说话人已登记', speakers.length > 0, `${speakers.length} 人`)
  expect('每句有英文译文', lines.every((l) => !!l.enText), `${lines.filter((l) => l.enText).length}/${lines.length}`)
  expect('每句已配音', lines.every((l) => !!l.dubWavPath), `${lines.filter((l) => l.dubWavPath).length}/${lines.length}`)
  expect('配音文件存在', lines.every((l) => !l.dubWavPath || existsSync(l.dubWavPath)), '')
  const keyframes = artifacts.filter((a) => a.kind === 'keyframe')
  const clips = artifacts.filter((a) => a.kind === 'shot3d_clip')
  expect('3D 关键帧产物存在', keyframes.length > 0, `${keyframes.length} 张关键帧 / ${clips.length} 段动态片段`)
  const stepStates = project.stepStates ?? {}
  const statesText = Object.entries(stepStates).map(([s, v]) => `${s}:${v}`).join(' ')
  expect('全片六步已确认', [1, 2, 3, 4, 5, 6].every((s) => stepStates[s] === 'confirmed'), statesText)
  expect('成片 mp4 存在', !!product?.mp4 && existsSync(product.mp4), product?.mp4 ?? '无')
  expect('字幕 srt 存在', !!product?.srt && existsSync(product.srt), product?.srt ?? '无')
  expect('偏差报告存在', !!product?.report && existsSync(product.report), product?.report ?? '无')
  if (product?.mp4 && existsSync(product.mp4)) {
    const bytes = statSync(product.mp4).size
    expect('成片体积合理', bytes > 10_000, `${(bytes / 1024).toFixed(0)} KB`)
    const sizeOk = product.width > 0 && product.height > 0 && product.fps > 0
    expect('成片元信息完整', sizeOk, `${product.width}x${product.height}@${product.fps}fps ${Math.round(product.durationMs / 1000)}s`)
  }
  if (product?.srt && existsSync(product.srt)) {
    const text = readFileSync(product.srt, 'utf8')
    expect('SRT 有时间码与文本', /\d{2}:\d{2}:\d{2},\d{3} -->/.test(text) && text.trim().length > 20, `${text.split('\n').length} 行`)
  }
  const exported = product?.exportedTo
  expect('已导出到目标目录', !!exported && existsSync(exported), exported ?? '未导出')

  const report = await get(`/api/projects/${projectId}/report`)
  expect('报告逐句偏差行数一致', report.lines.length === lines.length, `${report.lines.length} vs ${lines.length}`)
}

/* ------------------------------------------------------------ 汇总 */

function report() {
  const failed = results.filter((r) => !r.ok)
  console.log('\n===== 冒烟测试结论 =====')
  console.log(`断言 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✘ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
    process.exitCode = 1
  } else {
    console.log('①→⑥ 全链路跑通，产物齐备。')
  }
}

async function run(bin, args) {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (c) => {
      stderr += String(c)
    })
    proc.on('error', rejectP)
    proc.on('exit', (code) => (code === 0 ? resolveP(stderr) : rejectP(new Error(`${bin} 退出码 ${code}：${stderr.slice(-400)}`))))
  })
}
