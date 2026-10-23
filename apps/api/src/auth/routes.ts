import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.js'
import { getPool, withTx } from '../db.js'
import { ApiError, fieldError } from '../errors.js'
import { isAdult, normalizeName, normalizeTzPhone, passwordProblem } from '../identity.js'
import { dummyVerify, hashPassword, verifyPassword } from '../passwords.js'
import { isAdminRole } from '../admin/roles.js'
import {
  assertCsrf,
  assertOrigin,
  clearSessionCookies,
  CSRF_COOKIE,
  issueSession,
  stopImpersonation,
  newToken,
  publicUser,
  revokeAllSessions,
  revokeFamily,
  rotateSession,
} from './sessions.js'

type UserRow = {
  id: string
  phone: string
  password_hash: string
  role: string
  failed_login_count: number
  locked_until: Date | null
}

async function recordAuth(
  cfg: AppConfig,
  event: string,
  ip: string | undefined,
  userId: string | null,
  phone: string | null,
) {
  await getPool(cfg).query(
    `INSERT INTO auth_events (user_id, phone, event, ip) VALUES ($1, $2, $3, $4)`,
    [userId, phone, event, ip?.slice(0, 64) ?? null],
  )
}

function lockMinutes(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))
}

async function failLogin(cfg: AppConfig, user: UserRow, ip: string | undefined): Promise<Date | null> {
  const { rows } = await getPool(cfg).query<{ locked_until: Date | null }>(
    `UPDATE users SET
       failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
       locked_until = CASE
         WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' seconds')::interval
         ELSE locked_until
       END,
       updated_at = now()
     WHERE id = $1
     RETURNING locked_until`,
    [user.id, cfg.lockoutThreshold, String(cfg.lockoutSeconds)],
  )
  const until = rows[0]?.locked_until ? new Date(rows[0].locked_until) : null
  const locked = Boolean(until && until.getTime() > Date.now())
  await recordAuth(cfg, locked ? 'lockout' : 'login_failure', ip, user.id, user.phone)
  return locked ? until : null
}

function clientIp(req: { ip?: string }) {
  return req.ip
}

