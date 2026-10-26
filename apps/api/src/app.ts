import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { registerAdminRoutes } from './admin/routes.js'
import { registerAuthRoutes } from './auth/routes.js'
import { readAccessSession } from './auth/sessions.js'
import { loadConfig, type AppConfig } from './config.js'
import { getPool } from './db.js'
import { ApiError } from './errors.js'

type SchemaIssue = {
  instancePath?: string
  keyword?: string
  params?: { missingProperty?: string; additionalProperty?: string }
}

function schemaFields(issues: SchemaIssue[]) {
  const fields: Record<string, string> = {}
  for (const issue of issues) {
    const missing = issue.params?.missingProperty
    const extra = issue.params?.additionalProperty
    const field = missing || extra || String(issue.instancePath || '').replace(/^\//, '') || 'body'
    if (issue.keyword === 'required') fields[field] = 'required'
    else if (issue.keyword === 'minLength') fields[field] = 'min_length'
    else if (issue.keyword === 'maxLength') fields[field] = 'max_length'
    else if (issue.keyword === 'additionalProperties') fields[field] = 'unexpected'
    else if (!fields[field]) fields[field] = 'invalid'
  }
  const values = Object.values(fields)
  return { error: values.length === 1 ? values[0] : 'validation', fields }
}
import { warmPasswordHasher } from './passwords.js'
import { registerDepositRoutes } from './deposits/routes.js'
import { registerAviatorRoutes } from './aviator/routes.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerJackpotRoutes } from './jackpot/routes.js'
import { registerDiceRoutes } from './dice/routes.js'
import { registerMinesRoutes } from './mines/routes.js'
import { registerMayanRoutes } from './mayan/routes.js'
import { registerPenaltyRoutes } from './penalty/routes.js'
import { registerZungushaRoutes } from './zungusha/routes.js'
import { registerSportsRoutes } from './sports/routes.js'

function waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('redis connect timeout'))
    }, timeoutMs)
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const cleanup = () => {
      clearTimeout(timer)
      redis.off('ready', onReady)
      redis.off('error', onError)
    }
    redis.on('ready', onReady)
    redis.on('error', onError)
    if (redis.status === 'ready') onReady()
  })
}

async function connectRedis(cfg: AppConfig): Promise<Redis | null> {
  if (!cfg.redisUrl) return null
  const redis = new Redis(cfg.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  })
  try {
    // enableOfflineQueue is false, so a ping issued before the socket is
    // writable throws even when Redis is up.
    await waitUntilReady(redis, 2000)
    await redis.ping()
    redis.on('error', (err) => {
      console.error('redis error', err.message)
    })
    return redis
  } catch (err) {
    redis.disconnect()
    if (cfg.isProduction) throw err
    console.warn('redis unavailable, using in-memory rate limits')
    return null
  }
}

export async function buildApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const cfg: AppConfig = { ...loadConfig(), ...overrides }
  await warmPasswordHasher()
  const redis = await connectRedis(cfg)
  const app = Fastify({
    logger: cfg.isTest ? false : {
      level: 'info',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    bodyLimit: 64 * 1024,
    trustProxy: cfg.trustProxy ? 1 : false,
  })
  app.decorateRequest('auth', null)

  await app.register(helmet, {
    contentSecurityPolicy: false,
    hsts: cfg.cookieSecure ? { maxAge: 15_552_000 } : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    origin(origin, cb) {
      if (!origin || cfg.corsOrigins.includes(origin)) cb(null, true)
      else cb(null, false)
    },
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...(redis ? { redis, nameSpace: 'ushindi-rl:' } : {}),
    skipOnError: !cfg.isProduction,
    errorResponseBuilder: () => new ApiError(429, 'rate_limited'),
  })

  app.addHook('onRequest', async (req) => {
    req.auth = await readAccessSession(cfg, req)
  })
  app.addHook('preHandler', async (req) => {
    if (!req.auth?.readOnly) return
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return
    const path = req.url.split('?')[0]
    if (path === '/api/auth/impersonation/stop' || path === '/api/auth/logout') return
    throw new ApiError(403, 'read_only')
  })
  // A temporary password can only refresh the session, read /me, log out, or set a new password.
  const passwordChangeAllow = new Set([
    '/health',
    '/api/auth/csrf',
    '/api/auth/me',
    '/api/auth/logout',
    '/api/auth/refresh',
    '/api/auth/set-password',
  ])
  app.addHook('preHandler', async (req) => {
    if (!req.auth?.mustChangePassword) return
    const path = req.url.split('?')[0]
    if (passwordChangeAllow.has(path)) return
    throw new ApiError(403, 'password_change_required')
  })
  app.addHook('onClose', async () => {
    if (redis) await redis.quit().catch(() => undefined)
  })

  app.get('/health', async (_req, reply) => {
    let db: 'up' | 'down' = 'down'
    try {
      await getPool(cfg).query('SELECT 1')
      db = 'up'
    } catch {
      db = 'down'
    }
    let redisStatus: 'up' | 'down' | 'disabled' = redis ? 'down' : 'disabled'
    if (redis) {
      try {
        await redis.ping()
        redisStatus = 'up'
      } catch {
        redisStatus = 'down'
      }
    }
    const ok = db === 'up' && (!cfg.isProduction || redisStatus === 'up')
    reply.code(ok ? 200 : 503)
    return {
      ok,
      service: 'ushindi-api',
      tz: 'Africa/Dar_es_Salaam',
      sandbox: true,
      auth: 'postgres',
      db,
      redis: redisStatus,
    }
  })

  registerPublicRoutes(app)
  registerAviatorRoutes(app, cfg)
  registerSportsRoutes(app, cfg)
  registerJackpotRoutes(app, cfg)
  registerDiceRoutes(app, cfg)
  registerMinesRoutes(app, cfg)
  registerMayanRoutes(app, cfg)
  registerPenaltyRoutes(app, cfg)
  registerZungushaRoutes(app, cfg)
  registerAuthRoutes(app, cfg)
  registerDepositRoutes(app, cfg)
  registerAdminRoutes(app, cfg)

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code, ...(err.details ?? {}) })
    }
    const status = err.statusCode ?? 500
    const validation = (err as { validation?: SchemaIssue[] }).validation
    if (status === 400 && validation?.length) return reply.code(400).send(schemaFields(validation))
    if (status === 400) return reply.code(400).send({ error: 'validation' })
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' })
    req.log.error({ err }, 'request failed')
    return reply.code(500).send({ error: 'internal' })
  })

  return app
}
