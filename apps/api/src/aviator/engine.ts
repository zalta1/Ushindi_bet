import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { operatorConfig } from '../operator-config.js'
import { AVIATOR_CLIENT_SEED, crashHash, crashPointFromHash, sha256 } from './fairness.js'

export const AVIATOR_LOCK_KEY = 842164221

type TickValue = { action: string, roundId?: string }

export type TickResult = { skipped: true, reason: 'locked' } | { skipped: false, action: string, roundId?: string }

let timer: NodeJS.Timeout | null = null

async function withLock<T>(cfg: AppConfig, fn: (client: PoolClient) => Promise<T>): Promise<{ skipped: true, reason: 'locked' } | { skipped: false, value: T }> {
  const client = await getPool(cfg).connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [AVIATOR_LOCK_KEY])
    if (!locked.rows[0]?.ok) {
      await client.query('ROLLBACK')
      return { skipped: true, reason: 'locked' }
    }
    const value = await fn(client)
    await client.query('COMMIT')
    return { skipped: false, value }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

async function ensureState(client: PoolClient) {
  await client.query(
    `INSERT INTO aviator_state (id, phase, round_id, phase_started_at)
     VALUES (1, 'idle', NULL, '2000-01-01')
     ON CONFLICT (id) DO NOTHING`,
  )
}

