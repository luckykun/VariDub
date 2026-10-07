/**
 * Mock 云端返回（SPEC-001 §7.8 冒烟测试：10s 样片跑通①→⑥，mock 云端返回）。
 * 仅在 api.mock / VARIDUB_MOCK=1 时被调用，产出真实可播放的音频与可显示的图像，
 * 让门禁、编排、文件产物在无 API-KEY / 无消耗的情况下可验证。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { runFFmpeg } from '../media/ffmpeg'
import { ensureParent } from '../logger'

const ZH_CORPUS = [
  '我们今天的游戏规则很简单，赢的人可以获得优先选择权。',
  '下饭操作！这波真的把我看饿了。',
  '你别拉我，我自己能行。',
  '说实话，我一开始真的没被看好。',
  '这个梗我们后面还会用到，先记住。',
  '三轮下来，分数已经拉到两倍了。',
  '等一下，我需要确认一下规则。',
  '你们这样卷，新人怎么活？',
  '这段剪辑太秀了，直接封神。',
  '行吧，这局我认输。',
  '谁去挑战那个高台项目？',
  '我觉得他会选左边，因为他上一轮就这样干。',
  '别卖关子了，快说！',
  '我们队今天就是要逆风翻盘。',
  '这碗面真的下饭，我吃了两碗。',
  '倒计时十秒，准备。',
  '你猜怎么着，他反手就给了提示。',
  '这个操作需要非常稳的手感。',
  '我们先把分歧放一边，游戏继续。',
  '观众都在看着呢，不能怂。',
  '这题我熟，让我来。',
  '刚才那段能不能重来一次？',
  '好，那我们抽签决定。',
  '输了要做一整天的苦力活。',
  '别急，听我说完。',
  '这就是团队配合的价值。',
  '我的天，他居然一次就过了。',
  '我们时间不多了，加速。',
  '这段留到下期做彩蛋。',
  '行，就这么定。',
  '再来一次我有把握。',
  '你看他表情就知道有多紧张。',
  '这局的关键在于谁先失误。',
  '恭喜获胜队，掌声鼓励。'
]

const EN_CORPUS = [
  'The rule today is simple: the winner picks first.',
  'What a play — that one made me hungry.',
  "Don't pull me, I've got this.",
  'Honestly, nobody expected me at the start.',
  'We will use this joke again later. Keep it in mind.',
  'After three rounds, the gap has doubled.',
  'Hold on, I need to check the rules.',
  'If you all grind like this, what about the newcomers?',
  'This edit is unreal. Instant classic.',
  'Fine. I concede this round.',
  'Who is taking the platform challenge?',
  "He'll go left. He did exactly that last round.",
  'Stop teasing us and just say it!',
  'Today we turn this around.',
  'That noodles dish was pure comfort food. I had two bowls.',
  'Ten seconds. Get ready.',
  'Guess what — he handed out a hint right away.',
  'This move needs a really steady hand.',
  "Let's put the disagreement aside and keep playing.",
  'The audience is watching. No chickenging out.',
  "I know this one. My turn.",
  'Can we run that part again?',
  'Alright, we draw straws.',
  'Losing means chores all day.',
  'Easy, let me finish.',
  'This is what teamwork looks like.',
  'Oh my god, he cleared it in one try.',
  'We are running out of time. Speed up.',
  "Save that bit for next episode's bonus.",
  'Done. That is settled.',
  'One more round and I have it.',
  'Look at his face — he is nervous.',
  'The key is who cracks first.',
  'Congrats to the winning team. Big applause.'
]

export interface MockSegment {
  startMs: number
  endMs: number
  speaker: string
  text: string
}

/** 按音频时长均匀造 8-34 句中文转写（含俚语词，便于验证标黄逻辑） */
export function mockAsrSegments(durationMs: number, speakerCount = 2): MockSegment[] {
  const count = Math.max(6, Math.min(34, Math.round(durationMs / 7_000)))
  const per = Math.max(1_200, Math.floor((durationMs * 0.92) / count))
  const out: MockSegment[] = []
  for (let i = 0; i < count; i += 1) {
    const start = 400 + i * per
    const end = Math.min(durationMs - 200, start + Math.round(per * (0.55 + ((i % 3) * 0.1))))
    out.push({
      startMs: start,
      endMs: Math.max(start + 700, end),
      speaker: `S${(i % speakerCount) + 1}`,
      text: ZH_CORPUS[i % ZH_CORPUS.length]
    })
  }
  return out
}

