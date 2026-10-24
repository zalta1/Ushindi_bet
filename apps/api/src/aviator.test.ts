import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AVIATOR_LOCK_KEY, recoverAviator, tickAviator } from './aviator/engine.js'
import { crashHash, crashPointFromHash, multiplierAt } from './aviator/fairness.js'

process.env.NODE_ENV = 'test'
process.env.COOKIE_SECURE = 'false'
process.env.TRUST_PROXY = 'false'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ushindi:local_dev_only_change_me_1@127.0.0.1:5432/ushindi_test'
process.env.MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
delete process.env.SUPER_ADMIN_PHONE
delete process.env.SUPER_ADMIN_PASSWORD
delete process.env.ADMIN_PHONE
delete process.env.ADMIN_PASSWORD
delete process.env.API_SPORTS_KEY
delete process.env.REDIS_URL

const dbName = new URL(process.env.DATABASE_URL).pathname
if (!dbName.includes('test')) throw new Error(`Refusing to run aviator tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 1200
let keyN = 0

function nextPhone() {
  n += 1
  return phone(n)
}

function nextKey() {
  keyN += 1
  return `aviator-key-${String(keyN).padStart(8, '0')}`
}

function payoutOf(stake: number, mult: number, maxWin = operatorConfig.aviatorMaxWin) {
  return Math.min(Math.floor(stake * mult + 1e-6), maxWin)
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  Object.assign(operatorConfig, {
    aviatorEnabled: true,
    aviatorRtpBps: 9600,
    aviatorMaxMultiplier: 1000,
    aviatorMinStake: 100,
    aviatorMaxStake: 2_000_000,
    aviatorMaxWin: 10_000_000,
    aviatorBettingMs: 5000,
    aviatorCrashedMs: 5000,
  })
  await pool.query(`DELETE FROM settings`)
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`TRUNCATE aviator_rounds RESTART IDENTITY CASCADE`)
  await pool.query(
    `INSERT INTO aviator_state (id, phase, round_id, phase_started_at)
     VALUES (1, 'idle', NULL, '2000-01-01')
     ON CONFLICT (id) DO UPDATE
       SET phase = 'idle', round_id = NULL, phase_started_at = '2000-01-01', updated_at = clock_timestamp()`,
  )
  await pool.query(`SELECT setval('aviator_round_no_seq', 1, false)`)
})

after(async () => {
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  return { client, number, id: created.json.user.id as string }
}

async function adminAndPlayer(balance = 50_000) {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit',
    amountTzs: balance,
    reason: 'aviator test stake',
  })
  assert.equal(credited.status, 200, JSON.stringify(credited.json))
  return { admin, player }
}

async function balanceOf(client: Client) {
  const me = await client.send('GET', '/api/auth/me')
  assert.equal(me.status, 200, JSON.stringify(me.json))
  return me.json.user.balanceTzs as number
}

async function openBetting() {
  const tick = await tickAviator(cfg)
  assert.equal(tick.skipped, false)
  if (tick.skipped) throw new Error('locked')
  assert.equal(tick.action, 'betting')
  return tick.roundId as string
}

async function forceFlying(roundId: string, crashPoint: number, seconds: number) {
  await pool.query(
    `UPDATE aviator_rounds
        SET crash_point = $2, status = 'flying',
            flying_started_at = clock_timestamp() - make_interval(secs => $3)
      WHERE id = $1`,
    [roundId, crashPoint, seconds],
  )
  await pool.query(
    `UPDATE aviator_state
        SET phase = 'flying', round_id = $1,
            phase_started_at = clock_timestamp() - make_interval(secs => $2),
            updated_at = clock_timestamp()
      WHERE id = 1`,
    [roundId, seconds],
  )
}

test('crash points follow the bustabit formula, the cap, and the published seed hash', () => {
  const serverSeed = 'abc123seed'
  const clientSeed = 'ushindi'
  const nonce = 7
  const hash = createHash('sha256').update(`${serverSeed}${clientSeed}${nonce}`).digest('hex')
  assert.equal(crashHash(serverSeed, clientSeed, nonce), hash)
  const h = parseInt(hash.slice(0, 13), 16)
  const houseEdge = Math.max(0.005, Math.min(0.5, 1 - 96 / 100))
  const mod = Math.floor(1 / houseEdge)
  assert.equal(mod, 24)
  let expected = 1
  if (h % mod !== 0) {
    const e = 2 ** 52
    expected = Math.min(1000, Math.floor((100 * e) / (e - h)) / 100)
    expected = Number(expected.toFixed(2))
  }
  assert.equal(crashPointFromHash(hash, 96, 1000), expected)

  let instant = false
  for (let n = 1; n < 8000; n += 1) {
    const sample = crashHash(serverSeed, clientSeed, n)
    const bits = parseInt(sample.slice(0, 13), 16)
    if (bits % mod === 0) {
      assert.equal(crashPointFromHash(sample, 96, 1000), 1)
      instant = true
      break
    }
  }
  assert.equal(instant, true)

  const huge = crashPointFromHash('f'.repeat(64), 96, 1000)
  assert.equal(huge, 1000)
  assert.equal(sha256(serverSeed), createHash('sha256').update(serverSeed).digest('hex'))
})

test('the multiplier curve matches Postgres within one cent', async () => {
  for (const seconds of [0, 1, 3, 6, 10, 15, 30]) {
    const { rows } = await pool.query<{ m: string }>(`SELECT aviator_multiplier($1) AS m`, [seconds])
    const sql = Number(rows[0].m)
    const ts = multiplierAt(seconds)
    assert.ok(Math.abs(sql - ts) <= 0.01, `${seconds}s sql ${sql} ts ${ts}`)
  }
  assert.equal(multiplierAt(3), 1.23)
})

test('a round hides the server seed until it crashes, and the crash matches the hash', async () => {
  const roundId = await openBetting()
  const hidden = await app.inject({ method: 'GET', url: '/api/aviator/state' })
  const body = JSON.parse(hidden.body)
  assert.equal(body.phase, 'betting')
  assert.equal(body.round.serverSeed, null)
  assert.equal(body.round.crashPoint, null)
  assert.equal(body.round.clientSeed, 'ushindi')
  assert.equal(body.round.serverSeedHash.length, 64)

  const stored = await pool.query<{ server_seed: string, server_seed_hash: string, crash_point: string, nonce: string, rtp_bps: number, max_multiplier: string }>(
    `SELECT server_seed, server_seed_hash, crash_point, nonce, rtp_bps, max_multiplier FROM aviator_rounds WHERE id = $1`,
    [roundId],
  )
  const row = stored.rows[0]
  assert.equal(row.server_seed_hash, createHash('sha256').update(row.server_seed).digest('hex'))
  const expected = crashPointFromHash(
    crashHash(row.server_seed, 'ushindi', Number(row.nonce)),
    row.rtp_bps / 100,
    Number(row.max_multiplier),
  )
  assert.equal(Number(row.crash_point).toFixed(2), expected.toFixed(2))

  await pool.query(`UPDATE aviator_rounds SET crash_point = 1, betting_ends_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [roundId])
  const crashed = await tickAviator(cfg)
  assert.equal(crashed.skipped, false)
  if (crashed.skipped) throw new Error('locked')
  assert.equal(crashed.action, 'crashed')
  const revealed = JSON.parse((await app.inject({ method: 'GET', url: `/api/aviator/rounds/${roundId}` })).body)
  assert.equal(revealed.status, 'crashed')
  assert.equal(revealed.serverSeed, row.server_seed)
  assert.equal(Number(revealed.crashPoint).toFixed(2), '1.00')
  const live = JSON.parse((await app.inject({ method: 'GET', url: '/api/aviator/state' })).body)
  assert.equal(live.round.serverSeed, row.server_seed)
})