async function openRound(client: PoolClient): Promise<string> {
  const serverSeed = randomBytes(32).toString('hex')
  const serverSeedHash = sha256(serverSeed)
  const nonceRow = await client.query<{ n: string }>(`SELECT nextval('aviator_round_no_seq') AS n`)
  const nonce = Number(nonceRow.rows[0].n)
  const hash = crashHash(serverSeed, AVIATOR_CLIENT_SEED, nonce)
  // The budget switch is stored on the round and is not an input to this formula.
  const crash = crashPointFromHash(hash, operatorConfig.aviatorRtpBps / 100, operatorConfig.aviatorMaxMultiplier)
  const bettingMs = operatorConfig.aviatorBettingMs
  const budget = await client.query<{ enabled: boolean }>(`SELECT enabled FROM aviator_budget WHERE id`)
  const budgetEnabled = Boolean(budget.rows[0]?.enabled)
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO aviator_rounds (
       round_no, status, server_seed, server_seed_hash, client_seed, nonce, crash_hash,
       crash_point, rtp_bps, max_multiplier, max_win_tzs, betting_ms, betting_ends_at,
       min_stake_tzs, max_stake_tzs, crashed_ms, budget_enabled
     ) VALUES (
       $1, 'betting', $2, $3, $4, $1, $5,
       $6, $7, $8, $9, $10, clock_timestamp() + make_interval(secs => $11::double precision / 1000.0),
       $12, $13, $14, $15
     ) RETURNING id`,
    [
      nonce,
      serverSeed,
      serverSeedHash,
      AVIATOR_CLIENT_SEED,
      hash,
      crash,
      operatorConfig.aviatorRtpBps,
      operatorConfig.aviatorMaxMultiplier,
      operatorConfig.aviatorMaxWin,
      bettingMs,
      bettingMs,
      operatorConfig.aviatorMinStake,
      operatorConfig.aviatorMaxStake,
      operatorConfig.aviatorCrashedMs,
      budgetEnabled,
    ],
  )
  const id = inserted.rows[0].id
  await client.query(
    `UPDATE aviator_state
        SET phase = 'betting', round_id = $1, phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = 1`,
    [id],
  )
  return id
}

async function finishFlight(client: PoolClient, roundId: string): Promise<'flying' | 'crashed'> {
  const round = await client.query<{ crash_point: string, live_m: string }>(
    `SELECT crash_point,
            aviator_multiplier(EXTRACT(EPOCH FROM (clock_timestamp() - flying_started_at))) AS live_m
       FROM aviator_rounds
      WHERE id = $1
      FOR UPDATE`,
    [roundId],
  )
  const row = round.rows[0]
  if (!row) return 'flying'
  await client.query(`SELECT aviator_auto_cashout($1)`, [roundId])
  if (Number(row.live_m) >= Number(row.crash_point)) {
    await client.query(
      `UPDATE aviator_bets
          SET status = 'lost', settled_at = clock_timestamp()
        WHERE round_id = $1 AND status = 'active'`,
      [roundId],
    )
    await client.query(
      `UPDATE aviator_rounds SET status = 'crashed', crashed_at = clock_timestamp() WHERE id = $1`,
      [roundId],
    )
    await client.query(
      `UPDATE aviator_state
          SET phase = 'crashed', phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = 1`,
    )
    return 'crashed'
  }
  return 'flying'
}

async function advance(client: PoolClient): Promise<TickValue> {
  await ensureState(client)
  const state = await client.query<{
    phase: string
    round_id: string | null
    phase_started_at: Date
    clock: Date
  }>(
    `SELECT phase, round_id, phase_started_at, clock_timestamp() AS clock
       FROM aviator_state
      WHERE id = 1
      FOR UPDATE`,
  )
  const row = state.rows[0]
  const phase = row?.phase ?? 'idle'
  const roundId = row?.round_id ?? null
  const enabled = operatorConfig.aviatorEnabled
  const elapsed = row ? new Date(row.clock).getTime() - new Date(row.phase_started_at).getTime() : 0

  if (!enabled && phase === 'betting' && roundId) {
    await client.query(`SELECT refund_aviator_round($1)`, [roundId])
    return { action: 'aborted', roundId }
  }

  if (phase === 'idle') {
    if (!enabled) return { action: 'disabled' }
    const id = await openRound(client)
    return { action: 'betting', roundId: id }
  }

  if (phase === 'betting' && roundId) {
    const betting = await client.query<{ ended: boolean }>(
      `SELECT betting_ends_at <= clock_timestamp() AS ended
         FROM aviator_rounds WHERE id = $1 FOR UPDATE`,
      [roundId],
    )
    if (!betting.rows[0]?.ended) return { action: 'betting', roundId }
    await client.query(
      `UPDATE aviator_rounds
          SET status = 'flying', flying_started_at = clock_timestamp()
        WHERE id = $1`,
      [roundId],
    )
    await client.query(
      `UPDATE aviator_state
          SET phase = 'flying', phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = 1`,
    )
    const next = await finishFlight(client, roundId)
    return { action: next, roundId }
  }

  if (phase === 'flying' && roundId) {
    const next = await finishFlight(client, roundId)
    return { action: next, roundId }
  }

  if (phase === 'crashed') {
    let waitMs = operatorConfig.aviatorCrashedMs
    if (roundId) {
      const timing = await client.query<{ crashed_ms: number }>(
        `SELECT crashed_ms FROM aviator_rounds WHERE id = $1`,
        [roundId],
      )
      if (timing.rows[0]) waitMs = timing.rows[0].crashed_ms
    }
    if (elapsed < waitMs) return { action: 'crashed', roundId: roundId ?? undefined }
    if (!enabled) {
      await client.query(
        `UPDATE aviator_state
            SET phase = 'idle', round_id = NULL, phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = 1`,
      )
      return { action: 'disabled' }
    }
    const id = await openRound(client)
    return { action: 'betting', roundId: id }
  }

  if (!enabled) return { action: 'disabled' }
  const id = await openRound(client)
  return { action: 'betting', roundId: id }
}

export async function tickAviator(cfg: AppConfig): Promise<TickResult> {
  const locked = await withLock(cfg, (client) => advance(client))
  if (locked.skipped) return { skipped: true, reason: 'locked' }
  return { skipped: false, ...locked.value }
}

/** Refund bets left on a betting or flying round after a restart or an abort. */
export async function recoverAviator(cfg: AppConfig): Promise<{ skipped: true, reason: 'locked' } | { skipped: false, refunded: number }> {
  const locked = await withLock(cfg, async (client) => {
    await ensureState(client)
    const open = await client.query<{ id: string }>(
      `SELECT id FROM aviator_rounds WHERE status IN ('betting', 'flying') ORDER BY round_no`,
    )
    let refunded = 0
    for (const row of open.rows) {
      const result = await client.query<{ result: { refunded?: number } }>(
        `SELECT refund_aviator_round($1) AS result`,
        [row.id],
      )
      refunded += Number(result.rows[0]?.result?.refunded ?? 0)
    }
    await client.query(
      `UPDATE aviator_state
          SET phase = 'idle', round_id = NULL, phase_started_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = 1`,
    )
    return refunded
  })
  if (locked.skipped) return { skipped: true, reason: 'locked' }
  return { skipped: false, refunded: locked.value }
}

export function startAviatorWorker(cfg: AppConfig): () => void {
  if (cfg.isTest || timer) return () => undefined
  void recoverAviator(cfg).catch((err: unknown) => {
    console.error('aviator recover failed', err instanceof Error ? err.message : err)
  })
  timer = setInterval(() => {
    void tickAviator(cfg).catch((err: unknown) => {
      console.error('aviator tick failed', err instanceof Error ? err.message : err)
    })
  }, 200)
  timer.unref()
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}
