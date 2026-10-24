import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
process.env.COOKIE_SECURE = 'false'
process.env.TRUST_PROXY = 'false'
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://ushindi:local_dev_only_change_me_1@127.0.0.1:5432/ushindi_test'
process.env.MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
delete process.env.SUPER_ADMIN_PHONE
delete process.env.SUPER_ADMIN_PASSWORD
delete process.env.ADMIN_PHONE
delete process.env.ADMIN_PASSWORD
delete process.env.REDIS_URL

const dbName = new URL(process.env.DATABASE_URL).pathname
if (!dbName.includes('test')) throw new Error(`Refusing to run mayan tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')
const { generateWheelIndex, mayanPayout, setMayanUnitForTests, weightFor, WHEEL_SEGMENTS } = await import('./mayan/fairness.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 2300

function nextPhone() {
  n += 1
  return phone(n)
}

function queue(values: number[]) {
  let i = 0
  setMayanUnitForTests(() => values[i++])
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  setMayanUnitForTests(null)
  operatorConfig.mayanEnabled = true
  operatorConfig.mayanMinStake = 50
  operatorConfig.mayanMaxStake = 2_000_000
  operatorConfig.mayanMaxWin = 10_000_000
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`UPDATE mayan_budget SET budget_tzs = 25000, total_bets_tzs = 0, total_payouts_tzs = 0, enabled = false`)
})

after(async () => {
  setMayanUnitForTests(null)
  await app.close()
  await closePool()
})

async function register(number = nextPhone()) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  return { client, number, id: created.json.user.id as string }
}

async function adminAndPlayer(balance = 20_000) {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit', amountTzs: balance, reason: 'mayan test stake',
  })
  assert.equal(credited.status, 200, JSON.stringify(credited.json))
  return { admin, player }
}

test('wheel weights match PesaBetPro and a zero draw takes the first segment in the pool', () => {
  assert.equal(weightFor(1000, true), 1)
  assert.equal(weightFor(100, false), 1)
  assert.equal(weightFor(48, true), 2)
  assert.equal(weightFor(24, false), 3)
  assert.equal(weightFor(12, true), 4)
  assert.equal(weightFor(12, false), 5)
  assert.equal(weightFor(4.8, true), 10)
  assert.equal(weightFor(2.5, false), 15)
  assert.equal(WHEEL_SEGMENTS.length, 24)

  const loss = generateWheelIndex([1000], 0.8, (() => {
    const values = [0, 0]
    let i = 0
    return () => values[i++]
  })())
  assert.equal(loss, 0)
  assert.equal(WHEEL_SEGMENTS[loss].multiplier, 2.5)

  const win = generateWheelIndex([2.5], 0.8, (() => {
    const values = [0.99, 0]
    let i = 0
    return () => values[i++]
  })())
  assert.equal(win, 0)
  assert.equal(mayanPayout(100, 2.5, 10_000_000), 250)
  assert.equal(mayanPayout(100, 4.8, 10_000_000), 480)
  assert.equal(mayanPayout(0, 2.5, 10_000_000), 0)
})

test('a covered x2.5 pays 2.5 times that stake, a miss pays nothing, and a replay does not debit again', async () => {
  const { player } = await adminAndPlayer(20_000)
  queue([0, 0])
  const missKey = randomUUID()
  const missed = await player.client.send('POST', '/api/mayan/spin', {
    bets: { x1000: 100 }, idempotencyKey: missKey,
  })
  assert.equal(missed.status, 200, JSON.stringify(missed.json))
  assert.equal(missed.json.spin.winIdx, 0)
  assert.equal(missed.json.spin.multiplier, 2.5)
  assert.equal(missed.json.spin.payoutTzs, 0)
  assert.equal(missed.json.spin.won, false)
  assert.equal(missed.json.spin.lossRate, undefined)
  assert.equal(missed.json.balanceTzs, 19_900)
  const missReplay = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 100 }, idempotencyKey: missKey,
  })
  assert.equal(missReplay.json.duplicate, true)
  assert.equal(missReplay.json.spin.winIdx, 0)
  assert.equal(missReplay.json.balanceTzs, 19_900)

  queue([0.99, 0])
  const winKey = randomUUID()
  const won = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 100 }, idempotencyKey: winKey,
  })
  assert.equal(won.status, 200, JSON.stringify(won.json))
  assert.equal(won.json.spin.winIdx, 0)
  assert.equal(won.json.spin.multiplier, 2.5)
  assert.equal(won.json.spin.payoutTzs, 250)
  assert.equal(won.json.spin.won, true)
  assert.equal(won.json.balanceTzs, 19_900 - 100 + 250)
  const winReplay = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 500 }, idempotencyKey: winKey,
  })
  assert.equal(winReplay.json.duplicate, true)
  assert.equal(winReplay.json.balanceTzs, won.json.balanceTzs)

  const stakes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_stake' AND reference_type = 'mayan'`,
    [player.id],
  )
  const credits = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win' AND reference_type = 'mayan'`,
    [player.id],
  )
  assert.equal(stakes.rows[0].n, 2)
  assert.equal(credits.rows[0].n, 1)
  const budget = await pool.query<{ bets: string; payouts: string }>(
    `SELECT total_bets_tzs::text AS bets, total_payouts_tzs::text AS payouts FROM mayan_budget`,
  )
  assert.equal(budget.rows[0].bets, '200')
  assert.equal(budget.rows[0].payouts, '250')

  const board = await player.client.send('GET', '/api/mayan')
  assert.equal(board.json.limits.budgetEnabled, false)
  assert.equal(board.json.limits.budgetTzs, undefined)
  assert.equal(board.json.history.length, 2)
  assert.equal(JSON.stringify(board.json).includes('budgetTzs'), false)
})

