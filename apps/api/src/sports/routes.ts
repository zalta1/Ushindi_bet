import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import { assertCsrf, assertOrigin } from '../auth/sessions.js'
import { getPool, withTx } from '../db.js'
import { ApiError, money } from '../errors.js'
import { operatorConfig } from '../operator-config.js'
import { isAdminRole } from '../admin/roles.js'
import { getPublicMatch, listAdminMatches, listPublicMatches } from './catalog.js'
import { loadMatchDetails } from './details.js'
import { activeApiKeys, checkApiFootballKey, syncApiFootball } from './feed.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type LegIn = { oddsId?: unknown; price?: unknown }

function dbError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err
  const pg = err as { code?: string; message?: string }
  const message = String(pg.message ?? '')
  if (message.includes('insufficient_funds')) return new ApiError(409, 'insufficient_funds')
  if (message.includes('idempotency_conflict')) return new ApiError(409, 'idempotency_conflict')
  if (message.includes('invalid_idempotency_key')) return new ApiError(400, 'validation', { fields: { idempotencyKey: 'length' } })
  if (message.includes('unsupported_market')) return new ApiError(400, 'unsupported_market')
  if (message.includes('invalid_score')) return new ApiError(400, 'validation', { fields: { homeScore: 'invalid' } })
  if (message.includes('invalid_payout_percent')) return new ApiError(400, 'validation', { fields: { payoutPercentBps: 'range' } })
  if (message.includes('invalid_odds')) return new ApiError(400, 'validation', { fields: { price: 'invalid' } })
  if (message.includes('invalid_stake')) return new ApiError(400, 'validation', { fields: { stake: 'invalid' } })
  if (message.includes('match_not_found') || message.includes('odds_not_found') || message.includes('bet_not_found')) return new ApiError(404, 'not_found')
  if (message.includes('cashout_changed')) return new ApiError(409, 'cashout_changed')
  if (message.includes('cashout_closed')) return new ApiError(409, 'cashout_closed')
  if (pg.code === '55P03') return new ApiError(409, 'busy')
  return null
}

function maskKey(value: string): string {
  if (value.length < 12) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function textField(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new ApiError(400, 'validation', { fields: { [field]: 'required' } })
  const text = value.trim()
  if (text.length < min || text.length > max) throw new ApiError(400, 'validation', { fields: { [field]: 'length' } })
  return text
}

function priceField(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 1 || n > 1000) throw new ApiError(400, 'validation', { fields: { [field]: 'invalid' } })
  return Math.round(n * 100) / 100
}

