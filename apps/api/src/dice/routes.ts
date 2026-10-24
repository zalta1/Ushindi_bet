import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { saveOperatorSettings } from '../admin/settings-store.js'
import { isAdminRole } from '../admin/roles.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { addCasinoTurnover, budgetView, lockCasinoBudget, lossRate, readCasinoBudget, saveCasinoBudget } from '../casino/budget.js'
import { operatorConfig } from '../operator-config.js'
import {
  DICE_CLIENT_SEED,
  diceHash,
  diceMultiplier,
  dicePayout,
  diceWins,
  generateDiceRoll,
  rollFromHash,
  sha256,
} from './fairness.js'
import { assertDiceRanges, diceSettings } from './settings.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type Commitment = {
  server_seed: string
  server_seed_hash: string
  client_seed: string
  nonce: number
}

type BetRow = {
  id: string
  phone?: string
  stake_tzs: string
  target: number
  side: 'under' | 'over'
  roll: number
  multiplier: string
  payout_tzs: string
  won: boolean
  server_seed: string
  server_seed_hash: string
  client_seed: string
  nonce: number
  rtp_bps: number
  forced: boolean
  created_at: Date
}

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
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

function freshSeed(): { serverSeed: string; serverSeedHash: string } {
  const serverSeed = randomBytes(32).toString('hex')
  return { serverSeed, serverSeedHash: sha256(serverSeed) }
}