export function mockTranslation(zh: string, index: number, alts = 2): { en: string; enAlts: string[]; slang: string | null } {
  const base = EN_CORPUS[index % EN_CORPUS.length]
  const pool = [
    `${base} (tighter)`,
    `${base.split('.')[0]}.`
  ]
  const slangHit = SLANG.find((s) => zh.includes(s.word))
  return {
    en: base,
    enAlts: pool.slice(0, Math.max(0, alts)),
    slang: slangHit ? `${slangHit.word}：${slangHit.note}` : null
  }
}

const SLANG = [
  { word: '下饭', note: '中文网络梗，指“看着让人有食欲/适合配饭”，英文需意译' },
  { word: '卷', note: '内卷，英文可用 grind / rat race' },
  { word: '封神', note: '夸张用语，可意译为 instant classic' },
  { word: '逆风翻盘', note: 'comeback from behind' },
  { word: '拉我', note: '口语“拽住/拖后腿”，注意别直译 pull me' },
  { word: '卖关子', note: 'tease / drag out the suspense' },
  { word: '彩蛋', note: 'easter egg / post-credits bit' }
]

/** 生成可播放的合成语音 WAV（正弦 + 包络 + 噪声），供配音/时间轴/波形联调 */
export async function syntheticWav(dest: string, durationMs: number, baseFreq = 220): Promise<string> {
  ensureParent(dest)
  const args = ['-y']
  args.push(
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${baseFreq}:sample_rate=44100:duration=${(durationMs / 1000).toFixed(3)}`
  )
  args.push('-f', 'lavfi', '-i', `anoisesrc=color=brown:sample_rate=44100:amplitude=0.08:duration=${(durationMs / 1000).toFixed(3)}`)
  // 尾音淡出，避免结束瞬间的硬切爆音
  const fadeStart = Math.max(0, durationMs / 1000 - 0.05).toFixed(3)
  args.push(
    '-filter_complex',
    `[0:a]aecho=0.6:0.4:35|70|110:0.4|0.3|0.2,tremolo=f=5:d=0.4[v];` +
      `[1:a][v]amix=inputs=2:duration=first:normalize=0,tremolo=f=2.5:d=0.6,afade=t=out:st=${fadeStart}:d=0.05[out]`,
    '-map',
    '[out]',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '44100',
    '-ac',
    '1',
    dest
  )
  await runFFmpeg(args, { timeoutMs: 120_000 })
  return dest
}

/**
 * 用 ffmpeg 滤镜模拟「3D 重绘」关键帧（冒烟测试用，不宣称是真实风格化）。
 * 量化用 lutrgb 表达式而不是 posterize：ffmpeg-static 的精简构建里没有 posterize 滤镜。
 */
export async function mockKeyframe(srcJpeg: string, outPng: string, style: string): Promise<string> {
  ensureParent(outPng)
  const posterize = (n: number): string => {
    const step = Math.max(1, Math.round(255 / n))
    const q = `trunc(val/${step})*${step}`
    return `lutrgb=r='${q}':g='${q}':b='${q}'`
  }
  const filter = style === 'anime'
    ? `${posterize(6)},eq=saturation=1.4:contrast=1.15,hue=s=1.1`
    : style === 'claymation'
      ? `${posterize(4)},eq=saturation=1.25:brightness=0.03,gblur=sigma=3`
      : `gblur=sigma=2,${posterize(8)},eq=saturation=1.3:contrast=1.08`
  await runFFmpeg(['-y', '-i', srcJpeg, '-vf', `${filter},scale=768:-2`, outPng], { timeoutMs: 60_000 })
  return outPng
}

/** 冒烟测试的“云端异步任务”模拟产物：图 → 短片 */
export async function mockClipFromKeyframe(srcPng: string, outMp4: string, durationMs: number, size: { width: number; height: number; fps: number }): Promise<string> {
  ensureParent(outMp4)
  await runFFmpeg(
    [
      '-y',
      '-loop',
      '1',
      '-i',
      srcPng,
      '-vf',
      `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2,zoompan=z='min(zoom+0.0006,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round((durationMs / 1000) * size.fps)}:s=${size.width}x${size.height}:fps=${size.fps},setsar=1`,
      '-t',
      (durationMs / 1000).toFixed(3),
      '-r',
      String(size.fps),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      outMp4
    ],
    { timeoutMs: 300_000 }
  )
  return outMp4
}

export function readSmallJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeText(file: string, text: string): void {
  ensureParent(file)
  writeFileSync(file, text, 'utf8')
}
