import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import type { AppConfig } from '../config.js'
import { saveOperatorSettings } from '../admin/settings-store.js'
import { isAdminRole } from '../admin/roles.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'
import { addCasinoTurnover, budgetView, lockCasinoBudget, readCasinoBudget, saveCasinoBudget } from '../casino/budget.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { operatorConfig } from '../operator-config.js'
import { generateMines, minesMultiplier, minesPayout, MINES_CELLS, MINES_MAX_COUNT } from './fairness.js'
import { assertMinesRanges, minesSettings } from './settings.js'

type BetRow = {
  id: string
  phone?: string
  stake_tzs: string
  mine_count: number
  mines: number[] | string[]
  revealed: number[] | string[]
  multiplier: string
  payout_tzs: string
  status: 'active' | 'settled' | 'lost'
  rtp_bps: number
  created_at: Date
  settled_at: Date | null
}

function nums(value: number[] | string[] | null | undefined): number[] {
  if (!value) return []
  return value.map((item) => Number(item))
}

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('mines_one_active')) return new ApiError(409, 'active_game')
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

function mapBet(row: BetRow, showMines: boolean) {
  const status = row.status
  return {
    id: row.id,
    phone: row.phone,
    stakeTzs: money(row.stake_tzs),
    mineCount: row.mine_count,
    revealed: nums(row.revealed),
    multiplier: Number(row.multiplier),
    payoutTzs: money(row.payout_tzs),
    status,
    mines: showMines || status !== 'active' ? nums(row.mines) : null,
    rtpBps: row.rtp_bps,
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
  }
}

const BET_COLUMNS = `id, stake_tzs, mine_count, mines, revealed, multiplier, payout_tzs, status, rtp_bps, created_at, settled_at`

function publicLimits(budgetEnabled: boolean) {
  const settings = minesSettings()
  return {
    enabled: settings.minesEnabled,
    rtpBps: settings.minesRtpBps,
    minStake: settings.minesMinStake,
    maxStake: settings.minesMaxStake,
    maxWin: settings.minesMaxWin,
    minMines: 1,
    maxMines: MINES_MAX_COUNT,
    cells: MINES_CELLS,
    budgetEnabled,
  }
}

function idempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length < 8 || key.length > 160) throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  return key
}

async function betByRef(client: PoolClient, key: string) {
  return client.query<BetRow>(
    `SELECT ${BET_COLUMNS} FROM mines_bets WHERE client_ref = $1`,
    [key],
  )
}

async function balanceOf(client: PoolClient, userId: string) {
  const balance = await client.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  return balance.rows[0]?.balance_tzs ?? '0'
}