test('a bet cashes out once at the server multiplier and a later cashout does not pay again', async () => {
  const { player } = await adminAndPlayer()
  const roundId = await openBetting()
  const before = await balanceOf(player.client)
  const placed = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 1000,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(placed.status, 200, JSON.stringify(placed.json))
  const secondPanel = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 500,
    panel: 2,
    idempotencyKey: nextKey(),
  })
  assert.equal(secondPanel.status, 200, JSON.stringify(secondPanel.json))
  const duplicate = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 1000,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(duplicate.status, 409)
  assert.equal(await balanceOf(player.client), before - 1500)

  await forceFlying(roundId, 20, 4)
  const low = await player.client.send('POST', '/api/aviator/cashout', { betId: placed.json.betId, multiplier: 50 })
  assert.equal(low.status, 400)

  const cashed = await player.client.send('POST', '/api/aviator/cashout', { betId: placed.json.betId })
  assert.equal(cashed.status, 200, JSON.stringify(cashed.json))
  const mult = Number(cashed.json.multiplier)
  assert.ok(mult >= 1.2 && mult < 2, `multiplier ${mult}`)
  const expected = payoutOf(1000, mult)
  assert.equal(cashed.json.payoutTzs, expected)
  const after = await balanceOf(player.client)
  assert.equal(after, before - 1500 + expected)

  const again = await player.client.send('POST', '/api/aviator/cashout', { betId: placed.json.betId })
  assert.equal(again.status, 200, JSON.stringify(again.json))
  assert.equal(again.json.idempotent, true)
  assert.equal(await balanceOf(player.client), after)
  const wins = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win'`,
    [player.id],
  )
  assert.equal(wins.rows[0].n, 1)
})

