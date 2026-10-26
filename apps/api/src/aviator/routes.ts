import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'
import { saveOperatorSettings } from '../admin/settings-store.js'
import { isAdminRole } from '../admin/roles.js'
import { budgetView, lockCasinoBudget, saveCasinoBudget } from '../casino/budget.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { operatorConfig } from '../operator-config.js'
import { activityCsv, activityRows, adminFeed, aviatorBudgetView, playerIdByPhone, playerReport, writeSuspension } from './admin.js'
import { AVIATOR_CLIENT_SEED, avatarColor, crashHash, crashPointFromHash, initials, maskPhone, sha256 } from './fairness.js'
import { assertAviatorRanges, aviatorSettings } from './settings.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type RoundRow = {
  id: string
  round_no: string
  status: string
  server_seed: string
  server_seed_hash: string
  client_seed: string
  nonce: string
  crash_hash: string
  crash_point: string
  rtp_bps: number
  max_multiplier: string
  max_win_tzs: string
  betting_ends_at: Date
  flying_started_at: Date | null
  crashed_at: Date | null
  live_m: string | null
}

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('invalid_stake')) return new ApiError(400, 'validation', { fields: { stakeTzs: 'range' } })
  if (message.includes('invalid_auto')) return new ApiError(400, 'validation', { fields: { autoCashout: 'range' } })
  if (message.includes('invalid_panel')) return new ApiError(400, 'validation', { fields: { panel: 'invalid' } })
  if (message.includes('already_placed')) return new ApiError(409, 'already_placed')
  if (message.includes('betting_closed')) return new ApiError(409, 'betting_closed')
  if (message.includes('game_disabled')) return new ApiError(403, 'game_disabled')
  if (message.includes('aviator_suspended')) return new ApiError(403, 'aviator_suspended')
  if (message.includes('bet_not_found')) return new ApiError(404, 'not_found')
  if (message.includes('bet_closed')) return new ApiError(409, 'bet_closed')
  if (message.includes('too_early')) return new ApiError(409, 'too_early')
  if (message.includes('not_flying')) return new ApiError(409, 'not_flying')
  if (message.includes('crashed')) return new ApiError(409, 'crashed')
  if (message.includes('muted')) return new ApiError(403, 'muted')
  if (message.includes('chat_rate')) return new ApiError(429, 'chat_rate')
  return null
}

function revealed(status: string) {
  return status === 'crashed' || status === 'aborted'
}

function roundView(row: RoundRow, showSecret: boolean) {
  const open = showSecret && revealed(row.status)
  return {
    id: row.id,
    roundNo: Number(row.round_no),
    status: row.status,
    serverSeedHash: row.server_seed_hash,
    serverSeed: open ? row.server_seed : null,
    clientSeed: row.client_seed,
    nonce: Number(row.nonce),
    crashHash: open ? row.crash_hash : null,
    crashPoint: open ? Number(row.crash_point) : null,
    rtpBps: row.rtp_bps,
    maxMultiplier: Number(row.max_multiplier),
    maxWinTzs: money(row.max_win_tzs),
    bettingEndsAt: row.betting_ends_at,
    flyingStartedAt: row.flying_started_at,
    crashedAt: row.crashed_at,
  }
}

function liveMultiplier(row: RoundRow | undefined, phase: string): number {
  if (!row) return 1
  if (phase === 'crashed' || row.status === 'crashed') return Number(row.crash_point)
  if (phase === 'flying' && row.live_m != null) return Number(row.live_m)
  return 1
}

async function audit(cfg: AppConfig, req: FastifyRequest, action: string, payload: unknown) {
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [req.auth?.userId ?? null, req.auth?.phone ?? 'system', action, JSON.stringify(payload)],
  )
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

