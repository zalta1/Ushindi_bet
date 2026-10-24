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
if (!dbName.includes('test')) throw new Error(`Refusing to run dice tests against ${dbName}`)

const { buildApp } = await import('./app.js')
const { loadConfig } = await import('./config.js')
const { closePool, getPool } = await import('./db.js')
const { migrate } = await import('./migrate.js')
const { operatorConfig } = await import('./operator-config.js')
const { Client, phone } = await import('./test-support.js')
const { diceHash, diceMultiplier, dicePayout, rollFromHash, sha256 } = await import('./dice/fairness.js')

const cfg = loadConfig()
const pool = getPool(cfg)
let app: Awaited<ReturnType<typeof buildApp>>
const password = 'Horse-battery-9'
let n = 1800

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
  operatorConfig.diceEnabled = true
  operatorConfig.diceRtpBps = 9700
  operatorConfig.diceMinStake = 100
  operatorConfig.diceMaxStake = 2_000_000
  operatorConfig.diceMaxWin = 10_000_000
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
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

async function adminAndPlayer(balance = 20_000) {
  const admin = await register()
  await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id])
  const player = await register()
  const credited = await admin.client.send('POST', `/api/admin/users/${player.id}/adjust`, {
    direction: 'credit', amountTzs: balance, reason: 'dice test stake',
  })
  assert.equal(credited.status, 200, JSON.stringify(credited.json))
  return { admin, player }
}

async function openTable(client: Client) {
  const state = await client.send('GET', '/api/dice')
  assert.equal(state.status, 200, JSON.stringify(state.json))
  assert.equal(typeof state.json.commitment.serverSeedHash, 'string')
  return state.json.commitment as { serverSeedHash: string; clientSeed: string; nonce: number }
}

async function plant(userId: string, serverSeed: string, nonce: number, clientSeed = 'ushindi') {
  await pool.query(
    `UPDATE dice_commitments
        SET server_seed = $2, server_seed_hash = $3, client_seed = $4, nonce = $5
      WHERE user_id = $1`,
    [userId, serverSeed, sha256(serverSeed), clientSeed, nonce],
  )
}

test('the price matches PesaBetPro at 97% and the roll is a pure function of the hash', () => {
  assert.equal(diceMultiplier(50, 'under', 9700), Number(((99 / 50) * 0.97).toFixed(2)))
  assert.equal(diceMultiplier(50, 'over', 9700), Number(((99 / 50) * 0.97).toFixed(2)))
  assert.equal(diceMultiplier(25, 'under', 9700), Number(((99 / 25) * 0.97).toFixed(2)))
  assert.equal(diceMultiplier(75, 'over', 9700), Number(((99 / 25) * 0.97).toFixed(2)))
  const hash = diceHash('seed', 'ushindi', 3)
  assert.equal(rollFromHash(hash), rollFromHash(hash))
  assert.ok(rollFromHash(hash) >= 1 && rollFromHash(hash) <= 100)
})