test('covering every multiplier still pays only the landed stake', async () => {
  const { player } = await adminAndPlayer(20_000)
  queue([0, 0])
  const bets = { x4: 100, x12: 100, x48: 100, x1000: 100, 'x2.5': 100, 'x4.8': 100, x24: 100, x100: 100 }
  const spun = await player.client.send('POST', '/api/mayan/spin', { bets, idempotencyKey: randomUUID() })
  assert.equal(spun.status, 200, JSON.stringify(spun.json))
  assert.equal(spun.json.spin.winIdx, 0)
  assert.equal(spun.json.spin.multiplier, 2.5)
  assert.equal(spun.json.spin.payoutTzs, 250)
  assert.equal(spun.json.balanceTzs, 20_000 - 800 + 250)
})

test('mayan rejects an empty slip, a stranger target, a short wallet, a missing token, and a switched-off wheel', async () => {
  const { admin, player } = await adminAndPlayer(500)
  const empty = await player.client.send('POST', '/api/mayan/spin', { bets: {}, idempotencyKey: randomUUID() })
  assert.equal(empty.status, 400)
  const unknown = await player.client.send('POST', '/api/mayan/spin', {
    bets: { x7: 100 }, idempotencyKey: randomUUID(),
  })
  assert.equal(unknown.status, 400)
  const small = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 49 }, idempotencyKey: randomUUID(),
  })
  assert.equal(small.status, 400)
  const broke = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 1000 }, idempotencyKey: randomUUID(),
  })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')

  const missing = await app.inject({
    method: 'POST',
    url: '/api/mayan/spin',
    headers: { cookie: player.client.header() },
    payload: { bets: { 'x2.5': 100 }, idempotencyKey: randomUUID() },
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')

  const denied = await player.client.send('GET', '/api/admin/mayan')
  assert.equal(denied.status, 403)
  const deniedPatch = await player.client.send('PATCH', '/api/admin/mayan/budget', { enabled: true })
  assert.equal(deniedPatch.status, 403)

  operatorConfig.mayanEnabled = false
  const off = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 100 }, idempotencyKey: randomUUID(),
  })
  assert.equal(off.status, 409)
  assert.equal(off.json.error, 'game_disabled')
  operatorConfig.mayanEnabled = true

  const bad = await admin.client.send('PATCH', '/api/admin/mayan/settings', { mayanMinStake: 10 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/mayan/settings', { mayanMinStake: 100, mayanEnabled: false })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.mayanMinStake, 100)
  assert.equal(saved.json.mayanEnabled, false)
  const audit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.mayan.settings'`,
  )
  assert.equal(audit.rows[0].n, 1)
  operatorConfig.mayanMinStake = 50
  operatorConfig.mayanEnabled = true
})

test('an enabled budget at the danger band is audited and still pays when the wheel hits', async () => {
  const { admin, player } = await adminAndPlayer(20_000)
  const missing = await app.inject({
    method: 'PATCH',
    url: '/api/admin/mayan/budget',
    headers: { cookie: admin.client.header() },
    payload: { enabled: true },
  })
  assert.equal(missing.statusCode, 403)
  const bad = await admin.client.send('PATCH', '/api/admin/mayan/budget', { budgetTzs: -1 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/mayan/budget', { enabled: true, budgetTzs: 25_000 })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.enabled, true)
  assert.equal(saved.json.lossRate, 0.8)
  assert.equal(saved.json.payoutCap, 13_750)

  await pool.query(`UPDATE mayan_budget SET total_payouts_tzs = 25000, total_bets_tzs = 0, enabled = true`)
  const danger = await admin.client.send('GET', '/api/admin/mayan')
  assert.equal(danger.json.budget.lossRate, 0.98)
  assert.equal(danger.json.budget.healthLabel, 'danger')

  queue([0, 0])
  const forced = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 100 }, idempotencyKey: randomUUID(),
  })
  assert.equal(forced.status, 200, JSON.stringify(forced.json))
  assert.equal(forced.json.spin.won, false)
  assert.equal(forced.json.spin.payoutTzs, 0)
  const stored = await pool.query<{ loss_rate: string; win_idx: number }>(
    `SELECT loss_rate::text AS loss_rate, win_idx FROM mayan_spins WHERE user_id = $1`,
    [player.id],
  )
  assert.equal(Number(stored.rows[0].loss_rate), 0.98)
  assert.notEqual(stored.rows[0].win_idx, 0)

  await pool.query(`UPDATE mayan_budget SET total_payouts_tzs = 13750, total_bets_tzs = 0, enabled = true`)
  const capped = await admin.client.send('GET', '/api/admin/mayan')
  assert.equal(capped.json.budget.isPayoutCapReached, true)
  queue([0.99, 0])
  const paid = await player.client.send('POST', '/api/mayan/spin', {
    bets: { 'x2.5': 100 }, idempotencyKey: randomUUID(),
  })
  assert.equal(paid.status, 200, JSON.stringify(paid.json))
  assert.equal(paid.json.spin.won, true)
  assert.equal(paid.json.spin.payoutTzs, 250)

  const reset = await admin.client.send('PATCH', '/api/admin/mayan/budget', { resetCounters: true, enabled: false })
  assert.equal(reset.status, 200, JSON.stringify(reset.json))
  assert.equal(reset.json.enabled, false)
  assert.equal(reset.json.totalBetsTzs, 0)
  assert.equal(reset.json.totalPayoutsTzs, 0)
  assert.equal(reset.json.lossRate, 0.8)
  const audit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.mayan.budget'`,
  )
  assert.equal(audit.rows[0].n, 2)
})
