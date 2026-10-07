/**
 * ffmpeg 封装：抽帧 / 切片 / 音轨时间轴拼装 / 混音 / 合成（SPEC-001 §7.2）。
 * 二进制由 ffmpeg-static 随包分发；该包不含 ffprobe，故统一用 `ffmpeg -i`  stderr 解析 + 滤镜取元信息。
 */
import ffmpegStatic from 'ffmpeg-static'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureParent } from '../logger'
import { CancelledError, throwIfCancelled } from '../jobs'
import type { JobRecord } from '../jobs'

/**
 * asar 内的二进制无法被 CreateProcess 直接执行，打包后需指向 electron-builder 的解包目录。
 * 未命中 app.asar 路径时原样返回（开发环境）。
 */
function resolveExecutable(p: string): string {
  const unpacked = p.replace(/\.asar([\\/])/, '.asar.unpacked$1')
  if (unpacked === p) return p
  return existsSync(unpacked) ? unpacked : p
}

export const FFMPEG_PATH = resolveExecutable((ffmpegStatic as unknown as string) ?? 'ffmpeg')

export interface MediaProbe {
  durationMs: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  audioSampleRate: number | null
  meanVolumeDb: number | null
  maxVolumeDb: number | null
}

export class FfmpegError extends Error {
  stderr: string
  constructor(message: string, stderr: string) {
    super(message)
    this.name = 'FfmpegError'
    this.stderr = stderr
  }
}

export interface RunOptions {
  cwd?: string
  onLine?: (line: string) => void
  timeoutMs?: number
  /** 用于进度：把 00:xx:xx 时间码回报给调用方 */
  onTimecode?: (ms: number) => void
  totalMs?: number
}

/**
 * 从 stderr 里提炼一句「人能看懂的原因」。
 * 只报「ffmpeg 退出码 1」用户无从下手（滤镜拼错 / 编码器缺失 / 文件损坏都长一个样）。
 */
function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return ''
  const noise = /^(frame=|\s*video:|\s*apple|Press \[q\])/i
  const pick =
    lines.filter((l) => !noise.test(l)).slice(-6).find((l) => /error|invalid|no such|not found|failed|denied|no space/i.test(l)) ??
    lines[lines.length - 1]
  return pick.slice(0, 240)
}

/** 跑一条 ffmpeg 命令，收集 stderr；非 0 退出抛 FfmpegError */
export function runFFmpeg(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(FFMPEG_PATH, args, { cwd: opts.cwd, windowsHide: true })
    let stderr = ''
    let timer: NodeJS.Timeout | null = null
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectP(new FfmpegError(`ffmpeg 超时（${Math.round(opts.timeoutMs! / 1000)}s）`, stderr))
      }, opts.timeoutMs)
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      const lines = chunk.split('\n').filter((l) => l.trim().length > 0)
      for (const line of lines) {
        opts.onLine?.(line)
        if (opts.onTimecode) {
          const m = /time=(\d+):(\d+):(\d+)\.(\d+)/.exec(line)
          if (m) opts.onTimecode(Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0').slice(0, 3)))
        }
      }
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      rejectP(new FfmpegError(`无法启动 ffmpeg：${err.message}`, stderr))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolveP(stderr)
      else {
        const why = summarizeStderr(stderr)
        rejectP(new FfmpegError(why ? `ffmpeg 退出码 ${code}：${why}` : `ffmpeg 退出码 ${code}`, stderr))
      }
    })
  })
}

function parseDuration(text: string): number {
  const m = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(text)
  if (!m) return 0
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10
}

function parseVideo(text: string): { width: number; height: number; fps: number } {
  const v = /Stream #\d+:\d+.*?Video:.*?(\d{2,5})x(\d{2,5}).*?(?:([\d.]+)\s*fps)?/.exec(text)
  if (!v) return { width: 0, height: 0, fps: 0 }
  return { width: Number(v[1]), height: Number(v[2]), fps: v[3] ? Number(v[3]) : 0 }
}

function parseAudio(text: string): { has: boolean; sampleRate: number | null } {
  const a = /Stream #\d+:\d+.*?Audio:.*?(\d+)\s*Hz/.exec(text)
  if (!a) return { has: /Audio:/.test(text), sampleRate: null }
  return { has: true, sampleRate: Number(a[1]) }
}

/** 一次探测：时长/分辨率/帧率/音轨 */
export async function probe(path: string): Promise<MediaProbe> {
  if (!existsSync(path)) throw new FfmpegError(`文件不存在：${path}`, '')
  const stderr = await runFFmpeg(['-hide_banner', '-i', path, '-frames:v', '1', '-f', 'null', '-'], { timeoutMs: 60_000 })
  const dur = parseDuration(stderr)
  const video = parseVideo(stderr)
  const audio = parseAudio(stderr)
  return {
    durationMs: dur,
    width: video.width,
    height: video.height,
    fps: video.fps,
    hasAudio: audio.has,
    audioSampleRate: audio.sampleRate,
    meanVolumeDb: null,
    maxVolumeDb: null
  }
}

