import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import type { AppConfig } from '../config.js'
import { saveOperatorSettings } from '../admin/settings-store.js'
import { isAdminRole } from '../admin/roles.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'
import { addCasinoTurnover, budgetView, lockCasinoBudget, lossRate, readCasinoBudget, saveCasinoBudget } from '../casino/budget.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { operatorConfig } from '../operator-config.js'
import { generateWheelIndex, MAYAN_CHIPS, MAYAN_TARGETS, mayanPayout, mayanTarget, WHEEL_SEGMENTS } from './fairness.js'
import { assertMayanRanges, mayanSettings } from './settings.js'

type SpinRow = {
  id: string
  phone?: string
  stake_tzs: string
  bets: Record<string, number> | string
  win_idx: number
  multiplier: string
  payout_tzs: string
  won: boolean
  loss_rate: string
  created_at: Date
}

const SPIN_COLUMNS = `id, stake_tzs, bets, win_idx, multiplier, payout_tzs, won, loss_rate, created_at`

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('mayan_spins_client_ref')) return new ApiError(409, 'idempotency_conflict')
  return null
}

function requireUser(req: FastifyRequest) {
  if (!req.auth) throw new ApiError(401, 'unauthenticated')
  if (req.auth.readOnly) throw new ApiError(403, 'read_only')
}

function requireWrite(cfg: AppConfig, req: FastifyRequest) {
  assertOrigin(req, cfg.corsOrigins)
  requireUser(req)
  assertCsrf(req, req.auth!.csrfHash)
}

function requireAdmin(cfg: AppConfig, req: FastifyRequest, write: boolean) {
  if (write) assertOrigin(req, cfg.corsOrigins)
  if (!req.auth) throw new ApiError(401, 'unauthenticated')
  if (write) assertCsrf(req, req.auth.csrfHash)
  if (!isAdminRole(req.auth.role) || req.auth.readOnly) throw new ApiError(403, 'forbidden')
}

async function audit(cfg: AppConfig, req: FastifyRequest, action: string, payload: unknown) {
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [req.auth?.userId ?? null, req.auth?.phone ?? 'system', action, JSON.stringify(payload)],
  )
}

function betMap(value: SpinRow['bets']): Record<string, number> {
  const source = typeof value === 'string' ? JSON.parse(value) as Record<string, number> : value
  const out: Record<string, number> = {}
  for (const [key, amount] of Object.entries(source ?? {})) out[key] = money(amount)
  return out
}

function mapSpin(row: SpinRow, admin: boolean) {
  return {
    id: row.id,
    phone: row.phone,
    stakeTzs: money(row.stake_tzs),
    bets: betMap(row.bets),
    winIdx: row.win_idx,
    multiplier: Number(row.multiplier),
    label: WHEEL_SEGMENTS[row.win_idx]?.label ?? '',
    payoutTzs: money(row.payout_tzs),
    won: row.won,
    ...(admin ? { lossRate: Number(row.loss_rate) } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function publicLimits(budgetEnabled: boolean) {
  const settings = mayanSettings()
  return {
    enabled: settings.mayanEnabled,
    minStake: settings.mayanMinStake,
    maxStake: settings.mayanMaxStake,
    maxWin: settings.mayanMaxWin,
    budgetEnabled,
    chips: MAYAN_CHIPS,
    segments: WHEEL_SEGMENTS,
    targets: MAYAN_TARGETS,
  }
}

function idempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length < 8 || key.length > 160) throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  return key
}

function parseBets(value: unknown, minStake: number, maxStake: number): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'validation', { fields: { bets: 'invalid' } })
  }
  const out: Record<string, number> = {}
  let total = 0
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    if (!mayanTarget(key)) throw new ApiError(400, 'validation', { fields: { bets: 'unknown' } })
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < minStake) {
      throw new ApiError(400, 'validation', { fields: { bets: 'range' } })
    }
    out[key] = amount
    total += amount
  }
  if (!Object.keys(out).length) throw new ApiError(400, 'validation', { fields: { bets: 'empty' } })
  if (total > maxStake) throw new ApiError(400, 'validation', { fields: { bets: 'range' } })
  return out
}

async function balanceOf(client: PoolClient, userId: string) {
  const balance = await client.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  return balance.rows[0]?.balance_tzs ?? '0'
}

