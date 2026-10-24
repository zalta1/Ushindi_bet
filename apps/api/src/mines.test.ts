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
if (!dbName.includes('test')) throw new Error(`Refusing to run mines tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')
const { generateMines, minesMultiplier, minesPayout, setMinesRndForTests } = await import('./mines/fairness.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 2100

function nextPhone() {
  n += 1
  return phone(n)
}

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  setMinesRndForTests(null)
  operatorConfig.minesEnabled = true
  operatorConfig.minesRtpBps = 9700
  operatorConfig.minesMinStake = 100
  operatorConfig.minesMaxStake = 2_000_000
  operatorConfig.minesMaxWin = 10_000_000
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
  await pool.query(`UPDATE mines_budget SET budget_tzs = 25000, total_bets_tzs = 0, total_payouts_tzs = 0, enabled = false`)
})

after(async () => {
  setMinesRndForTests(null)
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
    direction: 'credit', amountTzs: balance, reason: 'mines test stake',
  })
  assert.equal(credited.status, 200, JSON.stringify(credited.json))
  return { admin, player }
}

test('the mines price matches PesaBetPro at 97% and positions are a uniform draw', () => {
  assert.equal(minesMultiplier(0, 3, 9700), 1)
  assert.equal(minesMultiplier(1, 1, 9700), Number(((25 / 24) * 0.97).toFixed(2)))
  assert.equal(minesMultiplier(2, 3, 9700), Number((((25 / 22) * (24 / 21)) * 0.97).toFixed(2)))
  const placed = generateMines(3, (() => {
    const values = [4, 4, 9, 1]
    let i = 0
    return () => values[i++]
  })())
  assert.deepEqual(placed, [4, 9, 1])
})

test('a safe click can cash out once, a mine pays nothing, and a clear board wins', async () => {
  const { player } = await adminAndPlayer(20_000)
  setMinesRndForTests(() => 24)
  const startKey = randomUUID()
  const started = await player.client.send('POST', '/api/mines/start', {
    mineCount: 1, stakeTzs: 1000, idempotencyKey: startKey,
  })
  assert.equal(started.status, 200, JSON.stringify(started.json))
  assert.equal(started.json.bet.status, 'active')
  assert.equal(started.json.bet.mines, null)
  assert.equal(started.json.balanceTzs, 19_000)
  const replay = await player.client.send('POST', '/api/mines/start', {
    mineCount: 3, stakeTzs: 1000, idempotencyKey: startKey,
  })
  assert.equal(replay.json.duplicate, true)
  assert.equal(replay.json.balanceTzs, 19_000)

  const blocked = await player.client.send('POST', '/api/mines/start', {
    mineCount: 1, stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.json.error, 'active_game')

  const early = await player.client.send('POST', '/api/mines/cashout', {
    betId: started.json.bet.id, idempotencyKey: randomUUID(),
  })
  assert.equal(early.status, 409)
  assert.equal(early.json.error, 'too_early')

  const revealKey = randomUUID()
  const safe = await player.client.send('POST', '/api/mines/reveal', {
    betId: started.json.bet.id, cell: 0, idempotencyKey: revealKey,
  })
  assert.equal(safe.status, 200, JSON.stringify(safe.json))
  assert.equal(safe.json.bet.status, 'active')
  assert.deepEqual(safe.json.bet.revealed, [0])
  const expectedMult = minesMultiplier(1, 1, 9700)
  assert.equal(safe.json.bet.multiplier, expectedMult)
  assert.equal(safe.json.balanceTzs, 19_000)
  const revealReplay = await player.client.send('POST', '/api/mines/reveal', {
    betId: started.json.bet.id, cell: 1, idempotencyKey: revealKey,
  })
  assert.equal(revealReplay.json.duplicate, true)
  assert.deepEqual(revealReplay.json.bet.revealed, [0])

  const cashKey = randomUUID()
  const expectedPay = minesPayout(1000, expectedMult, 10_000_000)
  const cashed = await player.client.send('POST', '/api/mines/cashout', {
    betId: started.json.bet.id, idempotencyKey: cashKey,
  })
  assert.equal(cashed.status, 200, JSON.stringify(cashed.json))
  assert.equal(cashed.json.bet.status, 'settled')
  assert.equal(cashed.json.bet.payoutTzs, expectedPay)
  assert.equal(cashed.json.bet.won ?? cashed.json.bet.status, 'settled')
  assert.deepEqual(cashed.json.bet.mines, [24])
  assert.equal(cashed.json.balanceTzs, 19_000 + expectedPay)
  const cashReplay = await player.client.send('POST', '/api/mines/cashout', {
    betId: started.json.bet.id, idempotencyKey: cashKey,
  })
  assert.equal(cashReplay.json.duplicate, true)
  assert.equal(cashReplay.json.balanceTzs, cashed.json.balanceTzs)
  const again = await player.client.send('POST', '/api/mines/cashout', {
    betId: started.json.bet.id, idempotencyKey: randomUUID(),
  })
  assert.equal(again.status, 409)
  assert.equal(again.json.error, 'bet_closed')

  setMinesRndForTests(() => 0)
  const mineGame = await player.client.send('POST', '/api/mines/start', {
    mineCount: 1, stakeTzs: 500, idempotencyKey: randomUUID(),
  })
  assert.equal(mineGame.status, 200, JSON.stringify(mineGame.json))
  const lost = await player.client.send('POST', '/api/mines/reveal', {
    betId: mineGame.json.bet.id, cell: 0, idempotencyKey: randomUUID(),
  })
  assert.equal(lost.status, 200, JSON.stringify(lost.json))
  assert.equal(lost.json.bet.status, 'lost')
  assert.equal(lost.json.bet.payoutTzs, 0)
  assert.deepEqual(lost.json.bet.mines, [0])
  assert.equal(lost.json.balanceTzs, cashed.json.balanceTzs - 500)

  let cursor = 1
  setMinesRndForTests(() => cursor++)
  const clear = await player.client.send('POST', '/api/mines/start', {
    mineCount: 24, stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(clear.status, 200, JSON.stringify(clear.json))
  const won = await player.client.send('POST', '/api/mines/reveal', {
    betId: clear.json.bet.id, cell: 0, idempotencyKey: randomUUID(),
  })
  assert.equal(won.status, 200, JSON.stringify(won.json))
  assert.equal(won.json.bet.status, 'settled')
  const clearMult = minesMultiplier(1, 24, 9700)
  assert.equal(won.json.bet.multiplier, clearMult)
  assert.equal(won.json.bet.payoutTzs, minesPayout(100, clearMult, 10_000_000))
  assert.equal(won.json.bet.mines.length, 24)
  assert.equal(won.json.bet.mines.includes(0), false)

  const stakes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_stake' AND reference_type = 'mines'`,
    [player.id],
  )
  const credits = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win' AND reference_type = 'mines'`,
    [player.id],
  )
  assert.equal(stakes.rows[0].n, 3)
  assert.equal(credits.rows[0].n, 2)
})