type PublicSnap = {
  enabled: boolean
  phase: string
  multiplier: number
  countdownMs: number
  serverNow: string
  round: ReturnType<typeof roundView> | null
  history: { id: string, roundNo: number, crashPoint: number }[]
  liveBets: LiveBet[]
  winners: LiveBet[]
  chat: ChatLine[]
  viewerCount: number
  limits: ReturnType<typeof aviatorSettings>
}

type LiveBet = {
  id: string
  panel: number
  stakeTzs: number
  payoutTzs: number
  status: string
  multiplier: number | null
  autoCashout: number | null
  phone: string
  initials: string
  color: string
  userId?: string
}

type ChatLine = {
  id: string
  body: string
  createdAt: string
  deleted: boolean
  phone: string
  initials: string
  color: string
  userId?: string
}

function betLine(row: {
  id: string
  panel: number
  stake_tzs: string
  payout_tzs: string
  status: string
  cashout_multiplier: string | null
  auto_cashout_at: string | null
  phone: string
  user_id: string
}, includeUser: boolean): LiveBet {
  return {
    id: row.id,
    panel: row.panel,
    stakeTzs: money(row.stake_tzs),
    payoutTzs: money(row.payout_tzs),
    status: row.status,
    multiplier: row.cashout_multiplier == null ? null : Number(row.cashout_multiplier),
    autoCashout: row.auto_cashout_at == null ? null : Number(row.auto_cashout_at),
    phone: maskPhone(row.phone),
    initials: initials(row.phone),
    color: avatarColor(row.user_id),
    ...(includeUser ? { userId: row.user_id } : {}),
  }
}

async function loadPublic(cfg: AppConfig): Promise<PublicSnap> {
  const pool = getPool(cfg)
  const current = await pool.query<RoundRow & { phase: string, clock: Date }>(
    `SELECT s.phase, clock_timestamp() AS clock, r.id, r.round_no, r.status, r.server_seed, r.server_seed_hash,
            r.client_seed, r.nonce, r.crash_hash, r.crash_point, r.rtp_bps, r.max_multiplier, r.max_win_tzs,
            r.betting_ends_at, r.flying_started_at, r.crashed_at,
            CASE WHEN r.flying_started_at IS NOT NULL
              THEN aviator_multiplier(EXTRACT(EPOCH FROM (clock_timestamp() - r.flying_started_at)))
            END AS live_m
       FROM aviator_state s
       LEFT JOIN aviator_rounds r ON r.id = s.round_id
      WHERE s.id = 1`,
  )
  const row = current.rows[0]
  const phase = row?.phase ?? 'idle'
  const round = row?.id ? roundView(row, true) : null
  const history = await pool.query<{ id: string, round_no: string, crash_point: string }>(
    `SELECT id, round_no, crash_point
       FROM aviator_rounds
      WHERE status = 'crashed'
      ORDER BY round_no DESC
      LIMIT 25`,
  )
  const live = row?.id
    ? await pool.query(
      `SELECT b.id, b.panel, b.stake_tzs, b.payout_tzs, b.status, b.cashout_multiplier, b.auto_cashout_at,
              u.phone, u.id AS user_id
         FROM aviator_bets b
         JOIN users u ON u.id = b.user_id
        WHERE b.round_id = $1
        ORDER BY b.created_at ASC
        LIMIT 40`,
      [row.id],
    )
    : { rows: [] }
  const winners = await pool.query(
    `SELECT b.id, b.panel, b.stake_tzs, b.payout_tzs, b.status, b.cashout_multiplier, b.auto_cashout_at,
            u.phone, u.id AS user_id
       FROM aviator_bets b
       JOIN users u ON u.id = b.user_id
      WHERE b.status = 'cashed_out' AND b.settled_at >= now() - interval '24 hours'
      ORDER BY b.payout_tzs DESC, b.settled_at DESC
      LIMIT 10`,
  )
  const chat = await pool.query(
    `SELECT c.id, c.body, c.created_at, c.deleted_at, u.phone, u.id AS user_id
       FROM aviator_chat c
       JOIN users u ON u.id = c.user_id
      WHERE c.deleted_at IS NULL
      ORDER BY c.created_at DESC
      LIMIT 40`,
  )
  const viewers = await pool.query<{ n: string }>(
    `SELECT count(DISTINCT user_id)::text AS n FROM aviator_viewers WHERE last_ping >= now() - interval '30 seconds'`,
  )
  const ends = row?.betting_ends_at ? new Date(row.betting_ends_at).getTime() : 0
  const clock = row?.clock ? new Date(row.clock).getTime() : Date.now()
  return {
    enabled: operatorConfig.aviatorEnabled,
    phase,
    multiplier: liveMultiplier(row, phase),
    countdownMs: phase === 'betting' ? Math.max(0, ends - clock) : 0,
    serverNow: row?.clock ? new Date(row.clock).toISOString() : new Date().toISOString(),
    round,
    history: history.rows.map((item) => ({
      id: item.id,
      roundNo: Number(item.round_no),
      crashPoint: Number(item.crash_point),
    })),
    liveBets: live.rows.map((item) => betLine(item, false)),
    winners: winners.rows.map((item) => betLine(item, false)),
    chat: chat.rows.reverse().map((item) => ({
      id: item.id,
      body: item.body,
      createdAt: new Date(item.created_at).toISOString(),
      deleted: false,
      phone: maskPhone(item.phone),
      initials: initials(item.phone),
      color: avatarColor(item.user_id),
    })),
    viewerCount: Number(viewers.rows[0]?.n ?? 0),
    limits: aviatorSettings(),
  }
}

