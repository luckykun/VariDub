/** HTTPS 下载到文件，带进度回调（重下时覆盖已有文件） */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname } from 'node:path'

export interface DownloadResult {
  bytes: number
  seconds: number
}

interface Fetched {
  stream: Readable
  total: number | null
}

function fetchStream(url: string, redirectsLeft: number, onProgress?: (r: number, t: number | null) => void): Promise<Fetched> {
  return new Promise((resolveP, rejectP) => {
    const req = httpsGet(url, (res) => {
      const code = res.statusCode ?? 0
      const location = res.headers.location
      if (code >= 300 && code < 400 && location && redirectsLeft > 0) {
        res.resume()
        const next = location.startsWith('http') ? location : new URL(location, url).toString()
        fetchStream(next, redirectsLeft - 1, onProgress).then(resolveP, rejectP)
        return
      }
      if (code !== 200) {
        res.resume()
        rejectP(new Error(`下载失败 HTTP ${code}：${url}`))
        return
      }
      const lenHeader = res.headers['content-length']
      const total = lenHeader ? Number(lenHeader) : null
      let received = 0
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress?.(received, total)
      })
      resolveP({ stream: res, total })
    })
    req.on('error', rejectP)
    req.setTimeout(120_000, () => req.destroy(new Error('下载超时（120s 无数据）')))
  })
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number | null) => void,
  redirectsLeft = 5
): Promise<DownloadResult> {
  mkdirSync(dirname(dest), { recursive: true })
  const started = Date.now()
  const fetched = await fetchStream(url, redirectsLeft, onProgress)
  if (existsSync(dest)) rmSync(dest, { force: true })
  await pipeline(fetched.stream, createWriteStream(dest))
  const bytes = fetched.total ?? 0
  return { bytes, seconds: (Date.now() - started) / 1000 }
}
