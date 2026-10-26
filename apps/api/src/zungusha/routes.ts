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
import {
  chooseReward,
  newServerSeed,
  nextUnit,
  segmentIndexFor,
  ZUNGUSHA_CHIPS,
  ZUNGUSHA_CLIENT_SEED,
  zungushaHash,
  zungushaPayout,
  type WheelReward,
} from './fairness.js'
import { assertZungushaRanges, zungushaSettings } from './settings.js'

type RewardRow = {
  id: string
  reward_key: string
  label: string
  amount_tzs: string
  segment_count: number
  weight: string
  color: string
  is_lost: boolean
  is_active: boolean
  display_order: number
}

type SpinRow = {
  id: string
  user_id?: string
  phone?: string
  reward_id: string | null
  stake_tzs: string
  reward_label: string
  reward_color: string
  amount_tzs: string
  payout_tzs: string
  is_lost: boolean
  segment_index: number
  weight: string
  forced: boolean
  roll: string
  server_seed: string
  hash: string
  nonce: number
  client_seed: string
  created_at: Date
}

const SPIN_COLUMNS = `id, reward_id, stake_tzs, reward_label, reward_color, amount_tzs, payout_tzs, is_lost, segment_index, weight, forced, roll, server_seed, hash, nonce, client_seed, created_at`
const REWARD_COLUMNS = `id, reward_key, label, amount_tzs, segment_count, weight, color, is_lost, is_active, display_order`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLOR_RE = /^#[0-9a-f]{6}$/

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('zungusha_spins_client_ref')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('zungusha_rewards')) return new ApiError(400, 'validation', { fields: { reward: 'range' } })
  if (message.includes('no_weight')) return new ApiError(409, 'no_rewards')
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

function mapReward(row: RewardRow, admin: boolean) {
  return {
    id: row.id,
    rewardKey: row.reward_key,
    label: row.label,
    amount: money(row.amount_tzs),
    segmentCount: row.segment_count,
    color: row.color,
    isLost: row.is_lost,
    displayOrder: row.display_order,
    ...(admin ? { weight: Number(row.weight), isActive: row.is_active } : {}),
  }
}

function mapSpin(row: SpinRow, admin: boolean) {
  return {
    id: row.id,
    stakeTzs: money(row.stake_tzs),
    payoutTzs: money(row.payout_tzs),
    segmentIndex: row.segment_index,
    rewardLabel: row.reward_label,
    nonce: row.nonce,
    createdAt: new Date(row.created_at).toISOString(),
    reward: {
      id: row.reward_id,
      label: row.reward_label,
      color: row.reward_color,
      isLost: row.is_lost,
      amount: money(row.payout_tzs),
    },
    ...(admin
      ? {
          phone: row.phone,
          userId: row.user_id,
          forced: row.forced,
          amountTzs: money(row.amount_tzs),
          weight: Number(row.weight),
          hash: row.hash,
          serverSeed: row.server_seed,
          clientSeed: row.client_seed,
          roll: Number(row.roll),
        }
      : {}),
  }
}

function publicLimits(budgetEnabled: boolean) {
  const settings = zungushaSettings()
  return {
    enabled: settings.zungushaEnabled,
    spinCost: settings.zungushaSpinCost,
    minStake: settings.zungushaMinStake,
    maxStake: settings.zungushaMaxStake,
    maxPayout: settings.zungushaMaxPayout,
    budgetEnabled,
    chips: ZUNGUSHA_CHIPS,
  }
}

function idempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length < 8 || key.length > 160) throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  return key
}

function clientSeedOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return ZUNGUSHA_CLIENT_SEED
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw new ApiError(400, 'validation', { fields: { clientSeed: 'length' } })
  }
  return value
}

function stakeOf(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'validation', { fields: { stakeTzs: 'range' } })
  }
  return value
}

function uuidOf(value: string): string {
  if (!UUID_RE.test(value)) throw new ApiError(400, 'validation', { fields: { id: 'invalid' } })
  return value
}

async function balanceOf(client: PoolClient, userId: string) {
  const balance = await client.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  return balance.rows[0]?.balance_tzs ?? '0'
}