async function myBets(cfg: AppConfig, userId: string, roundId: string | null) {
  if (!roundId) return []
  const { rows } = await getPool(cfg).query(
    `SELECT id, panel, stake_tzs, payout_tzs, status, cashout_multiplier, auto_cashout_at
       FROM aviator_bets
      WHERE user_id = $1 AND round_id = $2
      ORDER BY panel`,
    [userId, roundId],
  )
  return rows.map((row) => ({
    id: row.id as string,
    panel: row.panel as number,
    stakeTzs: money(row.stake_tzs),
    payoutTzs: money(row.payout_tzs),
    status: row.status as string,
    multiplier: row.cashout_multiplier == null ? null : Number(row.cashout_multiplier),
    autoCashout: row.auto_cashout_at == null ? null : Number(row.auto_cashout_at),
  }))
}

function stakeField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError(400, 'validation', { fields: { stakeTzs: 'invalid' } })
  }
  return value
}

function panelField(value: unknown): number {
  if (value !== 1 && value !== 2) throw new ApiError(400, 'validation', { fields: { panel: 'invalid' } })
  return value
}

function keyField(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  }
  return value
}

function autoField(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new ApiError(400, 'validation', { fields: { autoCashout: 'invalid' } })
  return Math.round(n * 100) / 100
}

