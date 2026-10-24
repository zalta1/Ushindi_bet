import type { AppConfig } from '../config.js'
import { getPool } from '../db.js'
import { operatorConfig } from '../operator-config.js'
import { activeApiKeys, refreshLiveOdds, syncApiFootball } from './feed.js'

const LOCK_KEY = 842164219
let timer: NodeJS.Timeout | null = null
let lastFeed = 0
let lastLive = 0
let lastLife = 0

async function logRun(cfg: AppConfig, job: string, ok: boolean, detail: unknown) {
  await getPool(cfg).query(
    `INSERT INTO feed_runs (job, ok, detail) VALUES ($1, $2, $3::jsonb)`,
    [job, ok, JSON.stringify(detail)],
  )
}

async function runLifecycle(cfg: AppConfig, client: import('pg').PoolClient) {
  const started = await client.query<{ id: number }>(
    `UPDATE matches
        SET status = 'live', minute = 0
      WHERE status = 'upcoming' AND kickoff_at <= now()
      RETURNING id`,
  )
  const live = await client.query<{ id: number; minute: number; elapsed: number; home_score: number; away_score: number }>(
    `SELECT id, minute, home_score, away_score,
            GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - kickoff_at)) / 60))::int AS elapsed
       FROM matches
      WHERE status = 'live' AND source = 'manual'
      FOR UPDATE`,
  )
  let settled = 0
  for (const match of live.rows) {
    const elapsed = Number(match.elapsed)
    const shown = Math.min(88, elapsed)
    if (shown !== match.minute && elapsed < 90) {
      await client.query(`UPDATE matches SET minute = $2 WHERE id = $1`, [match.id, shown])
    }
    await client.query(`SELECT process_two_up($1)`, [match.id])
    if (elapsed >= 90) {
      await client.query(`UPDATE matches SET minute = 90 WHERE id = $1 AND status = 'live'`, [match.id])
      const result = await client.query<{ result: { already_settled?: boolean } }>(
        `SELECT settle_match_atomic($1, $2, $3, NULL, false, 'auto full time') AS result`,
        [match.id, match.home_score, match.away_score],
      )
      if (!result.rows[0]?.result?.already_settled) settled += 1
    }
  }
  return { started: started.rowCount ?? started.rows.length, checked: live.rows.length, settled }
}

export async function runSportsCycle(cfg: AppConfig, opts: { force?: boolean } = {}) {
  if (!operatorConfig.feedSyncEnabled && !operatorConfig.lifecycleEnabled) {
    return { skipped: true }
  }
  const pool = getPool(cfg)
  const client = await pool.connect()
  try {
    const locked = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY])
    if (!locked.rows[0]?.ok) return { skipped: true, reason: 'locked' }
    const now = Date.now()
    const detail: Record<string, unknown> = {}
    try {
      if (operatorConfig.lifecycleEnabled && (opts.force || now - lastLife >= operatorConfig.lifecycleIntervalSec * 1000)) {
        detail.lifecycle = await runLifecycle(cfg, client)
        lastLife = now
      }
      if (!cfg.isTest && operatorConfig.feedSyncEnabled && (opts.force || now - lastFeed >= operatorConfig.feedSyncIntervalSec * 1000)) {
        const keys = await activeApiKeys(cfg)
        if (keys.length) {
          detail.import = await syncApiFootball(cfg, null)
          lastFeed = now
        } else {
          detail.import = { skipped: 'no_api_key' }
        }
      }
      if (!cfg.isTest && operatorConfig.feedSyncEnabled && (opts.force || now - lastLive >= operatorConfig.liveOddsIntervalSec * 1000)) {
        detail.liveOdds = await refreshLiveOdds(cfg).catch((err: unknown) => ({ error: err instanceof Error ? err.message : 'feed_unavailable' }))
        lastLive = now
      }
      await logRun(cfg, 'sports-cycle', true, detail)
      return { skipped: false, detail }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'worker_failed'
      await logRun(cfg, 'sports-cycle', false, { error: message })
      return { skipped: false, error: message }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
    }
  } finally {
    client.release()
  }
}

export function startSportsWorker(cfg: AppConfig): () => void {
  if (cfg.isTest || timer) return () => undefined
  timer = setInterval(() => {
    void runSportsCycle(cfg).catch(() => undefined)
  }, 15_000)
  timer.unref()
  return () => {
    if (timer) clearInterval(timer)
    timer = null
  }
}
