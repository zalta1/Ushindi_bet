import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { isAdminRole } from '../admin/roles.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PICKS = new Set(['home', 'draw', 'away'])
const RESULTS = new Set(['home', 'draw', 'away', 'void'])

type JackpotRow = {
  id: string
  type: 'mega10' | 'power8'
  name: string
  stake_tzs: string
  grand_prize_tzs: string
  tier_prizes: Record<string, number>
  closing_time: Date
  status: string
  prize_pool_tzs: string
  participants_count: number
  total_matches: number
  created_at: Date
}

type MatchRow = {
  jackpot_id: string
  position: number
  match_id: number
  correct_result: string | null
  home: string
  away: string
  league: string | null
  kickoff_at: Date
  status: string
  home_score: number
  away_score: number
  home_odds: string | null
  draw_odds: string | null
  away_odds: string | null
}

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const message = String((err as { message?: string }).message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('jackpot_not_found')) return new ApiError(404, 'not_found')
  if (message.includes('jackpot_closed_time')) return new ApiError(409, 'closed')
  if (message.includes('jackpot_closed')) return new ApiError(409, 'jackpot_closed')
  if (message.includes('jackpot_match_started')) return new ApiError(409, 'match_started')
  if (message.includes('jackpot_selections') || message.includes('jackpot_results') || message.includes('jackpot_prize')) {
    return new ApiError(400, 'validation', { fields: { selections: 'invalid' } })
  }
  if (message.includes('jackpot_cancelled')) return new ApiError(409, 'jackpot_cancelled')
  if (message.includes('jackpot_settled')) return new ApiError(409, 'jackpot_settled')
  if (message.includes('jackpot_matches_missing')) return new ApiError(409, 'jackpot_matches_missing')
  return null
}

function textField(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'validation', { fields: { [field]: 'required' } })
  const text = value.trim()
  if (text.length < min || text.length > max) throw new ApiError(400, 'validation', { fields: { [field]: 'length' } })
  return text
}

function wholeShillings(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'validation', { fields: { [field]: 'invalid' } })
  }
  return value
}

async function audit(cfg: AppConfig, req: FastifyRequest, action: string, payload: unknown) {
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [req.auth?.userId ?? null, req.auth?.phone ?? 'system', action, JSON.stringify(payload)],
  )
}

function mapJackpot(row: JackpotRow, matches: MatchRow[] = []) {
  const tiers: Record<string, number> = {}
  for (const [key, value] of Object.entries(row.tier_prizes ?? {})) tiers[key] = money(value)
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    stakeTzs: money(row.stake_tzs),
    grandPrizeTzs: money(row.grand_prize_tzs),
    tierPrizes: tiers,
    closingTime: new Date(row.closing_time).toISOString(),
    status: row.status,
    prizePoolTzs: money(row.prize_pool_tzs),
    participants: row.participants_count,
    totalMatches: row.total_matches,
    createdAt: new Date(row.created_at).toISOString(),
    matches: matches
      .filter((match) => match.jackpot_id === row.id)
      .sort((a, b) => a.position - b.position)
      .map((match) => ({
        position: match.position,
        matchId: match.match_id,
        home: match.home,
        away: match.away,
        league: match.league ?? '',
        kickoff: new Date(match.kickoff_at).toISOString(),
        status: match.status,
        homeScore: match.home_score,
        awayScore: match.away_score,
        result: match.correct_result,
        odds: {
          home: match.home_odds == null ? null : Number(match.home_odds),
          draw: match.draw_odds == null ? null : Number(match.draw_odds),
          away: match.away_odds == null ? null : Number(match.away_odds),
        },
      })),
  }
}

