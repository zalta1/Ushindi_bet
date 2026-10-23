import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'

export type Outcome = {
  sel: string
  price: number
  oddsId: number
  market: string
  suspended: boolean
}

export type PublicMatch = {
  id: number
  sport: string
  league: string
  country: string
  home: string
  away: string
  kickoff: string
  live: boolean
  minute: number
  hs: number
  as: number
  status: string
  source: string
  marketsCount: number
  odds: Outcome[]
  markets: Record<string, Outcome[]>
}

type Row = {
  id: number
  sport: string | null
  league: string | null
  country: string | null
  home: string | null
  away: string | null
  kickoff_at: Date | null
  status: string
  minute: number
  home_score: number
  away_score: number
  source: string
  market_code: string | null
  odds_id: number | null
  selection: string | null
  price: string | null
  suspended: boolean | null
}

function group(rows: Row[], includeSuspended: boolean): PublicMatch[] {
  const byId = new Map<number, PublicMatch>()
  for (const row of rows) {
    let match = byId.get(row.id)
    if (!match) {
      match = {
        id: row.id,
        sport: row.sport ?? 'Football',
        league: row.league ?? '',
        country: row.country ?? '',
        home: row.home ?? '',
        away: row.away ?? '',
        kickoff: row.kickoff_at ? new Date(row.kickoff_at).toISOString() : new Date(0).toISOString(),
        live: row.status === 'live',
        minute: row.minute ?? 0,
        hs: row.home_score ?? 0,
        as: row.away_score ?? 0,
        status: row.status,
        source: row.source ?? 'manual',
        marketsCount: 0,
        odds: [],
        markets: {},
      }
      byId.set(row.id, match)
    }
    if (!row.market_code || row.odds_id == null || row.selection == null || row.price == null) continue
    const suspended = Boolean(row.suspended)
    if (suspended && !includeSuspended) continue
    const outcome: Outcome = {
      sel: row.selection,
      price: Number(row.price),
      oddsId: row.odds_id,
      market: row.market_code,
      suspended,
    }
    const list = match.markets[row.market_code] ?? []
    list.push(outcome)
    match.markets[row.market_code] = list
    if (row.market_code === '1X2') match.odds.push(outcome)
  }
  for (const match of byId.values()) {
    match.marketsCount = Object.keys(match.markets).length
  }
  return [...byId.values()]
}

const select = `
  SELECT m.id, m.sport, m.league, m.country, m.home, m.away, m.kickoff_at, m.status,
         m.minute, m.home_score, m.away_score, m.source,
         mk.code AS market_code, o.id AS odds_id, o.selection, o.price, o.suspended
    FROM matches m
    LEFT JOIN markets mk ON mk.match_id = m.id
    LEFT JOIN odds o ON o.market_id = mk.id
`

export async function listPublicMatches(cfg: AppConfig, liveOnly = false): Promise<PublicMatch[]> {
  const { rows } = await getPool(cfg).query<Row>(
    `${select}
      WHERE m.status IN ('upcoming', 'live')
        AND ($1::boolean = false OR m.status = 'live')
      ORDER BY (m.status = 'live') DESC, m.kickoff_at, m.id, mk.id, o.id`,
    [liveOnly],
  )
  return group(rows, false)
}

export async function getPublicMatch(cfg: AppConfig, id: number): Promise<PublicMatch | null> {
  const { rows } = await getPool(cfg).query<Row>(
    `${select} WHERE m.id = $1 ORDER BY mk.id, o.id`,
    [id],
  )
  return group(rows, false)[0] ?? null
}

export async function listAdminMatches(cfg: AppConfig): Promise<PublicMatch[]> {
  const { rows } = await getPool(cfg).query<Row>(
    `${select}
      ORDER BY m.kickoff_at DESC NULLS LAST, m.id DESC, mk.id, o.id
      LIMIT 4000`,
  )
  return group(rows, true).slice(0, 80)
}
