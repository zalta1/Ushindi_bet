import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { activeApiKeys } from './feed.js'

const BASE = 'https://v3.football.api-sports.io'
const TIMEZONE = 'Africa/Dar_es_Salaam'

export type MatchDetails = {
  source: 'cache' | 'api' | 'sample' | 'unavailable'
  note: string
  events: { minute: number; team: string; type: string; detail: string; player: string }[]
  lineups: { homeFormation: string; awayFormation: string; home: string[]; away: string[] }
  h2h: { date: string; home: string; away: string; hs: number; as: number }[]
  injuries: { team: string; player: string; reason: string }[]
  last: { home: { date: string; opponent: string; hs: number; as: number }[]; away: { date: string; opponent: string; hs: number; as: number }[] }
  stats: { homePossession: number | null; awayPossession: number | null }
}

const empty = (note: string, source: MatchDetails['source']): MatchDetails => ({
  source,
  note,
  events: [],
  lineups: { homeFormation: '', awayFormation: '', home: [], away: [] },
  h2h: [],
  injuries: [],
  last: { home: [], away: [] },
  stats: { homePossession: null, awayPossession: null },
})

function asDetails(value: unknown): MatchDetails | null {
  if (!value || typeof value !== 'object') return null
  const row = value as MatchDetails
  if (!row.source || !Array.isArray(row.events)) return null
  return row
}

