import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { DemoEngine } from './engine.js'

/**
 * Presentation server. In-memory only: no database client, no wallet, no payment.
 * The session cookie is aviator_demo so it stays separate from the real site.
 */

function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === 'aviator_demo') return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function readBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') return body as Record<string, unknown>
  return {}
}

function sendError(reply: FastifyReply, err: unknown) {
  const status = typeof err === 'object' && err && 'statusCode' in err ? Number(err.statusCode) : 400
  const message = err instanceof Error ? err.message : 'demo_error'
  return reply.code(Number.isFinite(status) ? status : 400).send({ error: message })
}

function webDir(): string | null {
  const candidates = [
    fileURLToPath(new URL('./web', import.meta.url)),
    fileURLToPath(new URL('../../dist/web', import.meta.url)),
  ]
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir
  }
  return null
}

export async function createApp(engine: DemoEngine = new DemoEngine()) {
  const app = Fastify({ logger: false })

  app.get('/api/health', async () => ({ ok: true, demo: true }))
  app.get('/api/state', async (req) => engine.playerView(cookieToken(req.headers.cookie)))
  app.get('/api/admin/state', async () => engine.adminView())

  app.post('/api/login', async (req, reply) => {
    try {
      const name = String(readBody(req.body).name ?? '')
      const session = engine.login(name)
      reply.header('Set-Cookie', `aviator_demo=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax`)
      return { id: session.player.id, name: session.player.name, balance: session.player.balance }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/api/bet', async (req, reply) => {
    try {
      const body = readBody(req.body)
      const auto = body.auto == null || body.auto === '' ? null : Number(body.auto)
      return engine.placeBetForToken(cookieToken(req.headers.cookie), Number(body.stake), auto, Number(body.panel ?? 1))
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/api/cashout', async (req, reply) => {
    try {
      return engine.cashoutForToken(cookieToken(req.headers.cookie), Number(readBody(req.body).panel ?? 1))
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/api/admin/plan', async (req, reply) => {
    try {
      const body = readBody(req.body)
      const input: { crash?: number, takeoffMs?: number, flyAwayMs?: number } = {}
      if (body.crash != null && body.crash !== '') input.crash = Number(body.crash)
      if (body.takeoffMs != null && body.takeoffMs !== '') input.takeoffMs = Number(body.takeoffMs)
      if (body.flyAwayMs != null && body.flyAwayMs !== '') input.flyAwayMs = Number(body.flyAwayMs)
      engine.setNext(input)
      return engine.adminView()
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/api/admin/winners', async (req, reply) => {
    try {
      engine.markWinners(readBody(req.body).playerIds)
      return engine.adminView()
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/api/admin/automatic', async (_req, reply) => {
    try {
      engine.automatic()
      return engine.adminView()
    } catch (err) {
      return sendError(reply, err)
    }
  })

  const stream = (write: (req: FastifyRequest) => unknown) => (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const send = () => {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(write(req))}\n\n`)
    }
    send()
    const timer = setInterval(send, 200)
    req.raw.on('close', () => clearInterval(timer))
  }

  app.get('/api/stream', stream((req) => engine.playerView(cookieToken(req.headers.cookie))))
  app.get('/api/admin/stream', stream(() => engine.adminView()))

  const dir = webDir()
  if (dir) {
    await app.register(fastifyStatic, { root: dir })
    app.get('/admin', async (_req, reply) => reply.sendFile('index.html'))
  }

  return { app, engine }
}

function startedAsEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === fileURLToPath(import.meta.url)
}

if (startedAsEntry()) {
  const port = Number(process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 5180 : 5181))
  const host = process.env.HOST ?? '0.0.0.0'
  createApp().then(({ app, engine }) => {
    const timer = setInterval(() => engine.tick(), 100)
    timer.unref()
    return app.listen({ port, host })
  }).then(() => {
    process.stdout.write(`aviator-demo listening on ${host}:${port}\n`)
  }).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