const matchSelect = `
  SELECT jm.jackpot_id, jm.position, jm.match_id, jm.correct_result,
         m.home, m.away, m.league, m.kickoff_at, m.status, m.home_score, m.away_score,
         MAX(CASE WHEN o.selection = '1' THEN o.price END)::text AS home_odds,
         MAX(CASE WHEN o.selection = 'X' THEN o.price END)::text AS draw_odds,
         MAX(CASE WHEN o.selection = '2' THEN o.price END)::text AS away_odds
    FROM jackpot_matches jm
    JOIN matches m ON m.id = jm.match_id
    LEFT JOIN markets mk ON mk.match_id = m.id AND mk.code = '1X2'
    LEFT JOIN odds o ON o.market_id = mk.id AND o.selection IN ('1', 'X', '2')
`

async function loadMatches(cfg: AppConfig, ids: string[]): Promise<MatchRow[]> {
  if (!ids.length) return []
  const { rows } = await getPool(cfg).query<MatchRow>(
    `${matchSelect}
      WHERE jm.jackpot_id = ANY($1::uuid[])
      GROUP BY jm.jackpot_id, jm.position, jm.match_id, jm.correct_result,
               m.home, m.away, m.league, m.kickoff_at, m.status, m.home_score, m.away_score
      ORDER BY jm.position`,
    [ids],
  )
  return rows
}

function tierPrizes(value: unknown, total: number, grand: number): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'validation', { fields: { tierPrizes: 'invalid' } })
  }
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(key)
    if (!Number.isInteger(count) || count < 1 || count >= total) {
      throw new ApiError(400, 'validation', { fields: { tierPrizes: 'invalid' } })
    }
    const amount = wholeShillings(raw, 'tierPrizes', 1, grand - 1)
    out[String(count)] = amount
  }
  if (!Object.keys(out).length) throw new ApiError(400, 'validation', { fields: { tierPrizes: 'required' } })
  return out
}

function selectionsOf(value: unknown, total: number): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    if (value.length !== total) throw new ApiError(400, 'validation', { fields: { selections: 'count' } })
    value.forEach((pick, index) => {
      if (typeof pick !== 'string' || !PICKS.has(pick)) throw new ApiError(400, 'validation', { fields: { selections: 'invalid' } })
      out[String(index + 1)] = pick
    })
    return out
  }
  if (!value || typeof value !== 'object') throw new ApiError(400, 'validation', { fields: { selections: 'invalid' } })
  for (let pos = 1; pos <= total; pos++) {
    const pick = (value as Record<string, unknown>)[String(pos)]
    if (typeof pick !== 'string' || !PICKS.has(pick)) throw new ApiError(400, 'validation', { fields: { selections: 'invalid' } })
    out[String(pos)] = pick
  }
  return out
}