export function registerMinesRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/mines', async (req) => {
    const budget = await readCasinoBudget(getPool(cfg), 'mines')
    const limits = publicLimits(budget.enabled)
    if (!req.auth) return { limits, active: null, history: [] }
    const active = await getPool(cfg).query<BetRow>(
      `SELECT ${BET_COLUMNS} FROM mines_bets WHERE user_id = $1 AND status = 'active'`,
      [req.auth.userId],
    )
    const history = await getPool(cfg).query<BetRow>(
      `SELECT ${BET_COLUMNS} FROM mines_bets
        WHERE user_id = $1 AND status <> 'active'
        ORDER BY created_at DESC LIMIT 20`,
      [req.auth.userId],
    )
    return {
      limits,
      active: active.rows[0] ? mapBet(active.rows[0], false) : null,
      history: history.rows.map((row) => mapBet(row, false)),
    }
  })

  app.post('/api/mines/start', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { mineCount?: unknown; stakeTzs?: unknown; idempotencyKey?: unknown }
    if (typeof body.mineCount !== 'number' || !Number.isInteger(body.mineCount) || body.mineCount < 1 || body.mineCount > MINES_MAX_COUNT) {
      throw new ApiError(400, 'validation', { fields: { mineCount: 'range' } })
    }
    const limits = minesSettings()
    if (!limits.minesEnabled) throw new ApiError(409, 'game_disabled')
    if (typeof body.stakeTzs !== 'number' || !Number.isSafeInteger(body.stakeTzs) || body.stakeTzs < limits.minesMinStake || body.stakeTzs > limits.minesMaxStake) {
      throw new ApiError(400, 'validation', { fields: { stakeTzs: 'range' } })
    }
    const mineCount = body.mineCount
    const stake = body.stakeTzs
    const key = idempotencyKey(body.idempotencyKey)
    try {
      const result = await withTx(cfg, async (client) => {
        const existing = await betByRef(client, key)
        if (existing.rows[0]) {
          const owner = await client.query<{ user_id: string }>(`SELECT user_id FROM mines_bets WHERE client_ref = $1`, [key])
          if (owner.rows[0].user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          return { duplicate: true, bet: existing.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        await lockCasinoBudget(client, 'mines')
        const open = await client.query(`SELECT id FROM mines_bets WHERE user_id = $1 AND status = 'active' FOR UPDATE`, [req.auth!.userId])
        if (open.rows[0]) throw new ApiError(409, 'active_game')
        const betId = randomUUID()
        const mines = generateMines(mineCount)
        const debited = await client.query<{ result: { balance_tzs: string | number } }>(
          `SELECT wallet_debit($1, $2, 'bet_stake', $3, 'cash', 'mines', $4, NULL, NULL) AS result`,
          [req.auth!.userId, stake, `mines_stake:${key}`, betId],
        )
        const inserted = await client.query<BetRow>(
          `INSERT INTO mines_bets (
             id, user_id, stake_tzs, mine_count, mines, revealed, multiplier, payout_tzs, status, rtp_bps, client_ref
           ) VALUES ($1,$2,$3,$4,$5,'{}',1,0,'active',$6,$7)
           RETURNING ${BET_COLUMNS}`,
          [betId, req.auth!.userId, stake, mineCount, mines, limits.minesRtpBps, key],
        )
        await addCasinoTurnover(client, 'mines', stake, 0)
        return { duplicate: false, bet: inserted.rows[0], balance: debited.rows[0].result.balance_tzs }
      })
      return { duplicate: result.duplicate, balanceTzs: money(result.balance), bet: mapBet(result.bet, false) }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/mines/reveal', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { betId?: unknown; cell?: unknown; idempotencyKey?: unknown }
    if (typeof body.betId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.betId)) {
      throw new ApiError(400, 'validation', { fields: { betId: 'invalid' } })
    }
    if (typeof body.cell !== 'number' || !Number.isInteger(body.cell) || body.cell < 0 || body.cell >= MINES_CELLS) {
      throw new ApiError(400, 'validation', { fields: { cell: 'range' } })
    }
    const key = idempotencyKey(body.idempotencyKey)
    const cell = body.cell
    const limits = minesSettings()
    try {
      const result = await withTx(cfg, async (client) => {
        const prior = await client.query<{ bet_id: string }>(`SELECT bet_id FROM mines_actions WHERE client_ref = $1`, [key])
        if (prior.rows[0]) {
          const replay = await client.query<BetRow & { user_id: string }>(
            `SELECT ${BET_COLUMNS}, user_id FROM mines_bets WHERE id = $1`,
            [prior.rows[0].bet_id],
          )
          if (replay.rows[0]?.user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          return { duplicate: true, bet: replay.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        const locked = await client.query<BetRow & { user_id: string }>(
          `SELECT ${BET_COLUMNS}, user_id FROM mines_bets WHERE id = $1 FOR UPDATE`,
          [body.betId],
        )
        const bet = locked.rows[0]
        if (!bet || bet.user_id !== req.auth!.userId) throw new ApiError(404, 'not_found')
        if (bet.status !== 'active') throw new ApiError(409, 'bet_closed')
        const revealed = nums(bet.revealed)
        const mines = nums(bet.mines)
        if (!revealed.includes(cell)) {
          revealed.push(cell)
          if (mines.includes(cell)) {
            const lost = await client.query<BetRow>(
              `UPDATE mines_bets
                  SET revealed = $2, status = 'lost', payout_tzs = 0, settled_at = now()
                WHERE id = $1
                RETURNING ${BET_COLUMNS}`,
              [bet.id, revealed],
            )
            await client.query(
              `INSERT INTO mines_actions (bet_id, client_ref, kind, cell) VALUES ($1, $2, 'reveal', $3)`,
              [bet.id, key, cell],
            )
            return { duplicate: false, bet: lost.rows[0], balance: await balanceOf(client, req.auth!.userId) }
          }
          const safeCount = revealed.filter((index) => !mines.includes(index)).length
          const multiplier = minesMultiplier(safeCount, bet.mine_count, bet.rtp_bps)
          const cleared = safeCount === MINES_CELLS - bet.mine_count
          if (cleared) {
            const payout = minesPayout(money(bet.stake_tzs), multiplier, limits.minesMaxWin)
            await lockCasinoBudget(client, 'mines')
            const credited = await client.query<{ result: { balance_tzs: string | number } }>(
              `SELECT wallet_credit($1, $2, 'bet_win', $3, 'cash', 'mines', $4, NULL, NULL) AS result`,
              [req.auth!.userId, payout, `mines_payout:${bet.id}`, bet.id],
            )
            await addCasinoTurnover(client, 'mines', 0, payout)
            const won = await client.query<BetRow>(
              `UPDATE mines_bets
                  SET revealed = $2, multiplier = $3, payout_tzs = $4, status = 'settled', settled_at = now()
                WHERE id = $1
                RETURNING ${BET_COLUMNS}`,
              [bet.id, revealed, multiplier, payout],
            )
            await client.query(
              `INSERT INTO mines_actions (bet_id, client_ref, kind, cell) VALUES ($1, $2, 'reveal', $3)`,
              [bet.id, key, cell],
            )
            return { duplicate: false, bet: won.rows[0], balance: credited.rows[0].result.balance_tzs }
          }
          const updated = await client.query<BetRow>(
            `UPDATE mines_bets SET revealed = $2, multiplier = $3 WHERE id = $1 RETURNING ${BET_COLUMNS}`,
            [bet.id, revealed, multiplier],
          )
          await client.query(
            `INSERT INTO mines_actions (bet_id, client_ref, kind, cell) VALUES ($1, $2, 'reveal', $3)`,
            [bet.id, key, cell],
          )
          return { duplicate: false, bet: updated.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        await client.query(
          `INSERT INTO mines_actions (bet_id, client_ref, kind, cell) VALUES ($1, $2, 'reveal', $3)`,
          [bet.id, key, cell],
        )
        return { duplicate: false, bet, balance: await balanceOf(client, req.auth!.userId) }
      })
      return { duplicate: result.duplicate, balanceTzs: money(result.balance), bet: mapBet(result.bet, false) }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/mines/cashout', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { betId?: unknown; idempotencyKey?: unknown }
    if (typeof body.betId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.betId)) {
      throw new ApiError(400, 'validation', { fields: { betId: 'invalid' } })
    }
    const key = idempotencyKey(body.idempotencyKey)
    const limits = minesSettings()
    try {
      const result = await withTx(cfg, async (client) => {
        const prior = await client.query<{ bet_id: string }>(`SELECT bet_id FROM mines_actions WHERE client_ref = $1`, [key])
        if (prior.rows[0]) {
          const replay = await client.query<BetRow & { user_id: string }>(
            `SELECT ${BET_COLUMNS}, user_id FROM mines_bets WHERE id = $1`,
            [prior.rows[0].bet_id],
          )
          if (replay.rows[0]?.user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          return { duplicate: true, bet: replay.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        const locked = await client.query<BetRow & { user_id: string }>(
          `SELECT ${BET_COLUMNS}, user_id FROM mines_bets WHERE id = $1 FOR UPDATE`,
          [body.betId],
        )
        const bet = locked.rows[0]
        if (!bet || bet.user_id !== req.auth!.userId) throw new ApiError(404, 'not_found')
        if (bet.status !== 'active') throw new ApiError(409, 'bet_closed')
        const revealed = nums(bet.revealed)
        if (revealed.length === 0) throw new ApiError(409, 'too_early')
        const payout = minesPayout(money(bet.stake_tzs), Number(bet.multiplier), limits.minesMaxWin)
        await lockCasinoBudget(client, 'mines')
        let balance: string | number = await balanceOf(client, req.auth!.userId)
        if (payout > 0) {
          const credited = await client.query<{ result: { balance_tzs: string | number } }>(
            `SELECT wallet_credit($1, $2, 'bet_win', $3, 'cash', 'mines', $4, NULL, NULL) AS result`,
            [req.auth!.userId, payout, `mines_payout:${bet.id}`, bet.id],
          )
          balance = credited.rows[0].result.balance_tzs
        }
        await addCasinoTurnover(client, 'mines', 0, payout)
        const settled = await client.query<BetRow>(
          `UPDATE mines_bets
              SET payout_tzs = $2, status = 'settled', settled_at = now()
            WHERE id = $1
            RETURNING ${BET_COLUMNS}`,
          [bet.id, payout],
        )
        await client.query(
          `INSERT INTO mines_actions (bet_id, client_ref, kind, cell) VALUES ($1, $2, 'cashout', NULL)`,
          [bet.id, key],
        )
        return { duplicate: false, bet: settled.rows[0], balance }
      })
      return { duplicate: result.duplicate, balanceTzs: money(result.balance), bet: mapBet(result.bet, false) }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/admin/mines', async (req) => {
    requireAdmin(cfg, req, false)
    const bets = await getPool(cfg).query<BetRow>(
      `SELECT b.id, u.phone, b.stake_tzs, b.mine_count, b.mines, b.revealed, b.multiplier, b.payout_tzs,
              b.status, b.rtp_bps, b.created_at, b.settled_at
         FROM mines_bets b
         JOIN users u ON u.id = b.user_id
        ORDER BY b.created_at DESC
        LIMIT 50`,
    )
    const pnl = await getPool(cfg).query<{ stakes: string; payouts: string; n: number }>(
      `SELECT COALESCE(SUM(stake_tzs), 0)::text AS stakes,
              COALESCE(SUM(payout_tzs), 0)::text AS payouts,
              COUNT(*)::int AS n
         FROM mines_bets`,
    )
    const row = pnl.rows[0]
    const stakes = money(row?.stakes ?? 0)
    const payouts = money(row?.payouts ?? 0)
    const budget = await readCasinoBudget(getPool(cfg), 'mines')
    return {
      settings: minesSettings(),
      budget: budgetView(budget),
      pnl: { stakes, payouts, profit: stakes - payouts, bets: row?.n ?? 0 },
      bets: bets.rows.map((bet) => mapBet(bet, true)),
    }
  })

  app.patch('/api/admin/mines/budget', async (req) => {
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
      const before = await lockCasinoBudget(client, 'mines')
      const after = await saveCasinoBudget(client, 'mines', next)
      return { before: budgetView(before), after: budgetView(after) }
    })
    await audit(cfg, req, 'admin.mines.budget', saved)
    return saved.after
  })

  app.patch('/api/admin/mines/settings', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as Record<string, unknown>
    const before = minesSettings()
    const next = { ...operatorConfig }
    for (const key of ['minesRtpBps', 'minesMinStake', 'minesMaxStake', 'minesMaxWin'] as const) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    if (body.minesEnabled !== undefined) {
      if (typeof body.minesEnabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { minesEnabled: 'invalid' } })
      next.minesEnabled = body.minesEnabled
    }
    assertMinesRanges(next)
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.mines.settings', { before, after: minesSettings() })
    return minesSettings()
  })
}
