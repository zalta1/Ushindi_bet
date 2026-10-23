import assert from 'node:assert/strict'
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
if (!dbName.includes('test')) throw new Error(`Refusing to run deposit tests against ${dbName}`)

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

before(async () => {
  await migrate(cfg)
  app = await buildApp({ authRateMax: 1000, registerRateMax: 1000, redisUrl: '' })
  await app.ready()
})

beforeEach(async () => {
  operatorConfig.minDeposit = 30_000
  operatorConfig.maxDeposit = 5_000_000
  await pool.query(`TRUNCATE auth_events, audit_log, bet_legs, bets, ledger_entries, sessions, deposit_requests, wallets, users RESTART IDENTITY CASCADE`)
})

after(async () => {
  await app.close()
  await closePool()
})

async function player(number = phone(80)) {
  const client = new Client(app)
  const created = await client.send('POST', '/api/auth/register', { phone: number, password })
  assert.equal(created.status, 201)
  return client
}

test('deposit limits publish the configured minimum', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/deposits/limits' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { minDeposit: 30000, maxDeposit: 5000000, currency: 'TZS' })
})

test('a deposit below 30000 is rejected and a valid one stays pending', async () => {
  const number = phone(80)
  const client = await player(number)
  const low = await client.send('POST', '/api/deposits', { amount: 25000, phone: number })
  assert.equal(low.status, 400)
  assert.equal(low.json.error, 'amount_below_minimum')
  assert.equal(low.json.fields.amount, 'min_deposit')
  assert.equal(low.json.minDeposit, 30000)

  const edge = await client.send('POST', '/api/deposits', { amount: 29999, phone: number })
  assert.equal(edge.status, 400)
  assert.equal(edge.json.error, 'amount_below_minimum')

  const badPhone = await client.send('POST', '/api/deposits', { amount: 30000, phone: '+254712000080' })
  assert.equal(badPhone.status, 400)
  assert.equal(badPhone.json.error, 'invalid_phone')

  const anon = await app.inject({
    method: 'POST',
    url: '/api/deposits',
    payload: { amount: 30000, phone: number },
  })
  assert.equal(anon.statusCode, 401)

  const ok = await client.send('POST', '/api/deposits', { amount: 30000, phone: number })
  assert.equal(ok.status, 201)
  assert.equal(ok.json.status, 'pending')
  assert.equal(ok.json.amountTzs, 30000)
  assert.equal(ok.json.phone, number)
  assert.equal(ok.json.ledger, false)
  assert.equal(ok.json.sandbox, true)

  const wallet = await pool.query(`SELECT balance_tzs FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.phone = $1`, [number])
  assert.equal(wallet.rows[0].balance_tzs, '0')
  const rows = await pool.query(`SELECT status, amount_tzs FROM deposit_requests`)
  assert.equal(rows.rowCount, 1)
  assert.equal(rows.rows[0].status, 'pending')
  assert.equal(rows.rows[0].amount_tzs, '30000')
})

test('an admin can raise the minimum and the API follows it', async () => {
  const adminPhone = phone(81)
  const admin = await player(adminPhone)
  await pool.query(`UPDATE users SET role = 'admin' WHERE phone = $1`, [adminPhone])
  const saved = await admin.send('PATCH', '/api/admin/config', { minDeposit: 40000 })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.minDeposit, 40000)

  const client = await player(phone(82))
  const rejected = await client.send('POST', '/api/deposits', { amount: 30000, phone: '0712000082' })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.json.minDeposit, 40000)
  const accepted = await client.send('POST', '/api/deposits', { amount: 40000, phone: '0712000082' })
  assert.equal(accepted.status, 201)
})