export function registerAuthRoutes(app: FastifyInstance, cfg: AppConfig) {
  const mutation = async (req: Parameters<typeof assertOrigin>[0]) => {
    assertOrigin(req, cfg.corsOrigins)
  }

  app.get('/api/auth/csrf', async (_req, reply) => {
    const csrf = newToken()
    reply.setCookie(CSRF_COOKIE, csrf, {
      httpOnly: false,
      secure: cfg.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: cfg.refreshTtlSeconds,
    })
    return { ok: true }
  })

  app.post(
    '/api/auth/register',
    {
      config: { rateLimit: { max: cfg.registerRateMax, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['phone', 'password'],
          properties: {
            phone: { type: 'string', maxLength: 32 },
            password: { type: 'string', maxLength: 200 },
            fullName: { type: 'string', maxLength: 80 },
            dob: { type: 'string', maxLength: 10 },
          },
        },
      },
    },
    async (req, reply) => {
      await mutation(req)
      assertCsrf(req)
      const body = req.body as { phone?: string; password?: string; fullName?: string; dob?: string }
      const fields: Record<string, string> = {}
      const rawPassword = typeof body.password === 'string' ? body.password : ''
      const phone = typeof body.phone === 'string' ? normalizeTzPhone(body.phone) : null
      if (!phone) fields.phone = 'invalid_phone'
      const problem = passwordProblem(rawPassword, phone ?? '')
      if (problem) fields.password = problem
      const fullName = typeof body.fullName === 'string' && body.fullName.trim() ? normalizeName(body.fullName) : null
      if (typeof body.fullName === 'string' && body.fullName.trim() && !fullName) fields.fullName = 'invalid_name'
      const dob = typeof body.dob === 'string' && body.dob.trim() ? body.dob : null
      if (dob && !isAdult(dob)) fields.dob = 'underage'
      if (!phone || Object.keys(fields).length) throw fieldError(fields)

      const passwordHash = await hashPassword(rawPassword)
      const adminPhone = normalizeTzPhone(cfg.adminPhone || cfg.superAdminPhone)
      const role = adminPhone && phone === adminPhone ? 'admin' : 'player'
      try {
        const userId = await withTx(cfg, async (client) => {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO users (phone, password_hash, full_name, dob, role)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [phone, passwordHash, fullName, dob, role],
          )
          await client.query(
            `INSERT INTO wallets (user_id) VALUES ($1)`,
            [inserted.rows[0].id],
          )
          return inserted.rows[0].id
        })
        await recordAuth(cfg, 'register', clientIp(req), userId, phone)
        const auth = await issueSession(cfg, reply, userId, req)
        reply.code(201)
        return { user: publicUser(auth) }
      } catch (err: unknown) {
        const pg = err as { code?: string }
        if (pg.code === '23505') throw new ApiError(409, 'phone_taken')
        if (pg.code === '23514') throw new ApiError(400, 'underage')
        throw err
      }
    },
  )

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: cfg.authRateMax, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['phone', 'password'],
          properties: {
            phone: { type: 'string', maxLength: 32 },
            password: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      await mutation(req)
      assertCsrf(req)
      const body = req.body as { phone: string; password: string }
      const phone = normalizeTzPhone(body.phone)
      if (!phone) {
        await dummyVerify(body.password)
        throw new ApiError(401, 'invalid_credentials')
      }
      const { rows } = await getPool(cfg).query<UserRow & { closed_at: Date | null }>(
        `SELECT id, phone, password_hash, role, failed_login_count, locked_until, closed_at
           FROM users WHERE phone = $1`,
        [phone],
      )
      const user = rows[0]
      if (!user) {
        await dummyVerify(body.password)
        await recordAuth(cfg, 'login_failure', clientIp(req), null, null)
        throw new ApiError(401, 'invalid_credentials')
      }
      if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        await dummyVerify(body.password)
        throw new ApiError(429, 'locked', { minutes: lockMinutes(new Date(user.locked_until)), field: 'password' })
      }
      const ok = await verifyPassword(user.password_hash, body.password)
      if (!ok) {
        const until = await failLogin(cfg, user, clientIp(req))
        if (until) throw new ApiError(429, 'locked', { minutes: lockMinutes(until), field: 'password' })
        throw new ApiError(401, 'invalid_credentials', { field: 'password' })
      }
      if (user.closed_at) throw new ApiError(403, 'account_closed')
      await getPool(cfg).query(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [user.id],
      )
      await recordAuth(cfg, 'login_success', clientIp(req), user.id, user.phone)
      const auth = await issueSession(cfg, reply, user.id, req)
      return { user: publicUser(auth) }
    },
  )

  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    await mutation(req)
    const auth = await rotateSession(cfg, req, reply)
    return { user: publicUser(auth) }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    await mutation(req)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
    if (req.auth.readOnly) {
      const impersonatorId = req.auth.impersonatorUserId
      if (impersonatorId) {
        const actor = await getPool(cfg).query<{ phone: string }>(`SELECT phone FROM users WHERE id = $1`, [impersonatorId])
        await getPool(cfg).query(
          `INSERT INTO audit_log (actor_user_id, actor, action, payload)
           VALUES ($1, $2, 'admin.impersonate.stop', $3::jsonb)`,
          [impersonatorId, actor.rows[0]?.phone ?? 'admin', JSON.stringify({ targetUserId: req.auth.userId, impersonationId: req.auth.impersonationId, via: 'logout' })],
        )
      }
      await stopImpersonation(cfg, req, reply)
      return { ok: true, restored: true }
    }
    await revokeFamily(cfg, req.auth.familyId)
    await recordAuth(cfg, 'logout', clientIp(req), req.auth.userId, req.auth.phone)
    clearSessionCookies(reply, cfg)
    return { ok: true }
  })

  app.post('/api/auth/impersonation/stop', async (req, reply) => {
    await mutation(req)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
    const impersonatorId = req.auth.impersonatorUserId
    const targetId = req.auth.userId
    const impersonationId = req.auth.impersonationId
    if (impersonatorId) {
      const actor = await getPool(cfg).query<{ phone: string }>(`SELECT phone FROM users WHERE id = $1`, [impersonatorId])
      await getPool(cfg).query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.impersonate.stop', $3::jsonb)`,
        [impersonatorId, actor.rows[0]?.phone ?? 'admin', JSON.stringify({ targetUserId: targetId, impersonationId })],
      )
    }
    await stopImpersonation(cfg, req, reply)
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    return { user: publicUser(req.auth) }
  })

  app.post(
    '/api/auth/change-password',
    {
      config: { rateLimit: { max: cfg.authRateMax, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string', maxLength: 200 },
            newPassword: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      await mutation(req)
      if (!req.auth) throw new ApiError(401, 'unauthenticated')
      assertCsrf(req, req.auth.csrfHash)
      const body = req.body as { currentPassword: string; newPassword: string }
      const { rows } = await getPool(cfg).query<UserRow>(
        `SELECT id, phone, password_hash, role, failed_login_count, locked_until FROM users WHERE id = $1`,
        [req.auth.userId],
      )
      const user = rows[0]
      if (!user) throw new ApiError(401, 'unauthenticated')
      const ok = await verifyPassword(user.password_hash, body.currentPassword)
      if (!ok) {
        const until = await failLogin(cfg, user, clientIp(req))
        if (until) throw new ApiError(429, 'locked', { minutes: lockMinutes(until), field: 'password' })
        throw new ApiError(401, 'invalid_credentials', { field: 'password' })
      }
      if (body.currentPassword === body.newPassword) throw fieldError({ newPassword: 'same_password' })
      const problem = passwordProblem(body.newPassword, user.phone)
      if (problem) throw fieldError({ newPassword: problem })
      const passwordHash = await hashPassword(body.newPassword)
      await getPool(cfg).query(
        `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [user.id, passwordHash],
      )
      await revokeAllSessions(cfg, user.id)
      await recordAuth(cfg, 'password_change', clientIp(req), user.id, user.phone)
      if (isAdminRole(user.role)) {
        await getPool(cfg).query(
          `INSERT INTO audit_log (actor_user_id, actor, action, payload)
           VALUES ($1, $2, 'admin.password_change', '{}'::jsonb)`,
          [user.id, user.phone],
        )
      }
      const auth = await issueSession(cfg, reply, user.id, req)
      return { user: publicUser(auth) }
    },
  )
}
