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
import {
  keeperFor,
  newServerSeed,
  nextUnit,
  outcomeFromRolls,
  PENALTY_CHIPS,
  PENALTY_CLIENT_SEED,
  PENALTY_STAKE_STEP,
  penaltyHash,
  penaltyPayout,
  type PenaltyOutcome,
} from './fairness.js'
import { assertPenaltyRanges, penaltySettings } from './settings.js'

type ZoneRow = {
  zone_key: string
  label: string
  multiplier: string
  win_chance: string
  display_order: number
  is_active: boolean
}

type ShotRow = {
  id: string
  phone?: string
  stake_tzs: string
  zone_key: string
  keeper_zone: string
  multiplier: string
  win_chance: string
  roll: string
  outcome: PenaltyOutcome
  payout_tzs: string
  server_seed: string
  hash: string
  nonce: number
  client_seed: string
  created_at: Date
}

const SHOT_COLUMNS = `id, stake_tzs, zone_key, keeper_zone, multiplier, win_chance, roll, outcome, payout_tzs, server_seed, hash, nonce, client_seed, created_at`

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('penalty_shots_client_ref')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('penalty_zones')) return new ApiError(400, 'validation', { fields: { zones: 'range' } })
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

function mapZone(row: ZoneRow, admin: boolean) {
  return {
    zoneKey: row.zone_key,
    label: row.label,
    multiplier: Number(row.multiplier),
    displayOrder: row.display_order,
    isActive: row.is_active,
    ...(admin ? { winChance: Number(row.win_chance) } : {}),
  }
}

function mapShot(row: ShotRow, admin: boolean) {
  return {
    id: row.id,
    phone: row.phone,
    stakeTzs: money(row.stake_tzs),
    zoneKey: row.zone_key,
    keeperZone: row.keeper_zone,
    multiplier: Number(row.multiplier),
    outcome: row.outcome,
    payoutTzs: money(row.payout_tzs),
    serverSeed: row.server_seed,
    hash: row.hash,
    nonce: row.nonce,
    clientSeed: row.client_seed,
    roll: Number(row.roll),
    ...(admin ? { winChance: Number(row.win_chance) } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function publicLimits(budgetEnabled: boolean) {
  const settings = penaltySettings()
  return {
    enabled: settings.penaltyEnabled,
    minStake: settings.penaltyMinStake,
    maxStake: settings.penaltyMaxStake,
    maxPayout: settings.penaltyMaxPayout,
    budgetEnabled,
    chips: PENALTY_CHIPS,
    step: PENALTY_STAKE_STEP,
  }
}

function idempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key.length < 8 || key.length > 160) throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  return key
}

function clientSeedOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return PENALTY_CLIENT_SEED
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

function zoneKeyOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, 'validation', { fields: { zoneKey: 'empty' } })
  return value.trim()
}

type ZonePatch = { zoneKey: string; label: string; multiplier: number; winChance: number; isActive: boolean }

function parseZones(value: unknown): ZonePatch[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, 'validation', { fields: { zones: 'empty' } })
  return value.map((row) => {
    if (!row || typeof row !== 'object') throw new ApiError(400, 'validation', { fields: { zones: 'invalid' } })
    const zone = row as Record<string, unknown>
    const zoneKey = typeof zone.zoneKey === 'string' ? zone.zoneKey.trim() : ''
    const label = typeof zone.label === 'string' ? zone.label.trim() : ''
    if (!zoneKey || label.length < 1 || label.length > 40) {
      throw new ApiError(400, 'validation', { fields: { zones: 'invalid' } })
    }
    const multiplier = zone.multiplier
    const winChance = zone.winChance
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 1000) {
      throw new ApiError(400, 'validation', { fields: { multiplier: 'range' } })
    }
    if (typeof winChance !== 'number' || !Number.isFinite(winChance) || winChance < 0 || winChance > 0.95) {
      throw new ApiError(400, 'validation', { fields: { winChance: 'range' } })
    }
    if (typeof zone.isActive !== 'boolean') throw new ApiError(400, 'validation', { fields: { isActive: 'invalid' } })
    return {
      zoneKey,
      label,
      multiplier: Math.round(multiplier * 100) / 100,
      winChance: Math.round(winChance * 10000) / 10000,
      isActive: zone.isActive,
    }
  })
}

async function balanceOf(client: PoolClient, userId: string) {
  const balance = await client.query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
  return balance.rows[0]?.balance_tzs ?? '0'
}