async function loadRewards(client: { query: PoolClient['query'] }) {
  const rewards = await client.query<RewardRow>(
    `SELECT ${REWARD_COLUMNS} FROM zungusha_rewards ORDER BY display_order, reward_key`,
  )
  return rewards.rows
}

type RewardPatch = {
  label: string
  amountTzs: number
  segmentCount: number
  weight: number
  color: string
  isLost: boolean
  isActive: boolean
  displayOrder: number
}

function parseReward(body: Record<string, unknown>): RewardPatch {
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (label.length < 1 || label.length > 40) throw new ApiError(400, 'validation', { fields: { label: 'length' } })
  const amountTzs = body.amountTzs ?? body.amount
  if (typeof amountTzs !== 'number' || !Number.isInteger(amountTzs) || amountTzs < 0 || amountTzs > 50_000_000) {
    throw new ApiError(400, 'validation', { fields: { amount: 'range' } })
  }
  const segmentCount = body.segmentCount
  if (typeof segmentCount !== 'number' || !Number.isInteger(segmentCount) || segmentCount < 1 || segmentCount > 48) {
    throw new ApiError(400, 'validation', { fields: { segmentCount: 'range' } })
  }
  const weight = body.weight
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1_000_000) {
    throw new ApiError(400, 'validation', { fields: { weight: 'range' } })
  }
  const color = typeof body.color === 'string' ? body.color.trim().toLowerCase() : ''
  if (!COLOR_RE.test(color)) throw new ApiError(400, 'validation', { fields: { color: 'invalid' } })
  if (typeof body.isLost !== 'boolean') throw new ApiError(400, 'validation', { fields: { isLost: 'invalid' } })
  if (typeof body.isActive !== 'boolean') throw new ApiError(400, 'validation', { fields: { isActive: 'invalid' } })
  const displayOrder = body.displayOrder
  if (typeof displayOrder !== 'number' || !Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 10_000) {
    throw new ApiError(400, 'validation', { fields: { displayOrder: 'range' } })
  }
  return {
    label,
    amountTzs,
    segmentCount,
    weight: Math.round(weight * 1_000_000) / 1_000_000,
    color,
    isLost: body.isLost,
    isActive: body.isActive,
    displayOrder,
  }
}

function wheelOf(rows: RewardRow[]): WheelReward[] {
  return rows.filter((row) => row.is_active).map((row) => ({
    id: row.id,
    weight: Number(row.weight),
    segmentCount: row.segment_count,
    isLost: row.is_lost,
  }))
}

