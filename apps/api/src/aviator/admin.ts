import type { AppConfig } from '../config.js'
import { budgetView, readCasinoBudget } from '../casino/budget.js'
import { getPool } from '../db.js'
import { ApiError, money } from '../errors.js'
import { normalizeTzPhone } from '../identity.js'
import { operatorConfig } from '../operator-config.js'

const KINDS = new Set(['', 'round', 'bet', 'admin'])

function localPhone(phone: string): string {
  if (phone.startsWith('+255')) return `0${phone.slice(4)}`
  return phone
}

function revealed(status: string | null) {
  return status === 'crashed' || status === 'aborted'
}

export type AdminPlayer = {
  id: string
  userId: string
  phone: string
  panel: number
  stakeTzs: number
  autoCashout: number | null
  status: string
  multiplier: number | null
  payoutTzs: number
  suspended: boolean
}

export type RoundLimits = {
  id: string
  roundNo: number
  status: string
  serverSeedHash: string
  serverSeed: string | null
  crashHash: string | null
  crashPoint: number | null
  clientSeed: string
  nonce: number
  rtpBps: number
  maxMultiplier: number
  maxWinTzs: number
  minStakeTzs: number
  maxStakeTzs: number
  bettingMs: number
  crashedMs: number
  budgetEnabled: boolean
}

export type AdminFeed = {
  enabled: boolean
  phase: string
  multiplier: number
  countdownMs: number
  serverNow: string
  viewerCount: number
  round: RoundLimits | null
  players: AdminPlayer[]
}

type FeedRow = {
  phase: string
  clock: Date
  id: string | null
  round_no: string | null
  status: string | null
  server_seed: string | null
  server_seed_hash: string | null
  client_seed: string | null
  nonce: string | null
  crash_hash: string | null
  crash_point: string | null
  rtp_bps: number | null
  max_multiplier: string | null
  max_win_tzs: string | null
  min_stake_tzs: string | null
  max_stake_tzs: string | null
  betting_ms: number | null
  crashed_ms: number | null
  budget_enabled: boolean | null
  betting_ends_at: Date | null
  live_m: string | null
}

