import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { ApiError } from '../errors.js'

const BASE = 'https://v3.football.api-sports.io'
const TIMEZONE = 'Africa/Dar_es_Salaam'

const LIVE = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'])
const FINISHED = new Set(['FT', 'AET', 'PEN'])
const VOIDED = new Set(['CANC', 'ABD', 'AWD', 'WO'])
const MAJOR = new Set([39, 140, 135, 78, 61, 2, 3, 848])

type Bookmaker = {
  id?: number
  bets?: { id?: number; values?: { value?: string; odd?: string; suspended?: boolean; handicap?: string }[] }[]
}

export type ParsedSelection = { market: string; selection: string; price: number; line: number | null }

const PREMATCH = {
  winner: 1,
  homeAway: 2,
  handicap: 4,
  goals: 5,
  btts: 8,
  exact: 10,
  double: 12,
  oddEven: 21,
  dnb: 29,
  asian: 33,
  exactGoals: 38,
}
const LIVE_IDS = {
  winner: 59,
  goals: 36,
  btts: 69,
  double: 72,
  exact: 23,
  handicap: 21,
  asian: 33,
  dnb: 48,
  oddEven: 68,
}

function priceOf(odd: string | undefined): number | null {
  const n = Number(odd)
  if (!Number.isFinite(n) || n <= 1 || n > 1000) return null
  return Math.round(n * 100) / 100
}

function mapWinner(value: string): string | null {
  const v = value.toLowerCase()
  if (v === 'home' || v === '1') return '1'
  if (v === 'draw' || v === 'x') return 'X'
  if (v === 'away' || v === '2') return '2'
  return null
}

function mapBtts(value: string): string | null {
  const v = value.toLowerCase()
  if (v === 'yes') return 'Yes'
  if (v === 'no') return 'No'
  return null
}

function mapDouble(value: string): string | null {
  const v = value.toLowerCase().replace(/\s+/g, '')
  if (v === '1x' || v === 'home/draw' || v === 'homedraw') return '1X'
  if (v === '12' || v === 'home/away' || v === 'homeaway') return '12'
  if (v === 'x2' || v === 'draw/away' || v === 'drawaway') return 'X2'
  return null
}