export function registerMayanRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/mayan', async (req) => {
    const budget = await readCasinoBudget(getPool(cfg), 'mayan')
    const limits = publicLimits(budget.enabled)
    if (!req.auth) return { limits, history: [] }
    const history = await getPool(cfg).query<SpinRow>(
      `SELECT ${SPIN_COLUMNS} FROM mayan_spins WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.auth.userId],
    )
    return { limits, history: history.rows.map((row) => mapSpin(row, false)) }
  })

  app.post('/api/mayan/spin', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { bets?: unknown; idempotencyKey?: unknown }
    const limits = mayanSettings()
    if (!limits.mayanEnabled) throw new ApiError(409, 'game_disabled')
    const bets = parseBets(body.bets, limits.mayanMinStake, limits.mayanMaxStake)
    const stake = Object.values(bets).reduce((sum, amount) => sum + amount, 0)
    const key = idempotencyKey(body.idempotencyKey)
    const betted = MAYAN_TARGETS.filter((target) => bets[target.id]).map((target) => target.multiplier)
    try {
      const result = await withTx(cfg, async (client) => {
        const existing = await client.query<SpinRow>(
          `SELECT ${SPIN_COLUMNS} FROM mayan_spins WHERE client_ref = $1`,
          [key],
        )
        if (existing.rows[0]) {
          const owner = await client.query<{ user_id: string }>(`SELECT user_id FROM mayan_spins WHERE client_ref = $1`, [key])
          if (owner.rows[0].user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          return { duplicate: true, spin: existing.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        const budget = await lockCasinoBudget(client, 'mayan')
        const rate = lossRate(budget)
        const winIdx = generateWheelIndex(betted, rate)
        const segment = WHEEL_SEGMENTS[winIdx]
        const stakeOnLanded = bets[`x${segment.multiplier}`] ?? 0
        const payout = mayanPayout(stakeOnLanded, segment.multiplier, limits.mayanMaxWin)
        const betId = randomUUID()
        const debited = await client.query<{ result: { balance_tzs: string | number } }>(
          `SELECT wallet_debit($1, $2, 'bet_stake', $3, 'cash', 'mayan', $4, NULL, NULL) AS result`,
          [req.auth!.userId, stake, `mayan_stake:${key}`, betId],
        )
        let balance: string | number = debited.rows[0].result.balance_tzs
        if (payout > 0) {
          const credited = await client.query<{ result: { balance_tzs: string | number } }>(
            `SELECT wallet_credit($1, $2, 'bet_win', $3, 'cash', 'mayan', $4, NULL, NULL) AS result`,
            [req.auth!.userId, payout, `mayan_payout:${betId}`, betId],
          )
          balance = credited.rows[0].result.balance_tzs
        }
        await addCasinoTurnover(client, 'mayan', stake, payout)
        const inserted = await client.query<SpinRow>(
          `INSERT INTO mayan_spins (
             id, user_id, stake_tzs, bets, win_idx, multiplier, payout_tzs, won, loss_rate, client_ref
           ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
           RETURNING ${SPIN_COLUMNS}`,
          [betId, req.auth!.userId, stake, JSON.stringify(bets), winIdx, segment.multiplier, payout, payout > 0, rate, key],
        )
        return { duplicate: false, spin: inserted.rows[0], balance }
      })
      return { duplicate: result.duplicate, balanceTzs: money(result.balance), spin: mapSpin(result.spin, false) }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/admin/mayan', async (req) => {
    requireAdmin(cfg, req, false)
    const spins = await getPool(cfg).query<SpinRow>(
      `SELECT s.id, u.phone, s.stake_tzs, s.bets, s.win_idx, s.multiplier, s.payout_tzs, s.won, s.loss_rate, s.created_at
         FROM mayan_spins s
         JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC
        LIMIT 50`,
    )
    const pnl = await getPool(cfg).query<{ stakes: string; payouts: string; n: number }>(
      `SELECT COALESCE(SUM(stake_tzs), 0)::text AS stakes,
              COALESCE(SUM(payout_tzs), 0)::text AS payouts,
              COUNT(*)::int AS n
         FROM mayan_spins`,
    )
    const row = pnl.rows[0]
    const stakes = money(row?.stakes ?? 0)
    const payouts = money(row?.payouts ?? 0)
    const budget = await readCasinoBudget(getPool(cfg), 'mayan')
    return {
      settings: mayanSettings(),
      budget: budgetView(budget),
      pnl: { stakes, payouts, profit: stakes - payouts, bets: row?.n ?? 0 },
      spins: spins.rows.map((spin) => mapSpin(spin, true)),
    }
  })

  app.patch('/api/admin/mayan/budget', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as { budgetTzs?: unknown; enabled?: unknown; resetCounters?: unknown }
    const next: { budgetTzs?: number; enabled?: boolean; resetCounters?: boolean } = {}
    if (body.budgetTzs !== undefined) {
      if (typeof body.budgetTzs !== 'number' || !Number.isInteger(body.budgetTzs) || body.budgetTzs < 0 || body.budgetTzs > 1_000_000_000_000) {
        throw new ApiError(400, 'validation', { fields: { budgetTzs: 'invalid' } })
      }
      next.budgetTzs = body.budgetTzs
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { enabled: 'invalid' } })
      next.enabled = body.enabled
    }
    if (body.resetCounters !== undefined) {
      if (body.resetCounters !== true) throw new ApiError(400, 'validation', { fields: { resetCounters: 'invalid' } })
      next.resetCounters = true
    }
    if (next.budgetTzs === undefined && next.enabled === undefined && !next.resetCounters) {
      throw new ApiError(400, 'validation', { fields: { budget: 'empty' } })
    }
    const saved = await withTx(cfg, async (client) => {
      const before = await lockCasinoBudget(client, 'mayan')
      const after = await saveCasinoBudget(client, 'mayan', next)
      return { before: budgetView(before), after: budgetView(after) }
    })
    await audit(cfg, req, 'admin.mayan.budget', saved)
    return saved.after
  })

  app.patch('/api/admin/mayan/settings', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as Record<string, unknown>
    const before = mayanSettings()
    const next = { ...operatorConfig }
    for (const key of ['mayanMinStake', 'mayanMaxStake', 'mayanMaxWin'] as const) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    if (body.mayanEnabled !== undefined) {
      if (typeof body.mayanEnabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { mayanEnabled: 'invalid' } })
      next.mayanEnabled = body.mayanEnabled
    }
    assertMayanRanges(next)
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.mayan.settings', { before, after: mayanSettings() })
    return mayanSettings()
  })
}