/** Current round for an admin. The server seed and crash stay hidden until the round ends. */
export async function adminFeed(cfg: AppConfig): Promise<AdminFeed> {
  const pool = getPool(cfg)
  const current = await pool.query<FeedRow>(
    `SELECT s.phase, clock_timestamp() AS clock, r.id, r.round_no, r.status, r.server_seed, r.server_seed_hash,
            r.client_seed, r.nonce, r.crash_hash, r.crash_point, r.rtp_bps, r.max_multiplier, r.max_win_tzs,
            r.min_stake_tzs, r.max_stake_tzs, r.betting_ms, r.crashed_ms, r.budget_enabled, r.betting_ends_at,
            CASE WHEN r.flying_started_at IS NOT NULL
              THEN aviator_multiplier(EXTRACT(EPOCH FROM (clock_timestamp() - r.flying_started_at)))
            END AS live_m
       FROM aviator_state s
       LEFT JOIN aviator_rounds r ON r.id = s.round_id
      WHERE s.id = 1`,
  )
  const row = current.rows[0]
  const phase = row?.phase ?? 'idle'
  const open = revealed(row?.status ?? null)
  let multiplier = 1
  if (phase === 'crashed' || row?.status === 'crashed') multiplier = Number(row?.crash_point ?? 1)
  else if (phase === 'flying' && row?.live_m != null) multiplier = Number(row.live_m)
  const ends = row?.betting_ends_at ? new Date(row.betting_ends_at).getTime() : 0
  const clock = row?.clock ? new Date(row.clock).getTime() : Date.now()
  const players = row?.id
    ? await pool.query<{
      id: string
      user_id: string
      phone: string
      panel: number
      stake_tzs: string
      auto_cashout_at: string | null
      status: string
      cashout_multiplier: string | null
      payout_tzs: string
      suspended: boolean
    }>(
      `SELECT b.id, u.id AS user_id, u.phone, b.panel, b.stake_tzs, b.auto_cashout_at, b.status,
              b.cashout_multiplier, b.payout_tzs, COALESCE(s.active, false) AS suspended
         FROM aviator_bets b
         JOIN users u ON u.id = b.user_id
         LEFT JOIN aviator_suspensions s ON s.user_id = u.id
        WHERE b.round_id = $1
        ORDER BY CASE WHEN b.status = 'active' THEN 0 WHEN b.status = 'cashed_out' THEN 1 ELSE 2 END,
                 b.created_at
        LIMIT 200`,
      [row.id],
    )
    : { rows: [] }
  const viewers = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT user_id)::text AS n FROM aviator_viewers WHERE last_ping >= now() - interval '30 seconds'`,
  )
  const round: RoundLimits | null = row?.id && row.round_no && row.status && row.server_seed_hash
    ? {
      id: row.id,
      roundNo: Number(row.round_no),
      status: row.status,
      serverSeedHash: row.server_seed_hash,
      serverSeed: open ? row.server_seed : null,
      crashHash: open ? row.crash_hash : null,
      crashPoint: open ? Number(row.crash_point) : null,
      clientSeed: row.client_seed ?? 'ushindi',
      nonce: Number(row.nonce ?? 0),
      rtpBps: row.rtp_bps ?? 0,
      maxMultiplier: Number(row.max_multiplier ?? 0),
      maxWinTzs: money(row.max_win_tzs ?? 0),
      minStakeTzs: money(row.min_stake_tzs ?? 0),
      maxStakeTzs: money(row.max_stake_tzs ?? 0),
      bettingMs: row.betting_ms ?? 0,
      crashedMs: row.crashed_ms ?? 0,
      budgetEnabled: Boolean(row.budget_enabled),
    }
    : null
  return {
    enabled: operatorConfig.aviatorEnabled,
    phase,
    multiplier,
    countdownMs: phase === 'betting' ? Math.max(0, ends - clock) : 0,
    serverNow: row?.clock ? new Date(row.clock).toISOString() : new Date().toISOString(),
    viewerCount: Number(viewers.rows[0]?.n ?? 0),
    round,
    players: players.rows.map((item) => ({
      id: item.id,
      userId: item.user_id,
      phone: localPhone(item.phone),
      panel: item.panel,
      stakeTzs: money(item.stake_tzs),
      autoCashout: item.auto_cashout_at == null ? null : Number(item.auto_cashout_at),
      status: item.status,
      multiplier: item.cashout_multiplier == null ? null : Number(item.cashout_multiplier),
      payoutTzs: money(item.payout_tzs),
      suspended: item.suspended,
    })),
  }
}

export type PlayerFlag = { code: string, detail: string }

export type PlayerReport = {
  userId: string
  phone: string
  suspended: boolean
  reason: string | null
  netPnlTzs: number
  stakesTzs: number
  payoutsTzs: number
  bets: number
  cashedOut: number
  lost: number
  refunded: number
  flags: PlayerFlag[]
  history: {
    id: string
    roundNo: number
    roundId: string
    stakeTzs: number
    payoutTzs: number
    status: string
    multiplier: number | null
    autoCashout: number | null
    crashPoint: number | null
    serverSeedHash: string
    createdAt: string
  }[]
}

export async function playerIdByPhone(cfg: AppConfig, phone: string): Promise<string> {
  const normalized = normalizeTzPhone(phone)
  if (!normalized) throw new ApiError(400, 'validation', { fields: { phone: 'invalid' } })
  const found = await getPool(cfg).query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [normalized])
  if (!found.rows[0]) throw new ApiError(404, 'not_found')
  return found.rows[0].id
}

export async function playerReport(cfg: AppConfig, userId: string): Promise<PlayerReport> {
  const pool = getPool(cfg)
  const user = await pool.query<{ id: string, phone: string, suspended: boolean, reason: string | null }>(
    `SELECT u.id, u.phone, COALESCE(s.active, false) AS suspended, s.reason
       FROM users u
       LEFT JOIN aviator_suspensions s ON s.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  )
  const person = user.rows[0]
  if (!person) throw new ApiError(404, 'not_found')
  const totals = await pool.query<{
    bets: number
    stakes: string
    payouts: string
    cashed: number
    lost: number
    refunded: number
    recent: number
    latest: string | null
    prior_n: number
    median_prior: string | null
    near_crash: number
  }>(
    `WITH mine AS (
       SELECT stake_tzs, created_at,
              row_number() OVER (ORDER BY created_at DESC) AS rn
         FROM aviator_bets
        WHERE user_id = $1 AND status <> 'refunded'
     )
     SELECT
       (SELECT count(*) FROM mine)::int AS bets,
       COALESCE((SELECT SUM(stake_tzs) FROM mine), 0)::text AS stakes,
       COALESCE((SELECT SUM(payout_tzs) FROM aviator_bets WHERE user_id = $1 AND status = 'cashed_out'), 0)::text AS payouts,
       (SELECT count(*) FROM aviator_bets WHERE user_id = $1 AND status = 'cashed_out')::int AS cashed,
       (SELECT count(*) FROM aviator_bets WHERE user_id = $1 AND status = 'lost')::int AS lost,
       (SELECT count(*) FROM aviator_bets WHERE user_id = $1 AND status = 'refunded')::int AS refunded,
       (SELECT count(*) FROM aviator_bets WHERE user_id = $1 AND status <> 'refunded' AND created_at >= now() - interval '10 minutes')::int AS recent,
       (SELECT stake_tzs FROM mine WHERE rn = 1)::text AS latest,
       (SELECT count(*) FROM mine WHERE rn > 1)::int AS prior_n,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY stake_tzs) FROM mine WHERE rn > 1)::text AS median_prior,
       (SELECT count(*)::int FROM aviator_bets b
          JOIN aviator_rounds r ON r.id = b.round_id
         WHERE b.user_id = $1
           AND b.status = 'cashed_out'
           AND r.status = 'crashed'
           AND b.cashout_multiplier IS NOT NULL
           AND b.cashout_multiplier < r.crash_point
           AND r.crash_point - b.cashout_multiplier <= 0.10) AS near_crash`,
    [userId],
  )
  const line = totals.rows[0]
  const stakes = money(line?.stakes)
  const payouts = money(line?.payouts)
  const cashed = line?.cashed ?? 0
  const lost = line?.lost ?? 0
  const settled = cashed + lost
  const flags: PlayerFlag[] = []
  if (person.suspended) flags.push({ code: 'suspended', detail: 'Amezuiliwa kucheza Aviator.' })
  if (settled >= 20 && cashed / settled >= 0.7) {
    flags.push({
      code: 'high_cashout_rate',
      detail: `Ame-cash out ${cashed} kati ya dau ${settled} zilizokwisha (zaidi ya 70%).`,
    })
  }
  const near = line?.near_crash ?? 0
  if (near >= 3) {
    flags.push({
      code: 'cashout_near_crash',
      detail: `Cash out ndani ya 0.10x ya crash mara ${near}.`,
    })
  }
  const median = line?.median_prior == null ? 0 : Number(line.median_prior)
  const latest = line?.latest == null ? 0 : Number(line.latest)
  if ((line?.prior_n ?? 0) >= 10 && median > 0 && latest >= median * 5) {
    flags.push({
      code: 'stake_spike',
      detail: `Dau la mwisho ${Math.round(latest)} ni angalau mara 5 ya dau za awali (wastani ${Math.round(median)}).`,
    })
  }
  const recent = line?.recent ?? 0
  if (recent >= 8) {
    flags.push({
      code: 'burst',
      detail: `Dau ${recent} ndani ya dakika 10.`,
    })
  }
  const history = await pool.query<{
    id: string
    round_id: string
    round_no: string
    stake_tzs: string
    payout_tzs: string
    status: string
    cashout_multiplier: string | null
    auto_cashout_at: string | null
    crash_point: string | null
    round_status: string
    server_seed_hash: string
    created_at: Date
  }>(
    `SELECT b.id, b.round_id, r.round_no, b.stake_tzs, b.payout_tzs, b.status, b.cashout_multiplier,
            b.auto_cashout_at, r.status AS round_status, r.server_seed_hash, b.created_at,
            CASE WHEN r.status IN ('crashed', 'aborted') THEN r.crash_point ELSE NULL END AS crash_point
       FROM aviator_bets b
       JOIN aviator_rounds r ON r.id = b.round_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
      LIMIT 100`,
    [userId],
  )
  return {
    userId: person.id,
    phone: localPhone(person.phone),
    suspended: person.suspended,
    reason: person.reason,
    netPnlTzs: payouts - stakes,
    stakesTzs: stakes,
    payoutsTzs: payouts,
    bets: line?.bets ?? 0,
    cashedOut: cashed,
    lost,
    refunded: line?.refunded ?? 0,
    flags,
    history: history.rows.map((item) => ({
      id: item.id,
      roundNo: Number(item.round_no),
      roundId: item.round_id,
      stakeTzs: money(item.stake_tzs),
      payoutTzs: money(item.payout_tzs),
      status: item.status,
      multiplier: item.cashout_multiplier == null ? null : Number(item.cashout_multiplier),
      autoCashout: item.auto_cashout_at == null ? null : Number(item.auto_cashout_at),
      crashPoint: item.crash_point == null ? null : Number(item.crash_point),
      serverSeedHash: item.server_seed_hash,
      createdAt: new Date(item.created_at).toISOString(),
    })),
  }
}