async function loadZones(client: { query: PoolClient['query'] }) {
  const zones = await client.query<ZoneRow>(
    `SELECT zone_key, label, multiplier, win_chance, display_order, is_active
       FROM penalty_zones
      ORDER BY display_order, zone_key`,
  )
  return zones.rows
}

export function registerPenaltyRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/penalty', async (req) => {
    const budget = await readCasinoBudget(getPool(cfg), 'penalty')
    const zones = (await loadZones(getPool(cfg))).filter((zone) => zone.is_active)
    const limits = publicLimits(budget.enabled)
    if (!req.auth) return { limits, zones: zones.map((zone) => mapZone(zone, false)), history: [] }
    const history = await getPool(cfg).query<ShotRow>(
      `SELECT ${SHOT_COLUMNS} FROM penalty_shots WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.auth.userId],
    )
    return { limits, zones: zones.map((zone) => mapZone(zone, false)), history: history.rows.map((row) => mapShot(row, false)) }
  })

  app.post('/api/penalty/shoot', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { zoneKey?: unknown; stakeTzs?: unknown; idempotencyKey?: unknown; clientSeed?: unknown }
    const limits = penaltySettings()
    if (!limits.penaltyEnabled) throw new ApiError(409, 'game_disabled')
    const zoneKey = zoneKeyOf(body.zoneKey)
    const stake = stakeOf(body.stakeTzs, limits.penaltyMinStake, limits.penaltyMaxStake)
    const key = idempotencyKey(body.idempotencyKey)
    const seed = clientSeedOf(body.clientSeed)
    try {
      const result = await withTx(cfg, async (client) => {
        const existing = await client.query<ShotRow>(
          `SELECT ${SHOT_COLUMNS} FROM penalty_shots WHERE client_ref = $1`,
          [key],
        )
        if (existing.rows[0]) {
          const owner = await client.query<{ user_id: string }>(`SELECT user_id FROM penalty_shots WHERE client_ref = $1`, [key])
          if (owner.rows[0].user_id !== req.auth!.userId) throw new ApiError(409, 'idempotency_conflict')
          return { duplicate: true, shot: existing.rows[0], balance: await balanceOf(client, req.auth!.userId) }
        }
        await lockCasinoBudget(client, 'penalty')
        const locked = await client.query<ZoneRow>(
          `SELECT zone_key, label, multiplier, win_chance, display_order, is_active
             FROM penalty_zones
            WHERE zone_key = $1
            FOR UPDATE`,
          [zoneKey],
        )
        const zone = locked.rows[0]
        if (!zone) throw new ApiError(400, 'validation', { fields: { zoneKey: 'unknown' } })
        if (!zone.is_active) throw new ApiError(400, 'validation', { fields: { zoneKey: 'inactive' } })
        const prior = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM penalty_shots WHERE user_id = $1`,
          [req.auth!.userId],
        )
        const nonce = prior.rows[0]?.n ?? 0
        const serverSeed = newServerSeed()
        const hash = penaltyHash(serverSeed, seed, nonce)
        const roll = nextUnit(hash, 0)
        const split = nextUnit(hash, 13)
        const pick = nextUnit(hash, 26)
        const winChance = Number(zone.win_chance)
        const multiplier = Number(zone.multiplier)
        const outcome = outcomeFromRolls(winChance, roll, split)
        const keeper = keeperFor(zone.zone_key, outcome, pick)
        const payout = outcome === 'goal' ? penaltyPayout(stake, multiplier, limits.penaltyMaxPayout) : 0
        const shotId = randomUUID()
        const debited = await client.query<{ result: { balance_tzs: string | number } }>(
          `SELECT wallet_debit($1, $2, 'bet_stake', $3, 'cash', 'penalty', $4, NULL, NULL) AS result`,
          [req.auth!.userId, stake, `penalty_stake:${key}`, shotId],
        )
        let balance: string | number = debited.rows[0].result.balance_tzs
        if (payout > 0) {
          const credited = await client.query<{ result: { balance_tzs: string | number } }>(
            `SELECT wallet_credit($1, $2, 'bet_win', $3, 'cash', 'penalty', $4, NULL, NULL) AS result`,
            [req.auth!.userId, payout, `penalty_payout:${shotId}`, shotId],
          )
          balance = credited.rows[0].result.balance_tzs
        }
        await addCasinoTurnover(client, 'penalty', stake, payout)
        const inserted = await client.query<ShotRow>(
          `INSERT INTO penalty_shots (
             id, user_id, stake_tzs, zone_key, keeper_zone, multiplier, win_chance, roll, outcome,
             payout_tzs, server_seed, hash, nonce, client_seed, client_ref
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING ${SHOT_COLUMNS}`,
          [shotId, req.auth!.userId, stake, zone.zone_key, keeper, multiplier, winChance, roll, outcome, payout, serverSeed, hash, nonce, seed, key],
        )
        return { duplicate: false, shot: inserted.rows[0], balance }
      })
      return { duplicate: result.duplicate, balanceTzs: money(result.balance), shot: mapShot(result.shot, false) }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/admin/penalty', async (req) => {
    requireAdmin(cfg, req, false)
    const shots = await getPool(cfg).query<ShotRow>(
      `SELECT s.id, u.phone, s.stake_tzs, s.zone_key, s.keeper_zone, s.multiplier, s.win_chance, s.roll,
              s.outcome, s.payout_tzs, s.server_seed, s.hash, s.nonce, s.client_seed, s.created_at
         FROM penalty_shots s
         JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC
        LIMIT 50`,
    )
    const pnl = await getPool(cfg).query<{ stakes: string; payouts: string; n: number; goals: number }>(
      `SELECT COALESCE(SUM(stake_tzs), 0)::text AS stakes,
              COALESCE(SUM(payout_tzs), 0)::text AS payouts,
              COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE outcome = 'goal')::int AS goals
         FROM penalty_shots`,
    )
    const row = pnl.rows[0]
    const stakes = money(row?.stakes ?? 0)
    const payouts = money(row?.payouts ?? 0)
    const budget = await readCasinoBudget(getPool(cfg), 'penalty')
    const zones = await loadZones(getPool(cfg))
    return {
      settings: penaltySettings(),
      budget: budgetView(budget),
      zones: zones.map((zone) => mapZone(zone, true)),
      pnl: {
        stakes,
        payouts,
        profit: stakes - payouts,
        shots: row?.n ?? 0,
        goals: row?.goals ?? 0,
        rtp: stakes > 0 ? payouts / stakes : 0,
      },
      shots: shots.rows.map((shot) => mapShot(shot, true)),
    }
  })

  app.patch('/api/admin/penalty/budget', async (req) => {
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
      const before = await lockCasinoBudget(client, 'penalty')
      const after = await saveCasinoBudget(client, 'penalty', next)
      return { before: budgetView(before), after: budgetView(after) }
    })
    await audit(cfg, req, 'admin.penalty.budget', saved)
    return saved.after
  })

  app.patch('/api/admin/penalty/settings', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as Record<string, unknown>
    const before = penaltySettings()
    const next = { ...operatorConfig }
    for (const key of ['penaltyMinStake', 'penaltyMaxStake', 'penaltyMaxPayout'] as const) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    if (body.penaltyEnabled !== undefined) {
      if (typeof body.penaltyEnabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { penaltyEnabled: 'invalid' } })
      next.penaltyEnabled = body.penaltyEnabled
    }
    assertPenaltyRanges(next)
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.penalty.settings', { before, after: penaltySettings() })
    return penaltySettings()
  })

  app.patch('/api/admin/penalty/zones', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as { zones?: unknown }
    const zones = parseZones(body.zones)
    const saved = await withTx(cfg, async (client) => {
      const before = await client.query<ZoneRow>(
        `SELECT zone_key, label, multiplier, win_chance, display_order, is_active
           FROM penalty_zones
          ORDER BY display_order
          FOR UPDATE`,
      )
      const known = new Map(before.rows.map((row) => [row.zone_key, row.is_active]))
      for (const zone of zones) {
        if (!known.has(zone.zoneKey)) throw new ApiError(400, 'validation', { fields: { zoneKey: 'unknown' } })
        known.set(zone.zoneKey, zone.isActive)
      }
      if (![...known.values()].some(Boolean)) throw new ApiError(400, 'validation', { fields: { zones: 'inactive' } })
      for (const zone of zones) {
        await client.query(
          `UPDATE penalty_zones
              SET label = $2, multiplier = $3, win_chance = $4, is_active = $5
            WHERE zone_key = $1`,
          [zone.zoneKey, zone.label, zone.multiplier, zone.winChance, zone.isActive],
        )
      }
      const after = await loadZones(client)
      return {
        before: before.rows.map((row) => mapZone(row, true)),
        after: after.map((row) => mapZone(row, true)),
      }
    })
    await audit(cfg, req, 'admin.penalty.zones', saved)
    return { zones: saved.after }
  })
}
