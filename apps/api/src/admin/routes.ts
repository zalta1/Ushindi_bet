import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { ApiError, money } from '../errors.js'
import { operatorConfig } from '../operator-config.js'
import { hasPermission, isAccountRole, permissionsFor, type Permission } from './roles.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'

const CONFIG_KEYS = ['marginBps', 'minStake', 'maxStake', 'minWithdraw', 'maxWithdraw', 'minDeposit', 'maxDeposit', 'rtpBps'] as const

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    if (!hasPermission(req.auth.role, permission)) throw new ApiError(403, 'forbidden')
  }
}

async function audit(cfg: AppConfig, req: FastifyRequest, action: string, payload: unknown) {
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [req.auth?.userId ?? null, req.auth?.phone ?? 'system', action, JSON.stringify(payload)],
  )
}

export function registerAdminRoutes(app: FastifyInstance, cfg: AppConfig) {
  const guardWrite = async (req: FastifyRequest) => {
    assertOrigin(req, cfg.corsOrigins)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
  }

  app.get('/api/admin/whoami', { preHandler: async (req) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    if (req.auth.role === 'player') throw new ApiError(403, 'forbidden')
  } }, async (req) => ({
    role: req.auth!.role,
    permissions: permissionsFor(req.auth!.role),
  }))

  app.get('/api/admin/config', { preHandler: requirePermission('config.read') }, async () => operatorConfig)

  app.patch('/api/admin/config', { preHandler: [guardWrite, requirePermission('config.write')] }, async (req) => {
    const body = (req.body ?? {}) as Partial<Record<(typeof CONFIG_KEYS)[number], unknown>>
    const before = { ...operatorConfig }
    const next = { ...operatorConfig }
    for (const key of CONFIG_KEYS) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation')
      }
      next[key] = value
    }
    if (next.minStake > next.maxStake || next.minWithdraw > next.maxWithdraw || next.minDeposit > next.maxDeposit) {
      throw new ApiError(400, 'validation')
    }
    if (next.minDeposit < 1) throw new ApiError(400, 'validation')
    if (next.marginBps > 5000) throw new ApiError(400, 'validation')
    if (next.rtpBps < 9000 || next.rtpBps > 10000) throw new ApiError(400, 'validation')
    Object.assign(operatorConfig, next)
    await audit(cfg, req, 'admin.config.update', { before, after: next })
    return operatorConfig
  })

  app.get('/api/admin/audit', { preHandler: requirePermission('audit.read') }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, actor_user_id, actor, action, payload, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT 100`,
    )
    return { data: rows }
  })

  app.get('/api/admin/auth-events', { preHandler: requirePermission('auth_events.read') }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, user_id, phone, event, ip, created_at
         FROM auth_events ORDER BY created_at DESC LIMIT 100`,
    )
    return { data: rows }
  })

  app.get('/api/admin/users', { preHandler: requirePermission('users.read') }, async (req) => {
    const query = req.query as { limit?: string; offset?: string }
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 50) || 50))
    const offset = Math.max(0, Number(query.offset ?? 0) || 0)
    const { rows } = await getPool(cfg).query(
      `SELECT u.id, u.phone, u.full_name, u.role, u.kyc_status, u.locked_until, u.created_at,
              w.balance_tzs, w.bonus_balance_tzs
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    )
    return {
      data: rows.map((row) => ({
        id: row.id,
        phone: row.phone,
        fullName: row.full_name,
        role: row.role,
        kycStatus: row.kyc_status,
        lockedUntil: row.locked_until,
        createdAt: row.created_at,
        balanceTzs: money(row.balance_tzs),
        bonusBalanceTzs: money(row.bonus_balance_tzs),
      })),
    }
  })

  app.post('/api/admin/users/:id/role', {
    preHandler: [guardWrite, requirePermission('roles.write')],
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['role'],
        properties: { role: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(400, 'validation')
    const role = (req.body as { role: string }).role
    if (!isAccountRole(role)) throw new ApiError(400, 'validation')
    const client = await getPool(cfg).connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<{ id: string; role: string; phone: string }>(
        `SELECT id, role, phone FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const target = current.rows[0]
      if (!target) {
        await client.query('ROLLBACK')
        throw new ApiError(404, 'not_found')
      }
      if (target.role === 'super_admin' && role !== 'super_admin') {
        const count = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM users WHERE role = 'super_admin'`,
        )
        if (Number(count.rows[0].n) <= 1) {
          await client.query('ROLLBACK')
          throw new ApiError(409, 'last_super_admin')
        }
      }
      await client.query(`UPDATE users SET role = $2, updated_at = now() WHERE id = $1`, [id, role])
      await client.query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.user.role', $3::jsonb)`,
        [req.auth!.userId, req.auth!.phone, JSON.stringify({ targetUserId: id, targetPhone: target.phone, from: target.role, to: role })],
      )
      await client.query('COMMIT')
      return { id, role }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* already closed */ }
      throw err
    } finally {
      client.release()
    }
  })
}