function mapBet(row: BetRow) {
  return {
    id: row.id,
    phone: row.phone,
    stakeTzs: money(row.stake_tzs),
    target: row.target,
    side: row.side,
    roll: row.roll,
    multiplier: Number(row.multiplier),
    payoutTzs: money(row.payout_tzs),
    won: row.won,
    serverSeed: row.server_seed,
    serverSeedHash: row.server_seed_hash,
    clientSeed: row.client_seed,
    nonce: row.nonce,
    rtpBps: row.rtp_bps,
    forced: row.forced,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function publicLimits(budgetEnabled: boolean) {
  const settings = diceSettings()
  return {
    enabled: settings.diceEnabled,
    rtpBps: settings.diceRtpBps,
    minStake: settings.diceMinStake,
    maxStake: settings.diceMaxStake,
    maxWin: settings.diceMaxWin,
    minTarget: 2,
    maxTarget: 98,
    budgetEnabled,
  }
}

export function registerDiceRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/dice', async (req) => {
    const budget = await readCasinoBudget(getPool(cfg), 'dice')
    const limits = publicLimits(budget.enabled)
    if (!req.auth) return { limits, commitment: null, history: [] }
    const commitment = await withTx(cfg, async (client) => {
      const locked = await client.query<Commitment>(
        `SELECT server_seed, server_seed_hash, client_seed, nonce FROM dice_commitments WHERE user_id = $1 FOR UPDATE`,
        [req.auth!.userId],
      )
      if (locked.rows[0]) return locked.rows[0]
      const seed = freshSeed()
      const inserted = await client.query<Commitment>(
        `INSERT INTO dice_commitments (user_id, server_seed, server_seed_hash, client_seed, nonce)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING server_seed, server_seed_hash, client_seed, nonce`,
        [req.auth!.userId, seed.serverSeed, seed.serverSeedHash, DICE_CLIENT_SEED],
      )
      if (inserted.rows[0]) return inserted.rows[0]
      const again = await client.query<Commitment>(
        `SELECT server_seed, server_seed_hash, client_seed, nonce FROM dice_commitments WHERE user_id = $1`,
        [req.auth!.userId],
      )
      return again.rows[0]
    })
    const history = await getPool(cfg).query<BetRow>(
      `SELECT id, stake_tzs, target, side, roll, multiplier, payout_tzs, won,
              server_seed, server_seed_hash, client_seed, nonce, rtp_bps, forced, created_at
         FROM dice_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.auth.userId],
    )
    return {
      limits,
      commitment: {
        serverSeedHash: commitment.server_seed_hash,
        clientSeed: commitment.client_seed,
        nonce: commitment.nonce,
      },
      history: history.rows.map(mapBet),
    }
  })

  app.post('/api/dice/client-seed', async (req) => {
    requireWrite(cfg, req)
    const raw = (req.body as { clientSeed?: unknown } | null)?.clientSeed
    if (typeof raw !== 'string' || raw.length < 1 || raw.length > 32 || !/^[\x21-\x7e]+$/.test(raw)) {
      throw new ApiError(400, 'validation', { fields: { clientSeed: 'invalid' } })
    }
    await withTx(cfg, async (client) => {
      const updated = await client.query(
        `UPDATE dice_commitments SET client_seed = $2 WHERE user_id = $1`,
        [req.auth!.userId, raw],
      )
      if (updated.rowCount) return
      const seed = freshSeed()
      await client.query(
        `INSERT INTO dice_commitments (user_id, server_seed, server_seed_hash, client_seed, nonce)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (user_id) DO UPDATE SET client_seed = EXCLUDED.client_seed`,
        [req.auth!.userId, seed.serverSeed, seed.serverSeedHash, raw],
      )
    })
    return { clientSeed: raw }
  })

  app.post('/api/dice/play', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { side?: unknown; target?: unknown; stakeTzs?: unknown; idempotencyKey?: unknown }
    const side = body.side === 'under' || body.side === 'over' ? body.side : null
    if (!side) throw new ApiError(400, 'validation', { fields: { side: 'invalid' } })
    if (typeof body.target !== 'number' || !Number.isInteger(body.target) || body.target < 2 || body.target > 98) {
      throw new ApiError(400, 'validation', { fields: { target: 'range' } })
    }
    const target = body.target
    const limits = diceSettings()
    if (!limits.diceEnabled) throw new ApiError(409, 'game_disabled')
    if (typeof body.stakeTzs !== 'number' || !Number.isSafeInteger(body.stakeTzs) || body.stakeTzs < limits.diceMinStake || body.stakeTzs > limits.diceMaxStake) {
      throw new ApiError(400, 'validation', { fields: { stakeTzs: 'range' } })
    }
    const stake = body.stakeTzs
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
    if (key.length < 8 || key.length > 160) throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
    const multiplier = diceMultiplier(target, side, limits.diceRtpBps)
    if (multiplier < 1.01) throw new ApiError(400, 'validation', { fields: { target: 'payout' } })
    const payout = dicePayout(stake, multiplier, limits.diceMaxWin)

    try {
      const result = await withTx(cfg, async (client) => {
        const existing = await client.query<BetRow>(
          `SELECT id, stake_tzs, target, side, roll, multiplier, payout_tzs, won,
                  server_seed, server_seed_hash, client_seed, nonce, rtp_bps, forced, created_at
             FROM dice_bets WHERE client_ref = $1`,
          [key],
        )
        if (existing.rows[0]) {
          const owner = await client.query<{ user_id: string }>(`SELECT user_id FROM dice_bets WHERE client_ref = $1`, [key])
          if (owner.rows[0].user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          const balance = await client.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [req.auth!.userId])
          const next = await client.query<Commitment>(
            `SELECT server_seed_hash, client_seed, nonce FROM dice_commitments WHERE user_id = $1`,
            [req.auth!.userId],
          )
          return { duplicate: true, bet: existing.rows[0], balance: balance.rows[0]?.balance_tzs ?? '0', next: next.rows[0] }
        }

        const budget = await lockCasinoBudget(client, 'dice')
        const locked = await client.query<Commitment>(
          `SELECT server_seed, server_seed_hash, client_seed, nonce FROM dice_commitments WHERE user_id = $1 FOR UPDATE`,
          [req.auth!.userId],
        )
        const commitment = locked.rows[0]
        if (!commitment) throw new ApiError(409, 'commit_first')
        if (sha256(commitment.server_seed) !== commitment.server_seed_hash) {
          throw new ApiError(500, 'fairness')
        }

        // Budget off: the published hash is the roll. Budget on: PesaBetPro generateDiceRoll.
        // That roll is not a function of the seed, so the bet is marked forced.
        const roll = budget.enabled
          ? generateDiceRoll(target, side, lossRate(budget))
          : rollFromHash(diceHash(commitment.server_seed, commitment.client_seed, commitment.nonce))
        const forced = budget.enabled
        const won = diceWins(roll, target, side)
        const paid = won ? payout : 0
        const betId = randomUUID()

        const debited = await client.query<{ result: { balance_tzs: string | number } }>(
          `SELECT wallet_debit($1, $2, 'bet_stake', $3, 'cash', 'dice', $4, NULL, NULL) AS result`,
          [req.auth!.userId, stake, `dice_stake:${key}`, betId],
        )
        let balance = debited.rows[0].result.balance_tzs
        if (paid > 0) {
          const credited = await client.query<{ result: { balance_tzs: string | number } }>(
            `SELECT wallet_credit($1, $2, 'bet_win', $3, 'cash', 'dice', $4, NULL, NULL) AS result`,
            [req.auth!.userId, paid, `dice_payout:${betId}`, betId],
          )
          balance = credited.rows[0].result.balance_tzs
        }

        const inserted = await client.query<BetRow>(
          `INSERT INTO dice_bets (
             id, user_id, stake_tzs, target, side, roll, multiplier, payout_tzs, won,
             server_seed, server_seed_hash, client_seed, nonce, rtp_bps, client_ref, forced
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING id, stake_tzs, target, side, roll, multiplier, payout_tzs, won,
                     server_seed, server_seed_hash, client_seed, nonce, rtp_bps, forced, created_at`,
          [
            betId, req.auth!.userId, stake, target, side, roll, multiplier, paid, won,
            commitment.server_seed, commitment.server_seed_hash, commitment.client_seed,
            commitment.nonce, limits.diceRtpBps, key, forced,
          ],
        )
        await addCasinoTurnover(client, 'dice', stake, paid)
        const nextSeed = freshSeed()
        const rotated = await client.query<Commitment>(
          `UPDATE dice_commitments
              SET server_seed = $2, server_seed_hash = $3, nonce = nonce + 1, created_at = now()
            WHERE user_id = $1
            RETURNING server_seed_hash, client_seed, nonce`,
          [req.auth!.userId, nextSeed.serverSeed, nextSeed.serverSeedHash],
        )
        return { duplicate: false, bet: inserted.rows[0], balance, next: rotated.rows[0] }
      })
      return {
        duplicate: result.duplicate,
        balanceTzs: money(result.balance),
        bet: mapBet(result.bet),
        next: result.next
          ? { serverSeedHash: result.next.server_seed_hash, clientSeed: result.next.client_seed, nonce: result.next.nonce }
          : null,
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/dice/verify', async (req) => {
    const body = (req.body ?? {}) as { serverSeed?: unknown; clientSeed?: unknown; nonce?: unknown }
    if (typeof body.serverSeed !== 'string' || body.serverSeed.length < 8 || body.serverSeed.length > 128) {
      throw new ApiError(400, 'validation', { fields: { serverSeed: 'invalid' } })
    }
    const clientSeed = typeof body.clientSeed === 'string' && body.clientSeed.length > 0 && body.clientSeed.length <= 32
      ? body.clientSeed
      : DICE_CLIENT_SEED
    const nonce = typeof body.nonce === 'number' ? body.nonce : Number(body.nonce)
    if (!Number.isInteger(nonce) || nonce < 0 || nonce > 1_000_000_000) {
      throw new ApiError(400, 'validation', { fields: { nonce: 'invalid' } })
    }
    const hash = diceHash(body.serverSeed, clientSeed, nonce)
    return { serverSeedHash: sha256(body.serverSeed), hash, roll: rollFromHash(hash), clientSeed, nonce }
  })

  app.get('/api/admin/dice', async (req) => {
    requireAdmin(cfg, req, false)
    const bets = await getPool(cfg).query<BetRow>(
      `SELECT b.id, u.phone, b.stake_tzs, b.target, b.side, b.roll, b.multiplier, b.payout_tzs, b.won,
              b.server_seed, b.server_seed_hash, b.client_seed, b.nonce, b.rtp_bps, b.forced, b.created_at
         FROM dice_bets b
         JOIN users u ON u.id = b.user_id
        ORDER BY b.created_at DESC
        LIMIT 50`,
    )
    const pnl = await getPool(cfg).query<{ stakes: string; payouts: string; n: number }>(
      `SELECT COALESCE(SUM(stake_tzs), 0)::text AS stakes,
              COALESCE(SUM(payout_tzs), 0)::text AS payouts,
              COUNT(*)::int AS n
         FROM dice_bets`,
    )
    const row = pnl.rows[0]
    const stakes = money(row?.stakes ?? 0)
    const payouts = money(row?.payouts ?? 0)
    const budget = await readCasinoBudget(getPool(cfg), 'dice')
    return {
      settings: diceSettings(),
      budget: budgetView(budget),
      pnl: { stakes, payouts, profit: stakes - payouts, bets: row?.n ?? 0 },
      bets: bets.rows.map(mapBet),
    }
  })

  app.patch('/api/admin/dice/budget', async (req) => {
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
      const before = await lockCasinoBudget(client, 'dice')
      const after = await saveCasinoBudget(client, 'dice', next)
      return { before: budgetView(before), after: budgetView(after) }
    })
    await audit(cfg, req, 'admin.dice.budget', saved)
    return saved.after
  })

  app.patch('/api/admin/dice/settings', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as Record<string, unknown>
    const before = diceSettings()
    const next = { ...operatorConfig }
    for (const key of ['diceRtpBps', 'diceMinStake', 'diceMaxStake', 'diceMaxWin'] as const) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    if (body.diceEnabled !== undefined) {
      if (typeof body.diceEnabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { diceEnabled: 'invalid' } })
      next.diceEnabled = body.diceEnabled
    }
    assertDiceRanges(next)
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.dice.settings', { before, after: diceSettings() })
    return diceSettings()
  })
}