function mapOverUnder(value: string): { selection: string; line: number } | null {
  const match = /^(over|under)\s+([0-9]+(?:\.[0-9]+)?)$/i.exec(value.trim())
  if (!match) return null
  const line = Number(match[2])
  if (!Number.isFinite(line)) return null
  const side = match[1].toLowerCase() === 'over' ? 'Over' : 'Under'
  return { selection: `${side} ${match[2]}`, line }
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function pushParsed(out: ParsedSelection[], seen: Set<string>, market: string, selection: string, price: number, line: number | null) {
  const key = `${market}:${selection}`
  if (seen.has(key)) return
  seen.add(key)
  out.push({ market, selection, price, line })
}

/** Turns an API-Football /odds bookmaker list into the markets we settle. */
export function parseApiFootballBookmakers(bookmakers: unknown, mode: 'prematch' | 'live' = 'prematch'): ParsedSelection[] {
  if (!Array.isArray(bookmakers) || bookmakers.length === 0) return []
  const rows = bookmakers as Bookmaker[]
  const book = rows.find((item) => item.id === 8) ?? rows[0]
  const ids = mode === 'live' ? LIVE_IDS : PREMATCH
  const out: ParsedSelection[] = []
  const seen = new Set<string>()
  for (const bet of book.bets ?? []) {
    for (const value of bet.values ?? []) {
      if (value.suspended) continue
      const price = priceOf(value.odd)
      const label = (value.value ?? '').trim()
      if (price == null || !label) continue
      if (bet.id === ids.winner) {
        const mapped = mapWinner(label)
        if (!mapped) continue
        pushParsed(out, seen, '1X2', mapped, price, null)
      } else if (bet.id === ids.btts) {
        const mapped = mapBtts(label)
        if (!mapped) continue
        pushParsed(out, seen, 'BTTS', mapped, price, null)
      } else if (bet.id === ids.double) {
        const mapped = mapDouble(label)
        if (!mapped) continue
        pushParsed(out, seen, 'Double Chance', mapped, price, null)
      } else if (bet.id === ids.goals) {
        const mapped = mapOverUnder(label)
        if (!mapped) continue
        pushParsed(out, seen, 'Over/Under', mapped.selection, price, mapped.line)
      } else if (bet.id === ids.exact && /^[0-9]+\s*[-:]\s*[0-9]+$/.test(label)) {
        const [home, away] = label.split(/[-:]/).map((part) => Number(part))
        if (home > 4 || away > 4) continue
        pushParsed(out, seen, 'Correct Score', `${home}-${away}`, price, null)
      } else if (bet.id === ids.handicap) {
        const match = /^(Home|Draw|Away)\s*([+-]?\d+(?:\.\d+)?)/i.exec(label)
        if (!match) continue
        const line = Number(match[2])
        const side = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase()
        pushParsed(out, seen, `3-Way Handicap ${signed(line)}`, `${side} ${signed(line)}`, price, line)
      } else if (bet.id === ids.asian) {
        const match = /^(Home|Away)\s*([+-]?\d+(?:\.\d+)?)/i.exec(label)
        if (!match) continue
        const raw = Number(value.handicap ?? match[2])
        if (!Number.isFinite(raw)) continue
        const code = `2-Way Handicap ${signed(raw)}`
        if (match[1].toLowerCase() === 'home') pushParsed(out, seen, code, `Home ${signed(raw)}`, price, raw)
        else pushParsed(out, seen, code, `Away ${signed(-raw)}`, price, raw)
      } else if (mode === 'prematch' && bet.id === PREMATCH.homeAway) {
        const mapped = mapWinner(label)
        if (mapped !== '1' && mapped !== '2') continue
        pushParsed(out, seen, 'Home/Away', mapped, price, null)
      } else if (bet.id === ids.dnb) {
        const mapped = mapWinner(label)
        if (mapped !== '1' && mapped !== '2') continue
        pushParsed(out, seen, 'Draw No Bet', mapped, price, null)
      } else if (bet.id === ids.oddEven) {
        const side = label.toLowerCase()
        if (side !== 'odd' && side !== 'even') continue
        pushParsed(out, seen, 'Odd/Even', side === 'odd' ? 'Odd' : 'Even', price, null)
      } else if (mode === 'prematch' && bet.id === PREMATCH.exactGoals && /^[0-9]+\+?$/.test(label)) {
        pushParsed(out, seen, 'Exact Goals', label, price, null)
      }
      if (out.length >= 40) return out
    }
  }
  return out
}

type Fixture = {
  fixture?: { id?: number; date?: string; status?: { short?: string; elapsed?: number | null } }
  league?: { id?: number; name?: string; country?: string }
  teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } }
  goals?: { home?: number | null; away?: number | null }
}