test('cashout after the crash point is rejected and pays nothing', async () => {
  const { player } = await adminAndPlayer()
  const roundId = await openBetting()
  const placed = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 1000,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(placed.status, 200, JSON.stringify(placed.json))
  const staked = await balanceOf(player.client)
  await forceFlying(roundId, 1.05, 4)
  const late = await player.client.send('POST', '/api/aviator/cashout', { betId: placed.json.betId })
  assert.equal(late.status, 409)
  assert.equal(late.json.error, 'crashed')
  assert.equal(await balanceOf(player.client), staked)
  const still = await pool.query<{ status: string }>(`SELECT status FROM aviator_bets WHERE id = $1`, [placed.json.betId])
  assert.equal(still.rows[0].status, 'active')
  const crashed = await tickAviator(cfg)
  assert.equal(crashed.skipped, false)
  if (!crashed.skipped) assert.equal(crashed.action, 'crashed')
  const lost = await pool.query<{ status: string }>(`SELECT status FROM aviator_bets WHERE id = $1`, [placed.json.betId])
  assert.equal(lost.rows[0].status, 'lost')
  assert.equal(await balanceOf(player.client), staked)
})

test('auto cashout pays the chosen multiplier once', async () => {
  const { player } = await adminAndPlayer()
  const roundId = await openBetting()
  const before = await balanceOf(player.client)
  const placed = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 1000,
    panel: 1,
    autoCashout: 1.2,
    idempotencyKey: nextKey(),
  })
  assert.equal(placed.status, 200, JSON.stringify(placed.json))
  await forceFlying(roundId, 20, 4)
  const tick = await tickAviator(cfg)
  assert.equal(tick.skipped, false)
  if (!tick.skipped) assert.equal(tick.action, 'flying')
  const bet = await pool.query<{ status: string, cashout_multiplier: string, payout_tzs: string }>(
    `SELECT status, cashout_multiplier, payout_tzs FROM aviator_bets WHERE id = $1`,
    [placed.json.betId],
  )
  assert.equal(bet.rows[0].status, 'cashed_out')
  assert.equal(Number(bet.rows[0].cashout_multiplier), 1.2)
  assert.equal(Number(bet.rows[0].payout_tzs), 1200)
  assert.equal(await balanceOf(player.client), before - 1000 + 1200)
  await tickAviator(cfg)
  assert.equal(await balanceOf(player.client), before + 200)
  const wins = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win'`,
    [player.id],
  )
  assert.equal(wins.rows[0].n, 1)
})

test('max win caps the cashout', async () => {
  operatorConfig.aviatorMaxWin = 500
  const { player } = await adminAndPlayer()
  const roundId = await openBetting()
  const placed = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 1000,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(placed.status, 200, JSON.stringify(placed.json))
  await forceFlying(roundId, 20, 4)
  const cashed = await player.client.send('POST', '/api/aviator/cashout', { betId: placed.json.betId })
  assert.equal(cashed.status, 200, JSON.stringify(cashed.json))
  assert.equal(cashed.json.payoutTzs, 500)
})

