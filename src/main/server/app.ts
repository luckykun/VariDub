/**
 * 主进程内嵌 Fastify（SPEC-001 §7.5）：只监听 127.0.0.1 随机端口，不对外。
 * 渲染层所有数据经 /api/*，进度经 /api/events（SSE）；媒体文件走 /api/files（支持 Range，供 video/audio 拖动）。
 */
import { existsSync, statSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import type { ServerEvent } from '../../shared/types'
import { subscribe } from '../events'
import { log } from '../logger'
import { appDataDir } from '../paths'
import { getSetting } from '../db/repos/settings'
import { GateError } from '../pipeline/runner'
import { registerProjectRoutes } from './routes/projects'
import { registerPipelineRoutes } from './routes/pipeline'
import { registerContentRoutes } from './routes/content'
import { registerSystemRoutes } from './routes/system'

export interface ServerHandle {
  app: FastifyInstance
  port: number
  origin: string
  close: () => Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
}

export function mimeOf(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export async function buildServer(rendererDir: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, trustProxy: false })
  await app.register(cors, { origin: true, credentials: false })

  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof GateError ? 409 : (err as { statusCode?: number }).statusCode ?? 500
    const message = err instanceof Error ? err.message : String(err)
    if (status >= 500) log.error('http', `${req.method} ${req.url} → ${message}`)
    else log.warn('http', `${req.method} ${req.url} → ${status} ${message}`)
    void reply.status(status).send({ error: message, detail: err instanceof Error && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : undefined })
  })

  // 单帧心跳 + 事件流；客户端断开时自动退订
  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    const send = (evt: ServerEvent): void => {
      raw.write(`data: ${JSON.stringify(evt)}\n\n`)
    }
    send({ type: 'sidecar:status', online: false, gpu: false, reason: 'connected' })
    const unsubscribe = subscribe(send)
    const ping = setInterval(() => raw.write(': ping\n\n'), 20_000)
    const close = (): void => {
      clearInterval(ping)
      unsubscribe()
    }
    req.raw.on('close', close)
    raw.on('error', close)
  })

  // 渲染层产物（打包后由本服务提供；开发期渲染层在 vite 端口，靠 CORS 访问 API）
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      void reply.status(404).send({ error: `未知接口 ${req.url}` })
      return
    }
    serveStatic(reply, rendererDir, req.url)
  })

  registerProjectRoutes(app)
  registerPipelineRoutes(app)
  registerContentRoutes(app)
  registerSystemRoutes(app)
  await app.ready()
  return app
}

export async function startServer(rendererDir: string): Promise<ServerHandle> {
  const app = await buildServer(rendererDir)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const origin = `http://127.0.0.1:${port}`
  log.info('server', `本地服务已启动 ${origin}（数据目录 ${appDataDir()}）`)
  return {
    app,
    port,
    origin,
    close: async () => {
      await app.close()
    }
  }
}

/** 静态文件（限制在 rendererDir 内，防止穿越） */
function serveStatic(reply: FastifyReply, root: string, url: string): void {
  const rel = decodeURIComponent((url.split('?')[0] ?? '/').replace(/^\/+/, ''))
  const candidate = resolve(root, rel || 'index.html')
  const file = within(candidate, root) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html')
  if (!existsSync(file)) {
    void reply.status(404).type('text/plain').send('渲染层尚未构建：先运行 npm run build，或使用 npm run dev 走 vite 开发服务器')
    return
  }
  reply.header('Content-Type', mimeOf(file))
  reply.header('Cache-Control', 'no-cache')
  void reply.send(createReadStream(file))
}

/**
 * 媒体文件流：支持 Range（<video> / <audio> 拖动、以及读回非 faststart mp4 写在文件末尾的 moov），
 * 并限制在项目工作区 / 源视频目录 / 应用目录内，避免任意本地文件读取。
 *
 * 写法约束（碰不得）：本函数必须同步返回 reply，调用方必须写 `return streamFile(...)`，
 * 不做成 async、也不让人 await。原因：Fastify 在 async 处理器定下来时若发现 reply 尚未标记为已发送，
 * 就用处理器的返回值（undefined）收尾——状态码与响应头全对，body 却是 0 字节，
 * 于是所有视频/音频都变成「控件在、就是放不出来」。
 */
export function streamFile(req: FastifyRequest, reply: FastifyReply, path: string, download = false): FastifyReply {
  if (!existsSync(path)) return reply.status(404).send({ error: `文件不存在：${basename(path)}` })
  const size = statSync(path).size
  const full = (): FastifyReply =>
    reply.header('Content-Length', String(size)).status(200).send(createReadStream(path, { start: 0, end: size - 1 }))

  reply.header('Accept-Ranges', 'bytes')
  reply.header('Content-Type', mimeOf(path))
  reply.header('Cache-Control', 'no-cache')
  if (download) reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(basename(path))}"`)

  const range = req.headers.range
  if (!range) return full()
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  // 看不懂的 Range（多段合并、非法格式）直接给整文件，比报错更兼容
  if (!m || (!m[1] && !m[2])) return full()

  let start = 0
  let end = size - 1
  if (m[1]) {
    start = Number(m[1])
    if (m[2]) end = Number(m[2])
  } else {
    // `bytes=-N` 是「最后 N 字节」，不是「前 N 字节」
    start = Math.max(0, size - Number(m[2]))
  }
  if (!Number.isFinite(start) || start >= size || end < start) {
    return reply.header('Content-Range', `bytes */${size}`).status(416).send({ error: `Range 超出文件范围（共 ${size} 字节）` })
  }
  end = Math.min(end, size - 1)
  return reply
    .status(206)
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Content-Length', String(end - start + 1))
    .send(createReadStream(path, { start, end }))
}

/** 允许被 /api/files 读取的根目录（避免任意本地文件读取） */
const EXTRA_ROOTS = new Set<string>()

export function allowRoot(dir: string): void {
  if (dir && existsSync(dir)) EXTRA_ROOTS.add(resolve(dir))
}

export function allowedReadRoots(): string[] {
  const roots = [appDataDir(), ...EXTRA_ROOTS]
  const workspace = getSetting('storage.workspace_root').trim()
  if (workspace) roots.push(resolve(workspace))
  const exportDir = getSetting('storage.export_dir').trim()
  if (exportDir) roots.push(resolve(exportDir))
  return roots.filter((r) => existsSync(r))
}

export function isReadable(path: string): boolean {
  const target = resolve(path)
  return existsSync(target) && allowedReadRoots().some((root) => within(target, root))
}

export function within(file: string, root: string): boolean {
  // Windows 路径大小写不敏感（文件对话框给 C:\…，设置里可能被填成 c:\…），
  // 这里区分大小写会把合法文件误判成「不在允许目录」→ /api/files 返 403 → 视频又放不了了。
  const norm = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
  const f = norm(resolve(file))
  const r = norm(resolve(root))
  return f === r || f.startsWith(r + '\\') || f.startsWith(r + '/')
}
