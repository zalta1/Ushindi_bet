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
import { warmPasswordHasher } from './passwords.js'
import { registerPublicRoutes } from './routes/public.js'

async function connectRedis(cfg: AppConfig): Promise<Redis | null> {
  if (!cfg.redisUrl) return null
  const redis = new Redis(cfg.redisUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  })
  try {
    await redis.ping()
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
  registerAuthRoutes(app, cfg)
  registerAdminRoutes(app, cfg)

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.code })
    }
    const status = err.statusCode ?? 500
    if (status === 400) return reply.code(400).send({ error: 'validation' })
    if (status === 429) return reply.code(429).send({ error: 'rate_limited' })
    req.log.error({ err }, 'request failed')
    return reply.code(500).send({ error: 'internal' })
  })

  return app
}
