import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import type { AppConfig } from '../config.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { normalizeTzPhone } from '../identity.js'
import { assertAviatorRanges } from '../aviator/settings.js'
import { BOOL_SETTING_KEYS, INT_SETTING_KEYS, operatorConfig } from '../operator-config.js'
import { assertCsrf, assertOrigin, beginImpersonation } from '../auth/sessions.js'
import { isAdminRole, isAccountRole, permissionsFor } from './roles.js'
import { saveOperatorSettings } from './settings-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireAdmin() {
  return async (req: FastifyRequest) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    if (!isAdminRole(req.auth.role) || req.auth.readOnly) throw new ApiError(403, 'forbidden')
  }
}

async function audit(cfg: AppConfig, req: FastifyRequest, action: string, payload: unknown) {
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [req.auth?.userId ?? null, req.auth?.phone ?? 'system', action, JSON.stringify(payload)],
  )
}

function reasonOf(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'validation', { fields: { reason: 'required' } })
  const reason = value.trim()
  if (reason.length < 3 || reason.length > 200) throw new ApiError(400, 'validation', { fields: { reason: 'length' } })
  return reason
}

function httpUrl(value: unknown, field: string, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'validation', { fields: { [field]: 'required' } })
    return null
  }
  if (typeof value !== 'string' || value.length > 500) throw new ApiError(400, 'validation', { fields: { [field]: 'invalid' } })
  if (!/^https:\/\/[^ ]+$/i.test(value) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value)) {
    throw new ApiError(400, 'validation', { fields: { [field]: 'https_only' } })
  }
  return value
}

function textField(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'validation', { fields: { [field]: 'required' } })
  const text = value.trim()
  if (text.length < min || text.length > max) throw new ApiError(400, 'validation', { fields: { [field]: 'length' } })
  return text
}