async function audit(cfg: AppConfig, req: FastifyRequest, action: string, payload: unknown) {
  await getPool(cfg).query(
    `INSERT INTO audit_log (actor_user_id, actor, action, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [req.auth?.userId ?? null, req.auth?.phone ?? 'system', action, JSON.stringify(payload)],
  )
}

async function footballSport(cfg: AppConfig): Promise<number> {
  const { rows } = await getPool(cfg).query<{ id: number }>(
    `INSERT INTO sports (code, name_en, name_sw)
     VALUES ('football', 'Football', 'Mpira wa Miguu')
     ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en
     RETURNING id`,
  )
  return rows[0].id
}

const DEFAULT_ODDS: { market: string; selection: string; price: number; line: number | null }[] = [
  { market: '1X2', selection: '1', price: 2.1, line: null },
  { market: '1X2', selection: 'X', price: 3.2, line: null },
  { market: '1X2', selection: '2', price: 2.8, line: null },
  { market: 'BTTS', selection: 'Yes', price: 1.8, line: null },
  { market: 'BTTS', selection: 'No', price: 1.95, line: null },
  { market: 'Over/Under', selection: 'Over 2.5', price: 1.9, line: 2.5 },
  { market: 'Over/Under', selection: 'Under 2.5', price: 1.85, line: 2.5 },
  { market: 'Double Chance', selection: '1X', price: 1.3, line: null },
  { market: 'Double Chance', selection: '12', price: 1.28, line: null },
  { market: 'Double Chance', selection: 'X2', price: 1.55, line: null },
]

function oddsFromBody(body: Record<string, unknown>) {
  const raw = body.odds
  if (!raw || typeof raw !== 'object') return DEFAULT_ODDS
  const odds = raw as Record<string, unknown>
  const picked: { market: string; selection: string; price: number; line: number | null }[] = []
  const take = (field: string, market: string, selection: string, line: number | null) => {
    if (odds[field] === undefined || odds[field] === null || odds[field] === '') return
    picked.push({ market, selection, price: priceField(odds[field], field), line })
  }
  take('home', '1X2', '1', null)
  take('draw', '1X2', 'X', null)
  take('away', '1X2', '2', null)
  take('bttsYes', 'BTTS', 'Yes', null)
  take('bttsNo', 'BTTS', 'No', null)
  take('over25', 'Over/Under', 'Over 2.5', 2.5)
  take('under25', 'Over/Under', 'Under 2.5', 2.5)
  take('dc1x', 'Double Chance', '1X', null)
  take('dc12', 'Double Chance', '12', null)
  take('dcx2', 'Double Chance', 'X2', null)
  return picked.length ? picked : DEFAULT_ODDS
}

export function registerSportsRoutes(app: FastifyInstance, cfg: AppConfig) {
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
  const playerWrite = async (req: FastifyRequest) => {
    assertOrigin(req, cfg.corsOrigins)
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    assertCsrf(req, req.auth.csrfHash)
  }

  app.get('/api/matches', async (req) => {
    const query = req.query as { live?: string }
    return listPublicMatches(cfg, Boolean(query?.live))
  })

  app.get('/api/matches/:id', async (req) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id)) throw new ApiError(404, 'not_found')
    const match = await getPublicMatch(cfg, id)
    if (!match) throw new ApiError(404, 'not_found')
    const details = await loadMatchDetails(cfg, match)
    return { ...match, details }
  })

  app.get('/api/bets/limits', async () => ({
    minStake: operatorConfig.minStake,
    maxStake: operatorConfig.maxStake,
    currency: 'TZS',
    cashoutEnabled: operatorConfig.cashoutEnabled,
    cashoutMarginBps: operatorConfig.cashoutMarginBps,
    payoutPercentBps: operatorConfig.payoutPercentBps,
  }))

  app.get('/api/bets/quote', async (req) => {
    const query = req.query as { stake?: string; price?: string | string[] }
    const stake = Number(query.stake)
    if (!Number.isInteger(stake) || stake < 1 || stake > 100_000_000) {
      throw new ApiError(400, 'validation', { fields: { stake: 'invalid' } })
    }
    const raw = query.price === undefined ? [] : Array.isArray(query.price) ? query.price : [query.price]
    if (raw.length < 1 || raw.length > 20) throw new ApiError(400, 'validation', { fields: { price: 'invalid' } })
    const prices = raw.map((value) => {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 1 || n > 1000) throw new ApiError(400, 'validation', { fields: { price: 'invalid' } })
      return String(n)
    })
    try {
      const { rows } = await getPool(cfg).query<{ result: { potential_payout_tzs: number | string; combined_odds: number | string; payout_percent_bps: number | string } }>(
        `SELECT quote_bet($1, (SELECT COALESCE(array_agg(v::numeric), ARRAY[]::numeric[]) FROM unnest($2::text[]) AS v), $3) AS result`,
        [stake, prices, operatorConfig.payoutPercentBps],
      )
      const result = rows[0].result
      return {
        potentialPayoutTzs: money(result.potential_payout_tzs),
        combinedOdds: Number(result.combined_odds),
        payoutPercentBps: Number(result.payout_percent_bps),
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/bets', async (req) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    const status = (req.query as { status?: string }).status
    if (status && !['open', 'won', 'lost', 'void', 'cashout'].includes(status)) {
      throw new ApiError(400, 'validation', { fields: { status: 'invalid' } })
    }
    const bets = await getPool(cfg).query<{
      id: string
      stake_tzs: string
      combined_odds: string
      potential_payout_tzs: string
      payout_percent_bps: number | string
      status: string
      placed_at: Date
      settled_at: Date | null
    }>(
      `SELECT id, stake_tzs, combined_odds, potential_payout_tzs, payout_percent_bps, status, placed_at, settled_at
         FROM bets
        WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY placed_at DESC
        LIMIT 50`,
      [req.auth.userId, status ?? null],
    )
    const data = await withLegs(cfg, bets.rows)
    if (operatorConfig.cashoutEnabled) {
      for (const bet of data) {
        if (bet.status !== 'open') continue
        bet.cashoutTzs = await quoteCashout(cfg, req.auth!.userId, bet.id)
      }
    }
    return { data }
  })

  app.get('/api/bets/:id/cashout', async (req) => {
    if (!req.auth) throw new ApiError(401, 'unauthenticated')
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    if (!operatorConfig.cashoutEnabled) return { enabled: false, cashoutTzs: null }
    return { enabled: true, cashoutTzs: await quoteCashout(cfg, req.auth.userId, id) }
  })

  app.post('/api/bets/:id/cashout', { preHandler: playerWrite }, async (req) => {
    if (!operatorConfig.cashoutEnabled) throw new ApiError(403, 'cashout_disabled')
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const body = (req.body ?? {}) as { expectedTzs?: unknown }
    if (typeof body.expectedTzs !== 'number' || !Number.isInteger(body.expectedTzs) || body.expectedTzs < 1) {
      throw new ApiError(400, 'validation', { fields: { expectedTzs: 'invalid' } })
    }
    try {
      const { rows } = await getPool(cfg).query<{ result: { idempotent: boolean; credited_tzs: number | string; balance_tzs?: number | string; status: string } }>(
        `SELECT cashout_bet_atomic($1, $2, $3, $4) AS result`,
        [req.auth!.userId, id, operatorConfig.cashoutMarginBps, body.expectedTzs],
      )
      const result = rows[0].result
      const balance = result.balance_tzs == null
        ? await getPool(cfg).query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [req.auth!.userId])
        : null
      return {
        idempotent: result.idempotent,
        creditedTzs: money(result.credited_tzs),
        balanceTzs: money(result.balance_tzs ?? balance?.rows[0]?.balance_tzs),
        status: result.status,
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/bets', { preHandler: playerWrite }, async (req) => {
    const body = (req.body ?? {}) as { idempotencyKey?: unknown; stakeTzs?: unknown; legs?: unknown }
    const idempotencyKey = textField(body.idempotencyKey, 'idempotencyKey', 8, 180)
    if (typeof body.stakeTzs !== 'number' || !Number.isInteger(body.stakeTzs)) {
      throw new ApiError(400, 'validation', { fields: { stakeTzs: 'invalid' } })
    }
    const stakeTzs = body.stakeTzs
    if (!Array.isArray(body.legs) || body.legs.length < 1 || body.legs.length > 20) {
      throw new ApiError(400, 'validation', { fields: { legs: 'invalid' } })
    }
    const userId = req.auth!.userId
    const existing = await getPool(cfg).query<{
      id: string
      user_id: string
      stake_tzs: string
      combined_odds: string
      potential_payout_tzs: string
      payout_percent_bps: number | string
      status: string
    }>(`SELECT id, user_id, stake_tzs, combined_odds, potential_payout_tzs, payout_percent_bps, status FROM bets WHERE idempotency_key = $1`, [idempotencyKey])
    if (existing.rows[0]) {
      const row = existing.rows[0]
      if (row.user_id !== userId || Number(row.stake_tzs) !== stakeTzs) throw new ApiError(409, 'idempotency_conflict')
      const balance = await getPool(cfg).query<{ balance_tzs: string }>(`SELECT balance_tzs FROM wallets WHERE user_id = $1`, [userId])
      return {
        idempotent: true,
        betId: row.id,
        stakeTzs,
        combinedOdds: Number(row.combined_odds),
        potentialPayoutTzs: money(row.potential_payout_tzs),
        payoutPercentBps: Number(row.payout_percent_bps),
        status: row.status,
        balanceTzs: money(balance.rows[0]?.balance_tzs),
      }
    }
    if (stakeTzs < operatorConfig.minStake || stakeTzs > operatorConfig.maxStake) {
      throw new ApiError(400, 'validation', {
        fields: { stakeTzs: stakeTzs < operatorConfig.minStake ? 'min' : 'max' },
        minStake: operatorConfig.minStake,
        maxStake: operatorConfig.maxStake,
      })
    }
    const legs = body.legs as LegIn[]
    const oddsIds = legs.map((leg) => {
      const id = Number(leg.oddsId)
      if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'validation', { fields: { oddsId: 'invalid' } })
      return id
    })
    if (new Set(oddsIds).size !== oddsIds.length) throw new ApiError(400, 'validation', { fields: { legs: 'duplicate' } })

    try {
      return await withTx(cfg, async (client) => {
        const { rows } = await client.query<{
          odds_id: number
          selection: string
          price: string
          suspended: boolean
          market: string
          match_id: number
          status: string
        }>(
          `SELECT o.id AS odds_id, o.selection, o.price, o.suspended, mk.code AS market, mk.match_id, mt.status
             FROM odds o
             JOIN markets mk ON mk.id = o.market_id
             JOIN matches mt ON mt.id = mk.match_id
            WHERE o.id = ANY($1::int[])
            ORDER BY mt.id, o.id
            FOR UPDATE OF mt, o`,
          [oddsIds],
        )
        if (rows.length !== oddsIds.length) throw new ApiError(404, 'not_found')
        const byId = new Map(rows.map((row) => [row.odds_id, row]))
        const matchIds = new Set<number>()
        const payload = oddsIds.map((id, index) => {
          const row = byId.get(id)
          if (!row) throw new ApiError(404, 'not_found')
          if (row.suspended) throw new ApiError(409, 'odds_suspended', { oddsId: id })
          if (row.status !== 'upcoming' && row.status !== 'live') throw new ApiError(409, 'match_closed', { matchId: row.match_id })
          if (matchIds.has(row.match_id)) throw new ApiError(400, 'validation', { fields: { legs: 'duplicate_match' } })
          matchIds.add(row.match_id)
          const dbPrice = Number(row.price)
          const sent = legs[index].price
          if (sent !== undefined && sent !== null && sent !== '') {
            const clientPrice = Number(sent)
            if (!Number.isFinite(clientPrice) || Math.abs(clientPrice - dbPrice) > 0.001) {
              throw new ApiError(409, 'odds_changed', { oddsId: id, price: dbPrice })
            }
          }
          return { match_id: row.match_id, market: row.market, selection: row.selection, odds: dbPrice, odds_id: row.odds_id }
        })
        const placed = await client.query<{ result: {
          idempotent: boolean
          bet_id: string
          stake_tzs: number | string
          combined_odds: number | string
          potential_payout_tzs: number | string
          payout_percent_bps: number | string
          balance_tzs: number | string
        } }>(
          `SELECT place_bet_atomic($1, $2, $3::jsonb, $4, $5) AS result`,
          [userId, stakeTzs, JSON.stringify(payload), idempotencyKey, operatorConfig.payoutPercentBps],
        )
        const result = placed.rows[0].result
        return {
          idempotent: result.idempotent,
          betId: result.bet_id,
          stakeTzs: money(result.stake_tzs),
          combinedOdds: Number(result.combined_odds),
          potentialPayoutTzs: money(result.potential_payout_tzs),
          payoutPercentBps: Number(result.payout_percent_bps),
          status: 'open',
          balanceTzs: money(result.balance_tzs),
        }
      })
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.get('/api/admin/match-api', { preHandler: guardRead }, async () => {
    const { rows } = await getPool(cfg).query<{ id: string; label: string; api_key: string; is_active: boolean }>(
      `SELECT id, label, api_key, is_active FROM match_api_keys ORDER BY created_at`,
    )
    const keys: { source: 'system' | 'custom'; id: string | null; label: string; masked: string; is_active: boolean }[] = []
    const env = process.env.API_SPORTS_KEY?.trim()
    if (env) keys.push({ source: 'system', id: null, label: 'API_SPORTS_KEY', masked: maskKey(env), is_active: true })
    for (const row of rows) {
      keys.push({ source: 'custom', id: row.id, label: row.label, masked: maskKey(row.api_key), is_active: row.is_active })
    }
    return { provider: 'api-football', keys }
  })

  app.post('/api/admin/match-api', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as { label?: unknown; apiKey?: unknown }
    const label = textField(body.label ?? 'API-Football', 'label', 1, 80)
    const apiKey = textField(body.apiKey, 'apiKey', 8, 200)
    if (/\s/.test(apiKey)) throw new ApiError(400, 'validation', { fields: { apiKey: 'invalid' } })
    const id = randomUUID()
    await getPool(cfg).query(
      `INSERT INTO match_api_keys (id, label, api_key) VALUES ($1, $2, $3)`,
      [id, label, apiKey],
    )
    await audit(cfg, req, 'match_api.add', { id, label })
    const check = cfg.isTest ? { ok: false, message: 'Haifanyi kazi' } : await checkApiFootballKey(apiKey)
    return { id, label, masked: maskKey(apiKey), check }
  })

  app.post('/api/admin/match-api/:id/toggle', { preHandler: guardWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const { rows } = await getPool(cfg).query<{ is_active: boolean }>(
      `UPDATE match_api_keys SET is_active = NOT is_active WHERE id = $1 RETURNING is_active`,
      [id],
    )
    if (!rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'match_api.toggle', { id, is_active: rows[0].is_active })
    return { id, is_active: rows[0].is_active }
  })

  app.post('/api/admin/match-api/:id/delete', { preHandler: guardWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const { rowCount } = await getPool(cfg).query(`DELETE FROM match_api_keys WHERE id = $1`, [id])
    if (!rowCount) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'match_api.delete', { id })
    return { ok: true }
  })

  app.post('/api/admin/match-api/:id/check', { preHandler: guardWrite }, async (req) => {
    const id = (req.params as { id: string }).id
    if (!UUID.test(id)) throw new ApiError(404, 'not_found')
    const { rows } = await getPool(cfg).query<{ api_key: string }>(`SELECT api_key FROM match_api_keys WHERE id = $1`, [id])
    if (!rows[0]) throw new ApiError(404, 'not_found')
    if (cfg.isTest) return { ok: false, message: 'Haifanyi kazi' }
    return checkApiFootballKey(rows[0].api_key)
  })

  app.post('/api/admin/matches/sync', { preHandler: guardWrite }, async (req) => {
    const keys = await activeApiKeys(cfg)
    if (!keys.length) throw new ApiError(400, 'no_api_key')
    try {
      const result = await syncApiFootball(cfg, req.auth!.userId)
      await audit(cfg, req, 'matches.sync', result)
      return result
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      if (err instanceof ApiError) throw err
      throw new ApiError(502, 'feed_unavailable')
    }
  })

  app.get('/api/admin/matches', { preHandler: guardRead }, async () => ({
    data: await listAdminMatches(cfg),
  }))

  app.post('/api/admin/matches', { preHandler: guardWrite }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const home = textField(body.home, 'home', 2, 80)
    const away = textField(body.away, 'away', 2, 80)
    const league = textField(body.league, 'league', 2, 80)
    const country = typeof body.country === 'string' ? body.country.trim().slice(0, 80) : ''
    const status = body.status === 'live' ? 'live' : 'upcoming'
    const kickoff = typeof body.kickoff === 'string' ? new Date(body.kickoff) : null
    if (!kickoff || Number.isNaN(kickoff.getTime())) throw new ApiError(400, 'validation', { fields: { kickoff: 'invalid' } })
    const minute = status === 'live' ? Math.max(0, Math.min(130, Number(body.minute) || 0)) : 0
    const selections = oddsFromBody(body)
    const sportId = await footballSport(cfg)
    const created = await withTx(cfg, async (client) => {
      const leagueRow = await client.query<{ id: number }>(
        `INSERT INTO leagues (sport_id, name, country)
         VALUES ($1, $2, $3)
         ON CONFLICT (sport_id, name, country) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [sportId, league, country],
      )
      const match = await client.query<{ id: number }>(
        `INSERT INTO matches (sport, league, country, home, away, kickoff_at, status, minute, source, league_id)
         VALUES ('Football', $1, $2, $3, $4, $5, $6, $7, 'manual', $8)
         RETURNING id`,
        [league, country, home, away, kickoff.toISOString(), status, minute, leagueRow.rows[0].id],
      )
      const matchId = match.rows[0].id
      const odds: { id: number; market: string; selection: string; price: number }[] = []
      for (const item of selections) {
        const market = await client.query<{ id: number }>(
          `INSERT INTO markets (match_id, name, code, line)
           VALUES ($1, $2, $2, $3)
           ON CONFLICT (match_id, code) DO UPDATE SET line = COALESCE(EXCLUDED.line, markets.line)
           RETURNING id`,
          [matchId, item.market, item.line],
        )
        const row = await client.query<{ id: number }>(
          `INSERT INTO odds (market_id, selection, price)
           VALUES ($1, $2, $3)
           ON CONFLICT (market_id, selection) DO UPDATE SET price = EXCLUDED.price, suspended = false, updated_at = now()
           RETURNING id`,
          [market.rows[0].id, item.selection, item.price],
        )
        odds.push({ id: row.rows[0].id, market: item.market, selection: item.selection, price: item.price })
      }
      return { id: matchId, odds }
    })
    await audit(cfg, req, 'matches.create', { id: created.id, home, away, league, status })
    return created
  })

  app.post('/api/admin/matches/:id/odds', { preHandler: guardWrite }, async (req) => {
    const matchId = Number((req.params as { id: string }).id)
    if (!Number.isInteger(matchId)) throw new ApiError(404, 'not_found')
    const body = (req.body ?? {}) as { market?: unknown; selection?: unknown; price?: unknown; suspended?: unknown; line?: unknown }
    const market = textField(body.market, 'market', 2, 60)
    if (!/^(1X2|BTTS|Over\/Under|Double Chance|Correct Score|Draw No Bet|Odd\/Even|Home\/Away|Exact Goals|2UP|3-Way Handicap|2-Way Handicap)( |$)/.test(market)) {
      throw new ApiError(400, 'validation', { fields: { market: 'invalid' } })
    }
    const selection = textField(body.selection, 'selection', 1, 40)
    const price = priceField(body.price, 'price')
    const suspended = Boolean(body.suspended)
    const explicit = typeof body.line === 'number' && Number.isFinite(body.line) ? body.line : null
    const parsed = selection.match(/([+-]?[0-9]+\.?[0-9]*)/)
    const line = explicit ?? (market === 'Over/Under' || market.startsWith('3-Way Handicap') || market.startsWith('2-Way Handicap')
      ? Number(parsed?.[1] ?? (market === 'Over/Under' ? 2.5 : 0))
      : null)
    const { rows } = await getPool(cfg).query<{ id: number }>(
      `INSERT INTO markets (match_id, name, code, line)
       SELECT $1, $2, $2, $3
        WHERE EXISTS (SELECT 1 FROM matches WHERE id = $1 AND status IN ('upcoming', 'live'))
       ON CONFLICT (match_id, code) DO UPDATE SET line = COALESCE(EXCLUDED.line, markets.line)
       RETURNING id`,
      [matchId, market, line],
    )
    if (!rows[0]) throw new ApiError(409, 'match_closed')
    const saved = await getPool(cfg).query<{ id: number }>(
      `INSERT INTO odds (market_id, selection, price, suspended, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (market_id, selection) DO UPDATE
         SET price = EXCLUDED.price, suspended = EXCLUDED.suspended, updated_at = now()
       RETURNING id`,
      [rows[0].id, selection, price, suspended],
    )
    await audit(cfg, req, 'odds.update', { matchId, oddsId: saved.rows[0].id, market, selection, price, suspended })
    return { id: saved.rows[0].id, market, selection, price, suspended }
  })

  app.post('/api/admin/matches/:id/settle', { preHandler: guardWrite }, async (req) => {
    const matchId = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { homeScore?: unknown; awayScore?: unknown }
    if (!Number.isInteger(matchId)) throw new ApiError(404, 'not_found')
    if (typeof body.homeScore !== 'number' || typeof body.awayScore !== 'number' || !Number.isInteger(body.homeScore) || !Number.isInteger(body.awayScore)) {
      throw new ApiError(400, 'validation', { fields: { homeScore: 'invalid' } })
    }
    try {
      const { rows } = await getPool(cfg).query<{ result: { already_settled: boolean; status: string; bets_settled: number; credited_tzs: number | string } }>(
        `SELECT settle_match_atomic($1, $2, $3, $4, false, 'admin result') AS result`,
        [matchId, body.homeScore, body.awayScore, req.auth!.userId],
      )
      return {
        alreadySettled: rows[0].result.already_settled,
        status: rows[0].result.status,
        betsSettled: Number(rows[0].result.bets_settled),
        creditedTzs: money(rows[0].result.credited_tzs),
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/admin/matches/:id/void', { preHandler: guardWrite }, async (req) => {
    const matchId = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { reason?: unknown }
    if (!Number.isInteger(matchId)) throw new ApiError(404, 'not_found')
    const reason = textField(body.reason, 'reason', 3, 200)
    try {
      const { rows } = await getPool(cfg).query<{ result: { already_settled: boolean; status: string; bets_settled: number; credited_tzs: number | string } }>(
        `SELECT settle_match_atomic($1, 0, 0, $2, true, $3) AS result`,
        [matchId, req.auth!.userId, reason],
      )
      return {
        alreadySettled: rows[0].result.already_settled,
        status: rows[0].result.status,
        betsSettled: Number(rows[0].result.bets_settled),
        creditedTzs: money(rows[0].result.credited_tzs),
      }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      throw err
    }
  })

  app.post('/api/admin/matches/:id/hot', { preHandler: guardWrite }, async (req) => {
    const matchId = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { hot?: unknown }
    if (!Number.isInteger(matchId)) throw new ApiError(404, 'not_found')
    if (typeof body.hot !== 'boolean') throw new ApiError(400, 'validation', { fields: { hot: 'invalid' } })
    const { rows } = await getPool(cfg).query<{ id: number }>(
      `UPDATE matches SET is_hot_match = $2 WHERE id = $1 RETURNING id`,
      [matchId, body.hot],
    )
    if (!rows[0]) throw new ApiError(404, 'not_found')
    await audit(cfg, req, 'matches.hot', { matchId, hot: body.hot })
    return { id: matchId, hot: body.hot }
  })

  app.post('/api/admin/matches/:id/score', { preHandler: guardWrite }, async (req) => {
    const matchId = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { homeScore?: unknown; awayScore?: unknown; minute?: unknown }
    if (!Number.isInteger(matchId)) throw new ApiError(404, 'not_found')
    if (typeof body.homeScore !== 'number' || typeof body.awayScore !== 'number' || !Number.isInteger(body.homeScore) || !Number.isInteger(body.awayScore)) {
      throw new ApiError(400, 'validation', { fields: { homeScore: 'invalid' } })
    }
    const minute = Math.max(0, Math.min(130, Number(body.minute) || 0))
    try {
      const result = await withTx(cfg, async (client) => {
        const updated = await client.query<{ id: number }>(
          `UPDATE matches
              SET home_score = $2, away_score = $3, minute = $4, status = 'live'
            WHERE id = $1 AND status IN ('upcoming', 'live')
            RETURNING id`,
          [matchId, body.homeScore, body.awayScore, minute],
        )
        if (!updated.rows[0]) throw new ApiError(409, 'match_closed')
        const two = await client.query<{ result: { paid: number; reversed: number } }>(
          `SELECT process_two_up($1) AS result`,
          [matchId],
        )
        return two.rows[0].result
      })
      await audit(cfg, req, 'matches.score', { matchId, homeScore: body.homeScore, awayScore: body.awayScore, minute, ...result })
      return { id: matchId, homeScore: body.homeScore, awayScore: body.awayScore, minute, paid: result.paid, reversed: result.reversed }
    } catch (err) {
      const mapped = dbError(err)
      if (mapped) throw mapped
      if (err instanceof ApiError) throw err
      throw err
    }
  })

  app.get('/api/admin/two-up', { preHandler: guardRead }, async (req) => {
    const query = req.query as { q?: string; enabled?: string }
    const q = (query.q ?? '').trim().slice(0, 80)
    const enabledOnly = query.enabled === 'true'
    const { rows } = await getPool(cfg).query<{
      id: number
      home: string
      away: string
      league: string
      kickoff_at: Date
      status: string
      two_up_enabled: boolean
      two_up_home_odds: string | null
      two_up_draw_odds: string | null
      two_up_away_odds: string | null
      two_up_team: string
    }>(
      `SELECT id, home, away, league, kickoff_at, status, two_up_enabled,
              two_up_home_odds, two_up_draw_odds, two_up_away_odds, two_up_team
         FROM matches
        WHERE status = 'upcoming'
          AND kickoff_at >= now() - interval '1 hour'
          AND ($1::text = '' OR home ILIKE '%' || $1 || '%' OR away ILIKE '%' || $1 || '%' OR league ILIKE '%' || $1 || '%')
          AND ($2::boolean = false OR two_up_enabled)
        ORDER BY kickoff_at
        LIMIT 500`,
      [q, enabledOnly],
    )
    return {
      data: rows.map((row) => ({
        id: row.id,
        home: row.home,
        away: row.away,
        league: row.league,
        kickoff: row.kickoff_at,
        status: row.status,
        enabled: row.two_up_enabled,
        homeOdds: row.two_up_home_odds == null ? null : Number(row.two_up_home_odds),
        drawOdds: row.two_up_draw_odds == null ? null : Number(row.two_up_draw_odds),
        awayOdds: row.two_up_away_odds == null ? null : Number(row.two_up_away_odds),
        team: row.two_up_team,
      })),
    }
  })

  app.post('/api/admin/matches/:id/two-up', { preHandler: guardWrite }, async (req) => {
    const matchId = Number((req.params as { id: string }).id)
    const body = (req.body ?? {}) as { enabled?: unknown; homeOdds?: unknown; drawOdds?: unknown; awayOdds?: unknown; team?: unknown }
    if (!Number.isInteger(matchId)) throw new ApiError(404, 'not_found')
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'validation', { fields: { enabled: 'invalid' } })
    const team = body.team === 'home' || body.team === 'away' || body.team === 'both' ? body.team : null
    if (!team) throw new ApiError(400, 'validation', { fields: { team: 'invalid' } })
    const homeOdds = priceField(body.homeOdds, 'homeOdds')
    const drawOdds = priceField(body.drawOdds, 'drawOdds')
    const awayOdds = priceField(body.awayOdds, 'awayOdds')
    if (body.enabled && (homeOdds < 1.01 || drawOdds < 1.01 || awayOdds < 1.01)) {
      throw new ApiError(400, 'validation', { fields: { homeOdds: 'min' } })
    }
    const saved = await withTx(cfg, async (client) => {
      const match = await client.query<{ id: number }>(
        `UPDATE matches
            SET two_up_enabled = $2, two_up_home_odds = $3, two_up_draw_odds = $4, two_up_away_odds = $5, two_up_team = $6
          WHERE id = $1 AND status IN ('upcoming', 'live')
          RETURNING id`,
        [matchId, body.enabled, homeOdds, drawOdds, awayOdds, team],
      )
      if (!match.rows[0]) throw new ApiError(409, 'match_closed')
      const market = await client.query<{ id: number }>(
        `INSERT INTO markets (match_id, name, code)
         VALUES ($1, '2UP', '2UP')
         ON CONFLICT (match_id, code) DO UPDATE SET name = '2UP'
         RETURNING id`,
        [matchId],
      )
      const odds: { selection: string; price: number; id: number }[] = []
      for (const item of [{ selection: '1', price: homeOdds }, { selection: 'X', price: drawOdds }, { selection: '2', price: awayOdds }]) {
        const row = await client.query<{ id: number }>(
          `INSERT INTO odds (market_id, selection, price, suspended, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (market_id, selection) DO UPDATE
             SET price = EXCLUDED.price, suspended = EXCLUDED.suspended, updated_at = now()
           RETURNING id`,
          [market.rows[0].id, item.selection, item.price, !body.enabled],
        )
        odds.push({ selection: item.selection, price: item.price, id: row.rows[0].id })
      }
      return odds
    })
    await audit(cfg, req, 'matches.two_up', { matchId, enabled: body.enabled, homeOdds, drawOdds, awayOdds, team })
    return { id: matchId, enabled: body.enabled, team, odds: saved }
  })

  app.get('/api/admin/feed/runs', { preHandler: guardRead }, async () => {
    const { rows } = await getPool(cfg).query(
      `SELECT id, job, ok, detail, created_at FROM feed_runs ORDER BY id DESC LIMIT 30`,
    )
    return {
      enabled: operatorConfig.feedSyncEnabled,
      lifecycleEnabled: operatorConfig.lifecycleEnabled,
      intervals: {
        feedSyncIntervalSec: operatorConfig.feedSyncIntervalSec,
        liveOddsIntervalSec: operatorConfig.liveOddsIntervalSec,
        lifecycleIntervalSec: operatorConfig.lifecycleIntervalSec,
      },
      data: rows,
    }
  })

  app.get('/api/admin/bets', { preHandler: guardRead }, async (req) => {
    const status = (req.query as { status?: string }).status
    if (status && !['open', 'won', 'lost', 'void', 'cashout'].includes(status)) {
      throw new ApiError(400, 'validation', { fields: { status: 'invalid' } })
    }
    const totals = await getPool(cfg).query<{
      total: number
      open: number
      won: number
      lost: number
      voided: number
      stakes: string
      payouts: string
    }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'open')::int AS open,
         count(*) FILTER (WHERE status = 'won')::int AS won,
         count(*) FILTER (WHERE status = 'lost')::int AS lost,
         count(*) FILTER (WHERE status = 'void')::int AS voided,
         COALESCE(sum(stake_tzs), 0)::text AS stakes,
         COALESCE((SELECT sum(amount_tzs) FROM ledger_entries WHERE entry_type = 'bet_win'), 0)::text AS payouts
       FROM bets`,
    )
    const bets = await getPool(cfg).query<{
      id: string
      phone: string
      stake_tzs: string
      combined_odds: string
      potential_payout_tzs: string
      payout_percent_bps: number | string
      status: string
      placed_at: Date
      settled_at: Date | null
    }>(
      `SELECT b.id, u.phone, b.stake_tzs, b.combined_odds, b.potential_payout_tzs, b.payout_percent_bps, b.status, b.placed_at, b.settled_at
         FROM bets b
         JOIN users u ON u.id = b.user_id
        WHERE ($1::text IS NULL OR b.status = $1)
        ORDER BY b.placed_at DESC
        LIMIT 80`,
      [status ?? null],
    )
    const row = totals.rows[0]
    return {
      stats: {
        total: row.total,
        open: row.open,
        won: row.won,
        lost: row.lost,
        voided: row.voided,
        totalStakes: money(row.stakes),
        totalPayouts: money(row.payouts),
      },
      data: (await withLegs(cfg, bets.rows)).map((bet, index) => ({ ...bet, phone: bets.rows[index].phone })),
    }
  })
}

type BetRow = {
  id: string
  stake_tzs: string
  combined_odds: string
  potential_payout_tzs: string
  payout_percent_bps: number | string
  status: string
  placed_at: Date
  settled_at: Date | null
}

async function withLegs(cfg: AppConfig, bets: BetRow[]) {
  if (!bets.length) return []
  const legs = await getPool(cfg).query<{
    bet_id: string
    market: string
    selection: string
    odds_at_placement: string
    status: string
    home: string | null
    away: string | null
    league: string | null
  }>(
    `SELECT l.bet_id, l.market, l.selection, l.odds_at_placement, l.status, m.home, m.away, m.league
       FROM bet_legs l
       LEFT JOIN matches m ON m.id = l.match_id
      WHERE l.bet_id = ANY($1::uuid[])
      ORDER BY l.bet_id, m.kickoff_at`,
    [bets.map((bet) => bet.id)],
  )
  const grouped = new Map<string, { match: string; league: string; market: string; selection: string; odds: number; status: string }[]>()
  for (const leg of legs.rows) {
    const list = grouped.get(leg.bet_id) ?? []
    list.push({
      match: leg.home && leg.away ? `${leg.home} vs ${leg.away}` : '',
      league: leg.league ?? '',
      market: leg.market,
      selection: leg.selection,
      odds: Number(leg.odds_at_placement),
      status: leg.status,
    })
    grouped.set(leg.bet_id, list)
  }
  return bets.map((bet) => ({
    id: bet.id,
    stakeTzs: money(bet.stake_tzs),
    combinedOdds: Number(bet.combined_odds),
    potentialPayoutTzs: money(bet.potential_payout_tzs),
    payoutPercentBps: Number(bet.payout_percent_bps),
    status: bet.status,
    placedAt: bet.placed_at,
    settledAt: bet.settled_at,
    cashoutTzs: null as number | null,
    legs: grouped.get(bet.id) ?? [],
  }))
}

async function quoteCashout(cfg: AppConfig, userId: string, betId: string): Promise<number | null> {
  try {
    const { rows } = await getPool(cfg).query<{ v: string }>(
      `SELECT cashout_value($1, $2, $3)::text AS v`,
      [userId, betId, operatorConfig.cashoutMarginBps],
    )
    return money(rows[0]?.v)
  } catch {
    return null
  }
}