/** 音量统计（人声存在性启发：mean_volume > -60dB 视为有音频内容） */
export async function volumeStats(path: string, startMs = 0, durationMs = 30_000): Promise<{ mean: number; max: number }> {
  const stderr = await runFFmpeg(
    ['-hide_banner', '-ss', (startMs / 1000).toFixed(3), '-t', (durationMs / 1000).toFixed(3), '-i', path, '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-'],
    { timeoutMs: 120_000 }
  )
  const mean = /RMS level dB:\s*(-?[\d.]+)/.exec(stderr)
  const max = /Peak level dB:\s*(-?[\d.]+)/.exec(stderr)
  return {
    mean: mean ? Number(mean[1]) : -91,
    max: max ? Number(max[1]) : -91
  }
}

export async function extractAudioWav(video: string, outWav: string): Promise<string> {
  ensureParent(outWav)
  await runFFmpeg(['-y', '-i', video, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outWav], { timeoutMs: 300_000 })
  return outWav
}

export async function extractFrame(video: string, atMs: number, outJpg: string, width = 480): Promise<string> {
  ensureParent(outJpg)
  await runFFmpeg(
    ['-y', '-ss', (atMs / 1000).toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', outJpg],
    { timeoutMs: 60_000 }
  )
  return outJpg
}

/** 精确切片（重编码，供 3D 动态化的输入分镜与口型窗口使用） */
export async function cutSegment(video: string, startMs: number, endMs: number, outMp4: string, opts: { width?: number; fps?: number } = {}): Promise<string> {
  ensureParent(outMp4)
  const durMs = Math.max(200, endMs - startMs)
  const vf: string[] = []
  if (opts.width) vf.push(`scale=${opts.width}:-2`)
  const args = ['-y', '-ss', (startMs / 1000).toFixed(3), '-t', (durMs / 1000).toFixed(3), '-i', video]
  args.push('-an', '-vf', vf.length ? vf.join(',') : 'null', '-r', String(opts.fps ?? 30), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', outMp4)
  await runFFmpeg(args, { timeoutMs: 300_000 })
  return outMp4
}

export async function cutAudioSegment(audio: string, startMs: number, endMs: number, outWav: string, sampleRate = 44100): Promise<string> {
  ensureParent(outWav)
  await runFFmpeg(
    ['-y', '-ss', (startMs / 1000).toFixed(3), '-t', (Math.max(100, endMs - startMs) / 1000).toFixed(3), '-i', audio, '-acodec', 'pcm_s16le', '-ar', String(sampleRate), '-ac', '1', outWav],
    { timeoutMs: 120_000 }
  )
  return outWav
}

/** 把逐句配音按句级时间锚点铺到整条静音底轨上（锚点为全链路真值，SPEC-001 §7.7-2） */
export async function buildTimelineTrack(
  items: Array<{ startMs: number; file: string }>,
  totalMs: number,
  outWav: string,
  job?: JobRecord
): Promise<string> {
  const existing = items.filter((i) => existsSync(i.file))
  ensureParent(outWav)
  if (existing.length === 0) {
    await runFFmpeg(
      ['-y', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-t', (totalMs / 1000).toFixed(3), '-acodec', 'pcm_s16le', outWav],
      { timeoutMs: 120_000 }
    )
    return outWav
  }
  const args = ['-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`]
  for (const item of existing) args.push('-i', item.file)
  const labels: string[] = ['[0:a]']
  const filters: string[] = []
  existing.forEach((item, i) => {
    const idx = i + 1
    filters.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${Math.max(0, Math.round(item.startMs))}|${Math.max(0, Math.round(item.startMs))}[d${i}]`)
    labels.push(`[d${i}]`)
  })
  // 混音后限幅，避免叠加爆音（不做 ducking，评审决议 R4）
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0[mix]`)
  filters.push(`[mix]atrim=0:${(totalMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS,alimiter=limit=0.95:level=1[out]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-t', (totalMs / 1000).toFixed(3), '-acodec', 'pcm_s16le', '-ar', '44100', outWav)
  await runFFmpeg(args, { timeoutMs: 600_000 })
  return outWav
}

/** 原音量直接混入，不做 ducking（评审决议 R4） */
export async function mixTracks(tracks: string[], outWav: string): Promise<string> {
  const existing = tracks.filter((t) => existsSync(t))
  if (existing.length === 0) throw new FfmpegError('没有可混音的音轨', '')
  ensureParent(outWav)
  if (existing.length === 1) {
    await runFFmpeg(['-y', '-i', existing[0], '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', outWav], { timeoutMs: 300_000 })
    return outWav
  }
  const args = ['-y']
  for (const t of existing) args.push('-i', t)
  const inputs = existing.map((_, i) => `[${i}:a]`).join('')
  args.push(
    '-filter_complex',
    `${inputs}amix=inputs=${existing.length}:duration=longest:dropout_transition=0:normalize=0,aformat=sample_rates=44100:channel_layouts=stereo[out]`,
    '-map',
    '[out]',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '44100',
    outWav
  )
  await runFFmpeg(args, { timeoutMs: 600_000 })
  return outWav
}

/** 3D 分镜片段串联为整片视频（无音轨，音轨另混） */
export async function concatVideos(files: string[], outMp4: string, opts: { width: number; height: number; fps: number }): Promise<string> {
  const existing = files.filter((f) => existsSync(f))
  if (existing.length === 0) throw new FfmpegError('没有可串联的分镜片段', '')
  ensureParent(outMp4)
  const args = ['-y']
  for (const f of existing) args.push('-i', f)
  const chains = existing.map((_, i) => `[${i}:v]scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${opts.fps}[v${i}]`)
  const join = chains.join(';')
  args.push('-filter_complex', `${join};${existing.map((_, i) => `[v${i}]`).join('')}concat=n=${existing.length}:v=1:a=0[outv]`, '-map', '[outv]', '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', outMp4)
  await runFFmpeg(args, { timeoutMs: 1_200_000 })
  return outMp4
}

/**
 * 按「目标时长」把若干画面片段拼成整片时间轴。
 * 云端图生视频只能给整数秒，逐段取整会累积漂移；这里统一 fps → 补帧（tpad clone）→ trim 到精确时长，
 * 保证画面时间轴与句级时间锚点（真值）对齐（SPEC-001 §7.7-2）。
 */
export async function timelineFromSegments(
  items: Array<{ file: string; targetMs: number }>,
  outMp4: string,
  size: { width: number; height: number; fps: number }
): Promise<string> {
  const existing = items.filter((i) => existsSync(i.file) && i.targetMs > 0)
  if (existing.length === 0) throw new FfmpegError('没有可拼接的画面片段', '')
  ensureParent(outMp4)
  const args = ['-y']
  for (const i of existing) args.push('-i', i.file)
  const chains = existing.map((i, n) => {
    const seconds = (i.targetMs / 1000).toFixed(3)
    const pad = (i.targetMs / 1000 + 1).toFixed(3)
    return (
      `[${n}:v]fps=${size.fps},scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,` +
      `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS,` +
      `tpad=stop_mode=clone:stop_duration=${pad},trim=duration=${seconds},setpts=PTS-STARTPTS[v${n}]`
    )
  })
  const join = chains.join(';')
  args.push(
    '-filter_complex',
    `${join};${existing.map((_, n) => `[v${n}]`).join('')}concat=n=${existing.length}:v=1:a=0[outv]`,
    '-map',
    '[outv]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-r',
    String(size.fps),
    '-pix_fmt',
    'yuv420p',
    '-an',
    outMp4
  )
  await runFFmpeg(args, { timeoutMs: 1_800_000 })
  return outMp4
}

/** 画面 + 配音 + 背景音合成（字幕走外挂 SRT，评审决议 R7） */
export async function compose({
  video,
  audio,
  outMp4,
  fps,
  job
}: {
  video: string
  audio: string
  outMp4: string
  fps: number
  job?: JobRecord
}): Promise<string> {
  ensureParent(outMp4)
  await runFFmpeg(
    [
      '-y',
      '-i',
      video,
      '-i',
      audio,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-r',
      String(fps),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      '-movflags',
      '+faststart',
      outMp4
    ],
    { timeoutMs: 1_200_000 }
  )
  if (job) throwIfCancelled(job)
  return outMp4
}

/** 用 ffmpeg 把视频片段替换指定时间段画面（口型结果回灌） */
export async function replaceSegment(baseVideo: string, insertVideo: string, atMs: number, outMp4: string): Promise<string> {
  ensureParent(outMp4)
  await runFFmpeg(
    [
      '-y',
      '-i',
      baseVideo,
      '-ss',
      (atMs / 1000).toFixed(3),
      '-i',
      insertVideo,
      '-filter_complex',
      `[0:v]copy[base];[base][1:v]overlay=0:0:enable='between(t,${(atMs / 1000).toFixed(3)},${((atMs + 1e9) / 1000).toFixed(3)})'[outv]`,
      '-map',
      '[outv]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      outMp4
    ],
    { timeoutMs: 600_000 }
  )
  return outMp4
}

/** 图片序列 → 短片（3D 片段兜底：关键帧静态化，保证流程不中断） */
export async function imageToVideo(image: string, durationMs: number, outMp4: string, size: { width: number; height: number; fps: number }): Promise<string> {
  ensureParent(outMp4)
  await runFFmpeg(
    [
      '-y',
      '-loop',
      '1',
      '-i',
      image,
      '-t',
      (durationMs / 1000).toFixed(3),
      '-vf',
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      '-r',
      String(size.fps),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      outMp4
    ],
    { timeoutMs: 600_000 }
  )
  return outMp4
}

export async function wavDurationMs(file: string): Promise<number> {
  try {
    const p = await probe(file)
    return p.durationMs
  } catch {
    return 0
  }
}

export function describeError(err: unknown): string {
  if (err instanceof CancelledError) return err.message
  if (err instanceof FfmpegError) return err.stderr ? `${err.message}\n${err.stderr.split('\n').slice(-8).join('\n')}` : err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export { ensureParent, dirname }