async function apiGet(path: string, params: Record<string, string>, key: string): Promise<unknown> {
  const url = new URL(`${BASE}/${path}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  if (path === 'fixtures' && !url.searchParams.has('timezone')) url.searchParams.set('timezone', TIMEZONE)
  const res = await fetch(url, {
    headers: { 'x-apisports-key': key, accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error('feed_unavailable')
  return res.json()
}

function names(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list
    .map((item) => {
      const player = (item as { player?: { name?: string } }).player?.name
      return typeof player === 'string' ? player : ''
    })
    .filter(Boolean)
    .slice(0, 11)
}

function mapFixture(row: {
  fixture?: { date?: string; status?: { elapsed?: number | null } }
  teams?: { home?: { name?: string }; away?: { name?: string } }
  goals?: { home?: number | null; away?: number | null }
  events?: { time?: { elapsed?: number }; team?: { name?: string }; type?: string; detail?: string; player?: { name?: string } }[]
  lineups?: { team?: { name?: string }; formation?: string; startXI?: unknown }[]
  statistics?: { team?: { name?: string }; statistics?: { type?: string; value?: string | number | null }[] }[]
}, homeName: string, awayName: string) {
  const events = (row.events ?? []).slice(0, 40).map((event) => ({
    minute: Number(event.time?.elapsed ?? 0),
    team: event.team?.name === awayName ? 'away' : 'home',
    type: event.type ?? '',
    detail: event.detail ?? '',
    player: event.player?.name ?? '',
  }))
  const homeLine = row.lineups?.find((line) => line.team?.name === homeName)
  const awayLine = row.lineups?.find((line) => line.team?.name === awayName)
  const possession = (name: string) => {
    const block = row.statistics?.find((item) => item.team?.name === name)
    const stat = block?.statistics?.find((item) => item.type === 'Ball Possession')
    const n = Number(String(stat?.value ?? '').replace('%', ''))
    return Number.isFinite(n) ? n : null
  }
  return { events, homeLine, awayLine, homePossession: possession(homeName), awayPossession: possession(awayName) }
}

export async function loadMatchDetails(cfg: AppConfig, match: { id: number; live: boolean; home: string; away: string }): Promise<MatchDetails> {
  const pool = getPool(cfg)
  const cached = await pool.query<{ payload: unknown; fetched_at: Date }>(
    `SELECT payload, fetched_at FROM match_feed_cache WHERE match_id = $1`,
    [match.id],
  )
  const stored = asDetails(cached.rows[0]?.payload)
  const ageMs = cached.rows[0] ? Date.now() - new Date(cached.rows[0].fetched_at).getTime() : Infinity
  const ttl = match.live ? 60_000 : 600_000
  if (stored && stored.source !== 'sample' && ageMs < ttl) return { ...stored, source: 'cache' }
  if (cfg.isTest) return stored ?? empty('Hakuna takwimu za mechi hii kwa sasa.', 'unavailable')

  const keys = await activeApiKeys(cfg)
  if (!keys.length) {
    if (stored) return stored
    return empty('Hakuna ufunguo wa API-Football. Mechi na odds zinaendelea kutoka kwenye orodha.', 'unavailable')
  }

  const row = await pool.query<{ api_fixture_id: string | null; api_home_id: number | null; api_away_id: number | null }>(
    `SELECT api_fixture_id::text, api_home_id, api_away_id FROM matches WHERE id = $1`,
    [match.id],
  )
  const fixtureId = row.rows[0]?.api_fixture_id
  if (!fixtureId) {
    if (stored) return stored
    return empty('Mechi hii imewekwa kwa mkono. Takwimu za API-Football hazipo.', 'unavailable')
  }

  try {
    const key = keys[0].apiKey
    const fixtureBody = await apiGet('fixtures', { id: fixtureId }, key) as { response?: Parameters<typeof mapFixture>[0][] }
    const fx = fixtureBody.response?.[0]
    const mapped = fx ? mapFixture(fx, match.home, match.away) : null
    const homeId = row.rows[0]?.api_home_id
    const awayId = row.rows[0]?.api_away_id
    let h2h: MatchDetails['h2h'] = []
    if (homeId && awayId) {
      const h2hBody = await apiGet('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: '5' }, key) as {
        response?: { fixture?: { date?: string }; teams?: { home?: { name?: string }; away?: { name?: string } }; goals?: { home?: number | null; away?: number | null } }[]
      }
      h2h = (h2hBody.response ?? []).slice(0, 5).map((item) => ({
        date: item.fixture?.date ?? '',
        home: item.teams?.home?.name ?? '',
        away: item.teams?.away?.name ?? '',
        hs: item.goals?.home ?? 0,
        as: item.goals?.away ?? 0,
      }))
    }
    const injuriesBody = await apiGet('injuries', { fixture: fixtureId }, key) as {
      response?: { team?: { name?: string }; player?: { name?: string; reason?: string } }[]
    }
    const injuries = (injuriesBody.response ?? []).slice(0, 12).map((item) => ({
      team: item.team?.name === match.away ? 'away' : 'home',
      player: item.player?.name ?? '',
      reason: item.player?.reason ?? '',
    }))
    const lastFor = async (teamId: number | null, own: string) => {
      if (!teamId) return []
      const body = await apiGet('fixtures', { team: String(teamId), last: '5' }, key) as {
        response?: { fixture?: { date?: string }; teams?: { home?: { name?: string }; away?: { name?: string } }; goals?: { home?: number | null; away?: number | null } }[]
      }
      return (body.response ?? []).slice(0, 5).map((item) => {
        const homeName = item.teams?.home?.name ?? ''
        const awayName = item.teams?.away?.name ?? ''
        const ownHome = homeName === own
        return {
          date: item.fixture?.date ?? '',
          opponent: ownHome ? awayName : homeName,
          hs: ownHome ? (item.goals?.home ?? 0) : (item.goals?.away ?? 0),
          as: ownHome ? (item.goals?.away ?? 0) : (item.goals?.home ?? 0),
        }
      })
    }
    const payload: MatchDetails = {
      source: 'api',
      note: '',
      events: mapped?.events ?? [],
      lineups: {
        homeFormation: mapped?.homeLine?.formation ?? '',
        awayFormation: mapped?.awayLine?.formation ?? '',
        home: names(mapped?.homeLine?.startXI),
        away: names(mapped?.awayLine?.startXI),
      },
      h2h,
      injuries,
      last: { home: await lastFor(homeId, match.home), away: await lastFor(awayId, match.away) },
      stats: { homePossession: mapped?.homePossession ?? null, awayPossession: mapped?.awayPossession ?? null },
    }
    await pool.query(
      `INSERT INTO match_feed_cache (match_id, payload, fetched_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (match_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [match.id, JSON.stringify(payload)],
    )
    return payload
  } catch {
    if (stored) return stored
    return empty('API-Football haijapatikana kwa sasa. Odds za mechi bado zipo.', 'unavailable')
  }
}