test('aborting a round refunds the stake once, including a restart mid-flight', async () => {
  const { player } = await adminAndPlayer()
  const roundId = await openBetting()
  const before = await balanceOf(player.client)
  const placed = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 1000,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(placed.status, 200, JSON.stringify(placed.json))
  operatorConfig.aviatorEnabled = false
  const aborted = await tickAviator(cfg)
  assert.equal(aborted.skipped, false)
  if (!aborted.skipped) assert.equal(aborted.action, 'aborted')
  assert.equal(await balanceOf(player.client), before)
  const status = await pool.query<{ status: string }>(`SELECT status FROM aviator_bets WHERE id = $1`, [placed.json.betId])
  assert.equal(status.rows[0].status, 'refunded')
  const quiet = await tickAviator(cfg)
  assert.equal(quiet.skipped, false)
  if (!quiet.skipped) assert.equal(quiet.action, 'disabled')
  assert.equal(await balanceOf(player.client), before)

  operatorConfig.aviatorEnabled = true
  const nextRound = await openBetting()
  const again = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 800,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(again.status, 200, JSON.stringify(again.json))
  const mid = await balanceOf(player.client)
  await forceFlying(nextRound, 20, 2)
  const recovered = await recoverAviator(cfg)
  assert.equal(recovered.skipped, false)
  if (recovered.skipped) throw new Error('locked')
  assert.equal(recovered.refunded, 1)
  assert.equal(await balanceOf(player.client), mid + 800)
  const twice = await recoverAviator(cfg)
  assert.equal(twice.skipped, false)
  if (!twice.skipped) assert.equal(twice.refunded, 0)
  assert.equal(await balanceOf(player.client), mid + 800)
  assert.notEqual(roundId, nextRound)
})

test('only one worker holds the aviator lock', async () => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [AVIATOR_LOCK_KEY])
    const skipped = await tickAviator(cfg)
    assert.equal(skipped.skipped, true)
    if (skipped.skipped) assert.equal(skipped.reason, 'locked')
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
  const next = await tickAviator(cfg)
  assert.equal(next.skipped, false)
  if (!next.skipped) assert.equal(next.action, 'betting')
})

test('stake limits, chat moderation, and aviator settings are enforced and audited', async () => {
  const { admin, player } = await adminAndPlayer()
  await openBetting()
  const low = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 99,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(low.status, 400)
  const high = await player.client.send('POST', '/api/aviator/bets', {
    stakeTzs: 2_000_001,
    panel: 1,
    idempotencyKey: nextKey(),
  })
  assert.equal(high.status, 400)

  const said = await player.client.send('POST', '/api/aviator/chat', { body: 'Habari wachezaji' })
  assert.equal(said.status, 200, JSON.stringify(said.json))
  const fast = await player.client.send('POST', '/api/aviator/chat', { body: 'Tena' })
  assert.equal(fast.status, 429)
  const removed = await admin.client.send('POST', `/api/admin/aviator/chat/${said.json.id}/delete`, {})
  assert.equal(removed.status, 200, JSON.stringify(removed.json))
  const state = await player.client.send('GET', '/api/aviator/state')
  assert.equal(state.json.chat.some((line: { id: string }) => line.id === said.json.id), false)
  const muted = await admin.client.send('POST', '/api/admin/aviator/mutes', { userId: player.id, minutes: 10, reason: 'spam' })
  assert.equal(muted.status, 200, JSON.stringify(muted.json))
  await pool.query(`UPDATE aviator_chat SET created_at = now() - interval '1 minute' WHERE user_id = $1`, [player.id])
  const blocked = await player.client.send('POST', '/api/aviator/chat', { body: 'Naendelea' })
  assert.equal(blocked.status, 403)

  const bad = await admin.client.send('PATCH', '/api/admin/aviator/settings', { aviatorRtpBps: 5000 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/aviator/settings', { aviatorRtpBps: 9500, aviatorEnabled: false })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.aviatorRtpBps, 9500)
  assert.equal(operatorConfig.aviatorRtpBps, 9500)
  const audit = await pool.query(`SELECT action FROM audit_log WHERE action = 'admin.aviator.settings'`)
  assert.equal(audit.rowCount, 1)
  const overview = await admin.client.send('GET', '/api/admin/aviator')
  assert.equal(overview.status, 200, JSON.stringify(overview.json))
  assert.equal(overview.json.settings.aviatorRtpBps, 9500)
  assert.equal(typeof overview.json.pnl.allProfit, 'number')
})

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