test('mines rejects an empty wallet, a missing token, and a switched-off game', async () => {
  const { player } = await adminAndPlayer(500)
  const broke = await player.client.send('POST', '/api/mines/start', {
    mineCount: 3, stakeTzs: 1000, idempotencyKey: randomUUID(),
  })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')
  const missing = await app.inject({
    method: 'POST',
    url: '/api/mines/start',
    headers: { cookie: player.client.header() },
    payload: { mineCount: 3, stakeTzs: 100, idempotencyKey: randomUUID() },
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')
  operatorConfig.minesEnabled = false
  const off = await player.client.send('POST', '/api/mines/start', {
    mineCount: 3, stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(off.status, 409)
  assert.equal(off.json.error, 'game_disabled')
})

test('an admin sets mines limits and the budget, and both writes are audited', async () => {
  const { admin, player } = await adminAndPlayer(5_000)
  const denied = await player.client.send('PATCH', '/api/admin/mines/settings', { minesRtpBps: 9500 })
  assert.equal(denied.status, 403)
  const bad = await admin.client.send('PATCH', '/api/admin/mines/settings', { minesRtpBps: 5000 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/mines/settings', { minesRtpBps: 9500 })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.minesRtpBps, 9500)
  const budgetDenied = await player.client.send('PATCH', '/api/admin/mines/budget', { enabled: true })
  assert.equal(budgetDenied.status, 403)
  const budget = await admin.client.send('PATCH', '/api/admin/mines/budget', { enabled: true, budgetTzs: 25_000 })
  assert.equal(budget.status, 200, JSON.stringify(budget.json))
  assert.equal(budget.json.enabled, true)
  assert.equal(budget.json.lossRate, 0.8)
  assert.equal(budget.json.payoutCap, 13_750)

  setMinesRndForTests(() => 24)
  const started = await player.client.send('POST', '/api/mines/start', {
    mineCount: 1, stakeTzs: 1000, idempotencyKey: randomUUID(),
  })
  assert.equal(started.status, 200, JSON.stringify(started.json))
  assert.equal(started.json.bet.mines, null)
  const revealed = await player.client.send('POST', '/api/mines/reveal', {
    betId: started.json.bet.id, cell: 0, idempotencyKey: randomUUID(),
  })
  assert.equal(revealed.json.bet.status, 'active')
  const cashed = await player.client.send('POST', '/api/mines/cashout', {
    betId: started.json.bet.id, idempotencyKey: randomUUID(),
  })
  assert.equal(cashed.status, 200, JSON.stringify(cashed.json))
  const board = await admin.client.send('GET', '/api/admin/mines')
  assert.equal(board.status, 200, JSON.stringify(board.json))
  assert.equal(board.json.budget.totalBetsTzs, 1000)
  assert.equal(board.json.budget.totalPayoutsTzs, cashed.json.bet.payoutTzs)
  assert.equal(board.json.budget.enabled, true)
  assert.equal(board.json.settings.minesRtpBps, 9500)
  assert.deepEqual(board.json.bets[0].mines, [24])

  const reset = await admin.client.send('PATCH', '/api/admin/mines/budget', { resetCounters: true, enabled: false })
  assert.equal(reset.json.totalBetsTzs, 0)
  assert.equal(reset.json.enabled, false)
  const audit = await pool.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE action LIKE 'admin.mines.%' ORDER BY action`,
  )
  assert.deepEqual(audit.rows.map((row) => row.action), ['admin.mines.budget', 'admin.mines.budget', 'admin.mines.settings'])
  operatorConfig.minesRtpBps = 9700
})