function darDate(offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

async function apiGet(path: string, params: Record<string, string>, key: string): Promise<unknown> {
  const url = new URL(`${BASE}/${path}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  if (!url.searchParams.has('timezone') && (path === 'fixtures' || path === 'odds')) {
    url.searchParams.set('timezone', TIMEZONE)
  }
  const res = await fetch(url, {
    headers: { 'x-apisports-key': key, accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new ApiError(502, 'feed_unavailable')
  return res.json()
}

export async function activeApiKeys(cfg: AppConfig): Promise<{ id: string | null; label: string; apiKey: string }[]> {
  const { rows } = await getPool(cfg).query<{ id: string; label: string; api_key: string }>(
    `SELECT id, label, api_key FROM match_api_keys WHERE is_active = true ORDER BY created_at`,
  )
  const keys: { id: string | null; label: string; apiKey: string }[] = rows.map((row) => ({ id: row.id, label: row.label, apiKey: row.api_key }))
  const env = process.env.API_SPORTS_KEY?.trim()
  if (env) keys.unshift({ id: null, label: 'API_SPORTS_KEY', apiKey: env })
  return keys
}

export async function checkApiFootballKey(key: string): Promise<{ ok: boolean; message: string; plan?: string; used?: number; limit?: number }> {
  try {
    const body = await apiGet('status', {}, key) as {
      response?: { subscription?: { plan?: string }; requests?: { current?: number; limit_day?: number } }
      errors?: Record<string, string> | unknown[]
    }
    const errors = body.errors
    const errorText = errors && !Array.isArray(errors) ? Object.values(errors)[0] : Array.isArray(errors) && errors.length ? String(errors[0]) : ''
    if (errorText) return { ok: false, message: String(errorText).slice(0, 180) }
    const plan = body.response?.subscription?.plan
    const used = body.response?.requests?.current
    const limit = body.response?.requests?.limit_day
    return { ok: true, message: 'ok', plan, used, limit }
  } catch {
    return { ok: false, message: 'Haifanyi kazi' }
  }
}

async function ensureLeague(cfg: AppConfig, name: string, country: string): Promise<number> {
  const sport = await getPool(cfg).query<{ id: number }>(
    `INSERT INTO sports (code, name_en, name_sw)
     VALUES ('football', 'Football', 'Mpira wa Miguu')
     ON CONFLICT (code) DO UPDATE SET name_en = EXCLUDED.name_en
     RETURNING id`,
  )
  const league = await getPool(cfg).query<{ id: number }>(
    `INSERT INTO leagues (sport_id, name, country)
     VALUES ($1, $2, $3)
     ON CONFLICT (sport_id, name, country) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [sport.rows[0].id, name.slice(0, 80), country.slice(0, 80)],
  )
  return league.rows[0].id
}

async function upsertFixture(cfg: AppConfig, fx: Fixture): Promise<{ id: number; status: string } | null> {
  const fixtureId = fx.fixture?.id
  const home = fx.teams?.home?.name?.trim()
  const away = fx.teams?.away?.name?.trim()
  if (!fixtureId || !home || !away) return null
  const short = (fx.fixture?.status?.short ?? 'NS').toUpperCase()
  const status = LIVE.has(short) ? 'live' : 'upcoming'
  const leagueName = fx.league?.name?.trim() || 'Football'
  const country = fx.league?.country?.trim() || ''
  const leagueId = await ensureLeague(cfg, leagueName, country)
  const minute = Number(fx.fixture?.status?.elapsed ?? 0) || 0
  const homeScore = fx.goals?.home ?? 0
  const awayScore = fx.goals?.away ?? 0
  const kickoff = fx.fixture?.date ?? new Date().toISOString()
  const { rows } = await getPool(cfg).query<{ id: number; status: string }>(
    `INSERT INTO matches (
       sport, league, country, home, away, kickoff_at, status, minute, home_score, away_score,
       api_fixture_id, source, league_id, api_home_id, api_away_id
     ) VALUES ('Football', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'api-football', $11, $12, $13)
     ON CONFLICT (api_fixture_id) DO UPDATE SET
       league = EXCLUDED.league,
       country = EXCLUDED.country,
       minute = EXCLUDED.minute,
       status = CASE
         WHEN matches.status IN ('finished', 'void') THEN matches.status
         ELSE EXCLUDED.status
       END,
       home_score = CASE
         WHEN matches.status IN ('finished', 'void') THEN matches.home_score
         ELSE EXCLUDED.home_score
       END,
       away_score = CASE
         WHEN matches.status IN ('finished', 'void') THEN matches.away_score
         ELSE EXCLUDED.away_score
       END,
       league_id = EXCLUDED.league_id,
       api_home_id = COALESCE(EXCLUDED.api_home_id, matches.api_home_id),
       api_away_id = COALESCE(EXCLUDED.api_away_id, matches.api_away_id)
     RETURNING id, status`,
    [leagueName, country, home, away, kickoff, status, minute, homeScore, awayScore, fixtureId, leagueId, fx.teams?.home?.id ?? null, fx.teams?.away?.id ?? null],
  )
  return rows[0] ?? null
}

async function writeOdds(cfg: AppConfig, matchId: number, selections: ParsedSelection[]) {
  for (const item of selections) {
    const market = await getPool(cfg).query<{ id: number }>(
      `INSERT INTO markets (match_id, name, code, line)
       VALUES ($1, $2, $2, $3)
       ON CONFLICT (match_id, code) DO UPDATE SET line = COALESCE(EXCLUDED.line, markets.line)
       RETURNING id`,
      [matchId, item.market, item.line],
    )
    await getPool(cfg).query(
      `INSERT INTO odds (market_id, selection, price, suspended, updated_at)
       VALUES ($1, $2, $3, false, now())
       ON CONFLICT (market_id, selection) DO UPDATE
         SET price = EXCLUDED.price, suspended = false, updated_at = now()`,
      [market.rows[0].id, item.selection, item.price],
    )
  }
}

export async function syncApiFootball(cfg: AppConfig, actorId: string | null) {
  if (cfg.isTest) throw new ApiError(400, 'feed_disabled_in_test')
  const keys = await activeApiKeys(cfg)
  if (!keys.length) throw new ApiError(400, 'no_api_key')
  const key = keys[0].apiKey
  const dates = [darDate(0), darDate(1)]
  const fixtures: Fixture[] = []
  const seen = new Set<number>()
  const push = (list: Fixture[]) => {
    for (const fx of list) {
      const id = fx.fixture?.id
      if (!id || seen.has(id)) continue
      seen.add(id)
      fixtures.push(fx)
    }
  }
  for (const date of dates) {
    const body = await apiGet('fixtures', { date }, key) as { response?: Fixture[] }
    push(body.response ?? [])
  }
  const liveBody = await apiGet('fixtures', { live: 'all' }, key) as { response?: Fixture[] }
  push(liveBody.response ?? [])

  fixtures.sort((a, b) => {
    const aMajor = MAJOR.has(a.league?.id ?? 0) ? 0 : 1
    const bMajor = MAJOR.has(b.league?.id ?? 0) ? 0 : 1
    if (aMajor !== bMajor) return aMajor - bMajor
    const aLive = LIVE.has((a.fixture?.status?.short ?? '').toUpperCase()) ? 0 : 1
    const bLive = LIVE.has((b.fixture?.status?.short ?? '').toUpperCase()) ? 0 : 1
    return aLive - bLive
  })
  const batch = fixtures.slice(0, 25)
  let imported = 0
  let settled = 0
  let voided = 0
  let oddsWritten = 0
  for (const fx of batch) {
    const short = (fx.fixture?.status?.short ?? '').toUpperCase()
    const saved = await upsertFixture(cfg, fx)
    if (!saved) continue
    imported += 1
    if (saved.status === 'finished' || saved.status === 'void') continue
    try {
      if (FINISHED.has(short)) {
        const home = fx.goals?.home
        const away = fx.goals?.away
        if (home == null || away == null) continue
        await getPool(cfg).query(
          `SELECT settle_match_atomic($1, $2, $3, $4, false, 'api-football')`,
          [saved.id, home, away, actorId],
        )
        settled += 1
        continue
      }
      if (VOIDED.has(short)) {
        await getPool(cfg).query(
          `SELECT settle_match_atomic($1, 0, 0, $2, true, 'api-football')`,
          [saved.id, actorId],
        )
        voided += 1
        continue
      }
      if (LIVE.has(short)) {
        await getPool(cfg).query(`SELECT process_two_up($1)`, [saved.id])
      }
    } catch {
      continue
    }
    if (oddsWritten >= 8 || !fx.fixture?.id) continue
    const oddsBody = await apiGet('odds', { fixture: String(fx.fixture.id) }, key) as {
      response?: { bookmakers?: unknown }[]
    }
    const parsed = parseApiFootballBookmakers(oddsBody.response?.[0]?.bookmakers)
    if (parsed.length) {
      await writeOdds(cfg, saved.id, parsed)
      oddsWritten += 1
    }
  }
  return { imported, settled, voided, oddsWritten, dates }
}

type LiveOdd = {
  fixture?: { id?: number }
  status?: { stopped?: boolean; blocked?: boolean; finished?: boolean }
  odds?: { id?: number; values?: { value?: string; odd?: string; suspended?: boolean; handicap?: string }[] }[]
}

/** One /odds/live call. Skips stopped, blocked, and finished prices. */
export async function refreshLiveOdds(cfg: AppConfig): Promise<{ updated: number }> {
  if (cfg.isTest) return { updated: 0 }
  const keys = await activeApiKeys(cfg)
  if (!keys.length) return { updated: 0 }
  const body = await apiGet('odds/live', {}, keys[0].apiKey) as { response?: LiveOdd[] }
  let updated = 0
  for (const entry of body.response ?? []) {
    if (updated >= 8) break
    const fixtureId = entry.fixture?.id
    if (!fixtureId || entry.status?.stopped || entry.status?.blocked || entry.status?.finished) continue
    const match = await getPool(cfg).query<{ id: number }>(
      `SELECT id FROM matches WHERE api_fixture_id = $1 AND status = 'live'`,
      [fixtureId],
    )
    if (!match.rows[0]) continue
    const parsed = parseApiFootballBookmakers([{ bets: entry.odds }], 'live')
    if (!parsed.length) continue
    await writeOdds(cfg, match.rows[0].id, parsed)
    updated += 1
  }
  return { updated }
}