export async function writeSuspension(
  cfg: AppConfig,
  userId: string,
  active: boolean,
  reason: string,
  actorId: string,
) {
  const pool = getPool(cfg)
  const user = await pool.query(`SELECT id FROM users WHERE id = $1`, [userId])
  if (!user.rowCount) throw new ApiError(404, 'not_found')
  if (active) {
    await pool.query(
      `INSERT INTO aviator_suspensions (user_id, active, reason, created_by, updated_at)
       VALUES ($1, true, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE
         SET active = true, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, updated_at = now()`,
      [userId, reason, actorId],
    )
    return { userId, suspended: true, reason }
  }
  await pool.query(
    `INSERT INTO aviator_suspensions (user_id, active, reason, created_by)
     VALUES ($1, false, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET active = false, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, updated_at = now()`,
    [userId, reason, actorId],
  )
  return { userId, suspended: false, reason }
}

export type ActivityRow = {
  kind: string
  at: string
  roundNo: number | null
  status: string | null
  crashPoint: number | null
  serverSeedHash: string | null
  serverSeed: string | null
  phone: string | null
  stakeTzs: number | null
  payoutTzs: number | null
  multiplier: number | null
  action: string | null
  actor: string | null
  detail: string | null
  summary: string
}

function numOrNull(value: string | null): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export async function activityRows(cfg: AppConfig, input: { q: string, kind: string, limit: number }): Promise<ActivityRow[]> {
  if (!KINDS.has(input.kind)) throw new ApiError(400, 'validation', { fields: { kind: 'invalid' } })
  const q = input.q.trim().slice(0, 80)
  const phone = normalizeTzPhone(q) ?? ''
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
  const { rows } = await getPool(cfg).query<{
    kind: string
    at: Date
    round_no: string | null
    status: string | null
    crash_point: string | null
    server_seed_hash: string | null
    server_seed: string | null
    phone: string | null
    stake_tzs: string | null
    payout_tzs: string | null
    multiplier: string | null
    action: string | null
    actor: string | null
    detail: string | null
  }>(
    `WITH rows AS (
       SELECT 'round'::text AS kind, r.created_at AS at, r.round_no::text AS round_no, r.status,
              CASE WHEN r.status IN ('crashed', 'aborted') THEN r.crash_point::text ELSE NULL END AS crash_point,
              r.server_seed_hash,
              CASE WHEN r.status IN ('crashed', 'aborted') THEN r.server_seed ELSE NULL END AS server_seed,
              NULL::text AS phone, NULL::text AS stake_tzs, NULL::text AS payout_tzs, NULL::text AS multiplier,
              NULL::text AS action, NULL::text AS actor,
              ('rtp=' || r.rtp_bps::text || ' max=' || r.max_multiplier::text) AS detail
         FROM aviator_rounds r
       UNION ALL
       SELECT 'bet', b.created_at, r.round_no::text, b.status,
              CASE WHEN r.status IN ('crashed', 'aborted') THEN r.crash_point::text ELSE NULL END,
              r.server_seed_hash,
              CASE WHEN r.status IN ('crashed', 'aborted') THEN r.server_seed ELSE NULL END,
              u.phone, b.stake_tzs::text, b.payout_tzs::text, b.cashout_multiplier::text,
              NULL, NULL,
              CASE WHEN b.auto_cashout_at IS NULL THEN NULL ELSE 'auto=' || b.auto_cashout_at::text END
         FROM aviator_bets b
         JOIN aviator_rounds r ON r.id = b.round_id
         JOIN users u ON u.id = b.user_id
       UNION ALL
       SELECT 'admin', a.created_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              a.action, a.actor, a.payload::text
         FROM audit_log a
        WHERE a.action LIKE 'admin.aviator.%'
     )
     SELECT * FROM rows
      WHERE ($2 = '' OR kind = $2)
        AND (
          $1 = ''
          OR COALESCE(round_no, '') = $1
          OR ($4 <> '' AND phone = $4)
          OR COALESCE(phone, '') ILIKE $3 ESCAPE '\\'
          OR COALESCE(action, '') ILIKE $3 ESCAPE '\\'
          OR COALESCE(actor, '') ILIKE $3 ESCAPE '\\'
          OR COALESCE(server_seed_hash, '') ILIKE $3 ESCAPE '\\'
          OR COALESCE(status, '') ILIKE $3 ESCAPE '\\'
        )
      ORDER BY at DESC
      LIMIT $5`,
    [q, input.kind, like, phone, input.limit],
  )
  return rows.map((row) => {
    const crashPoint = numOrNull(row.crash_point)
    const phoneText = row.phone ? localPhone(row.phone) : null
    const actor = row.actor ? localPhone(row.actor) : null
    const stake = row.stake_tzs == null ? null : money(row.stake_tzs)
    const payout = row.payout_tzs == null ? null : money(row.payout_tzs)
    let summary = row.kind
    if (row.kind === 'round') {
      summary = `Raundi #${row.round_no} ${row.status ?? ''}`
      summary += crashPoint == null ? ' (crash bado imefichwa)' : ` ${crashPoint.toFixed(2)}x`
    } else if (row.kind === 'bet') {
      summary = `${phoneText ?? ''} raundi #${row.round_no} dau ${stake ?? 0} malipo ${payout ?? 0} ${row.status ?? ''}`
    } else {
      summary = `${row.action ?? 'admin'} · ${actor ?? ''}`
    }
    return {
      kind: row.kind,
      at: new Date(row.at).toISOString(),
      roundNo: row.round_no == null ? null : Number(row.round_no),
      status: row.status,
      crashPoint,
      serverSeedHash: row.server_seed_hash,
      serverSeed: row.server_seed,
      phone: phoneText,
      stakeTzs: stake,
      payoutTzs: payout,
      multiplier: numOrNull(row.multiplier),
      action: row.action,
      actor,
      detail: row.detail,
      summary: summary.trim(),
    }
  })
}

const CSV_COLUMNS = [
  'kind', 'at', 'roundNo', 'status', 'crashPoint', 'serverSeedHash', 'serverSeed',
  'phone', 'stakeTzs', 'payoutTzs', 'multiplier', 'action', 'actor', 'detail', 'summary',
] as const

function csvCell(value: unknown): string {
  if (value == null) return ''
  const text = String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function activityCsv(rows: ActivityRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((key) => csvCell(row[key])).join(','))
  }
  return `${lines.join('\n')}\n`
}

export async function aviatorBudgetView(cfg: AppConfig) {
  return budgetView(await readCasinoBudget(getPool(cfg), 'aviator'))
}
