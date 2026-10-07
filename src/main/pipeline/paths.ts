/** 项目检查点目录内所有产物的路径约定（SPEC-001 §7.4） */
import { join } from 'node:path'
import { projectWorkspaceDir } from '../db/repos'

export interface ProjectPaths {
  root: string
  shotsJson: string
  asrJson: string
  translationJson: string
  dubManifest: string
  renderManifest: string
  vocalsWav: string
  bgmWav: string
  audioDir: string
  samplesDir: string
  dubDir: string
  framesDir: string
  shots3dDir: string
  finalDir: string
  logsDir: string
  sampleOf: (speakerId: string) => string
  dubOf: (lineId: string) => string
  frameOf: (shotId: string) => string
  keyframeOf: (shotId: string) => string
  clip3dOf: (shotId: string) => string
  finalMp4: (name: string) => string
  finalSrt: (name: string) => string
  log: (name: string) => string
}

export function projectPaths(projectId: string): ProjectPaths {
  const root = projectWorkspaceDir(projectId)
  const audioDir = join(root, 'audio')
  const samplesDir = join(audioDir, 'voice_samples')
  const dubDir = join(root, 'dub')
  const framesDir = join(root, 'frames')
  const shots3dDir = join(root, 'shots3d')
  const finalDir = join(root, 'final')
  const logsDir = join(root, 'logs')
  return {
    root,
    shotsJson: join(root, 'shots.json'),
    asrJson: join(root, 'asr.json'),
    translationJson: join(root, 'translation.json'),
    dubManifest: join(dubDir, 'dub_manifest.json'),
    renderManifest: join(shots3dDir, 'render_manifest.json'),
    vocalsWav: join(audioDir, 'vocals.wav'),
    bgmWav: join(audioDir, 'bgm.wav'),
    audioDir,
    samplesDir,
    dubDir,
    framesDir,
    shots3dDir,
    finalDir,
    logsDir,
    sampleOf: (speakerId: string) => join(samplesDir, `${speakerId}.wav`),
    dubOf: (lineId: string) => join(dubDir, `${lineId}.wav`),
    frameOf: (shotId: string) => join(framesDir, `${shotId}.jpg`),
    keyframeOf: (shotId: string) => join(framesDir, `${shotId}.key3d.png`),
    clip3dOf: (shotId: string) => join(shots3dDir, `${shotId}.mp4`),
    finalMp4: (name: string) => join(finalDir, `${name}.mp4`),
    finalSrt: (name: string) => join(finalDir, `${name}.srt`),
    log: (name: string) => join(logsDir, `${name}.log`)
  }
}