export function registerZungushaRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/zungusha', async (req) => {
    const budget = await readCasinoBudget(getPool(cfg), 'zungusha')
    const rewards = (await loadRewards(getPool(cfg))).filter((row) => row.is_active)
    const winners = await getPool(cfg).query<SpinRow>(
      `SELECT id, reward_label, payout_tzs, created_at
         FROM zungusha_spins
        WHERE payout_tzs > 0
        ORDER BY created_at DESC
        LIMIT 10`,
    )
    const limits = publicLimits(budget.enabled)
    return {
      limits,
      rewards: rewards.map((row) => mapReward(row, false)),
      winners: winners.rows.map((row) => ({
        id: row.id,
        rewardLabel: row.reward_label,
        amountWon: money(row.payout_tzs),
        createdAt: new Date(row.created_at).toISOString(),
      })),
    }
  })

  app.post('/api/zungusha/spin', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { stakeTzs?: unknown; idempotencyKey?: unknown; clientSeed?: unknown }
    const limits = zungushaSettings()
    if (!limits.zungushaEnabled) throw new ApiError(409, 'game_disabled')
    const stake = stakeOf(body.stakeTzs, limits.zungushaMinStake, limits.zungushaMaxStake)
    const key = idempotencyKey(body.idempotencyKey)
    const seed = clientSeedOf(body.clientSeed)
    try {
      const result = await withTx(cfg, async (client) => {
        const existing = await client.query<SpinRow>(
          `SELECT ${SPIN_COLUMNS} FROM zungusha_spins WHERE client_ref = $1`,
          [key],
        )
        if (existing.rows[0]) {
          const owner = await client.query<{ user_id: string }>(`SELECT user_id FROM zungusha_spins WHERE client_ref = $1`, [key])
          if (owner.rows[0].user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          return { duplicate: true, spin: existing.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        const budget = await lockCasinoBudget(client, 'zungusha')
        const locked = await client.query<RewardRow>(
          `SELECT ${REWARD_COLUMNS} FROM zungusha_rewards ORDER BY display_order, reward_key FOR UPDATE`,
        )
        const active = wheelOf(locked.rows)
        if (!active.length) throw new ApiError(409, 'no_rewards')
        const prior = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM zungusha_spins WHERE user_id = $1`,
          [req.auth!.userId],
        )
        const nonce = prior.rows[0]?.n ?? 0
        const serverSeed = newServerSeed()
        const hash = zungushaHash(serverSeed, seed, nonce)
        const forcing = budget.enabled
        const forceDraw = forcing ? nextUnit(hash, 0) : 0
        const weightUnit = nextUnit(hash, forcing ? 13 : 0)
        const sliceUnit = nextUnit(hash, forcing ? 26 : 13)
        const chosen = chooseReward(active, weightUnit, forcing ? { rate: lossRate(budget), draw: forceDraw } : undefined)
        const reward = locked.rows.find((row) => row.id === chosen.reward.id)
        if (!reward) throw new ApiError(409, 'no_rewards')
        const segmentIndex = segmentIndexFor(
          locked.rows.filter((row) => row.is_active).map((row) => ({ id: row.id, segmentCount: row.segment_count })),
          reward.id,
          sliceUnit,
        )
        const amount = money(reward.amount_tzs)
        const payout = zungushaPayout(amount, reward.is_lost, limits.zungushaMaxPayout)
        const spinId = randomUUID()
        const debited = await client.query<{ result: { balance_tzs: string | number } }>(
          `SELECT wallet_debit($1, $2, 'bet_stake', $3, 'cash', 'zungusha', $4, NULL, NULL) AS result`,
          [req.auth!.userId, stake, `zungusha_stake:${key}`, spinId],
        )
        let balance: string | number = debited.rows[0].result.balance_tzs
        if (payout > 0) {
          const credited = await client.query<{ result: { balance_tzs: string | number } }>(
            `SELECT wallet_credit($1, $2, 'bet_win', $3, 'cash', 'zungusha', $4, NULL, NULL) AS result`,
            [req.auth!.userId, payout, `zungusha_payout:${spinId}`, spinId],
          )
          balance = credited.rows[0].result.balance_tzs
        }
        await addCasinoTurnover(client, 'zungusha', stake, payout)
        const inserted = await client.query<SpinRow>(
          `INSERT INTO zungusha_spins (
             id, user_id, reward_id, stake_tzs, reward_label, reward_color, amount_tzs, payout_tzs,
             is_lost, segment_index, weight, forced, roll, server_seed, hash, nonce, client_seed, client_ref
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           RETURNING ${SPIN_COLUMNS}`,
          [
            spinId, req.auth!.userId, reward.id, stake, reward.label, reward.color, amount, payout,
            reward.is_lost, segmentIndex, reward.weight, chosen.forced, weightUnit, serverSeed, hash, nonce, seed, key,
          ],
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

  app.get('/api/admin/zungusha', async (req) => {
    requireAdmin(cfg, req, false)
    const rewards = await loadRewards(getPool(cfg))
    const spins = await getPool(cfg).query<SpinRow>(
      `SELECT s.id, s.user_id, u.phone, s.reward_id, s.stake_tzs, s.reward_label, s.reward_color,
              s.amount_tzs, s.payout_tzs, s.is_lost, s.segment_index, s.weight, s.forced, s.roll,
              s.server_seed, s.hash, s.nonce, s.client_seed, s.created_at
         FROM zungusha_spins s
         JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC
        LIMIT 100`,
    )
    const budget = await readCasinoBudget(getPool(cfg), 'zungusha')
    return {
      settings: zungushaSettings(),
      budget: budgetView(budget),
      rewards: rewards.map((row) => mapReward(row, true)),
      spins: spins.rows.map((row) => mapSpin(row, true)),
    }
  })

  app.patch('/api/admin/zungusha/budget', async (req) => {
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
      const before = await lockCasinoBudget(client, 'zungusha')
      const after = await saveCasinoBudget(client, 'zungusha', next)
      return { before: budgetView(before), after: budgetView(after) }
    })
    await audit(cfg, req, 'admin.zungusha.budget', saved)
    return saved.after
  })

  app.patch('/api/admin/zungusha/settings', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as Record<string, unknown>
    const before = zungushaSettings()
    const next = { ...operatorConfig }
    for (const key of ['zungushaSpinCost', 'zungushaMinStake', 'zungushaMaxStake', 'zungushaMaxPayout'] as const) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    if (body.zungushaEnabled !== undefined) {
      if (typeof body.zungushaEnabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { zungushaEnabled: 'invalid' } })
      next.zungushaEnabled = body.zungushaEnabled
    }
    assertZungushaRanges(next)
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.zungusha.settings', { before, after: zungushaSettings() })
    return zungushaSettings()
  })

  app.post('/api/admin/zungusha/rewards', async (req) => {
    requireAdmin(cfg, req, true)
    const inserted = await withTx(cfg, async (client) => {
      const count = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM zungusha_rewards`)
      const order = (count.rows[0]?.n ?? 0) + 1
      const key = `new-${randomUUID()}`
      const row = await client.query<RewardRow>(
        `INSERT INTO zungusha_rewards (reward_key, label, amount_tzs, segment_count, weight, color, is_lost, is_active, display_order)
         VALUES ($1, 'NEW', 100, 1, 1, '#8b5cf6', FALSE, TRUE, $2)
         RETURNING ${REWARD_COLUMNS}`,
        [key, order],
      )
      return row.rows[0]
    })
    await audit(cfg, req, 'admin.zungusha.rewards.add', { reward: mapReward(inserted, true) })
    return { reward: mapReward(inserted, true) }
  })

  app.patch('/api/admin/zungusha/rewards/:id', async (req) => {
    requireAdmin(cfg, req, true)
    const id = uuidOf((req.params as { id: string }).id)
    const patch = parseReward((req.body ?? {}) as Record<string, unknown>)
    const saved = await withTx(cfg, async (client) => {
      const before = await client.query<RewardRow>(
        `SELECT ${REWARD_COLUMNS} FROM zungusha_rewards ORDER BY display_order, reward_key FOR UPDATE`,
      )
      const current = before.rows.find((row) => row.id === id)
      if (!current) throw new ApiError(404, 'not_found')
      const active = before.rows.some((row) => (row.id === id ? patch.isActive : row.is_active))
      if (!active) throw new ApiError(400, 'validation', { fields: { rewards: 'inactive' } })
      const updated = await client.query<RewardRow>(
        `UPDATE zungusha_rewards
            SET label = $2, amount_tzs = $3, segment_count = $4, weight = $5, color = $6,
                is_lost = $7, is_active = $8, display_order = $9
          WHERE id = $1
          RETURNING ${REWARD_COLUMNS}`,
        [id, patch.label, patch.amountTzs, patch.segmentCount, patch.weight, patch.color, patch.isLost, patch.isActive, patch.displayOrder],
      )
      return { before: mapReward(current, true), after: mapReward(updated.rows[0], true) }
    })
    await audit(cfg, req, 'admin.zungusha.rewards', saved)
    return { reward: saved.after }
  })

  app.delete('/api/admin/zungusha/rewards/:id', async (req) => {
    requireAdmin(cfg, req, true)
    const id = uuidOf((req.params as { id: string }).id)
    const removed = await withTx(cfg, async (client) => {
      const before = await client.query<RewardRow>(
        `SELECT ${REWARD_COLUMNS} FROM zungusha_rewards ORDER BY display_order, reward_key FOR UPDATE`,
      )
      const current = before.rows.find((row) => row.id === id)
      if (!current) throw new ApiError(404, 'not_found')
      const activeLeft = before.rows.filter((row) => row.id !== id && row.is_active).length
      if (activeLeft < 1) throw new ApiError(400, 'validation', { fields: { rewards: 'inactive' } })
      await client.query(`DELETE FROM zungusha_rewards WHERE id = $1`, [id])
      return mapReward(current, true)
    })
    await audit(cfg, req, 'admin.zungusha.rewards.delete', { reward: removed })
    return { deleted: true }
  })
}