export function registerAviatorRoutes(app: FastifyInstance, cfg: AppConfig) {
  app.get('/api/aviator/state', async (req) => {
    const snap = await loadPublic(cfg)
    const mine = req.auth ? await myBets(cfg, req.auth.userId, snap.round?.id ?? null) : []
    return { ...snap, myBets: mine }
  })

  app.get('/api/aviator/stream', async (req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let closed = false
    const userId = req.auth?.userId ?? null
    const push = async () => {
      if (closed) return
      try {
        const snap = await loadPublic(cfg)
        const mine = userId ? await myBets(cfg, userId, snap.round?.id ?? null) : []
        raw.write(`data: ${JSON.stringify({ ...snap, myBets: mine })}\n\n`)
      } catch {
        // The next tick retries. A closed socket is handled below.
      }
    }
    const timer = setInterval(() => { void push() }, 300)
    const stop = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      raw.end()
    }
    req.raw.on('close', stop)
    req.raw.on('error', stop)
    await push()
  })

  app.get('/api/aviator/rounds/:id', async (req) => {
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const { rows } = await getPool(cfg).query<RoundRow>(
      `SELECT id, round_no, status, server_seed, server_seed_hash, client_seed, nonce, crash_hash,
              crash_point, rtp_bps, max_multiplier, max_win_tzs, betting_ends_at, flying_started_at, crashed_at,
              NULL::numeric AS live_m
         FROM aviator_rounds WHERE id = $1`,
      [id],
    )
    if (!rows[0]) throw new ApiError(404, 'not_found')
    const view = roundView(rows[0], true)
    if (view.serverSeed && view.crashPoint != null) {
      const again = crashPointFromHash(crashHash(view.serverSeed, view.clientSeed, view.nonce), view.rtpBps / 100, view.maxMultiplier)
      return { ...view, verified: again.toFixed(2) === Number(view.crashPoint).toFixed(2), computedCrashPoint: again }
    }
    return { ...view, verified: null, computedCrashPoint: null }
  })

  app.post('/api/aviator/verify', async (req) => {
    const body = (req.body ?? {}) as {
      serverSeed?: unknown
      clientSeed?: unknown
      nonce?: unknown
      rtpBps?: unknown
      maxMultiplier?: unknown
    }
    if (typeof body.serverSeed !== 'string' || body.serverSeed.length < 8 || body.serverSeed.length > 128) {
      throw new ApiError(400, 'validation', { fields: { serverSeed: 'invalid' } })
    }
    const clientSeed = typeof body.clientSeed === 'string' && body.clientSeed.length > 0 && body.clientSeed.length <= 64
      ? body.clientSeed
      : AVIATOR_CLIENT_SEED
    const nonce = typeof body.nonce === 'number' ? body.nonce : Number(body.nonce)
    const rtpBps = typeof body.rtpBps === 'number' ? body.rtpBps : Number(body.rtpBps ?? 9600)
    const maxMultiplier = typeof body.maxMultiplier === 'number' ? body.maxMultiplier : Number(body.maxMultiplier ?? 1000)
    if (!Number.isInteger(nonce) || nonce < 0 || !Number.isInteger(rtpBps) || !Number.isFinite(maxMultiplier) || maxMultiplier < 1) {
      throw new ApiError(400, 'validation')
    }
    const hash = crashHash(body.serverSeed, clientSeed, nonce)
    return {
      serverSeedHash: sha256(body.serverSeed),
      clientSeed,
      nonce,
      crashHash: hash,
      rtpBps,
      maxMultiplier,
      crashPoint: crashPointFromHash(hash, rtpBps / 100, maxMultiplier),
    }
  })

  app.post('/api/aviator/bets', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { stakeTzs?: unknown, panel?: unknown, autoCashout?: unknown, idempotencyKey?: unknown }
    const stakeTzs = stakeField(body.stakeTzs)
    const panel = panelField(body.panel)
    const auto = autoField(body.autoCashout)
    const idempotencyKey = keyField(body.idempotencyKey)
    const current = await getPool(cfg).query<{ round_id: string | null, phase: string, min_stake_tzs: string | null, max_stake_tzs: string | null }>(
      `SELECT s.round_id, s.phase, r.min_stake_tzs, r.max_stake_tzs
         FROM aviator_state s
         LEFT JOIN aviator_rounds r ON r.id = s.round_id
        WHERE s.id = 1`,
    )
    const roundId = current.rows[0]?.round_id
    if (!roundId || current.rows[0]?.phase !== 'betting') throw new ApiError(409, 'betting_closed')
    // The SQL function uses the limits stored on the round. These arguments are not the live settings.
    const minStake = money(current.rows[0]?.min_stake_tzs ?? operatorConfig.aviatorMinStake)
    const maxStake = money(current.rows[0]?.max_stake_tzs ?? operatorConfig.aviatorMaxStake)
    try {
      const placed = await getPool(cfg).query<{ result: { idempotent: boolean, bet_id: string, balance_tzs: number, stake_tzs: number, panel: number } }>(
        `SELECT place_aviator_bet_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9) AS result`,
        [
          req.auth!.userId,
          roundId,
          panel,
          stakeTzs,
          auto,
          idempotencyKey,
          minStake,
          maxStake,
          operatorConfig.aviatorEnabled,
        ],
      )
      const result = placed.rows[0].result
      return {
        idempotent: result.idempotent,
        betId: result.bet_id,
        balanceTzs: money(result.balance_tzs),
        stakeTzs: money(result.stake_tzs),
        panel: result.panel,
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/aviator/cashout', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { betId?: unknown, multiplier?: unknown }
    if (body.multiplier !== undefined) throw new ApiError(400, 'validation', { fields: { multiplier: 'unexpected' } })
    if (typeof body.betId !== 'string' || !UUID.test(body.betId)) {
      throw new ApiError(400, 'validation', { fields: { betId: 'invalid' } })
    }
    try {
      const cashed = await getPool(cfg).query<{ result: { idempotent: boolean, bet_id: string, multiplier: number, payout_tzs: number, balance_tzs: number } }>(
        `SELECT cashout_aviator_bet_atomic($1, $2) AS result`,
        [req.auth!.userId, body.betId],
      )
      const result = cashed.rows[0].result
      return {
        idempotent: result.idempotent,
        betId: result.bet_id,
        multiplier: Number(result.multiplier),
        payoutTzs: money(result.payout_tzs),
        balanceTzs: money(result.balance_tzs),
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/aviator/chat', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { body?: unknown }
    if (typeof body.body !== 'string') throw new ApiError(400, 'validation', { fields: { body: 'required' } })
    const text = body.body.replace(/\s+/g, ' ').trim()
    if (text.length < 1 || text.length > 200) throw new ApiError(400, 'validation', { fields: { body: 'length' } })
    const pool = getPool(cfg)
    const muted = await pool.query(
      `SELECT 1 FROM aviator_mutes WHERE user_id = $1 AND until_at > now()`,
      [req.auth!.userId],
    )
    if (muted.rowCount) throw new ApiError(403, 'muted')
    const recent = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM aviator_chat WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.auth!.userId],
    )
    if (recent.rows[0] && Date.now() - new Date(recent.rows[0].created_at).getTime() < 3000) {
      throw new ApiError(429, 'chat_rate')
    }
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO aviator_chat (user_id, body) VALUES ($1, $2) RETURNING id`,
      [req.auth!.userId, text],
    )
    return { id: inserted.rows[0].id }
  })

  app.post('/api/aviator/viewers', async (req) => {
    requireWrite(cfg, req)
    const body = (req.body ?? {}) as { sessionId?: unknown }
    if (typeof body.sessionId !== 'string' || body.sessionId.length < 8 || body.sessionId.length > 80) {
      throw new ApiError(400, 'validation', { fields: { sessionId: 'invalid' } })
    }
    await getPool(cfg).query(
      `INSERT INTO aviator_viewers (user_id, session_id, last_ping)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id, session_id) DO UPDATE SET last_ping = now()`,
      [req.auth!.userId, body.sessionId],
    )
    await getPool(cfg).query(`DELETE FROM aviator_viewers WHERE last_ping < now() - interval '1 minute'`)
    return { ok: true }
  })

  app.get('/api/admin/aviator', async (req) => {
    requireAdmin(cfg, req, false)
    const feed = await adminFeed(cfg)
    const budget = await aviatorBudgetView(cfg)
    const pool = getPool(cfg)
    const rounds = await pool.query<RoundRow>(
      `SELECT id, round_no, status, server_seed, server_seed_hash, client_seed, nonce, crash_hash,
              crash_point, rtp_bps, max_multiplier, max_win_tzs, betting_ends_at, flying_started_at, crashed_at,
              NULL::numeric AS live_m
         FROM aviator_rounds
        ORDER BY round_no DESC
        LIMIT 40`,
    )
    const pnl = await pool.query<{
      day_stakes: string
      day_payouts: string
      day_bets: string
      all_stakes: string
      all_payouts: string
      all_bets: string
      rounds: string
    }>(
      `SELECT
         COALESCE(SUM(stake_tzs) FILTER (WHERE status <> 'refunded' AND created_at >= now() - interval '24 hours'), 0)::text AS day_stakes,
         COALESCE(SUM(payout_tzs) FILTER (WHERE status = 'cashed_out' AND created_at >= now() - interval '24 hours'), 0)::text AS day_payouts,
         count(*) FILTER (WHERE status <> 'refunded' AND created_at >= now() - interval '24 hours')::text AS day_bets,
         COALESCE(SUM(stake_tzs) FILTER (WHERE status <> 'refunded'), 0)::text AS all_stakes,
         COALESCE(SUM(payout_tzs) FILTER (WHERE status = 'cashed_out'), 0)::text AS all_payouts,
         count(*) FILTER (WHERE status <> 'refunded')::text AS all_bets,
         (SELECT count(*) FROM aviator_rounds)::text AS rounds
       FROM aviator_bets`,
    )
    const chat = await pool.query(
      `SELECT c.id, c.body, c.created_at, c.deleted_at, u.phone, u.id AS user_id
         FROM aviator_chat c
         JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC
        LIMIT 50`,
    )
    const line = pnl.rows[0]
    const dayStakes = money(line?.day_stakes)
    const dayPayouts = money(line?.day_payouts)
    const allStakes = money(line?.all_stakes)
    const allPayouts = money(line?.all_payouts)
    return {
      live: {
        enabled: feed.enabled,
        phase: feed.phase,
        multiplier: feed.multiplier,
        countdownMs: feed.countdownMs,
        round: feed.round,
        viewerCount: feed.viewerCount,
        openStakeTzs: feed.players.filter((bet) => bet.status === 'active').reduce((sum, bet) => sum + bet.stakeTzs, 0),
        betCount: feed.players.length,
        players: feed.players,
        roundLimits: feed.round,
      },
      settings: aviatorSettings(),
      budget,
      pnl: {
        dayStakes,
        dayPayouts,
        dayProfit: dayStakes - dayPayouts,
        dayBets: Number(line?.day_bets ?? 0),
        allStakes,
        allPayouts,
        allProfit: allStakes - allPayouts,
        allBets: Number(line?.all_bets ?? 0),
        rounds: Number(line?.rounds ?? 0),
      },
      rounds: rounds.rows.map((item) => roundView(item, true)),
      chat: chat.rows.map((item) => ({
        id: item.id as string,
        body: item.body as string,
        createdAt: new Date(item.created_at).toISOString(),
        deleted: item.deleted_at != null,
        phone: maskPhone(item.phone),
        initials: initials(item.phone),
        color: avatarColor(item.user_id),
        userId: item.user_id as string,
      })),
    }
  })

  app.get('/api/admin/aviator/rounds/:id', async (req) => {
    requireAdmin(cfg, req, false)
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const round = await getPool(cfg).query<RoundRow>(
      `SELECT id, round_no, status, server_seed, server_seed_hash, client_seed, nonce, crash_hash,
              crash_point, rtp_bps, max_multiplier, max_win_tzs, betting_ends_at, flying_started_at, crashed_at,
              NULL::numeric AS live_m
         FROM aviator_rounds WHERE id = $1`,
      [id],
    )
    if (!round.rows[0]) throw new ApiError(404, 'not_found')
    const bets = await getPool(cfg).query(
      `SELECT b.id, b.panel, b.stake_tzs, b.payout_tzs, b.status, b.cashout_multiplier, b.auto_cashout_at,
              u.phone, u.id AS user_id
         FROM aviator_bets b
         JOIN users u ON u.id = b.user_id
        WHERE b.round_id = $1
        ORDER BY b.created_at`,
      [id],
    )
    return {
      round: roundView(round.rows[0], true),
      bets: bets.rows.map((item) => betLine(item, true)),
    }
  })

  app.patch('/api/admin/aviator/settings', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as Record<string, unknown>
    for (const key of ['crashPoint', 'crash_point', 'serverSeed', 'server_seed', 'winners', 'userIds', 'pickWinners']) {
      if (body[key] !== undefined) throw new ApiError(400, 'validation', { fields: { [key]: 'forbidden' } })
    }
    const before = aviatorSettings()
    const next = { ...operatorConfig }
    const ints = [
      'aviatorRtpBps', 'aviatorMaxMultiplier', 'aviatorMinStake', 'aviatorMaxStake',
      'aviatorMaxWin', 'aviatorBettingMs', 'aviatorCrashedMs',
    ] as const
    for (const key of ints) {
      if (body[key] === undefined) continue
      const value = body[key]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new ApiError(400, 'validation', { fields: { [key]: 'invalid' } })
      }
      next[key] = value
    }
    if (body.aviatorEnabled !== undefined) {
      if (typeof body.aviatorEnabled !== 'boolean') {
        throw new ApiError(400, 'validation', { fields: { aviatorEnabled: 'invalid' } })
      }
      next.aviatorEnabled = body.aviatorEnabled
    }
    assertAviatorRanges(next)
    Object.assign(operatorConfig, next)
    try {
      await saveOperatorSettings(cfg, req.auth!.userId)
    } catch (err) {
      Object.assign(operatorConfig, before)
      throw err
    }
    await audit(cfg, req, 'admin.aviator.settings', { before, after: aviatorSettings() })
    return aviatorSettings()
  })

  app.post('/api/admin/aviator/chat/:id/delete', async (req) => {
    requireAdmin(cfg, req, true)
    const { id } = req.params as { id: string }
    if (!UUID.test(id)) throw new ApiError(400, 'validation')
    const updated = await getPool(cfg).query(
      `UPDATE aviator_chat SET deleted_at = COALESCE(deleted_at, now()), deleted_by = $2 WHERE id = $1 RETURNING id`,
      [id, req.auth!.userId],
    )
    if (!updated.rowCount) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'admin.aviator.chat_delete', { id })
    return { ok: true }
  })

  app.post('/api/admin/aviator/mutes', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as { userId?: unknown, minutes?: unknown, reason?: unknown }
    if (typeof body.userId !== 'string' || !UUID.test(body.userId)) {
      throw new ApiError(400, 'validation', { fields: { userId: 'invalid' } })
    }
    const minutes = body.minutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
      throw new ApiError(400, 'validation', { fields: { minutes: 'range' } })
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
    await getPool(cfg).query(
      `INSERT INTO aviator_mutes (user_id, until_at, reason, created_by)
       VALUES ($1, now() + make_interval(mins => $2), $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET until_at = EXCLUDED.until_at, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()`,
      [body.userId, minutes, reason, req.auth!.userId],
    )
    await audit(cfg, req, 'admin.aviator.mute', { userId: body.userId, minutes, reason })
    return { ok: true }
  })

  app.post('/api/admin/aviator/mutes/:userId/delete', async (req) => {
    requireAdmin(cfg, req, true)
    const { userId } = req.params as { userId: string }
    if (!UUID.test(userId)) throw new ApiError(400, 'validation')
    await getPool(cfg).query(`DELETE FROM aviator_mutes WHERE user_id = $1`, [userId])
    await audit(cfg, req, 'admin.aviator.unmute', { userId })
    return { ok: true }
  })

  app.get('/api/admin/aviator/stream', async (req, reply) => {
    requireAdmin(cfg, req, false)
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let closed = false
    const push = async () => {
      if (closed) return
      try {
        const feed = await adminFeed(cfg)
        raw.write(`data: ${JSON.stringify(feed)}\n\n`)
      } catch {
        // The next tick retries. A closed socket is handled below.
      }
    }
    const timer = setInterval(() => { void push() }, 300)
    const stop = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      raw.end()
    }
    req.raw.on('close', stop)
    req.raw.on('error', stop)
    await push()
  })

  app.get('/api/admin/aviator/players', async (req) => {
    requireAdmin(cfg, req, false)
    const phone = (req.query as { phone?: unknown }).phone
    if (typeof phone !== 'string' || !phone.trim()) throw new ApiError(400, 'validation', { fields: { phone: 'required' } })
    return playerReport(cfg, await playerIdByPhone(cfg, phone))
  })

  app.get('/api/admin/aviator/players/:userId', async (req) => {
    requireAdmin(cfg, req, false)
    const { userId } = req.params as { userId: string }
    if (!UUID.test(userId)) throw new ApiError(400, 'validation')
    return playerReport(cfg, userId)
  })

  app.post('/api/admin/aviator/players/:userId/suspend', async (req) => {
    requireAdmin(cfg, req, true)
    const { userId } = req.params as { userId: string }
    if (!UUID.test(userId)) throw new ApiError(400, 'validation')
    const body = (req.body ?? {}) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
    const saved = await writeSuspension(cfg, userId, true, reason, req.auth!.userId)
    await audit(cfg, req, 'admin.aviator.suspend', saved)
    return saved
  })

  app.post('/api/admin/aviator/players/:userId/unsuspend', async (req) => {
    requireAdmin(cfg, req, true)
    const { userId } = req.params as { userId: string }
    if (!UUID.test(userId)) throw new ApiError(400, 'validation')
    const saved = await writeSuspension(cfg, userId, false, '', req.auth!.userId)
    await audit(cfg, req, 'admin.aviator.unsuspend', saved)
    return saved
  })

  app.get('/api/admin/aviator/activity', async (req, reply) => {
    requireAdmin(cfg, req, false)
    const query = req.query as { q?: unknown, kind?: unknown, limit?: unknown, format?: unknown }
    const q = typeof query.q === 'string' ? query.q : ''
    const kind = typeof query.kind === 'string' ? query.kind : ''
    const format = query.format === 'csv' ? 'csv' : 'json'
    const cap = format === 'csv' ? 5000 : 200
    const fallback = format === 'csv' ? 2000 : 100
    const parsed = typeof query.limit === 'string' ? Number(query.limit) : fallback
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > cap) {
      throw new ApiError(400, 'validation', { fields: { limit: 'range' } })
    }
    const rows = await activityRows(cfg, { q, kind, limit: parsed })
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', 'attachment; filename="aviator-activity.csv"')
      return activityCsv(rows)
    }
    return { rows }
  })

  app.patch('/api/admin/aviator/budget', async (req) => {
    requireAdmin(cfg, req, true)
    const body = (req.body ?? {}) as { budgetTzs?: unknown, enabled?: unknown, resetCounters?: unknown, crashPoint?: unknown, winners?: unknown }
    if (body.crashPoint !== undefined || body.winners !== undefined) {
      throw new ApiError(400, 'validation', { fields: { crashPoint: 'forbidden' } })
    }
    const next: { budgetTzs?: number, enabled?: boolean, resetCounters?: boolean } = {}
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
      const before = await lockCasinoBudget(client, 'aviator')
      const after = await saveCasinoBudget(client, 'aviator', next)
      return { before: budgetView(before), after: budgetView(after) }
    })
    await audit(cfg, req, 'admin.aviator.budget', saved)
    return { ...saved.after, applies: 'next_round' }
  })
}