test('a committed seed pays a win once and a loss pays nothing', async () => {
  const { admin, player } = await adminAndPlayer(10_000)
  await openTable(player.client)
  const seed = 'dice-test-seed-0123456789abcdef'
  let winNonce = -1
  let lossNonce = -1
  for (let nonce = 0; nonce < 400 && (winNonce < 0 || lossNonce < 0); nonce += 1) {
    const roll = rollFromHash(diceHash(seed, 'ushindi', nonce))
    if (winNonce < 0 && roll <= 50) winNonce = nonce
    if (lossNonce < 0 && roll > 50) lossNonce = nonce
  }
  assert.ok(winNonce >= 0 && lossNonce >= 0)

  await plant(player.id, seed, winNonce)
  const winKey = randomUUID()
  const won = await player.client.send('POST', '/api/dice/play', {
    side: 'under', target: 50, stakeTzs: 1000, idempotencyKey: winKey,
  })
  assert.equal(won.status, 200, JSON.stringify(won.json))
  const expectedRoll = rollFromHash(diceHash(seed, 'ushindi', winNonce))
  const expectedMult = diceMultiplier(50, 'under', 9700)
  const expectedPay = dicePayout(1000, expectedMult, 10_000_000)
  assert.equal(won.json.bet.roll, expectedRoll)
  assert.equal(won.json.bet.won, true)
  assert.equal(won.json.bet.payoutTzs, expectedPay)
  assert.equal(won.json.bet.serverSeed, seed)
  assert.equal(won.json.balanceTzs, 10_000 - 1000 + expectedPay)
  assert.notEqual(won.json.next.serverSeedHash, sha256(seed))

  const replay = await player.client.send('POST', '/api/dice/play', {
    side: 'over', target: 10, stakeTzs: 1000, idempotencyKey: winKey,
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.json.duplicate, true)
  assert.equal(replay.json.bet.id, won.json.bet.id)
  assert.equal(replay.json.balanceTzs, won.json.balanceTzs)

  await plant(player.id, seed, lossNonce)
  const lost = await player.client.send('POST', '/api/dice/play', {
    side: 'under', target: 50, stakeTzs: 1000, idempotencyKey: randomUUID(),
  })
  assert.equal(lost.status, 200, JSON.stringify(lost.json))
  assert.equal(lost.json.bet.won, false)
  assert.equal(lost.json.bet.payoutTzs, 0)
  assert.equal(lost.json.balanceTzs, won.json.balanceTzs - 1000)

  const stakes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_stake' AND reference_type = 'dice'`,
    [player.id],
  )
  const credits = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1 AND entry_type = 'bet_win' AND reference_type = 'dice'`,
    [player.id],
  )
  assert.equal(stakes.rows[0].n, 2)
  assert.equal(credits.rows[0].n, 1)

  const verified = await app.inject({
    method: 'POST',
    url: '/api/dice/verify',
    payload: { serverSeed: seed, clientSeed: 'ushindi', nonce: winNonce },
  })
  assert.equal(verified.statusCode, 200)
  assert.equal(verified.json().roll, expectedRoll)
  assert.equal(verified.json().serverSeedHash, sha256(seed))

  const history = await admin.client.send('GET', '/api/admin/dice')
  assert.equal(history.status, 200)
  assert.equal(history.json.bets.length, 2)
  assert.equal(history.json.pnl.bets, 2)
  assert.equal(history.json.pnl.profit, 2000 - expectedPay)
})

test('dice rejects a late commitment, a weak price, and an empty wallet', async () => {
  const { player } = await adminAndPlayer(500)
  const early = await player.client.send('POST', '/api/dice/play', {
    side: 'under', target: 50, stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(early.status, 409)
  assert.equal(early.json.error, 'commit_first')

  await openTable(player.client)
  const priced = await player.client.send('POST', '/api/dice/play', {
    side: 'under', target: 98, stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(priced.status, 400)

  const broke = await player.client.send('POST', '/api/dice/play', {
    side: 'under', target: 50, stakeTzs: 1000, idempotencyKey: randomUUID(),
  })
  assert.equal(broke.status, 409)
  assert.equal(broke.json.error, 'insufficient_funds')

  const missing = await app.inject({
    method: 'POST',
    url: '/api/dice/play',
    headers: { cookie: player.client.header() },
    payload: { side: 'under', target: 50, stakeTzs: 100, idempotencyKey: randomUUID() },
  })
  assert.equal(missing.statusCode, 403)
  assert.equal(JSON.parse(missing.body).error, 'csrf_invalid')

  operatorConfig.diceEnabled = false
  const off = await player.client.send('POST', '/api/dice/play', {
    side: 'under', target: 50, stakeTzs: 100, idempotencyKey: randomUUID(),
  })
  assert.equal(off.status, 409)
  assert.equal(off.json.error, 'game_disabled')
})

test('an admin changes the dice RTP and the change is audited', async () => {
  const { admin, player } = await adminAndPlayer()
  const denied = await player.client.send('PATCH', '/api/admin/dice/settings', { diceRtpBps: 9500 })
  assert.equal(denied.status, 403)
  const bad = await admin.client.send('PATCH', '/api/admin/dice/settings', { diceRtpBps: 5000 })
  assert.equal(bad.status, 400)
  const saved = await admin.client.send('PATCH', '/api/admin/dice/settings', { diceRtpBps: 9500, diceEnabled: false })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  assert.equal(saved.json.diceRtpBps, 9500)
  assert.equal(saved.json.diceEnabled, false)
  assert.equal(operatorConfig.diceRtpBps, 9500)
  const audit = await pool.query<{ action: string; payload: { after: { diceRtpBps: number } } }>(
    `SELECT action, payload FROM audit_log WHERE action = 'admin.dice.settings'`,
  )
  assert.equal(audit.rows.length, 1)
  assert.equal(audit.rows[0].payload.after.diceRtpBps, 9500)
  const again = await admin.client.send('GET', '/api/admin/dice')
  assert.equal(again.json.settings.diceRtpBps, 9500)
  operatorConfig.diceRtpBps = 9700
  operatorConfig.diceEnabled = true
})