export function registerJackpotRoutes(app: FastifyInstance, cfg: AppConfig) {
  const playerWrite = async (req: FastifyRequest) => {
    assertOrigin(req, cfg.corsOrigins)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
  }
  const guardWrite = async (req: FastifyRequest) => {
    assertOrigin(req, cfg.corsOrigins)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
    if (!isAdminRole(req.auth.role) || req.auth.readOnly) throw new ApiError(403, 'forbidden')
  }
  const guardRead = async (req: FastifyRequest) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    if (!isAdminRole(req.auth.role) || req.auth.readOnly) throw new ApiError(403, 'forbidden')
  }

  app.get('/api/jackpots', async () => {
    const { rows } = await getPool(cfg).query<JackpotRow>(
      `SELECT id, type, name, stake_tzs, grand_prize_tzs, tier_prizes, closing_time, status,
              prize_pool_tzs, participants_count, total_matches, created_at
         FROM jackpots
        WHERE status = 'open'
        ORDER BY closing_time`,
    )
    const matches = await loadMatches(cfg, rows.map((row) => row.id))
    return { data: rows.map((row) => mapJackpot(row, matches)) }
  })

  app.get('/api/jackpot-tickets', async (req) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    const { rows } = await getPool(cfg).query<{
      id: string
      jackpot_id: string
      selections: Record<string, string>
      stake_tzs: string
      correct_count: number
      status: string
      prize_tzs: string
      created_at: Date
      name: string
      type: string
      total_matches: number
      jackpot_status: string
    }>(
      `SELECT t.id, t.jackpot_id, t.selections, t.stake_tzs, t.correct_count, t.status, t.prize_tzs, t.created_at,
              j.name, j.type, j.total_matches, j.status AS jackpot_status
         FROM jackpot_tickets t
         JOIN jackpots j ON j.id = t.jackpot_id
        WHERE t.user_id = $1
        ORDER BY t.created_at DESC
        LIMIT 50`,
      [req.auth.userId],
    )
    const matches = await loadMatches(cfg, [...new Set(rows.map((row) => row.jackpot_id))])
    return {
      data: rows.map((row) => ({
        id: row.id,
        jackpotId: row.jackpot_id,
        name: row.name,
        type: row.type,
        totalMatches: row.total_matches,
        jackpotStatus: row.jackpot_status,
        selections: row.selections,
        stakeTzs: money(row.stake_tzs),
        correctCount: row.correct_count,
        status: row.status,
        prizeTzs: money(row.prize_tzs),
        createdAt: new Date(row.created_at).toISOString(),
        matches: mapJackpot({
          id: row.jackpot_id,
          type: row.type as 'mega10' | 'power8',
          name: row.name,
          stake_tzs: '0',
          grand_prize_tzs: '0',
          tier_prizes: {},
          closing_time: new Date(),
          status: row.jackpot_status,
          prize_pool_tzs: '0',
          participants_count: 0,
          total_matches: row.total_matches,
          created_at: row.created_at,
        }, matches).matches,
      })),
    }
  })

  app.post('/api/jackpots/:id/tickets', { preHandler: playerWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const body = (req.body ?? {}) as { selections?: unknown; idempotencyKey?: unknown }
    const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
    if (key.length < 8 || key.length > 160) throw new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
    const size = await getPool(cfg).query<{ total_matches: number }>(`SELECT total_matches FROM jackpots WHERE id = $1`, [id])
    if (!size.rows[0]) throw new ApiError(404, 'not_found')
    const selections = selectionsOf(body.selections, size.rows[0].total_matches)
    try {
      const { rows } = await getPool(cfg).query<{ result: { duplicate: boolean; ticket_id: string; balance_tzs: string | number } }>(
        `SELECT place_jackpot_ticket($1, $2, $3::jsonb, $4) AS result`,
        [req.auth!.userId, id, JSON.stringify(selections), key],
      )
      const result = rows[0].result
      return {
        ticketId: result.ticket_id,
        duplicate: Boolean(result.duplicate),
        balanceTzs: result.balance_tzs == null ? null : money(result.balance_tzs),
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/admin/jackpot-fixtures', { preHandler: guardRead }, async () => {
    const { rows } = await getPool(cfg).query<{
      id: number
      home: string
      away: string
      league: string | null
      kickoff_at: Date
      home_odds: string | null
      draw_odds: string | null
      away_odds: string | null
    }>(
      `SELECT m.id, m.home, m.away, m.league, m.kickoff_at,
              MAX(CASE WHEN o.selection = '1' THEN o.price END)::text AS home_odds,
              MAX(CASE WHEN o.selection = 'X' THEN o.price END)::text AS draw_odds,
              MAX(CASE WHEN o.selection = '2' THEN o.price END)::text AS away_odds
         FROM matches m
         LEFT JOIN markets mk ON mk.match_id = m.id AND mk.code = '1X2'
         LEFT JOIN odds o ON o.market_id = mk.id AND o.selection IN ('1', 'X', '2')
        WHERE m.status = 'upcoming' AND m.kickoff_at > now()
        GROUP BY m.id
        ORDER BY m.kickoff_at
        LIMIT 200`,
    )
    return {
      data: rows.map((row) => ({
        id: row.id,
        home: row.home,
        away: row.away,
        league: row.league ?? '',
        kickoff: new Date(row.kickoff_at).toISOString(),
        odds: {
          home: row.home_odds == null ? null : Number(row.home_odds),
          draw: row.draw_odds == null ? null : Number(row.draw_odds),
          away: row.away_odds == null ? null : Number(row.away_odds),
        },
      })),
    }
  })

  app.get('/api/admin/jackpots', { preHandler: guardRead }, async () => {
    const { rows } = await getPool(cfg).query<JackpotRow>(
      `SELECT id, type, name, stake_tzs, grand_prize_tzs, tier_prizes, closing_time, status,
              prize_pool_tzs, participants_count, total_matches, created_at
         FROM jackpots
        ORDER BY created_at DESC
        LIMIT 100`,
    )
    const matches = await loadMatches(cfg, rows.map((row) => row.id))
    return { data: rows.map((row) => mapJackpot(row, matches)) }
  })

  app.post('/api/admin/jackpots', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as {
      type?: unknown
      name?: unknown
      stakeTzs?: unknown
      grandPrizeTzs?: unknown
      tierPrizes?: unknown
      closingTime?: unknown
      matchIds?: unknown
    }
    if (body.type !== 'mega10' && body.type !== 'power8') throw new ApiError(400, 'validation', { fields: { type: 'invalid' } })
    const total = body.type === 'mega10' ? 10 : 8
    const name = textField(body.name, 'name', 2, 80)
    const stake = wholeShillings(body.stakeTzs, 'stakeTzs', 100, 1_000_000)
    const grand = wholeShillings(body.grandPrizeTzs, 'grandPrizeTzs', stake, 1_000_000_000)
    const tiers = tierPrizes(body.tierPrizes, total, grand)
    const closing = typeof body.closingTime === 'string' ? new Date(body.closingTime) : null
    if (!closing || Number.isNaN(closing.getTime()) || closing.getTime() <= Date.now()) {
      throw new ApiError(400, 'validation', { fields: { closingTime: 'invalid' } })
    }
    if (!Array.isArray(body.matchIds) || body.matchIds.length !== total || body.matchIds.some((id) => !Number.isInteger(id))) {
      throw new ApiError(400, 'validation', { fields: { matchIds: 'count' } })
    }
    const matchIds = body.matchIds as number[]
    if (new Set(matchIds).size !== total) throw new ApiError(400, 'validation', { fields: { matchIds: 'duplicate' } })

    try {
      const created = await withTx(cfg, async (client) => {
        const fixtures = await client.query<{ id: number; kickoff_at: Date; status: string }>(
          `SELECT id, kickoff_at, status FROM matches WHERE id = ANY($1::int[]) FOR UPDATE`,
          [matchIds],
        )
        if (fixtures.rows.length !== total) throw new ApiError(400, 'validation', { fields: { matchIds: 'not_found' } })
        const byId = new Map(fixtures.rows.map((row) => [row.id, row]))
        for (const matchId of matchIds) {
          const fixture = byId.get(matchId)
          if (!fixture || fixture.status !== 'upcoming' || new Date(fixture.kickoff_at).getTime() <= Date.now()) {
            throw new ApiError(409, 'match_started')
          }
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO jackpots (
             type, name, stake_tzs, grand_prize_tzs, tier_prizes, closing_time, total_matches, created_by
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
           RETURNING id`,
          [body.type, name, stake, grand, JSON.stringify(tiers), closing.toISOString(), total, req.auth!.userId],
        )
        const jackpotId = inserted.rows[0].id
        for (let i = 0; i < matchIds.length; i++) {
          await client.query(
            `INSERT INTO jackpot_matches (jackpot_id, match_id, position) VALUES ($1, $2, $3)`,
            [jackpotId, matchIds[i], i + 1],
          )
        }
        await client.query(
          `INSERT INTO audit_log (actor_user_id, actor, action, payload)
           VALUES ($1, $2, 'admin.jackpot.create', $3::jsonb)`,
          [req.auth!.userId, req.auth!.phone, JSON.stringify({ jackpotId, type: body.type, name, matchIds, stakeTzs: stake, grandPrizeTzs: grand })],
        )
        return jackpotId
      })
      return { id: created }
    } catch (err) {
      if (err instanceof ApiError) throw err
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/admin/jackpots/:id/tickets', { preHandler: guardRead }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const { rows } = await getPool(cfg).query<{
      id: string
      phone: string
      selections: Record<string, string>
      stake_tzs: string
      correct_count: number
      status: string
      prize_tzs: string
      created_at: Date
    }>(
      `SELECT t.id, u.phone, t.selections, t.stake_tzs, t.correct_count, t.status, t.prize_tzs, t.created_at
         FROM jackpot_tickets t
         JOIN users u ON u.id = t.user_id
        WHERE t.jackpot_id = $1
        ORDER BY t.created_at DESC`,
      [id],
    )
    return {
      data: rows.map((row) => ({
        id: row.id,
        phone: row.phone,
        selections: row.selections,
        stakeTzs: money(row.stake_tzs),
        correctCount: row.correct_count,
        status: row.status,
        prizeTzs: money(row.prize_tzs),
        createdAt: new Date(row.created_at).toISOString(),
      })),
    }
  })

  app.post('/api/admin/jackpots/:id/settle', { preHandler: guardWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const body = (req.body ?? {}) as { results?: unknown }
    const results: Record<string, string> = {}
    if (body.results !== undefined) {
      if (!Array.isArray(body.results)) throw new ApiError(400, 'validation', { fields: { results: 'invalid' } })
      for (const row of body.results) {
        const item = row as { position?: unknown; result?: unknown }
        if (typeof item.position !== 'number' || !Number.isInteger(item.position) || item.position < 1) {
          throw new ApiError(400, 'validation', { fields: { results: 'invalid' } })
        }
        if (typeof item.result !== 'string' || !RESULTS.has(item.result)) {
          throw new ApiError(400, 'validation', { fields: { results: 'invalid' } })
        }
        results[String(item.position)] = item.result
      }
    }
    try {
      const { rows } = await getPool(cfg).query<{ result: { already?: boolean; pending?: boolean; paid: number; refunded?: number; all_void?: boolean } }>(
        `SELECT settle_jackpot($1, $2::jsonb) AS result`,
        [id, JSON.stringify(results)],
      )
      const result = rows[0].result
      await audit(cfg, req, 'admin.jackpot.settle', {
        jackpotId: id,
        pending: Boolean(result.pending),
        already: Boolean(result.already),
        paid: Number(result.paid ?? 0),
        refunded: Number(result.refunded ?? 0),
        allVoid: Boolean(result.all_void),
      })
      return {
        pending: Boolean(result.pending),
        already: Boolean(result.already),
        paid: Number(result.paid ?? 0),
        refunded: Number(result.refunded ?? 0),
        allVoid: Boolean(result.all_void),
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/admin/jackpots/:id/cancel', { preHandler: guardWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const reason = textField((req.body as { reason?: unknown } | null)?.reason, 'reason', 3, 200)
    try {
      const { rows } = await getPool(cfg).query<{ result: { already?: boolean; refunded: number } }>(
        `SELECT cancel_jackpot($1) AS result`,
        [id],
      )
      await audit(cfg, req, 'admin.jackpot.cancel', { jackpotId: id, reason, refunded: Number(rows[0].result.refunded ?? 0) })
      return { refunded: Number(rows[0].result.refunded ?? 0), already: Boolean(rows[0].result.already) }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/admin/jackpots/:id/delete', { preHandler: guardWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const deleted = await withTx(cfg, async (client) => {
      const current = await client.query<{ id: string }>(`SELECT id FROM jackpots WHERE id = $1 FOR UPDATE`, [id])
      if (!current.rows[0]) throw new ApiError(404, 'not_found')
      const tickets = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM jackpot_tickets WHERE jackpot_id = $1`, [id])
      if (Number(tickets.rows[0].n) > 0) throw new ApiError(409, 'has_tickets')
      await client.query(`DELETE FROM jackpots WHERE id = $1`, [id])
      await client.query(
        `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, 'admin.jackpot.delete', $3::jsonb)`,
        [req.auth!.userId, req.auth!.phone, JSON.stringify({ jackpotId: id })],
      )
      return true
    })
    return { id, deleted }
  })
}