async function activeAdminCount(client: PoolClient) {
  const count = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE role = 'admin' AND closed_at IS NULL`)
  return Number(count.rows[0].n)
}

function mapUser(row: {
  id: string
  phone: string
  full_name: string | null
  role: string
  kyc_status: string
  locked_until: Date | null
  created_at: Date
  closed_at: Date | null
  balance_tzs: string | null
  bonus_balance_tzs: string | null
}) {
  return {
    id: row.id,
    phone: row.phone,
    fullName: row.full_name ?? '',
    role: row.role,
    kycStatus: row.kyc_status,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    balanceTzs: money(row.balance_tzs),
    bonusBalanceTzs: money(row.bonus_balance_tzs),
  }
}

const userSelect = `
  SELECT u.id, u.phone, u.full_name, u.role, u.kyc_status, u.locked_until, u.created_at, u.closed_at,
         w.balance_tzs, w.bonus_balance_tzs
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
`

export function registerAdminRoutes(app: FastifyInstance, cfg: AppConfig) {
  const guard = requireAdmin()
  const guardWrite = async (req: FastifyRequest) => {
    assertOrigin(req, cfg.corsOrigins)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
    if (!isAdminRole(req.auth.role) || req.auth.readOnly) throw new ApiError(403, 'forbidden')
  }

  app.get('/api/admin/whoami', { preHandler: guard }, async (req) => ({
    role: req.auth!.role,
    permissions: permissionsFor(req.auth!.role),
  }))

  app.get('/api/admin/overview', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query<{
      users: string
      bets_today: string
      stakes: string
      wins: string
      active_matches: string
    }>(
      `SELECT
         (SELECT count(*) FROM users WHERE closed_at IS NULL)::text AS users,
         (SELECT count(*) FROM bets WHERE placed_at >= date_trunc('day', now()))::text AS bets_today,
         (SELECT COALESCE(SUM(amount_tzs), 0) FROM ledger_entries
           WHERE entry_type = 'bet_stake' AND created_at >= date_trunc('day', now()))::text AS stakes,
         (SELECT COALESCE(SUM(amount_tzs), 0) FROM ledger_entries
           WHERE entry_type = 'bet_win' AND created_at >= date_trunc('day', now()))::text AS wins,
         (SELECT count(*) FROM matches WHERE status IN ('live', 'inplay'))::text AS active_matches`,
    )
    const row = rows[0]
    const newest = await getPool(cfg).query(
      `${userSelect}
        WHERE u.closed_at IS NULL
        ORDER BY u.created_at DESC
        LIMIT 5`,
    )
    const stakes = money(row.stakes)
    const wins = money(row.wins)
    return {
      users: Number(row.users),
      betsToday: Number(row.bets_today),
      revenueTzs: stakes - wins,
      activeMatches: Number(row.active_matches),
      newest: newest.rows.map(mapUser),
    }
  })

  app.get('/api/admin/config', { preHandler: guard }, async () => operatorConfig)

  app.patch('/api/admin/config', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const before = { ...operatorConfig }
    const next = { ...operatorConfig }
    for (const key of INT_SETTING_KEYS) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    for (const key of BOOL_SETTING_KEYS) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      next[key] = body[key] as boolean
    }
    if (body.agentWhatsapp !== undefined) {
      if (typeof body.agentWhatsapp !== 'string' || body.agentWhatsapp.length > 20) {
        throw new ApiError(400, 'validation', { fields: { agentWhatsapp: 'invalid' } })
      }
      const trimmed = body.agentWhatsapp.trim()
      if (trimmed && !/^\+?[0-9 ]{8,18}$/.test(trimmed)) {
        throw new ApiError(400, 'validation', { fields: { agentWhatsapp: 'invalid' } })
      }
      next.agentWhatsapp = trimmed
    }
    if (next.minStake > next.maxStake || next.minWithdraw > next.maxWithdraw || next.minDeposit > next.maxDeposit) {
      throw new ApiError(400, 'validation')
    }
    if (next.minDeposit < 1) throw new ApiError(400, 'validation', { fields: { minDeposit: 'min' } })
    if (next.marginBps > 5000) throw new ApiError(400, 'validation', { fields: { marginBps: 'max' } })
    if (next.cashoutMarginBps > 5000) throw new ApiError(400, 'validation', { fields: { cashoutMarginBps: 'max' } })
    if (next.payoutPercentBps < 1 || next.payoutPercentBps > 10000) {
      throw new ApiError(400, 'validation', { fields: { payoutPercentBps: 'range' } })
    }
    assertAviatorRanges(next)
    if (next.rtpBps < 9000 || next.rtpBps > 10000) throw new ApiError(400, 'validation', { fields: { rtpBps: 'range' } })
    for (const key of ['feedSyncIntervalSec', 'liveOddsIntervalSec', 'lifecycleIntervalSec'] as const) {
      if (next[key] < 15 || next[key] > 86_400) throw new ApiError(400, 'validation', { fields: { [key]: 'range' } })
    }
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.config.update', { before, after: { ...operatorConfig } })
    return operatorConfig
  })

  app.get('/api/admin/audit', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, actor_user_id, actor, action, payload, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT 100`,
    )
    return { data: rows }
  })

  app.get('/api/admin/auth-events', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, user_id, phone, event, ip, created_at
         FROM auth_events ORDER BY created_at DESC LIMIT 100`,
    )
    return { data: rows }
  })

  app.get('/api/admin/users', { preHandler: guard }, async (req) => {
    const query = req.query as { limit?: string; offset?: string; q?: string }
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 50) || 50))
    const offset = Math.max(0, Number(query.offset ?? 0) || 0)
    const raw = typeof query.q === 'string' ? query.q.trim().slice(0, 40) : ''
    const like = raw ? `%${raw.replace(/[%_\\]/g, '')}%` : null
    const { rows } = await getPool(cfg).query(
      `${userSelect}
        WHERE ($3::text IS NULL OR u.phone ILIKE $3 OR COALESCE(u.full_name, '') ILIKE $3)
        ORDER BY u.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset, like],
    )
    return { data: rows.map(mapUser) }
  })

  app.get('/api/admin/users/:id', { preHandler: guard }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const user = await getPool(cfg).query(`${userSelect} WHERE u.id = $1`, [id])
    if (!user.rows[0]) throw new ApiError(404, 'not_found')
    const ledger = await getPool(cfg).query(
      `SELECT e.id, e.entry_type, e.direction, e.amount_tzs, e.balance_after_tzs, e.created_at, n.reason
         FROM ledger_entries e
         LEFT JOIN ledger_notes n ON n.ledger_id = e.id
        WHERE e.user_id = $1
        ORDER BY e.created_at DESC
        LIMIT 20`,
      [id],
    )
    const deposits = await getPool(cfg).query(
      `SELECT id, amount_tzs, status, phone, provider, created_at
         FROM deposit_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [id],
    )
    return {
      user: mapUser(user.rows[0]),
      ledger: ledger.rows.map((row) => ({
        id: row.id,
        entryType: row.entry_type,
        direction: row.direction,
        amountTzs: money(row.amount_tzs),
        balanceAfterTzs: money(row.balance_after_tzs),
        createdAt: row.created_at,
        reason: row.reason,
      })),
      deposits: deposits.rows.map((row) => ({
        id: row.id,
        amountTzs: money(row.amount_tzs),
        status: row.status,
        phone: row.phone,
        provider: row.provider,
        createdAt: row.created_at,
      })),
    }
  })

  app.post('/api/admin/users/:id/role', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const role = (req.body as { role?: string } | null)?.role
    if (!role || !isAccountRole(role)) throw new ApiError(400, 'validation', { fields: { role: 'invalid' } })
    await withTx(cfg, async (client) => {
      await client.query(`SELECT id FROM users WHERE role = 'admin' AND closed_at IS NULL FOR UPDATE`)
      const current = await client.query<{ id: string; role: string; phone: string; closed_at: Date | null }>(
        `SELECT id, role, phone, closed_at FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const target = current.rows[0]
      if (!target) throw new ApiError(404, 'not_found')
      if (target.closed_at) throw new ApiError(409, 'account_closed')
      const removing = target.role === 'admin' && role !== 'admin'
      if (removing && await activeAdminCount(client) <= 1) throw new ApiError(409, 'last_admin')
      await client.query(`UPDATE users SET role = $2, updated_at = now() WHERE id = $1`, [id, role])
      await client.query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.user.role', $3::jsonb)`,
        [req.auth!.userId, req.auth!.phone, JSON.stringify({ targetUserId: id, targetPhone: target.phone, from: target.role, to: role })],
      )
    })
    return { id, role }
  })

  app.get('/api/admin/admins', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `${userSelect} WHERE u.role = 'admin' ORDER BY u.created_at ASC`,
    )
    return { data: rows.map(mapUser) }
  })

  app.post('/api/admin/admins', { preHandler: guardWrite }, async (req) => {
    const phone = normalizeTzPhone(String((req.body as { phone?: string } | null)?.phone ?? ''))
    if (!phone) throw new ApiError(400, 'validation', { fields: { phone: 'invalid_phone' } })
    const { rows } = await getPool(cfg).query<{ id: string; role: string; closed_at: Date | null }>(
      `SELECT id, role, closed_at FROM users WHERE phone = $1`,
      [phone],
    )
    const target = rows[0]
    if (!target) throw new ApiError(404, 'not_found')
    if (target.closed_at) throw new ApiError(409, 'account_closed')
    if (target.role === 'admin') return { id: target.id, role: 'admin' }
    await getPool(cfg).query(`UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1`, [target.id])
    await audit(cfg, req, 'admin.user.role', { targetUserId: target.id, targetPhone: phone, from: target.role, to: 'admin' })
    return { id: target.id, role: 'admin' }
  })

  app.post('/api/admin/admins/:id/revoke', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const role = await withTx(cfg, async (client) => {
      await client.query(`SELECT id FROM users WHERE role = 'admin' AND closed_at IS NULL FOR UPDATE`)
      const current = await client.query<{ role: string; phone: string; closed_at: Date | null }>(
        `SELECT role, phone, closed_at FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const target = current.rows[0]
      if (!target) throw new ApiError(404, 'not_found')
      if (target.role !== 'admin') return target.role
      if (target.closed_at) throw new ApiError(409, 'account_closed')
      if (await activeAdminCount(client) <= 1) throw new ApiError(409, 'last_admin')
      await client.query(`UPDATE users SET role = 'player', updated_at = now() WHERE id = $1`, [id])
      await client.query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.user.role', $3::jsonb)`,
        [req.auth!.userId, req.auth!.phone, JSON.stringify({ targetUserId: id, targetPhone: target.phone, from: 'admin', to: 'player' })],
      )
      return 'player'
    })
    return { id, role }
  })

  app.post('/api/admin/users/:id/adjust', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const body = (req.body ?? {}) as { direction?: string; amountTzs?: number; reason?: string }
    if (body.direction !== 'credit' && body.direction !== 'debit') {
      throw new ApiError(400, 'validation', { fields: { direction: 'invalid' } })
    }
    if (typeof body.amountTzs !== 'number' || !Number.isInteger(body.amountTzs) || body.amountTzs < 1 || body.amountTzs > 100_000_000) {
      throw new ApiError(400, 'validation', { fields: { amountTzs: 'invalid' } })
    }
    const reason = reasonOf(body.reason)
    const direction = body.direction
    const amount = body.amountTzs
    try {
      const result = await withTx(cfg, async (client) => {
        const user = await client.query<{ closed_at: Date | null; phone: string }>(
          `SELECT closed_at, phone FROM users WHERE id = $1 FOR UPDATE`,
          [id],
        )
        if (!user.rows[0]) throw new ApiError(404, 'not_found')
        if (user.rows[0].closed_at) throw new ApiError(409, 'account_closed')
        const key = `admin-adjust-${randomUUID()}`
        const fn = direction === 'credit' ? 'wallet_credit' : 'wallet_debit'
        const moved = await client.query<{ result: { ledger_id: string; balance_tzs: string | number; idempotent: boolean } }>(
          `SELECT ${fn}($1::uuid, $2::bigint, 'adjustment', $3, 'cash', 'admin_adjustment', $4::uuid, 'admin', left($5, 120)) AS result`,
          [id, amount, key, req.auth!.userId, reason],
        )
        const ledgerId = moved.rows[0].result.ledger_id
        await client.query(
          `INSERT INTO ledger_notes (ledger_id, reason, actor_user_id) VALUES ($1, $2, $3)`,
          [ledgerId, reason, req.auth!.userId],
        )
        await client.query(
          `INSERT INTO audit_log (actor_user_id, actor, action, payload)
           VALUES ($1, $2, 'admin.user.adjust', $3::jsonb)`,
          [req.auth!.userId, req.auth!.phone, JSON.stringify({
            targetUserId: id,
            targetPhone: user.rows[0].phone,
            direction,
            amountTzs: amount,
            reason,
            ledgerId,
          })],
        )
        return {
          ledgerId,
          balanceTzs: money(moved.rows[0].result.balance_tzs),
        }
      })
      return { id, direction, amountTzs: amount, ...result }
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (message.includes('insufficient_funds')) throw new ApiError(409, 'insufficient_funds')
      throw err
    }
  })

  app.post('/api/admin/users/:id/force-logout', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const reason = reasonOf((req.body as { reason?: string } | null)?.reason)
    if (id === req.auth!.userId) throw new ApiError(409, 'cannot_target_self')
    const user = await getPool(cfg).query<{ phone: string }>(`SELECT phone FROM users WHERE id = $1`, [id])
    if (!user.rows[0]) throw new ApiError(404, 'not_found')
    await getPool(cfg).query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [id],
    )
    await getPool(cfg).query(
      `INSERT INTO force_logout_events (actor_user_id, target_user_id, reason) VALUES ($1, $2, $3)`,
      [req.auth!.userId, id, reason],
    )
    await audit(cfg, req, 'admin.user.force_logout', { targetUserId: id, targetPhone: user.rows[0].phone, reason })
    return { id, ok: true }
  })

  app.post('/api/admin/users/:id/close', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const reason = reasonOf((req.body as { reason?: string } | null)?.reason)
    if (id === req.auth!.userId) throw new ApiError(409, 'cannot_target_self')
    await withTx(cfg, async (client) => {
      await client.query(`SELECT id FROM users WHERE role = 'admin' AND closed_at IS NULL FOR UPDATE`)
      const current = await client.query<{ role: string; phone: string; closed_at: Date | null }>(
        `SELECT role, phone, closed_at FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const target = current.rows[0]
      if (!target) throw new ApiError(404, 'not_found')
      if (target.closed_at) return
      if (target.role === 'admin' && await activeAdminCount(client) <= 1) throw new ApiError(409, 'last_admin')
      await client.query(
        `UPDATE users SET closed_at = now(), closed_reason = $2, updated_at = now() WHERE id = $1`,
        [id, reason],
      )
      await client.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id])
      await client.query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload)
         VALUES ($1, $2, 'admin.user.close', $3::jsonb)`,
        [req.auth!.userId, req.auth!.phone, JSON.stringify({ targetUserId: id, targetPhone: target.phone, reason })],
      )
    })
    return { id, closed: true }
  })

  app.post('/api/admin/users/:id/impersonate', { preHandler: guardWrite }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const reason = reasonOf((req.body as { reason?: string } | null)?.reason)
    if (id === req.auth!.userId) throw new ApiError(409, 'cannot_target_self')
    const target = await getPool(cfg).query<{ role: string; phone: string; closed_at: Date | null }>(
      `SELECT role, phone, closed_at FROM users WHERE id = $1`,
      [id],
    )
    const row = target.rows[0]
    if (!row) throw new ApiError(404, 'not_found')
    if (row.closed_at) throw new ApiError(409, 'account_closed')
    if (row.role === 'admin') throw new ApiError(403, 'cannot_impersonate_admin')
    const created = await getPool(cfg).query<{ id: string }>(
      `INSERT INTO impersonation_sessions (actor_user_id, target_user_id, reason)
       VALUES ($1, $2, $3) RETURNING id`,
      [req.auth!.userId, id, reason],
    )
    await audit(cfg, req, 'admin.impersonate.start', {
      targetUserId: id,
      targetPhone: row.phone,
      reason,
      impersonationId: created.rows[0].id,
      readOnly: true,
    })
    const auth = await beginImpersonation(cfg, reply, req, id, created.rows[0].id)
    return {
      readOnly: true,
      impersonationId: created.rows[0].id,
      userId: auth.userId,
      phone: auth.phone,
    }
  })

  app.get('/api/admin/impersonations', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT s.id, s.reason, s.created_at, s.ended_at,
              a.phone AS actor_phone, t.phone AS target_phone
         FROM impersonation_sessions s
         JOIN users a ON a.id = s.actor_user_id
         JOIN users t ON t.id = s.target_user_id
        ORDER BY s.created_at DESC
        LIMIT 100`,
    )
    return { data: rows }
  })

  app.get('/api/admin/force-logouts', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT e.id, e.reason, e.created_at, a.phone AS actor_phone, t.phone AS target_phone
         FROM force_logout_events e
         JOIN users a ON a.id = e.actor_user_id
         JOIN users t ON t.id = e.target_user_id
        ORDER BY e.created_at DESC
        LIMIT 100`,
    )
    return { data: rows }
  })

  app.get('/api/admin/ledger', { preHandler: guard }, async (req) => {
    const query = req.query as { limit?: string }
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50) || 50))
    const { rows } = await getPool(cfg).query(
      `SELECT e.id, e.user_id, u.phone, e.entry_type, e.direction, e.amount_tzs,
              e.balance_after_tzs, e.bucket, e.created_at, n.reason
         FROM ledger_entries e
         JOIN users u ON u.id = e.user_id
         LEFT JOIN ledger_notes n ON n.ledger_id = e.id
        ORDER BY e.created_at DESC
        LIMIT $1`,
      [limit],
    )
    return {
      data: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        phone: row.phone,
        entryType: row.entry_type,
        direction: row.direction,
        amountTzs: money(row.amount_tzs),
        balanceAfterTzs: money(row.balance_after_tzs),
        bucket: row.bucket,
        createdAt: row.created_at,
        reason: row.reason,
      })),
    }
  })

  app.post('/api/admin/reconcile/wallets', { preHandler: guardWrite }, async (req) => {
    const { rows } = await getPool(cfg).query<{ result: { id: string; walletsChecked: number; mismatches: number } }>(
      `SELECT wallet_run_reconciliation($1::uuid) AS result`,
      [req.auth!.userId],
    )
    await audit(cfg, req, 'admin.wallet.reconcile', rows[0].result)
    return rows[0].result
  })

  app.get('/api/admin/reconciliation', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, ran_at, ran_by, wallets_checked, mismatches
         FROM wallet_reconciliation_log ORDER BY ran_at DESC LIMIT 20`,
    )
    return { data: rows }
  })

  app.get('/api/admin/fraud-alerts', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT a.id, a.user_id, u.phone, a.kind, a.detail, a.status, a.created_at, a.resolved_at
         FROM wallet_fraud_alerts a
         LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC
        LIMIT 100`,
    )
    return { data: rows }
  })

  app.post('/api/admin/fraud-alerts/:id/resolve', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const reason = reasonOf((req.body as { reason?: string } | null)?.reason)
    const updated = await getPool(cfg).query(
      `UPDATE wallet_fraud_alerts
          SET status = 'resolved', resolved_at = now(), resolved_by = $2
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [id, req.auth!.userId],
    )
    if (!updated.rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'admin.fraud.resolve', { alertId: id, reason })
    return { id, status: 'resolved' }
  })

  app.get('/api/admin/fraud-flags', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT flag_type, user_id, phone, amount_tzs, event_count, detected_at
         FROM fraud_flags
        ORDER BY detected_at DESC
        LIMIT 100`,
    )
    return {
      data: rows.map((row) => ({
        flagType: row.flag_type,
        userId: row.user_id,
        phone: row.phone,
        amountTzs: row.amount_tzs === null ? null : money(row.amount_tzs),
        eventCount: Number(row.event_count),
        detectedAt: row.detected_at,
      })),
    }
  })

  app.get('/api/banners', async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, title, image_url, link_url, sort_order FROM banners WHERE active ORDER BY sort_order, created_at`,
    )
    return { data: rows }
  })

  app.get('/api/admin/banners', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, title, image_url, link_url, sort_order, active, created_at FROM banners ORDER BY sort_order, created_at`,
    )
    return { data: rows }
  })

  app.post('/api/admin/banners', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as { title?: string; imageUrl?: string; linkUrl?: string; sortOrder?: number; active?: boolean }
    const title = textField(body.title, 'title', 1, 80)
    const imageUrl = httpUrl(body.imageUrl, 'imageUrl', true)
    const linkUrl = httpUrl(body.linkUrl, 'linkUrl', false)
    const sortOrder = body.sortOrder === undefined ? 0 : body.sortOrder
    if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000) {
      throw new ApiError(400, 'validation', { fields: { sortOrder: 'invalid' } })
    }
    const active = body.active === undefined ? true : body.active
    if (typeof active !== 'boolean') throw new ApiError(400, 'validation', { fields: { active: 'invalid' } })
    const inserted = await getPool(cfg).query<{ id: string }>(
      `INSERT INTO banners (title, image_url, link_url, sort_order, active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, imageUrl, linkUrl, sortOrder, active],
    )
    await audit(cfg, req, 'admin.banner.create', { id: inserted.rows[0].id, title })
    return { id: inserted.rows[0].id }
  })

  app.patch('/api/admin/banners/:id', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const body = (req.body ?? {}) as { title?: string; active?: boolean; sortOrder?: number }
    const current = await getPool(cfg).query(`SELECT id, title, active, sort_order FROM banners WHERE id = $1`, [id])
    if (!current.rows[0]) throw new ApiError(404, 'not_found')
    const title = body.title === undefined ? current.rows[0].title : textField(body.title, 'title', 1, 80)
    const active = body.active === undefined ? current.rows[0].active : body.active
    const sortOrder = body.sortOrder === undefined ? current.rows[0].sort_order : body.sortOrder
    if (typeof active !== 'boolean') throw new ApiError(400, 'validation')
    if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)) throw new ApiError(400, 'validation')
    await getPool(cfg).query(
      `UPDATE banners SET title = $2, active = $3, sort_order = $4, updated_at = now() WHERE id = $1`,
      [id, title, active, sortOrder],
    )
    await audit(cfg, req, 'admin.banner.update', { id, title, active, sortOrder })
    return { id }
  })

  app.post('/api/admin/banners/:id/delete', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const removed = await getPool(cfg).query(`DELETE FROM banners WHERE id = $1 RETURNING title`, [id])
    if (!removed.rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'admin.banner.delete', { id, title: removed.rows[0].title })
    return { id, deleted: true }
  })

  app.get('/api/announcements', async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, message_sw, message_en FROM announcements WHERE active ORDER BY created_at DESC LIMIT 5`,
    )
    return { data: rows }
  })

  app.get('/api/admin/announcements', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, message_sw, message_en, active, created_at FROM announcements ORDER BY created_at DESC LIMIT 100`,
    )
    return { data: rows }
  })

  app.post('/api/admin/announcements', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as { messageSw?: string; messageEn?: string; active?: boolean }
    const messageSw = textField(body.messageSw, 'messageSw', 1, 280)
    const messageEn = textField(body.messageEn, 'messageEn', 1, 280)
    const active = body.active === undefined ? true : body.active
    if (typeof active !== 'boolean') throw new ApiError(400, 'validation')
    const inserted = await getPool(cfg).query<{ id: string }>(
      `INSERT INTO announcements (message_sw, message_en, active) VALUES ($1, $2, $3) RETURNING id`,
      [messageSw, messageEn, active],
    )
    await audit(cfg, req, 'admin.announcement.create', { id: inserted.rows[0].id })
    return { id: inserted.rows[0].id }
  })

  app.post('/api/admin/announcements/:id/delete', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const removed = await getPool(cfg).query(`DELETE FROM announcements WHERE id = $1 RETURNING id`, [id])
    if (!removed.rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'admin.announcement.delete', { id })
    return { id, deleted: true }
  })

  app.patch('/api/admin/announcements/:id', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const active = (req.body as { active?: boolean } | null)?.active
    if (typeof active !== 'boolean') throw new ApiError(400, 'validation')
    const updated = await getPool(cfg).query(
      `UPDATE announcements SET active = $2, updated_at = now() WHERE id = $1 RETURNING id`,
      [id, active],
    )
    if (!updated.rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'admin.announcement.update', { id, active })
    return { id, active }
  })

  app.get('/api/admin/notifications', { preHandler: guard }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT n.id, n.user_id, u.phone, n.title, n.body, n.created_at
         FROM notifications n
         LEFT JOIN users u ON u.id = n.user_id
        WHERE n.deleted_at IS NULL
        ORDER BY n.created_at DESC
        LIMIT 100`,
    )
    return { data: rows }
  })

  app.post('/api/admin/notifications', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as { title?: string; body?: string; phone?: string }
    const title = textField(body.title, 'title', 1, 80)
    const text = textField(body.body, 'body', 1, 500)
    let userId: string | null = null
    if (body.phone && body.phone.trim()) {
      const phone = normalizeTzPhone(body.phone)
      if (!phone) throw new ApiError(400, 'validation', { fields: { phone: 'invalid_phone' } })
      const user = await getPool(cfg).query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone])
      if (!user.rows[0]) throw new ApiError(404, 'not_found')
      userId = user.rows[0].id
    }
    const inserted = await getPool(cfg).query<{ id: string }>(
      `INSERT INTO notifications (user_id, title, body, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, title, text, req.auth!.userId],
    )
    await audit(cfg, req, 'admin.notification.create', { id: inserted.rows[0].id, userId, title })
    return { id: inserted.rows[0].id }
  })

  app.post('/api/admin/notifications/:id/delete', { preHandler: guardWrite }, async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const updated = await getPool(cfg).query(
      `UPDATE notifications SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id],
    )
    if (!updated.rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'admin.notification.delete', { id })
    return { id, deleted: true }
  })
}
